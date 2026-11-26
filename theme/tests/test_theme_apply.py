"""theme-apply behaviour against a temporary HOME and theme dir."""

from __future__ import annotations

import os
import subprocess

import pytest


@pytest.fixture
def env(root, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    theme = tmp_path / "theme"
    for v in ("3.0", "4.0"):
        (theme / f"gtk-{v}").mkdir(parents=True)
        (theme / f"gtk-{v}/gtk.css").write_bytes((root / f"etc/skel/.config/gtk-{v}/gtk.css").read_bytes())
    e = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "CLAUDEOS_THEME_DIR": str(theme),
        "XDG_CONFIG_HOME": str(home / ".config"),
    }
    return e, home, root / "usr/lib/claudeos/theme-apply"


def run(script, e, *args):
    return subprocess.run([str(script), *args], env=e, capture_output=True, text=True, check=False)


def test_fresh_install_then_idempotent(env):
    e, home, script = env
    first = run(script, e)
    assert first.returncode == 0
    for v in ("3.0", "4.0"):
        assert (home / f".config/gtk-{v}/gtk.css").is_file()
    second = run(script, e)
    assert second.returncode == 0 and second.stdout == ""


def test_dry_run_changes_nothing(env):
    e, home, script = env
    out = run(script, e, "--dry-run")
    assert "install" in out.stdout
    assert not (home / ".config").exists()


def test_user_file_is_backed_up(env):
    e, home, script = env
    css = home / ".config/gtk-4.0/gtk.css"
    css.parent.mkdir(parents=True)
    css.write_text("/* mine */\n")
    assert run(script, e).returncode == 0
    backups = list(css.parent.glob("gtk.css.claudeos-bak-*"))
    assert len(backups) == 1 and backups[0].read_text() == "/* mine */\n"
    assert css.read_text().startswith("/* claudeos-theme:managed")


def test_no_clobber_keeps_user_file(env):
    e, home, script = env
    css = home / ".config/gtk-4.0/gtk.css"
    css.parent.mkdir(parents=True)
    css.write_text("/* mine */\n")
    out = run(script, e, "--no-clobber")
    assert "skip" in out.stdout
    assert css.read_text() == "/* mine */\n"
    assert not list(css.parent.glob("*.claudeos-bak-*"))


def test_pristine_older_file_replaced_without_backup(env, root):
    e, home, script = env
    import hashlib

    body = "@define-color accent_bg_color #000000;\n"
    old = f"/* claudeos-theme:managed sha256={hashlib.sha256(body.encode()).hexdigest()} */\n{body}"
    css = home / ".config/gtk-4.0/gtk.css"
    css.parent.mkdir(parents=True)
    css.write_text(old)
    assert run(script, e).returncode == 0
    assert not list(css.parent.glob("*.claudeos-bak-*"))
    assert "D97757" in css.read_text()


def test_missing_theme_dir_fails(env):
    e, _, script = env
    e["CLAUDEOS_THEME_DIR"] = "/nonexistent"
    assert run(script, e).returncode == 1
