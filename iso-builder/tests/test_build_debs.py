import shutil
import subprocess

import pytest
from conftest import ISO_BUILDER

pytestmark = pytest.mark.skipif(not shutil.which("dpkg-deb"), reason="dpkg-deb missing")
BUILD = ISO_BUILDER / "build-debs.sh"


def make_root(tmp_path, install_body, meta_extra=""):
    root = tmp_path / "repo"
    mod = root / "demo"
    (mod / "debian").mkdir(parents=True)
    (root / "VERSION").write_text("1.2.3\n")
    (mod / "package.meta").write_text(
        'PKG_NAME="claudeos-demo"\nPKG_DESCRIPTION="Demo\nsecond line"\nPKG_DEPENDS="bash"\n' + meta_extra)
    (mod / "Makefile").write_text(f"install:\n{install_body}\n")
    (mod / "debian" / "postinst").write_text("#!/bin/sh\nexit 0\n")
    (mod / "debian" / "postinst").chmod(0o644)
    return root


def build(root, out, *extra):
    return subprocess.run(["bash", str(BUILD), "--root", str(root), "--out", str(out), "--only", "demo", *extra],
                          capture_output=True, text=True, env={"SOURCE_DATE_EPOCH": "1700000000", "PATH": "/usr/bin:/bin"})


GOOD = ("\tinstall -D -m 0644 /dev/null $(DESTDIR)/usr/share/demo/f\n"
        "\tinstall -D -m 4755 /dev/null $(DESTDIR)/opt/demo/chrome-sandbox\n")


def test_builds_valid_deb(tmp_path):
    root = make_root(tmp_path, GOOD)
    r = build(root, tmp_path / "out")
    assert r.returncode == 0, r.stderr
    deb = tmp_path / "out" / "claudeos-demo_1.2.3+claudeos1_all.deb"
    assert deb.exists()
    ctrl = subprocess.run(["dpkg-deb", "-f", str(deb)], capture_output=True, text=True).stdout
    assert "Version: 1.2.3+claudeos1" in ctrl
    assert "Maintainer: ClaudeOS Maintainers <noreply@users.noreply.github.com>" in ctrl
    listing = subprocess.run(["dpkg-deb", "-c", str(deb)], capture_output=True, text=True).stdout
    assert "-rwsr-xr-x root/root" in listing and "chrome-sandbox" in listing
    assert (tmp_path / "out" / "Packages.gz").exists()
    ctl = subprocess.run(["dpkg-deb", "-I", str(deb), "postinst"], capture_output=True, text=True)
    assert ctl.returncode == 0 and "exit 0" in ctl.stdout


def test_reproducible(tmp_path):
    root = make_root(tmp_path, GOOD)
    build(root, tmp_path / "o1")
    build(root, tmp_path / "o2")
    name = "claudeos-demo_1.2.3+claudeos1_all.deb"
    assert (tmp_path / "o1" / name).read_bytes() == (tmp_path / "o2" / name).read_bytes()


def test_rejects_forbidden_paths(tmp_path):
    root = make_root(tmp_path, "\tinstall -D -m 0644 /dev/null $(DESTDIR)/home/x/f\n")
    r = build(root, tmp_path / "out")
    assert r.returncode != 0 and "outside the allowed prefixes" in r.stderr


def test_path_allowed(sh):
    for p, rc in [("usr/bin/x", 0), ("etc/a", 0), ("opt/a", 0), ("var/lib/x", 0), ("var", 0), ("home/u", 1),
                  ("usr/local/bin", 1), ("tmp/x", 1), ("var/log/x", 1), ("var/tmp", 1)]:
        assert sh(f"path_allowed {p}").returncode == rc, p


def test_real_modules_build(tmp_path):
    r = subprocess.run(["bash", str(BUILD), "--out", str(tmp_path / "debs")], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    names = {p.name.split("_")[0] for p in (tmp_path / "debs").glob("*.deb")}
    assert {"claudeos-desktop", "claudeos-theme", "claudeos-core"} <= names
    meta = next((tmp_path / "debs").glob("claudeos-desktop_*.deb"))
    ctrl = subprocess.run(["dpkg-deb", "-f", str(meta)], capture_output=True, text=True).stdout
    dep = next(ln for ln in ctrl.splitlines() if ln.startswith("Depends:"))
    assert "calamares" not in dep and "claudeos-calamares" in ctrl, "calamares must not be a hard dependency (installer purge would remove the meta)"
    assert "Recommends:" in ctrl and "calamares" in ctrl


def test_file_conflict_checker_flags_duplicate_ownership(tmp_path):
    import subprocess
    import sys

    def make_deb(name: str, files: dict[str, str]) -> None:
        root = tmp_path / f"{name}-root"
        for rel, content in files.items():
            f = root / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(content)
        (root / "DEBIAN").mkdir()
        (root / "DEBIAN/control").write_text(
            f"Package: {name}\nVersion: 1\nArchitecture: all\nMaintainer: t <t@example.org>\nDescription: t\n"
        )
        out = tmp_path / "debs"
        out.mkdir(exist_ok=True)
        subprocess.run(["dpkg-deb", "--build", "--root-owner-group", str(root), str(out / f"{name}_1_all.deb")],
                       check=True, capture_output=True)

    script = ISO_BUILDER / "lib" / "check_file_conflicts.py"
    make_deb("pkg-a", {"usr/share/x/a.txt": "a", "usr/share/x/shared.svg": "1"})
    make_deb("pkg-b", {"usr/share/x/b.txt": "b"})
    ok = subprocess.run([sys.executable, str(script), str(tmp_path / "debs")], capture_output=True, text=True)
    assert ok.returncode == 0, ok.stderr
    make_deb("pkg-c", {"usr/share/x/shared.svg": "2"})
    bad = subprocess.run([sys.executable, str(script), str(tmp_path / "debs")], capture_output=True, text=True)
    assert bad.returncode == 1
    assert "/usr/share/x/shared.svg" in bad.stderr and "pkg-a" in bad.stderr and "pkg-c" in bad.stderr
