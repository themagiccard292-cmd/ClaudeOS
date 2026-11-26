import os
import subprocess
import sys

import pytest
import yaml

import flatten_layers
import seed_edit
from conftest import REPO, UBUNTU


def test_remove_snap_from_yaml_keeps_validity():
    text = (
        "snaps:\n"
        "  - name: snapd\n    channel: latest/stable\n    file: snapd_1.snap\n"
        "  - name: ubuntu-desktop-bootstrap\n    channel: 26.04/stable\n    file: ubuntu-desktop-bootstrap_1.snap\n"
        "  - name: firefox\n    channel: latest/stable\n    file: firefox_1.snap\n"
    )
    new, files = seed_edit.remove_snap_from_yaml(text, "ubuntu-desktop-bootstrap")
    names = [s["name"] for s in yaml.safe_load(new)["snaps"]]
    assert names == ["snapd", "firefox"]
    assert files == ["ubuntu-desktop-bootstrap_1.snap"]


def test_remove_snap_missing_is_noop():
    text = "snaps:\n  - name: snapd\n    file: snapd_1.snap\n"
    new, files = seed_edit.remove_snap_from_yaml(text, "nope")
    assert new == text and files == []


def test_remove_snap_in_seed_dir(tmp_path):
    seed = tmp_path / "seed"
    (seed / "snaps").mkdir(parents=True)
    (seed / "snaps" / "boot_1.snap").write_text("x")
    (seed / "seed.yaml").write_text("snaps:\n  - name: boot\n    file: boot_1.snap\n  - name: snapd\n    file: s.snap\n")
    changed, _ = seed_edit.remove_snap(seed, "boot")
    assert changed and not (seed / "snaps" / "boot_1.snap").exists()
    assert [s["name"] for s in yaml.safe_load((seed / "seed.yaml").read_text())["snaps"]] == ["snapd"]


def _copy(src, dest, excludes):
    import shutil

    for p in src.rglob("*"):
        rel = p.relative_to(src)
        if str(rel) in excludes or p.is_char_device():
            continue
        t = dest / rel
        if p.is_dir():
            t.mkdir(exist_ok=True)
        else:
            t.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, t)


def test_flatten_whiteout_fallback(tmp_path):
    if os.geteuid() != 0:
        pytest.skip("mknod whiteout needs root")
    low, up, out = tmp_path / "low", tmp_path / "up", tmp_path / "out"
    (low / "d").mkdir(parents=True)
    (low / "d" / "gone").write_text("1")
    (low / "keep").write_text("1")
    up.mkdir()
    (up / "d").mkdir()
    os.mknod(up / "d" / "gone", 0o020000, os.makedev(0, 0))
    flatten_layers.flatten([low, up], out, copier=_copy)
    assert (out / "keep").exists() and not (out / "d" / "gone").exists()


def test_flatten_scan_finds_whiteouts(tmp_path):
    if os.geteuid() != 0:
        pytest.skip("mknod whiteout needs root")
    os.mknod(tmp_path / "w", 0o020000, os.makedev(0, 0))
    assert flatten_layers.scan_layer(tmp_path).whiteouts == ["w"]


def test_check_no_api_key_guard(tmp_path):
    script = REPO / "scripts" / "check_no_api_key.py"

    def run(content, name="x.sh"):
        f = tmp_path / name
        f.write_text(content)
        return subprocess.run([sys.executable, "-I", str(script), "--root", str(tmp_path), str(f)],
                              capture_output=True, text=True).returncode

    assert run("echo $ANTHROPIC_API_KEY\n") == 1
    assert run("export ANTHROPIC_API_KEY=abc\n") == 1
    assert run("const k = process.env.ANTHROPIC_API_KEY\n", "x.js") == 1
    assert run("unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN\n") == 0
    assert run("echo hello\n") == 0


def test_lint_all_fails_on_planted_key(tmp_path):
    (tmp_path / "bad.sh").write_text("#!/usr/bin/env bash\nset -euo pipefail\necho \"$ANTHROPIC_API_KEY\"\n")
    r = subprocess.run(["bash", str(REPO / "scripts" / "lint-all.sh"), str(tmp_path)], capture_output=True, text=True)
    assert r.returncode == 1 and "api-key-guard" in r.stderr


def test_join_iso(tmp_path):
    import hashlib

    data = os.urandom(5000)
    (tmp_path / "x.iso.part-aa").write_bytes(data[:2000])
    (tmp_path / "x.iso.part-ab").write_bytes(data[2000:])
    (tmp_path / "SHA256SUMS").write_text(f"{hashlib.sha256(data).hexdigest()}  x.iso\n")
    out = tmp_path / "joined.iso"
    j = REPO / "scripts" / "join-iso.sh"
    r = subprocess.run(["bash", str(j), "-o", str(out), str(tmp_path)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert out.read_bytes() == data
    (tmp_path / "x.iso.part-ab").write_bytes(b"corrupt")
    r = subprocess.run(["bash", str(j), "-o", str(tmp_path / "j2.iso"), str(tmp_path)], capture_output=True, text=True)
    assert r.returncode != 0


def test_fixture_sources_yaml_parses():
    assert yaml.safe_load((UBUNTU / "install-sources.yaml").read_text())["sources"]
