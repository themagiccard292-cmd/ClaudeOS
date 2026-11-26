"""package.meta, maintainer scripts and the install target."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


def test_package_meta(root):
    meta = (root / "package.meta").read_text(encoding="utf-8")
    assert 'PKG_NAME="claudeos-theme"' in meta
    for dep in ("librsvg2-common", "libglib2.0-bin", "fonts-jetbrains-mono", "fonts-inter"):
        assert dep in meta.split("PKG_RECOMMENDS")[0]
    assert "yaru-theme-gnome-shell" in meta


def test_maintainer_scripts_executable_and_exit_zero(root):
    for name in ("postinst", "postrm"):
        path = root / "debian" / name
        assert os.access(path, os.X_OK)
        assert path.read_text(encoding="utf-8").rstrip().endswith("exit 0")


def test_install_stages_expected_tree(root, tmp_path):
    subprocess.run(["make", "-C", str(root), "install", f"DESTDIR={tmp_path}"], check=True, capture_output=True)
    expected = [
        "usr/share/backgrounds/claudeos/claudeos-light.png",
        "usr/share/backgrounds/claudeos/claudeos-dark.svg",
        "usr/share/gnome-background-properties/claudeos.xml",
        "usr/share/glib-2.0/schemas/90_claudeos.gschema.override",
        "usr/share/claudeos/theme/tokens.json",
        "usr/share/claudeos/theme/gtk-4.0/gtk.css",
        "usr/lib/claudeos/theme-apply",
        "etc/skel/.config/gtk-3.0/gtk.css",
        "etc/skel/.config/gtk-4.0/gtk.css",
        "usr/share/icons/hicolor/scalable/apps/claudeos-panel.svg",
        "usr/share/icons/hicolor/symbolic/apps/claudeos-panel-symbolic.svg",
        "usr/share/icons/hicolor/256x256/apps/claudeos-installer.png",
    ]
    for rel in expected:
        assert (Path(tmp_path) / rel).is_file(), rel
    assert os.access(tmp_path / "usr/lib/claudeos/theme-apply", os.X_OK)
