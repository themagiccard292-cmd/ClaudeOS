from __future__ import annotations

import pytest
from claudeos_mcp.backends.input_ import XdotoolBackend, YdotoolBackend, select_backend
from claudeos_mcp.geometry import (
    HOME_DISTANCE,
    Mapping,
    OutOfBounds,
    downscaled_size,
    parse_xrandr,
    physical_to_backend,
    plan_ydotool_moves,
    screenshot_to_physical,
)
from claudeos_mcp.keys import KeyParseError, parse_combo, parse_keys
from claudeos_mcp.runner import RunResult
from claudeos_mcp.testing import FakeRunner


@pytest.mark.parametrize(
    ("text", "args"),
    [
        ("ctrl+c", ["29:1", "46:1", "46:0", "29:0"]),
        ("ctrl+alt+t", ["29:1", "56:1", "20:1", "20:0", "56:0", "29:0"]),
        ("Return", ["28:1", "28:0"]),
        ("alt+F4", ["56:1", "62:1", "62:0", "56:0"]),
        ("super", ["125:1", "125:0"]),
        ("shift+Tab", ["42:1", "15:1", "15:0", "42:0"]),
        ("CTRL+Shift+A", ["29:1", "42:1", "30:1", "30:0", "42:0", "29:0"]),
        ("Escape", ["1:1", "1:0"]),
        ("space", ["57:1", "57:0"]),
    ],
)
def test_key_combos_to_evdev(text: str, args: list[str]) -> None:
    assert parse_combo(text).ydotool_args() == args


def test_key_sequences_and_errors() -> None:
    assert len(parse_keys("ctrl+a Delete")) == 2
    for bad in ["", "   ", "ctrl+", "nonsense", "ctrl+ctrl+c", "a+b", "ctrl+alt+nosuchkey"]:
        with pytest.raises(KeyParseError):
            parse_keys(bad)


def test_xdotool_names() -> None:
    assert parse_combo("ctrl+alt+t").xdotool_name().lower() == "ctrl+alt+t"


MAP = Mapping(1568, 882, 0, 0, 2560, 1440, 2560, 1440, 1.0)


def test_downscale_never_upscales() -> None:
    assert downscaled_size(2560, 1440, 1568) == (1568, 882)
    assert downscaled_size(800, 600, 1568) == (800, 600)
    with pytest.raises(ValueError):
        downscaled_size(0, 10, 100)


def test_screenshot_to_physical_maps_and_clamps() -> None:
    assert screenshot_to_physical(0, 0, MAP) == (0, 0)
    assert screenshot_to_physical(784, 441, MAP) == (1280, 720)
    px, py = screenshot_to_physical(1568, 882, MAP)
    assert (px, py) == (2559, 1439)
    with pytest.raises(OutOfBounds):
        screenshot_to_physical(1569, 5, MAP)


def test_region_mapping_with_origin() -> None:
    m = Mapping(500, 250, 1000, 200, 1000, 500, 2560, 1440, 1.0)
    assert screenshot_to_physical(250, 125, m) == (1500, 450)


def test_no_screenshot_means_physical_pixels() -> None:
    m = Mapping(0, 0, 0, 0, 0, 0, 0, 0, 1.0, from_screenshot=False)
    assert screenshot_to_physical(10.4, 20, m) == (10, 20)


def test_scale_conversion() -> None:
    assert physical_to_backend(2000, 1000, backend="ydotool", session_type="wayland", scale=2.0) == (1000, 500)
    assert physical_to_backend(2000, 1000, backend="xdotool", session_type="x11", scale=2.0) == (2000, 1000)
    assert physical_to_backend(2000, 1000, backend="xdotool", session_type="wayland", scale=2.0) == (1000, 500)


def test_ydotool_planner_homes_then_moves_relative() -> None:
    assert plan_ydotool_moves(100, 50) == [(-HOME_DISTANCE, -HOME_DISTANCE), (100, 50)]
    assert plan_ydotool_moves(0, 0) == [(-HOME_DISTANCE, -HOME_DISTANCE)]
    assert plan_ydotool_moves(10, 10, home=False) == [(10, 10)]
    steps = plan_ydotool_moves(1000, 500, max_step=300)[1:]
    assert sum(s[0] for s in steps) == 1000 and sum(s[1] for s in steps) == 500
    assert all(abs(dx) <= 300 and abs(dy) <= 300 for dx, dy in steps)
    calibrated = plan_ydotool_moves(100, 100, units_per_px=1.5)
    assert calibrated[1] == (150, 150)
    with pytest.raises(ValueError):
        plan_ydotool_moves(-1, 0)


def test_parse_xrandr() -> None:
    text = "Screen 0: minimum 16 x 16, current 2560 x 1440, maximum 32767 x 32767\nDP-1 connected primary 2560x1440+0+0 (n) 600mm x 340mm\n"
    screen, mons = parse_xrandr(text)
    assert screen == (2560, 1440) and mons[0].name == "DP-1" and mons[0].primary


@pytest.mark.parametrize(
    ("override", "session", "have", "display", "expected"),
    [
        ("", "wayland", {"ydotool", "xdotool"}, True, "ydotool"),
        ("", "wayland", {"xdotool"}, True, "xdotool"),
        ("", "wayland", {"xdotool"}, False, None),
        ("", "x11", {"ydotool", "xdotool"}, True, "xdotool"),
        ("", "x11", {"ydotool"}, True, "ydotool"),
        ("", "", set(), False, None),
        ("xdotool", "wayland", {"ydotool", "xdotool"}, True, "xdotool"),
        ("ydotool", "x11", {"ydotool", "xdotool"}, True, "ydotool"),
        ("ydotool", "wayland", {"xdotool"}, True, None),
        ("bogus", "wayland", {"ydotool"}, True, None),
    ],
)
def test_backend_selection(override, session, have, display, expected) -> None:
    sel = select_backend(override=override, session_type=session, has=lambda n: n in have, display=display)
    assert sel.backend == expected and sel.reason


def _ydo(runner_calls: bool = True):
    runner = FakeRunner(programs={"ydotool": RunResult(0), "xdotool": RunResult(0)})
    env = {"XDG_RUNTIME_DIR": "/run/user/1000"}
    return runner, YdotoolBackend(runner, env, socket_exists=lambda _p: True)


def test_ydotool_commands() -> None:
    runner, backend = _ydo()
    backend.move(100, 50)
    backend.click("left", 1)
    backend.click("right", 2)
    backend.scroll(0, 3)
    backend.keys(parse_keys("ctrl+c"))
    backend.type_text("hi")
    argvs = runner.argvs("ydotool")
    assert argvs[0] == ["ydotool", "mousemove", "-x", str(-HOME_DISTANCE), "-y", str(-HOME_DISTANCE)]
    assert argvs[1][-4:] == ["-x", "100", "-y", "50"]
    assert argvs[2] == ["ydotool", "click", "0xc0"]
    assert "0xc1" in argvs[3] and "--repeat" in argvs[3]
    assert argvs[4][-1] == "-3"
    assert argvs[5][:2] == ["ydotool", "key"] and "29:1" in argvs[5]
    assert runner.calls[-1].input == b"hi"
    assert runner.calls[0].env["YDOTOOL_SOCKET"] == "/run/user/1000/.ydotool_socket"


def test_ydotool_without_daemon_is_actionable() -> None:
    from claudeos_mcp.backends.input_ import InputError

    backend = YdotoolBackend(FakeRunner(programs={"ydotool": RunResult(0)}), {"XDG_RUNTIME_DIR": "/x"},
                             socket_exists=lambda _p: False)
    with pytest.raises(InputError, match="ydotoold"):
        backend.click("left", 1)


def test_xdotool_backend_moves_absolute() -> None:
    runner = FakeRunner(programs={"xdotool": RunResult(0)})
    XdotoolBackend(runner).move(10, 20)
    assert runner.argvs("xdotool")[0][:2] == ["xdotool", "mousemove"]
