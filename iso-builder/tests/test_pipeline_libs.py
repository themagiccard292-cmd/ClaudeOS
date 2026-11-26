import re

from conftest import FIXTURES, UBUNTU

PINNED = "601e30fbf5d97759367c632e2c33630665039b7e2158fd068403da3ccf1bda1f"


def test_names(sh):
    r = sh('iso_filename 26.04.1; output_iso_name 26.04.1; volume_id 26.04.1')
    assert r.stdout.split("\n")[:3] == ["ubuntu-26.04.1-desktop-amd64.iso", "claudeos-26.04.1-amd64.iso",
                                        "ClaudeOS 26.04.1 amd64"]


def test_pinned_hash_matches_fixture_and_config(sh):
    sums = (UBUNTU / "SHA256SUMS").read_text()
    assert f"{PINNED} *ubuntu-26.04.1-desktop-amd64.iso" in sums
    assert PINNED in (FIXTURES.parent.parent / "config" / "build.conf").read_text()


def test_check_validsig(sh):
    ok = "[GNUPG:] VALIDSIG AAAA 2026 0 4 0 1 10 00 ABCDEF\n"
    assert sh(f"check_validsig '{ok}' 'abcdef'").returncode == 0
    assert sh(f"check_validsig '{ok}' '123456'").returncode != 0
    assert sh("check_validsig '' 'abcdef'").returncode != 0


def test_node_version_ok(sh):
    for v, rc in [("22.14.0+dfsg-1", 0), ("1:22.1", 0), ("18.19.1+dfsg", 1), ("(none)", 1), ("", 1)]:
        assert sh(f"node_version_ok '{v}' 22").returncode == rc, v


def test_select_hold_packages(sh):
    listing = "linux-image-7.0 ii\ngrub-pc-bin ii\nshim-signed hi\nbash ii\nlinux-foo rc\n"
    r = sh("select_hold_packages", stdin=listing)
    assert r.stdout.split() == ["grub-pc-bin", "linux-image-7.0", "shim-signed"]


def test_packages_list_has_required(sh):
    r = sh(f"packages_from_list {UBUNTU.parents[2] / 'config' / 'packages.list'}")
    pk = set(r.stdout.split())
    need = {"calamares", "nodejs", "npm", "python3-nautilus", "python3-venv", "ydotool", "xdotool", "grim",
            "wl-clipboard", "xclip", "gnome-screenshot", "x11-xserver-utils", "librsvg2-bin", "libnotify-bin",
            "xdg-utils", "jq", "fonts-inter", "fonts-jetbrains-mono", "wmctrl", "x11-utils", "libnss3", "libxss1",
            "libasound2t64", "libgtk-3-0t64", "grub-pc-bin", "grub-efi-amd64-signed", "shim-signed", "efibootmgr"}
    assert need <= pk


def test_layer_chain_and_lowerdir(sh):
    r = sh("layer_chain minimal.standard.live; overlay_lowerdir /m minimal.standard.live")
    lines = r.stdout.split("\n")
    assert lines[:3] == ["minimal.standard.live", "minimal.standard", "minimal"]
    assert lines[3] == "/m/minimal.standard.live:/m/minimal.standard:/m/minimal"


def test_grub_cfg_rewrite_fixture(sh):
    r = sh(f"rewrite_grub_cfg < {UBUNTU / 'grub.cfg'} > $WORK_DIR.g; check_grub_cfg $WORK_DIR.g; cat $WORK_DIR.g")
    assert r.returncode == 0, r.stderr
    assert 'menuentry "Try or Install ClaudeOS"' in r.stdout
    assert "ClaudeOS (safe graphics)" in r.stdout
    assert "layerfs-path" not in r.stdout
    assert re.search(r'^\s*menuentry .*Ubuntu', r.stdout, re.M) is None


def test_grub_rewrites_existing_layerfs_path(sh):
    r = sh("echo 'linux /casper/vmlinuz layerfs-path=minimal.standard.live.squashfs --- quiet splash' | rewrite_grub_cfg")
    assert "layerfs-path=filesystem.squashfs" in r.stdout


def test_loopback_cfg_check(sh):
    r = sh(f"rewrite_grub_cfg < {UBUNTU / 'loopback.cfg'}")
    assert "Ubuntu" not in "".join(ln for ln in r.stdout.splitlines() if "menuentry" in ln)


def test_disk_info(sh):
    stock = UBUNTU / "disk-info"
    r = sh(f"c=$(disk_info_codename {stock}); disk_info_line 26.04.1 \"$c\" $(SOURCE_DATE_EPOCH=1700000000 build_date)")
    assert r.stdout == 'ClaudeOS 26.04.1 "Resolute Raccoon" - Release amd64 (20231114)'


def test_generate_md5sum(sh, tmp_path):
    tree = tmp_path / "t"
    (tree / "d").mkdir(parents=True)
    (tree / "d" / "b").write_text("b")
    (tree / "a").write_text("a")
    (tree / "boot.catalog").write_text("x")
    assert sh(f"generate_md5sum {tree}").returncode == 0
    lines = (tree / "md5sum.txt").read_text().splitlines()
    assert [ln.split("  ")[1] for ln in lines] == ["./a", "./d/b"]
    assert lines[0].startswith("0cc175b9c0f1b6a831c399e269772661  ")


def test_mksquashfs_args(sh):
    z = sh("mksquashfs_args /r /o.sq | tr '\\0' ' '").stdout
    assert "-comp zstd" in z
    x = sh("SQUASHFS_COMP=xz; mksquashfs_args /r /o | tr '\\0' ' '").stdout
    assert "-comp xz" in x
    assert sh("SQUASHFS_COMP=gzip; mksquashfs_args /r /o").returncode != 0


def test_validate_manifest(sh, tmp_path):
    good = tmp_path / "g"
    good.write_text("bash\t5.2\nlibc6:amd64\t2.40-1ubuntu1\n")
    bad = tmp_path / "b"
    bad.write_text("bash 5.2\n")
    assert sh(f"validate_manifest {good}").stdout.strip() == "2"
    assert sh(f"validate_manifest {bad}").returncode != 0
    diff = (UBUNTU / "minimal.standard.live.manifest").read_text().splitlines()
    real = tmp_path / "real"
    real.write_text("\n".join(x[1:] for x in diff if x.startswith("+") and not x.startswith(("+++", "+snap:"))) + "\n")
    assert sh(f"validate_manifest {real}").returncode == 0


def test_xorriso_repack_args(sh):
    r = sh("REPACK_CHANGED_FILES=(boot/grub/grub.cfg md5sum.txt); xorriso_repack_args o.iso /t out.iso 'ClaudeOS 26.04.1 amd64'")
    args = r.stdout.split("\0")
    assert "-boot_image" in args and args[args.index("-boot_image") + 1:][:2] == ["any", "replay"]
    assert "ClaudeOS 26.04.1 amd64" in args and "-commit" in args


def test_boot_report_parser(sh):
    d = FIXTURES / "xorriso"
    cases = {"bios-efi": 0, "bios-mbr-esp": 0, "bios-only": 1, "efi-only": 1, "no-boot": 1}
    for name, rc in cases.items():
        r = sh(f"verify_boot_report < {d / ('report-' + name + '.txt')}")
        assert r.returncode == rc, (name, r.stdout)

