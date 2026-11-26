"""Behaviour tests of postinstall.sh and launch-installer using a fake root and fake tools."""

import os
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
POST = ROOT / "usr/lib/claudeos/calamares/postinstall.sh"
LAUNCH = ROOT / "usr/lib/claudeos/calamares/launch-installer"


def fake_tool(bindir, name, body=""):
    p = bindir / name
    p.write_text(f'#!/usr/bin/env bash\necho "{name} $*" >> "$FAKE_LOG"\n{body}\n')
    p.chmod(p.stat().st_mode | stat.S_IEXEC)


@pytest.fixture
def env(tmp_path):
    root, bindir = tmp_path / "root", tmp_path / "bin"
    bindir.mkdir()
    for d in ("boot/grub", "etc/default", "etc/skel", "etc/xdg/autostart", "usr/share/applications",
              "cdrom/.disk", "cdrom/casper", "proc", "var/log", "boot/efi/EFI/ubuntu"):
        (root / d).mkdir(parents=True)
    (root / "boot/vmlinuz-7.0.0-30-generic").write_text("k")
    (root / "boot/initrd.img-7.0.0-30-generic").write_text("i")
    (root / "boot/grub/grub.cfg").write_text("cfg")
    (root / "etc/default/locale").write_text("LANG=de_DE.UTF-8\n")
    (root / "etc/default/keyboard").write_text('XKBLAYOUT="us"\nXKBVARIANT=""\n')
    (root / "etc/xdg/autostart/claudeos-installer.desktop").write_text("x")
    (root / "usr/share/applications/claudeos-install.desktop").write_text("x")
    (root / "cdrom/.disk/info").write_text('ClaudeOS 26.04.1 "Resolute Raccoon"\n')
    (root / "cdrom/casper/filesystem.squashfs").write_text("s")
    (root / "proc/cmdline").write_text("quiet boot=casper splash\n")
    log = tmp_path / "log"
    log.write_text("")
    fake_tool(bindir, "apt-get")
    fake_tool(bindir, "apt-mark")
    fake_tool(bindir, "update-initramfs")
    fake_tool(bindir, "userdel")
    fake_tool(bindir, "dpkg-query",
              'case "$*" in *claudeos-*) printf "claudeos-core\\nclaudeos-calamares\\n";; '
              '*casper*|*calamares*) echo ii;; esac')
    (bindir / "id").write_text("#!/usr/bin/env bash\necho 1000\n")  # run as the live user, not root
    (bindir / "id").chmod(0o755)
    fake_tool(bindir, "xhost")
    fake_tool(bindir, "pkexec")
    e = {**os.environ, "PATH": f"{bindir}:{os.environ['PATH']}", "CLAUDEOS_ROOT": str(root),
         "FAKE_LOG": str(log)}
    e.pop("CLAUDEOS_INSTALLER_DEBUG", None)
    return root, e, log


def run(script, e, *args):
    return subprocess.run([str(script), *args], env=e, capture_output=True, text=True)


def test_prepare_purges_and_protects(env):
    root, e, log = env
    r = run(POST, e, "prepare")
    assert r.returncode == 0, r.stderr
    cmds = log.read_text()
    assert "apt-get -y purge --no-autoremove" in cmds
    assert "apt-mark manual claudeos-core" in cmds and "manual claudeos-core claudeos-calamares" not in cmds
    assert not (root / "etc/xdg/autostart/claudeos-installer.desktop").exists()
    assert not (root / "usr/share/applications/claudeos-install.desktop").exists()


def test_prepare_copies_live_kernel_when_missing(env):
    root, e, _ = env
    for f in (root / "boot").glob("vmlinuz-*"):
        f.unlink()
    (root / "cdrom/casper/vmlinuz").write_text("live")
    assert run(POST, e, "prepare").returncode == 0
    assert list((root / "boot").glob("vmlinuz-*"))
    assert list((root / "boot").glob("initrd.img-*"))


def test_finalize_outputs_and_idempotent(env):
    root, e, log = env
    shim = root / "boot/efi/EFI/ubuntu/shimx64.efi"
    shim.write_text("shim")
    for _ in range(2):
        r = run(POST, e, "finalize")
        assert r.returncode == 0, r.stderr
    assert (root / "etc/skel/.config/gnome-initial-setup-done").exists()
    assert 'XKBLAYOUT="de"' in (root / "etc/default/keyboard").read_text()
    info = (root / "etc/claudeos-install-info").read_text()
    assert "install_date=" in info and "ClaudeOS 26.04.1" in info
    assert (root / "boot/efi/EFI/BOOT/BOOTX64.EFI").read_text() == "shim"
    assert "update-initramfs" not in log.read_text()
    assert (root / "var/log/claudeos-postinstall.log").exists()


def test_finalize_generates_missing_initrd(env):
    root, e, log = env
    (root / "boot/initrd.img-7.0.0-30-generic").write_text("")
    assert run(POST, e, "finalize").returncode == 0
    assert "update-initramfs -c -k 7.0.0-30-generic" in log.read_text()


def test_finalize_fails_only_when_unbootable(env):
    root, e, _ = env
    (root / "boot/grub/grub.cfg").unlink()
    assert run(POST, e, "finalize").returncode == 1


def test_non_critical_purge_failure_tolerated(env, tmp_path):
    root, e, _ = env
    fake_tool(Path(e["PATH"].split(":")[0]), "apt-get", "exit 100")
    assert run(POST, e, "prepare").returncode == 0


def test_leftover_ubuntu_user_removed_only_with_other_user(env):
    root, e, log = env
    (root / "etc/passwd").write_text("ubuntu:x:1000:1000::/home/ubuntu:/bin/bash\n")
    run(POST, e, "prepare")
    assert "userdel" not in log.read_text()
    (root / "etc/passwd").write_text(
        "ubuntu:x:1000:1000::/h:/bin/bash\nalice:x:1001:1001::/home/alice:/bin/bash\n")
    run(POST, e, "prepare")
    assert "userdel --remove ubuntu" in log.read_text()


@pytest.mark.parametrize("lang,layout", [("en_US.UTF-8", "us"), ("en_GB.UTF-8", "gb"), ("fr_FR.UTF-8", "fr"),
                                        ("sv_SE.UTF-8", "se"), ("pt_BR.UTF-8", "br")])
def test_keyboard_from_locale(env, lang, layout):
    root, e, _ = env
    (root / "etc/default/locale").write_text(f"LANG={lang}\n")
    assert run(POST, e, "finalize").returncode == 0
    assert f'XKBLAYOUT="{layout}"' in (root / "etc/default/keyboard").read_text()


def test_usage_error(env):
    assert run(POST, env[1], "bogus").returncode == 2


def test_launcher_not_live_is_silent(env):
    root, e, log = env
    (root / "proc/cmdline").write_text("quiet splash\n")
    r = run(LAUNCH, e)
    assert (r.returncode, r.stdout, r.stderr) == (0, "", "")
    assert "pkexec" not in log.read_text()


def test_launcher_no_squashfs_is_silent(env):
    root, e, log = env
    (root / "cdrom/casper/filesystem.squashfs").unlink()
    assert run(LAUNCH, e, "--force").returncode == 0
    assert "pkexec" not in log.read_text()


def test_launcher_runs_pkexec(env):
    _, e, log = env
    e = {**e, "DISPLAY": ":1", "XAUTHORITY": "/tmp/xa", "XDG_RUNTIME_DIR": "/run/user/1000"}
    assert run(LAUNCH, e).returncode == 0
    t = log.read_text()
    assert "xhost +si:localuser:root" in t
    line = next(x for x in t.splitlines() if x.startswith("pkexec"))
    assert "env DISPLAY=:1 XAUTHORITY=/tmp/xa XDG_RUNTIME_DIR=/run/user/1000 QT_QPA_PLATFORM=xcb calamares" in line
    assert line.endswith("calamares")


def test_launcher_debug_and_force(env):
    root, e, log = env
    (root / "proc/cmdline").write_text("quiet\n")
    assert run(LAUNCH, {**e, "CLAUDEOS_INSTALLER_DEBUG": "1"}, "--force").returncode == 0
    assert next(x for x in log.read_text().splitlines() if x.startswith("pkexec")).endswith("calamares -d")
