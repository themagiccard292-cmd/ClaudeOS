import subprocess

import yaml
from conftest import REPO

SCRIPT = REPO / "scripts" / "build-iso.sh"


def run(*args, env=None):
    return subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True, env=env)


def test_help():
    r = run("-h")
    assert r.returncode == 0
    for flag in ["--work-dir", "--out-dir", "--skip-download", "--dry-run", "--keep-work", "--ubuntu-iso", "--no-gpg"]:
        assert flag in r.stdout


def test_dry_run_touches_nothing_and_prints_every_stage(tmp_path):
    work, out = tmp_path / "w", tmp_path / "o"
    r = run("--dry-run", "--work-dir", str(work), "--out-dir", str(out), "--cache-dir", str(tmp_path / "c"))
    assert r.returncode == 0, r.stderr
    assert not work.exists() and not out.exists() and not (tmp_path / "c").exists()
    for needle in ["Stage 1", "Stage 8", "xorriso", "mksquashfs", "apt-mark", "-boot_image any replay",
                   "claudeos-26.04.1-amd64.iso", "setup-venv.sh", "install-claude-code.sh", "apply-branding.sh"]:
        assert needle in r.stdout + r.stderr, needle


def test_unknown_option_and_dangerous_work_dir():
    assert run("--bogus").returncode != 0
    assert run("--dry-run", "--work-dir", "/").returncode != 0
    assert run("--dry-run", "--work-dir", "/usr").returncode != 0


def test_out_dir_inside_work_dir_rejected(tmp_path):
    r = run("--dry-run", "--work-dir", str(tmp_path / "w"), "--out-dir", str(tmp_path / "w" / "o"))
    assert r.returncode != 0


def test_non_dry_run_needs_root_or_fails_early(tmp_path):
    import os

    if os.geteuid() == 0:
        return
    assert run("--work-dir", str(tmp_path / "w"), "--out-dir", str(tmp_path / "o")).returncode != 0


def test_workflows_structure():
    wf = REPO / ".github" / "workflows"
    build = yaml.safe_load((wf / "build-iso.yml").read_text())
    ci = yaml.safe_load((wf / "ci.yml").read_text())
    on = build.get("on", build.get(True))
    assert on["push"]["tags"] == ["v*"]
    assert set(on["workflow_dispatch"]["inputs"]) >= {"ubuntu_version", "release_tag", "publish"}
    job = next(iter(build["jobs"].values()))
    assert job["runs-on"] == "ubuntu-24.04" and job["timeout-minutes"] == 360
    assert "concurrency" in build
    text = (wf / "build-iso.yml").read_text()
    for s in ["softprops/action-gh-release", "1900M", "compression-level: 0", "retention-days: 7", "SHA256SUMS",
              "make debs", "build-iso.sh", "join-iso.sh"]:
        assert s in text, s
    assert "contents: write" in text
    assert "contents: write" not in (wf / "ci.yml").read_text()
    cit = (wf / "ci.yml").read_text()
    assert "--dry-run" in cit and "make debs" in cit
    assert ci["jobs"]
