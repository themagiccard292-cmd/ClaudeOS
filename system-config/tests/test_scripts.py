"""Behaviour of doctor, firstboot, session-init, installer, update, login, branding."""

from __future__ import annotations

import json
import os
import socket
import subprocess

import pytest
from conftest import BASE, LIB, fake_claude, load_script, run, write_exe

DOCTOR = LIB / "claudeos-doctor"


def doctor(env, *args, root=None):
    e = dict(env)
    if root is not None:
        e["CLAUDEOS_ROOT"] = str(root)
    return run(["python3", DOCTOR, *args], e)


def make_root(tmp_path):
    root = tmp_path / "root"
    (root / "etc/claude-code").mkdir(parents=True)
    (root / "etc/claude-code/managed-settings.json").write_text('{"forceLoginMethod": "claudeai"}')
    (root / "dev").mkdir()
    (root / "dev/uinput").write_text("")
    write_exe(root / "usr/bin/claudeos-computer-control-mcp", "true")
    write_exe(root / "opt/claudeos/venv/bin/python", "exit 0")
    (root / "etc/claudeos").mkdir()
    (root / "etc/claudeos/mcp.json").write_text("{}")
    write_exe(root / "usr/bin/claudeos-panel", "true")
    write_exe(root / "opt/claudeos/panel/claudeos-panel-app", "true")
    (root / "etc/dconf/db/claudeos.d").mkdir(parents=True)
    (root / "etc/dconf/db/claudeos.d/20-claudeos-keybindings").write_text("x")
    return root


@pytest.fixture
def healthy(tmp_path, clean_env, fakebin):
    root = make_root(tmp_path)
    fake_claude(fakebin, tmp_path / "claude.log")
    write_exe(fakebin / "node", 'echo v22.1.0')
    write_exe(fakebin / "gnome-screenshot", "true")
    write_exe(fakebin / "gsettings", (
        'case "$*" in\n'
        '  *custom-keybindings) echo "[\'/x/claudeos-panel/\']" ;;\n'
        '  *" binding") echo "\'<Super>c\'" ;;\n'
        '  *" command") echo "\'claudeos-panel toggle\'" ;;\n'
        'esac'))
    sock_path = tmp_path / "run/.ydotool_socket"
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    srv.bind(str(sock_path))
    env = dict(clean_env, XDG_SESSION_TYPE="wayland", YDOTOOL_SOCKET=str(sock_path))
    yield env, root
    srv.close()


def checks_by_id(proc):
    return {c["id"]: c for c in json.loads(proc.stdout)["checks"]}


def test_doctor_all_ok(healthy):
    env, root = healthy
    proc = doctor(env, "--json", "--strict", root=root)
    assert proc.returncode == 0, proc.stdout
    data = json.loads(proc.stdout)
    assert data["ok"] is True
    for c in data["checks"]:
        assert set(c) == {"id", "label", "status", "detail", "fix"}
        assert c["status"] == "ok", c
    assert {c["id"] for c in data["checks"]} >= {
        "session", "node", "claude", "auth", "managed-settings", "uinput", "ydotoold",
        "screenshot", "mcp", "panel", "keybinding"}


def test_doctor_failures_and_strict(healthy, fakebin, tmp_path):
    env, root = healthy
    (root / "dev/uinput").chmod(0o444)
    (root / "etc/claude-code/managed-settings.json").write_text('{"forceLoginMethod": "console"}')
    write_exe(fakebin / "node", "echo v18.0.0")
    fake_claude(fakebin, tmp_path / "c.log", logged_in=False)
    env = dict(env, XDG_SESSION_TYPE="x11")
    proc = doctor(env, "--json", root=root)
    assert proc.returncode == 0  # not strict
    c = checks_by_id(proc)
    assert c["session"]["status"] == "warn"
    assert c["node"]["status"] == "fail" and c["node"]["fix"]
    assert c["auth"]["status"] == "fail" and "claudeos-login" in c["auth"]["fix"]
    assert c["managed-settings"]["status"] == "fail"
    if os.geteuid() != 0:  # root ignores file modes
        assert c["uinput"]["status"] == "fail"
    assert json.loads(proc.stdout)["ok"] is False
    assert doctor(env, "--strict", root=root).returncode == 1


def test_doctor_missing_everything_and_no_secrets(clean_env, tmp_path):
    env = dict(clean_env, ANTHROPIC_API_KEY="sk-secret-value")
    proc = doctor(env, "--json", root=tmp_path / "empty")
    c = checks_by_id(proc)
    assert c["claude"]["status"] == "fail"
    assert c["ydotoold"]["status"] == "fail"
    assert c["screenshot"]["status"] == "fail"
    assert "sk-secret-value" not in proc.stdout + proc.stderr


def test_doctor_stale_socket_warns(healthy, tmp_path):
    env, root = healthy
    stale = tmp_path / "stale.sock"
    s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    s.bind(str(stale))
    s.close()
    proc = doctor(dict(env, YDOTOOL_SOCKET=str(stale)), "--json", root=root)
    assert checks_by_id(proc)["ydotoold"]["status"] == "warn"


def test_doctor_text_output(healthy):
    env, root = healthy
    out = doctor(env, root=root).stdout
    assert "[OK  ]" in out and "All good." in out


def test_doctor_strips_provider_env_for_claude(healthy, tmp_path):
    env, root = healthy
    doctor(dict(env, ANTHROPIC_API_KEY="k"), "--json", root=root)
    assert "ANTHROPIC_API_KEY=unset" in (tmp_path / "claude.log").read_text()


# ---- firstboot -------------------------------------------------------------------------------

@pytest.fixture
def fb(tmp_path, clean_env, fakebin):
    log = tmp_path / "panel.log"
    write_exe(fakebin / "claudeos-panel", f'echo "$@" >> "{log}"')
    clog = tmp_path / "claude.log"
    env = dict(clean_env, CLAUDEOS_PROC_CMDLINE=str(tmp_path / "cmdline"), CLAUDEOS_CDROM=str(tmp_path / "cdrom"))
    (tmp_path / "cmdline").write_text("BOOT_IMAGE=/vmlinuz root=/dev/sda1 quiet splash")
    return env, log, clog, fakebin


def stamp(env):
    d = env["CLAUDEOS_CONFIG_DIR"]
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "onboarding-done"), "w").close()


@pytest.mark.parametrize("live", ["cmdline", "cdrom"])
def test_firstboot_live_session_exits(fb, tmp_path, live):
    env, log, clog, fakebin = fb
    fake_claude(fakebin, clog, logged_in=False)
    if live == "cmdline":
        (tmp_path / "cmdline").write_text("boot=casper quiet splash")
    else:
        (tmp_path / "cdrom/casper").mkdir(parents=True)
    assert run([LIB / "claudeos-firstboot"], env).returncode == 0
    assert not log.exists()


def test_firstboot_matrix(fb):
    env, log, clog, fakebin = fb
    fake_claude(fakebin, clog, logged_in=True)
    run([LIB / "claudeos-firstboot"], env)
    assert log.read_text().strip() == "onboarding"  # no stamp
    log.unlink()
    stamp(env)
    run([LIB / "claudeos-firstboot"], env)
    assert not log.exists()  # stamp + signed in
    fake_claude(fakebin, clog, logged_in=False)
    run([LIB / "claudeos-firstboot"], env)
    assert log.read_text().strip() == "onboarding"  # stamp but signed out


def test_firstboot_lock_prevents_double_launch(fb):
    env, log, clog, fakebin = fb
    fake_claude(fakebin, clog)
    import fcntl
    lock = open(os.path.join(env["XDG_RUNTIME_DIR"], "claudeos-firstboot.lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    assert run([LIB / "claudeos-firstboot"], env).returncode == 0
    assert not log.exists()
    lock.close()


# ---- session init ----------------------------------------------------------------------------

def test_session_init_idempotent(tmp_path, clean_env, fakebin):
    log = tmp_path / "claude.log"
    fake_claude(fakebin, log)
    cj = tmp_path / "home/.claude.json"
    env = dict(clean_env, CLAUDEOS_CLAUDE_JSON=str(cj))
    assert run([LIB / "claudeos-session-init"], env).returncode == 0
    assert (tmp_path / "home/.config/claudeos").is_dir()
    assert "mcp add --scope user claudeos-desktop -- /usr/bin/claudeos-computer-control-mcp" in log.read_text()
    log.unlink()
    cj.write_text(json.dumps({"mcpServers": {"claudeos-desktop": {"command": "/usr/bin/claudeos-computer-control-mcp"}}}))
    assert run([LIB / "claudeos-session-init"], env).returncode == 0
    assert not log.exists()  # already registered: claude is not even called


def test_session_init_replaces_stale_and_never_fails(tmp_path, clean_env, fakebin):
    log = tmp_path / "claude.log"
    fake_claude(fakebin, log)
    cj = tmp_path / "home/.claude.json"
    cj.write_text(json.dumps({"mcpServers": {"claudeos-desktop": {"command": "/old/path"}}}))
    env = dict(clean_env, CLAUDEOS_CLAUDE_JSON=str(cj))
    run([LIB / "claudeos-session-init"], env)
    text = log.read_text()
    assert "mcp remove --scope user claudeos-desktop" in text and "mcp add" in text
    write_exe(fakebin / "claude", "exit 1")
    cj.write_text("not json")
    assert run([LIB / "claudeos-session-init"], env).returncode == 0
    assert run([LIB / "claudeos-session-init"], {k: v for k, v in env.items() if k != "PATH"} | {"PATH": "/nonexistent"}).returncode == 0


# ---- installer / update / login --------------------------------------------------------------

def fake_npm(fakebin, prefix, fail=False, broken_claude=False):
    body = "exit 1" if fail else (
        f'mkdir -p "{prefix}/bin"\n'
        + ("printf '#!/bin/sh\\nexit 3\\n'" if broken_claude else "printf '#!/bin/sh\\necho \"2.1.332 (Claude Code)\"\\n'")
        + f' > "{prefix}/bin/claude"\nchmod +x "{prefix}/bin/claude"\necho "args: $*" > "{prefix}/args"\n'
        f'echo "prefix=$NPM_CONFIG_PREFIX" >> "{prefix}/args"')
    write_exe(fakebin / "npm", body)


def test_installer_success(tmp_path, clean_env, fakebin):
    prefix = tmp_path / "pfx"
    prefix.mkdir()
    write_exe(fakebin / "node", "echo v22.3.0")
    fake_npm(fakebin, prefix)
    env = dict(clean_env, CLAUDEOS_NPM_PREFIX=str(prefix), CLAUDE_CODE_VERSION="2.1.332")
    proc = run([LIB / "install-claude-code.sh"], env)
    assert proc.returncode == 0, proc.stderr
    args = (prefix / "args").read_text()
    assert "install -g --no-fund --no-audit @anthropic-ai/claude-code@2.1.332" in args
    assert f"prefix={prefix}" in args
    assert "2.1.332" in proc.stdout


def test_installer_failures(tmp_path, clean_env, fakebin):
    prefix = tmp_path / "pfx"
    prefix.mkdir()
    env = dict(clean_env, CLAUDEOS_NPM_PREFIX=str(prefix))
    write_exe(fakebin / "node", "echo v20.1.0")
    fake_npm(fakebin, prefix)
    old = run([LIB / "install-claude-code.sh"], env)
    assert old.returncode != 0 and "22" in old.stderr
    write_exe(fakebin / "node", "echo v22.1.0")
    fake_npm(fakebin, prefix, fail=True)
    assert run([LIB / "install-claude-code.sh"], env).returncode != 0
    fake_npm(fakebin, prefix, broken_claude=True)
    bad = run([LIB / "install-claude-code.sh"], env)
    assert bad.returncode != 0 and "--version" in bad.stderr
    (fakebin / "node").unlink()
    nonode = run([LIB / "install-claude-code.sh"], env)
    assert nonode.returncode != 0 and "node" in nonode.stderr


def test_update_prints_before_after(tmp_path, clean_env, fakebin):
    prefix = tmp_path / "pfx"
    write_exe(fakebin / "claude", 'echo "2.0.0 (Claude Code)"')
    inst = write_exe(tmp_path / "inst.sh", f'echo "$CLAUDE_CODE_VERSION" > "{tmp_path}/ver"\n'
                     f'printf \'#!/bin/sh\\necho "2.1.332 (Claude Code)"\\n\' > "{fakebin}/claude"')
    env = dict(clean_env, CLAUDEOS_ELEVATE="none", CLAUDEOS_INSTALL_SCRIPT=str(inst), HTTPS_PROXY="http://p:1")
    del prefix
    proc = run([BASE / "usr/bin/claudeos-update", "--version", "2.1.332"], env)
    assert proc.returncode == 0, proc.stderr
    assert "before: 2.0.0" in proc.stdout and "after:  2.1.332" in proc.stdout and "Updated." in proc.stdout
    assert (tmp_path / "ver").read_text().strip() == "2.1.332"


def test_login_no_api_key_wording_and_unsets_env(tmp_path, clean_env, fakebin):
    log = tmp_path / "c.log"
    fake_claude(fakebin, log)
    env = dict(clean_env, ANTHROPIC_API_KEY="sk-x", ANTHROPIC_AUTH_TOKEN="t", ANTHROPIC_BASE_URL="http://x")
    proc = run([BASE / "usr/bin/claudeos-login"], env)
    assert proc.returncode == 0
    out = (proc.stdout + proc.stderr).lower()
    assert "api key" not in out and "api_key" not in out and "sk-x" not in out
    text = log.read_text()
    assert "auth login --claudeai" in text and "auth status" in text
    assert "ANTHROPIC_API_KEY=unset" in text


# ---- branding --------------------------------------------------------------------------------

def test_apply_branding_idempotent_and_revert(tmp_path):
    root = tmp_path / "r"
    (root / "usr/lib").mkdir(parents=True)
    (root / "etc").mkdir()
    orig = 'NAME="Ubuntu"\nID=ubuntu\nPRETTY_NAME="Ubuntu 26.04.1 LTS"\n'
    (root / "usr/lib/os-release").write_text(orig)
    (root / "etc/os-release").symlink_to("../usr/lib/os-release")
    (root / "etc/lsb-release").write_text('DISTRIB_ID=Ubuntu\nDISTRIB_DESCRIPTION="Ubuntu 26.04.1 LTS"\nDISTRIB_CODENAME=resolute\n')
    env = dict(os.environ, ROOT=str(root), BRANDING_DIR=str(BASE / "usr/share/claudeos/branding"))
    script = LIB / "apply-branding.sh"
    for _ in range(2):
        assert run([script], env).returncode == 0
    osr = (root / "etc/os-release").read_text()
    assert 'NAME="ClaudeOS"' in osr and "ID=ubuntu" in osr and "CLAUDEOS_BASE=ubuntu-26.04.1" in osr
    assert (root / "etc/os-release").is_symlink()
    assert (BASE / "usr/share/claudeos/branding/os-release.ubuntu-orig").exists() is False
    lsb = (root / "etc/lsb-release").read_text()
    assert lsb.count("DISTRIB_DESCRIPTION=") == 1 and "ClaudeOS 26.04.1" in lsb and "DISTRIB_CODENAME=resolute" in lsb
    assert "ClaudeOS" in (root / "etc/issue").read_text()
    # the original was backed up once, from the pristine file
    backup = root / "usr/share/claudeos/branding/os-release.ubuntu-orig"
    assert not backup.exists()  # BRANDING_DIR points at the repo copy, which must stay untouched
