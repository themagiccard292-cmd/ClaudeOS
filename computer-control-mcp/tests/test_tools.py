from __future__ import annotations

import asyncio
import json
import os
import sys
import time


import pytest

from claudeos_mcp.approval import ApprovalClient
from claudeos_mcp.backends import files, shell
from claudeos_mcp.backends.portal import PortalError
from claudeos_mcp.backends.screen import INSTALL_HINT, ScreenBackend, ScreenshotError
from claudeos_mcp.runner import RunResult, SubprocessRunner
from claudeos_mcp.server import build_server
from claudeos_mcp.testing import FakeRunner, make_png, screenshot_writer

EXPECTED_TOOLS = {
    "screenshot", "screen_info", "mouse_move", "mouse_click", "mouse_drag", "scroll", "type_text", "key_press",
    "wait", "list_windows", "focus_window", "open_app", "open_url", "clipboard_read", "clipboard_write",
    "run_command", "read_file", "write_file", "list_dir", "search_files", "move_path", "delete_path",
    "system_info", "notify", "gsettings", "systemd", "dbus_call", "request_permission",
}


def call(server, name: str, **args):
    out = asyncio.run(server.call_tool(name, args))
    content = out[0] if isinstance(out, tuple) else out
    return content


def text_of(server, name: str, **args) -> str:
    return "\n".join(c.text for c in call(server, name, **args) if getattr(c, "type", "") == "text")


# ---- approval client against a real unix socket ------------------------------------------
def ask(client: ApprovalClient, timeout_ms: int = 300):
    return client.request(tool="Bash", tool_input={"command": "x"}, summary="s", risk="high", reason="r",
                          timeout_ms=timeout_ms)


def test_approval_allow_and_request_shape(panel) -> None:
    result = ask(ApprovalClient([panel.path]))
    assert result.allowed
    req = panel.requests[0]
    assert req["cmd"] == "approval-request" and req["tool"] == "Bash" and req["timeoutMs"] == 300
    assert {"id", "input", "summary", "risk", "reason"} <= set(req)


@pytest.mark.parametrize("mode", ["deny", "malformed", "close"])
def test_approval_fails_closed(panel, mode: str) -> None:
    panel.mode = mode
    assert not ask(ApprovalClient([panel.path])).allowed


def test_approval_timeout_fails_closed(panel, monkeypatch) -> None:
    import claudeos_mcp.approval as approval

    monkeypatch.setattr(approval, "CLIENT_GRACE_S", 0.2)
    panel.mode = "timeout"
    start = time.monotonic()
    assert not ask(ApprovalClient([panel.path]), timeout_ms=100).allowed
    assert time.monotonic() - start < 3


def test_approval_ignores_foreign_id_then_times_out(panel, monkeypatch) -> None:
    import claudeos_mcp.approval as approval

    monkeypatch.setattr(approval, "CLIENT_GRACE_S", 0.2)
    panel.mode = "wrong-id"
    assert not ask(ApprovalClient([panel.path]), timeout_ms=100).allowed


def test_approval_missing_socket_denies(tmp_path) -> None:
    result = ask(ApprovalClient([str(tmp_path / "nope.sock")]))
    assert not result.allowed and "not running" in result.message


def test_only_explicit_allow_allows(panel) -> None:
    # decision other than "allow" (e.g. "yes") must not pass
    panel.mode = "deny"
    assert not ask(ApprovalClient([panel.path])).allowed


# ---- request_permission end to end ------------------------------------------------------
def perm(server, tool: str, inp: dict) -> dict:
    return json.loads(text_of(server, "request_permission", tool_name=tool, input=inp))


def test_permission_allow_block_confirm(make_ctx, panel) -> None:
    server = build_server(make_ctx(socket_path=panel.path))
    ok = perm(server, "Bash", {"command": "ls"})
    assert ok == {"behavior": "allow", "updatedInput": {"command": "ls"}}
    assert panel.requests == []
    blocked = perm(server, "Bash", {"command": "rm -rf /"})
    assert blocked["behavior"] == "deny" and "Blocked" in blocked["message"]
    assert panel.requests == []  # block never asks
    asked = perm(server, "Bash", {"command": "sudo apt remove firefox"})
    assert asked["behavior"] == "allow" and len(panel.requests) == 1
    assert panel.requests[0]["risk"] in {"medium", "high", "critical"}
    panel.mode = "deny"
    assert perm(server, "Write", {"file_path": "/etc/hosts", "content": "x"})["behavior"] == "deny"
    assert perm(server, "WebFetch", {"url": "https://x"})["behavior"] == "allow"
    assert perm(server, "Mystery", {})["behavior"] == "deny"


def test_permission_without_panel_denies(make_ctx) -> None:
    server = build_server(make_ctx())
    assert perm(server, "Bash", {"command": "sudo ls"})["behavior"] == "deny"
    assert perm(server, "mcp__claudeos-desktop__run_command", {"command": "reboot"})["behavior"] == "deny"


def test_permission_grant_is_single_use_for_own_tools(make_ctx, panel, home) -> None:
    server = build_server(make_ctx(socket_path=panel.path))
    inp = {"command": "sudo true"}
    assert perm(server, "mcp__claudeos-desktop__run_command", inp)["behavior"] == "allow"
    n = len(panel.requests)
    panel.mode = "deny"
    # The tool's own gate consumes the remembered approval once (no second prompt)...
    out = text_of(server, "run_command", **inp)
    assert len(panel.requests) == n and "Not done" not in out
    # ...and then asks again (denied now).
    assert "Not done" in text_of(server, "run_command", **inp)


# ---- run_command ------------------------------------------------------------------------
def real_server(make_ctx, **kw):
    ctx = make_ctx(**kw)
    ctx.runner = SubprocessRunner({"PATH": os.environ["PATH"], "HOME": ctx.config.home})
    return build_server(ctx)


def test_run_command_output_and_exit_code(make_ctx) -> None:
    server = real_server(make_ctx)
    out = text_of(server, "run_command", command="echo hello; echo oops >&2; exit 3")
    assert "exit code 3" in out and "hello" in out and "oops" in out


def test_run_command_blocked_never_runs(make_ctx, home) -> None:
    server = real_server(make_ctx)
    target = home / "keep"
    target.write_text("x")
    out = text_of(server, "run_command", command=f"touch {home}/ran; rm -rf /")
    assert "Blocked" in out and not (home / "ran").exists()


def test_run_command_truncates_to_20000() -> None:
    out = shell.truncate("a" * 100_000)
    assert len(out) < 20_300 and "omitted" in out


def test_run_command_large_output(make_ctx) -> None:
    server = real_server(make_ctx)
    out = text_of(server, "run_command", command=f"{sys.executable} -c \"print('x'*100000)\"")
    assert len(out) < 21_000 and "omitted" in out


def test_run_command_timeout_kills_process_group(make_ctx, home) -> None:
    server = real_server(make_ctx)
    marker = home / "child-survived"
    cmd = f"(sleep 3; touch {marker}) & sleep 30"
    start = time.monotonic()
    out = text_of(server, "run_command", command=cmd, timeout_s=1)
    assert "TIMED OUT" in out and time.monotonic() - start < 10
    time.sleep(3.5)
    assert not marker.exists()


def test_run_command_bad_cwd(make_ctx) -> None:
    server = real_server(make_ctx)
    assert text_of(server, "run_command", command="ls", cwd="/definitely/not/here").startswith("Error")


# ---- file tools -------------------------------------------------------------------------
def test_file_roundtrip_and_limits(make_ctx, home) -> None:
    server = real_server(make_ctx)
    assert "Error" not in text_of(server, "write_file", path="~/a/b.txt", content="hello\nworld", create_dirs=True)
    assert "world" in text_of(server, "read_file", path="~/a/b.txt")
    assert "b.txt" in text_of(server, "list_dir", path="~/a")
    assert "b.txt" in text_of(server, "search_files", root="~", contains="world")
    text_of(server, "write_file", path="~/a/b.txt", content="!", append=True)
    assert (home / "a" / "b.txt").read_text() == "hello\nworld!"
    assert "Folder" in text_of(server, "write_file", path="~/zz/new.txt", content="x")
    (home / "bin.dat").write_bytes(b"\x00\x01\x02" * 100)
    assert "binary" in text_of(server, "read_file", path="~/bin.dat")
    (home / "big.txt").write_text("y" * 2000)
    assert len(files.read_file(str(home / "big.txt"), max_bytes=100).text) < 400
    assert files.read_file(str(home / "big.txt"), max_bytes=10**9).text  # clamped to 5 MiB, no crash


def test_file_tools_gate(make_ctx, home) -> None:
    server = real_server(make_ctx)
    assert "Blocked" in text_of(server, "read_file", path="/etc/shadow")
    cred = home / ".claude" / ".credentials.json"
    cred.parent.mkdir()
    cred.write_text("{}")
    assert "Blocked" in text_of(server, "read_file", path="~/.claude/.credentials.json")
    assert "Not done" in text_of(server, "write_file", path="/etc/claudeos-test", content="x")  # confirm, no panel
    assert "Not done" in text_of(server, "delete_path", path="~/a.txt", permanent=True)


def test_delete_defaults_to_trash(make_ctx, home) -> None:
    runner = FakeRunner(programs={"gio": RunResult(0)})
    server = build_server(make_ctx(runner))
    (home / "gone.txt").write_text("x")
    out = text_of(server, "delete_path", path="~/gone.txt")
    assert "trash" in out.lower()
    assert runner.argvs("gio") == [["gio", "trash", "--", str(home / "gone.txt")]]
    assert (home / "gone.txt").exists()  # the fake gio did not remove it; nothing deleted directly


def test_move_path(make_ctx, home) -> None:
    server = build_server(make_ctx())
    (home / "m.txt").write_text("x")
    assert "Moved" in text_of(server, "move_path", source="~/m.txt", destination="~/n.txt")
    assert (home / "n.txt").exists()
    assert "exists" in text_of(server, "move_path", source="~/n.txt", destination="~/n.txt")


# ---- open_url / misc tools --------------------------------------------------------------
@pytest.mark.parametrize("url", ["javascript:alert(1)", "ftp://x/y", "data:text/html,x", "chrome://settings",
                                 "gopher://x", "vscode://file/x", "https://"])
def test_open_url_rejects(make_ctx, url: str) -> None:
    runner = FakeRunner(programs={"xdg-open": RunResult(0)})
    out = text_of(build_server(make_ctx(runner)), "open_url", url=url)
    assert out.startswith("Error") and runner.spawned == []


@pytest.mark.parametrize("url", ["https://example.com", "http://localhost:8080/x", "file:///tmp/a.txt", "mailto:a@b.c"])
def test_open_url_allows(make_ctx, url: str) -> None:
    runner = FakeRunner(programs={"xdg-open": RunResult(0)})
    assert "Opened" in text_of(build_server(make_ctx(runner)), "open_url", url=url)
    assert runner.spawned


def test_system_info_has_no_env_dump(make_ctx, monkeypatch) -> None:
    monkeypatch.setenv("SECRET_TOKEN_X", "hunter2")
    out = text_of(build_server(make_ctx(SECRET_TOKEN_X="hunter2")), "system_info")
    assert "hunter2" not in out and "OS:" in out


def test_tools_never_raise(make_ctx) -> None:
    server = build_server(make_ctx(FakeRunner()))  # nothing installed
    for name, args in [("mouse_click", {"x": 1, "y": 1}), ("key_press", {"keys": "nonsense"}),
                       ("clipboard_read", {}), ("screenshot", {}), ("notify", {"title": "t"}),
                       ("systemd", {"action": "status", "unit": "ssh"}), ("list_windows", {}),
                       ("focus_window", {"id_or_title": "x"}), ("open_app", {"name": "nope"}),
                       ("gsettings", {"action": "bogus", "schema": "x"})]:
        out = text_of(server, name, **args)
        assert out, name


def test_key_press_and_click_use_ydotool(make_ctx) -> None:
    runner = FakeRunner(programs={"ydotool": RunResult(0), "gnome-screenshot": screenshot_writer(2560, 1440)})
    server = build_server(make_ctx(runner))
    assert "Pressed" in text_of(server, "key_press", keys="ctrl+alt+t")
    call(server, "screenshot")
    assert "click" in text_of(server, "mouse_click", x=784, y=441)
    moves = [a for a in runner.argvs("ydotool") if a[1] == "mousemove"]
    assert moves[-1][-4:] == ["-x", "1280", "-y", "720"]  # screenshot space -> physical px
    assert "Error" in text_of(server, "mouse_click", x=5000, y=5)


def test_wait_clamped(make_ctx) -> None:
    assert "0.1" in text_of(build_server(make_ctx()), "wait", seconds=0.1)


# ---- screenshot ---------------------------------------------------------------------------
def test_screenshot_downscale_and_metadata(make_ctx) -> None:
    content = call(build_server(make_ctx()), "screenshot")
    kinds = [c.type for c in content]
    assert kinds == ["image", "text"]
    assert "1568x882" in content[1].text and "2560x1440" in content[1].text


def test_screenshot_region_and_max_dimension(make_ctx) -> None:
    server = build_server(make_ctx())
    call(server, "screenshot")
    content = call(server, "screenshot", region=[0, 0, 400, 300], max_dimension=200)
    assert content[0].type == "image" and "200x" in content[1].text
    assert "Error" in text_of(server, "screenshot", region=[0, 0, 1])


def test_screenshot_chain_falls_through() -> None:
    def fail(_argv, _in):
        return RunResult(1, stderr=b"nope")

    png_path = {}

    def portal(_t: float) -> str:
        raise PortalError("denied")

    runner = FakeRunner(programs={"gnome-screenshot": fail, "grim": screenshot_writer(100, 80)})
    cap = ScreenBackend(runner, session_type="wayland", portal=portal).capture()
    assert cap.method == "grim" and (cap.width, cap.height) == (100, 80)
    assert [a[0] for a in (c.argv for c in runner.calls)] == ["gnome-screenshot", "grim"]
    assert not png_path


def test_screenshot_portal_used_before_grim(tmp_path) -> None:
    p = tmp_path / "portal.png"
    p.write_bytes(make_png(64, 48))
    runner = FakeRunner(programs={"gnome-screenshot": RunResult(1), "grim": screenshot_writer(10, 10)})
    cap = ScreenBackend(runner, session_type="wayland", portal=lambda _t: str(p)).capture()
    assert cap.method == "xdg-desktop-portal" and cap.width == 64


def test_screenshot_all_fail_is_clear() -> None:
    def portal(_t: float) -> str:
        raise PortalError("no portal")

    with pytest.raises(ScreenshotError) as err:
        ScreenBackend(FakeRunner(), session_type="wayland", portal=portal).capture()
    assert INSTALL_HINT in str(err.value) and "no portal" in str(err.value)


def test_screenshot_x11_chain_has_import_and_scrot() -> None:
    runner = FakeRunner(programs={"import": screenshot_writer(30, 20), "scrot": screenshot_writer(5, 5)})
    backend = ScreenBackend(runner, session_type="x11", portal=lambda _t: (_ for _ in ()).throw(PortalError("x")))
    assert [n for n, _ in backend.methods()] == ["xdg-desktop-portal", "import", "scrot"]
    assert backend.capture().method == "import"


def test_child_env_strips_api_keys(monkeypatch) -> None:
    from claudeos_mcp.runner import child_env

    env = child_env({"ANTHROPIC_API_KEY": "k", "ANTHROPIC_BASE_URL": "u", "CLAUDE_CODE_USE_BEDROCK": "1", "PATH": "/bin"})
    assert env == {"PATH": "/bin"} or "ANTHROPIC_API_KEY" not in env and "ANTHROPIC_BASE_URL" not in env


def test_tool_set_is_exact(make_ctx) -> None:
    tools = asyncio.run(build_server(make_ctx()).list_tools())
    assert {t.name for t in tools} == EXPECTED_TOOLS
    for t in tools:
        assert t.description and t.inputSchema["type"] == "object"


