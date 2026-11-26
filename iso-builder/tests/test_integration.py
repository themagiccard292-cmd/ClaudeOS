"""Integration tests with the real tools (skipped when they are missing)."""

import shutil
import subprocess

import pytest

pytestmark = [pytest.mark.integration,
              pytest.mark.skipif(not (shutil.which("xorriso") and shutil.which("mksquashfs")),
                                 reason="xorriso/squashfs-tools missing")]


def test_squashfs_args_build_a_readable_image(sh, tmp_path):
    src = tmp_path / "src"
    (src / "etc").mkdir(parents=True)
    (src / "etc" / "hello").write_text("hi")
    for comp in ("zstd", "xz"):
        out = tmp_path / f"{comp}.squashfs"
        r = sh(f"SQUASHFS_COMP={comp}; mapfile -d '' a < <(mksquashfs_args {src} {out}); \"${{a[@]}}\" >/dev/null")
        assert r.returncode == 0, r.stderr
        assert out.stat().st_size > 0


def test_unbootable_iso_fails_boot_verification(sh, tmp_path):
    tree = tmp_path / "tree"
    tree.mkdir()
    (tree / "f").write_text("x")
    iso = tmp_path / "plain.iso"
    subprocess.run(["xorriso", "-as", "mkisofs", "-o", str(iso), str(tree)], check=True, capture_output=True)
    assert sh(f"boot_report {iso} | verify_boot_report").returncode != 0
