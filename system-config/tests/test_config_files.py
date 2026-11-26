"""Static integration files: dconf, desktop entries, systemd unit, udev, os-release, packaging."""

from __future__ import annotations

import configparser
import os
import re
import shutil
import subprocess

import pytest
from conftest import BASE, LIB


def keyfile(path):
    cp = configparser.ConfigParser(strict=True, interpolation=None)
    cp.optionxform = str
    cp.read(path, encoding="utf-8")
    return cp


def test_dconf_keybinding():
    cp = keyfile(BASE / "etc/dconf/db/claudeos.d/20-claudeos-keybindings")
    base = "org/gnome/settings-daemon/plugins/media-keys"
    path = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/claudeos-panel/"
    assert cp[base]["custom-keybindings"] == f"['{path}']"
    sec = cp[f"{base}/custom-keybindings/claudeos-panel"]
    assert sec["name"] == "'Toggle Claude panel'"
    assert sec["command"] == "'claudeos-panel toggle'"
    assert sec["binding"] == "'<Super>c'"


def test_dconf_profile():
    lines = (BASE / "etc/dconf/profile/user").read_text().split()
    assert lines == ["user-db:user", "system-db:claudeos", "system-db:local", "system-db:site"]


@pytest.mark.parametrize("name,exe", [
    ("claudeos-panel", "claudeos-panel --background"),
    ("claudeos-session-init", "/usr/lib/claudeos/claudeos-session-init"),
    ("claudeos-firstboot", "/usr/lib/claudeos/claudeos-firstboot"),
])
def test_desktop_entries(name, exe):
    cp = keyfile(BASE / f"etc/xdg/autostart/{name}.desktop")
    d = cp["Desktop Entry"]
    assert d["Type"] == "Application" and d["Name"] and d["Exec"] == exe
    assert d["OnlyShowIn"] == "GNOME;"
    assert d["X-GNOME-Autostart-Delay"].isdigit()
    if exe.startswith("/usr/lib/claudeos/"):
        assert (LIB / exe.rsplit("/", 1)[1]).exists()
    if shutil.which("desktop-file-validate"):
        subprocess.run(["desktop-file-validate", str(BASE / f"etc/xdg/autostart/{name}.desktop")], check=True)


def test_ydotoold_unit():
    cp = keyfile(BASE / "usr/lib/systemd/user/ydotoold.service")
    svc = cp["Service"]
    assert svc["ExecStart"] == "/usr/bin/ydotoold --socket-path=%t/.ydotool_socket --socket-perm=0600"
    assert svc["Restart"] == "on-failure" and cp["Install"]["WantedBy"] == "default.target"
    assert cp["Unit"]["StartLimitIntervalSec"] == "0"


def test_environment_d_matches_socket():
    text = (BASE / "etc/environment.d/60-claudeos.conf").read_text()
    assert "%t" not in re.sub(r"#.*", "", text)  # specifiers are not expanded here
    assert "YDOTOOL_SOCKET=${XDG_RUNTIME_DIR}/.ydotool_socket" in text


def test_udev_and_modules():
    rule = (BASE / "usr/lib/udev/rules.d/60-claudeos-uinput.rules").read_text()
    rules = [x for x in rule.splitlines() if x and not x.startswith("#")]
    assert len(rules) == 1
    for tok in ('KERNEL=="uinput"', 'TAG+="uaccess"', 'OPTIONS+="static_node=uinput"', 'GROUP="input"', 'MODE="0660"'):
        assert tok in rules[0]
    assert all(re.fullmatch(r'[A-Za-z_{}]+(==|=|\+=)"[^"]*"', t.strip()) for t in rules[0].split(","))
    assert (BASE / "usr/lib/modules-load.d/claudeos-uinput.conf").read_text().strip() == "uinput"


def test_skel_stamp():
    assert (BASE / "etc/skel/.config/gnome-initial-setup-done").read_text().strip() == "yes"


def test_os_release_template():
    kv = dict(
        line.split("=", 1) for line in (BASE / "usr/share/claudeos/branding/os-release.claudeos").read_text().splitlines()
    )
    unq = {k: v.strip('"') for k, v in kv.items()}
    assert unq["ID"] == "ubuntu" and unq["ID_LIKE"] == "debian"
    assert unq["NAME"] == "ClaudeOS" and unq["VERSION_ID"] == "26.04.1"
    assert unq["PRETTY_NAME"] == "ClaudeOS 26.04.1 (Ubuntu 26.04.1 LTS)"
    assert unq["CLAUDEOS_BASE"] == "ubuntu-26.04.1"
    for k in ("HOME_URL", "SUPPORT_URL", "BUG_REPORT_URL"):
        assert unq[k].startswith("https://github.com/themagiccard292-cmd/ClaudeOS")


def test_package_meta_and_debian_scripts():
    meta = dict(re.findall(r'^(\w+)="(.*)"$', (BASE / "package.meta").read_text(), re.M))
    assert meta["PKG_NAME"] == "claudeos-core"
    for dep in ("nodejs (>= 22)", "npm", "python3", "dconf-cli", "jq", "curl", "claudeos-computer-control"):
        assert dep in meta["PKG_DEPENDS"]
    for n in ("postinst", "prerm", "postrm"):
        p = BASE / "debian" / n
        assert os.access(p, os.X_OK)
        assert p.read_text().rstrip().endswith("exit 0")


def test_shellcheck_all():
    if not shutil.which("shellcheck"):
        pytest.skip("shellcheck missing")
    files = [str(p) for p in [*LIB.glob("*.sh"), LIB / "claudeos-firstboot", *(BASE / "usr/bin").glob("*"),
                              *(BASE / "debian").glob("*")]]
    subprocess.run(["shellcheck", *files], check=True)


def test_ruff_python_scripts():
    if not shutil.which("ruff"):
        pytest.skip("ruff missing")
    subprocess.run(["ruff", "check", "--config", str(BASE.parent / "ruff.toml"),
                    str(LIB / "claudeos-doctor"), str(LIB / "claudeos-session-init")], check=True)


def test_make_install_modes(tmp_path):
    subprocess.run(["make", "-C", str(BASE), "install", f"DESTDIR={tmp_path}"], check=True, capture_output=True)
    def mode(p):
        return oct((tmp_path / p).stat().st_mode & 0o777)
    assert mode("usr/bin/claudeos-login") == "0o755"
    assert mode("usr/lib/claudeos/claudeos-doctor") == "0o755"
    assert mode("etc/claude-code/managed-settings.json") == "0o644"
    assert mode("etc/skel/.config/gnome-initial-setup-done") == "0o644"
    assert (tmp_path / "usr/lib/systemd/user/ydotoold.service").exists()
