"""Offline static checks of the ClaudeOS Calamares configuration."""

import re
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
MODULES = ROOT / "etc/calamares/modules"
BRANDING = ROOT / "usr/share/calamares/branding/claudeos"
SCRIPTS = [
    ROOT / "usr/lib/claudeos/calamares/postinstall.sh",
    ROOT / "usr/lib/claudeos/calamares/launch-installer",
    ROOT / "debian/postinst",
]

# Allowed top-level keys per module (Calamares 3.3.14 sample configs, schema.yaml files, source).
KEYS = {
    "welcome": {"showSupportUrl", "showKnownIssuesUrl", "showReleaseNotesUrl", "showDonateUrl",
                "requirements", "geoip", "languageIcon"},
    "locale": {"region", "zone", "useSystemTimezone", "adjustLiveTimezone", "localeGenPath", "geoip"},
    "partition": {"efi", "efiSystemPartition", "efiSystemPartitionSize", "efiSystemPartitionName",
                  "userSwapChoices", "swapPartitionName", "luksGeneration", "allowZfsEncryption",
                  "drawNestedPartitions", "alwaysShowPartitionLabels", "allowManualPartitioning",
                  "showNotEncryptedBootMessage", "initialPartitioningChoice", "initialSwapChoice",
                  "armInstall", "defaultPartitionTableType", "createHybridBootloaderLayout",
                  "requiredPartitionTableType", "defaultFileSystemType", "availableFileSystemTypes",
                  "directoryFilesystemRestrictions", "essentialMounts",
                  "enableLuksAutomatedPartitioning", "preCheckEncryption", "lvm", "partitionLayout",
                  "requiredStorage"},
    "users": {"defaultGroups", "sudoersGroup", "autologinGroup", "sudoersConfigureWithGroup",
              "setRootPassword", "doReusePassword", "displayAutologin", "doAutologin",
              "passwordRequirements", "allowWeakPasswords", "allowWeakPasswordsDefault", "user",
              "hostname", "allowActiveDirectory", "presets"},
    "unpackfs": {"unpack"},
    "mount": {"extraMounts", "btrfsSubvolumes", "btrfsSwapSubvol", "mountOptions"},
    "fstab": {"crypttabOptions", "tmpOptions"},
    "machineid": {"systemd", "systemd-style", "dbus", "dbus-symlink", "entropy-copy", "entropy-files"},
    "initramfs": {"kernel", "be_unsafe"},
    "grubcfg": {"overwrite", "prefer_grub_d", "keep_distributor", "kernel_params", "defaults",
                "always_use_defaults"},
    "bootloader": {"efiBootLoaderVar", "efiBootLoader", "kernelSearchPath", "kernelName", "kernelParams",
                   "kernelPattern", "loaderEntries", "refindKernelList", "grubInstall", "grubMkconfig",
                   "grubCfg", "grubProbe", "efiBootMgr", "efiBootloaderId", "installEFIFallback"},
    "displaymanager": {"displaymanagers", "defaultDesktopEnvironment", "basicSetup", "sysconfigSetup",
                       "greetd", "lightdm", "sddm"},
    "services-systemd": {"units"},
    "finished": {"restartNowMode", "restartNowCommand", "notifyOnFinished"},
    "umount": {"emergency"},
    "shellprocess": {"dontChroot", "timeout", "verbose", "script", "i18n"},
}
# Modules with `noconfig: true` upstream: no .conf file must exist for them.
NOCONFIG = {"localecfg", "hwclock", "networkcfg", "summary"}


def load(path):
    return yaml.safe_load(path.read_text())


SETTINGS = load(ROOT / "etc/calamares/settings.conf")


def flat(phase):
    return [m for s in SETTINGS["sequence"] if phase in s for m in s[phase]]


def instance_conf(key):
    name, _, inst = key.partition("@")
    if not inst:
        return name, f"{name}.conf"
    for i in SETTINGS["instances"]:
        if i["module"] == name and i["id"] == inst:
            return name, i["config"]
    raise AssertionError(f"unresolved instance {key}")


def test_all_yaml_parses():
    files = list((ROOT / "etc").rglob("*.conf")) + [BRANDING / "branding.desc"]
    assert len(files) > 15
    for f in files:
        assert isinstance(load(f), dict), f


def test_sequence_invariants():
    show, exe = flat("show"), flat("exec")
    assert SETTINGS["sequence"][0]["show"][0] == "welcome"
    assert SETTINGS["sequence"][0]["show"] == ["welcome", "locale", "partition", "users", "summary"]
    assert SETTINGS["sequence"][-1] == {"show": ["finished"]}
    assert "keyboard" not in show + exe and "packagechooser" not in show
    idx = exe.index
    assert idx("partition") < idx("mount") < idx("unpackfs") < idx("users")
    assert idx("initramfs") < idx("bootloader") < idx("shellprocess@postinstall") < idx("umount")
    assert idx("shellprocess@preinstall") < idx("initramfs")
    assert idx("grubcfg") < idx("bootloader")
    assert exe[-1] == "umount"
    assert SETTINGS["branding"] == "claudeos" and (BRANDING / "branding.desc").exists()
    for k, v in {"prompt-install": False, "dont-chroot": False, "oem-setup": False,
                 "disable-cancel": False, "disable-cancel-during-exec": True}.items():
        assert SETTINGS[k] is v
    assert SETTINGS["modules-search"] == ["local"]


def test_every_module_has_conf_and_known_keys():
    used = {m for m in flat("show") + flat("exec")}
    for key in used:
        name, conf = instance_conf(key)
        base = name
        if name in NOCONFIG:
            assert not (MODULES / f"{name}.conf").exists()
            continue
        if base in {"partition", "unpackfs", "mount", "fstab", "machineid", "initramfs", "grubcfg",
                    "bootloader", "displaymanager", "services-systemd", "finished", "umount",
                    "welcome", "locale", "users", "shellprocess"}:
            assert (MODULES / conf).exists(), conf
            data = load(MODULES / conf)
            unknown = set(data) - KEYS[base]
            assert not unknown, f"{conf}: unknown keys {unknown}"
        else:
            pytest.fail(f"module {name} has no key table")


def test_unpackfs_source():
    (u,) = load(MODULES / "unpackfs.conf")["unpack"]
    assert u == {"source": "/cdrom/casper/filesystem.squashfs", "sourcefs": "squashfs", "destination": ""}


def test_partition_defaults():
    p = load(MODULES / "partition.conf")
    assert p["initialPartitioningChoice"] == "erase"
    assert p["defaultFileSystemType"] == "ext4" and p["availableFileSystemTypes"] == ["ext4"]
    assert p["efi"]["mountPoint"] == "/boot/efi" and p["efi"]["recommendedSize"] == "512MiB"
    assert p["defaultPartitionTableType"] == "gpt"
    assert p["enableLuksAutomatedPartitioning"] is False and p["allowManualPartitioning"] is True
    assert p["initialSwapChoice"] in p["userSwapChoices"]
    w = load(MODULES / "welcome.conf")
    assert w["requirements"]["requiredStorage"] >= 15 and w["requirements"]["requiredRam"] >= 2
    assert not any(w[k] for k in w if k.startswith("show"))
    assert "power" not in w["requirements"]["check"] and "internet" not in w["requirements"]["check"]


def test_users():
    u = load(MODULES / "users.conf")
    names = {g if isinstance(g, str) else g["name"] for g in u["defaultGroups"]}
    assert names <= {"adm", "cdrom", "dip", "lpadmin", "plugdev", "sambashare", "sudo"}
    assert u["sudoersGroup"] == "sudo" and "sudo" in names
    assert u["doAutologin"] is False and u["setRootPassword"] is False
    assert u["allowWeakPasswords"] is False and u["user"]["shell"] == "/bin/bash"
    assert u["hostname"]["template"] == "claudeos" and "ubuntu" in u["user"]["forbidden_names"]


def test_bootloader_and_finished():
    b = load(MODULES / "bootloader.conf")
    assert b["efiBootLoader"] == "grub" and b["efiBootloaderId"] == "ubuntu"
    assert b["grubCfg"] == "/boot/grub/grub.cfg" and b["installEFIFallback"] is True
    f = load(MODULES / "finished.conf")
    assert f["restartNowMode"] == "user-checked" and f["restartNowCommand"] == "systemctl reboot"
    assert load(MODULES / "initramfs.conf")["kernel"] == "all"


def test_shellprocess_instances():
    for inst in ("preinstall", "postinstall"):
        d = load(MODULES / f"shellprocess_{inst}.conf")
        assert d["dontChroot"] is False
        cmd = d["script"][0]["command"]
        assert cmd.startswith("/usr/lib/claudeos/calamares/postinstall.sh ")
    assert load(MODULES / "shellprocess_postinstall.conf")["timeout"] == 600


def test_branding_desc():
    d = load(BRANDING / "branding.desc")
    assert d["componentName"] == BRANDING.name
    s = d["strings"]
    assert s["productName"] == "ClaudeOS" and s["versionedName"] == "ClaudeOS 26.04.1"
    assert all(s[k].startswith("https://github.com/themagiccard292-cmd/ClaudeOS")
               for k in ("productUrl", "supportUrl", "knownIssuesUrl", "releaseNotesUrl"))
    assert d["slideshowAPI"] == 2 and (BRANDING / d["slideshow"]).exists()
    for img in d["images"].values():
        assert (BRANDING / img).stat().st_size < 30_000
    assert d["style"] == {"SidebarBackground": "#262624", "SidebarText": "#F5F4EF",
                          "SidebarTextCurrent": "#D97757", "SidebarBackgroundCurrent": "#383835"}


def test_qml_sanity():
    for q in BRANDING.glob("*.qml"):
        t = q.read_text()
        assert t.count("{") == t.count("}"), q
        assert "import QtQuick" in t
        assert "http://" not in t and "https://" not in t
    show = (BRANDING / "show.qml").read_text()
    assert "import calamares.slideshow 1.0" in show and "function onActivate" in show
    assert show.count("Slide {") == 5
    assert (BRANDING / "logo.svg").read_text().count("#D97757") == 1


def parse_desktop(p):
    lines = p.read_text().splitlines()
    assert lines[0] == "[Desktop Entry]"
    kv = dict(line.split("=", 1) for line in lines[1:] if "=" in line)
    for req in ("Type", "Name", "Exec"):
        assert req in kv
    return kv


def test_desktop_files():
    a = parse_desktop(ROOT / "etc/xdg/autostart/claudeos-installer.desktop")
    assert a["Exec"] == "/usr/lib/claudeos/calamares/launch-installer"
    assert a["OnlyShowIn"] == "GNOME;" and a["X-GNOME-Autostart-Delay"] == "3"
    i = parse_desktop(ROOT / "usr/share/applications/claudeos-install.desktop")
    assert i["Name"] == "Install ClaudeOS" and i["Exec"].endswith("launch-installer --force")
    assert (ROOT / "usr/share/icons/hicolor/scalable/apps" / f"{i['Icon']}.svg").exists()


def test_shellcheck_and_exec_bits():
    for s in SCRIPTS:
        assert s.stat().st_mode & 0o111, s
    subprocess.run(["shellcheck", *map(str, SCRIPTS)], check=True)


def test_package_meta():
    meta = dict(re.findall(r'^(\w+)="(.*)"$', (ROOT / "package.meta").read_text(), re.M))
    assert meta["PKG_NAME"] == "claudeos-calamares" and meta["PKG_ARCH"] == "all"
    for dep in ("calamares", "x11-xserver-utils", "rsync", "squashfs-tools", "qml6-module-qtquick"):
        assert dep in meta["PKG_DEPENDS"]
