"""Key-combo parsing: ``"ctrl+alt+t"``, ``"Return"``, ``"super+d"``, ``"alt+Tab"``, ``"F5"``...

The same xdotool-style names drive both backends:
- ydotool needs Linux evdev keycodes (``input-event-codes.h``) as ``CODE:1`` / ``CODE:0`` pairs;
- xdotool needs X keysym names (``ctrl+alt+t``, ``Return``, ``super+d``).

Several combos may be given separated by spaces (``"ctrl+a ctrl+c"``); they are pressed in order.
Names are case-insensitive. Use ``plus`` for a literal ``+`` key.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass


@dataclass(frozen=True)
class Key:
    name: str  # canonical name (lowercase)
    code: int  # evdev keycode
    keysym: str  # X keysym name for xdotool
    modifier: bool = False


def _k(name: str, code: int, keysym: str, modifier: bool = False) -> Key:
    return Key(name, code, keysym, modifier)


_KEYS: list[Key] = [
    _k("ctrl", 29, "ctrl", True),
    _k("ctrl_r", 97, "Control_R", True),
    _k("shift", 42, "shift", True),
    _k("shift_r", 54, "Shift_R", True),
    _k("alt", 56, "alt", True),
    _k("altgr", 100, "ISO_Level3_Shift", True),
    _k("super", 125, "super", True),
    _k("super_r", 126, "Super_R", True),
    _k("return", 28, "Return"),
    _k("kp_enter", 96, "KP_Enter"),
    _k("tab", 15, "Tab"),
    _k("escape", 1, "Escape"),
    _k("space", 57, "space"),
    _k("backspace", 14, "BackSpace"),
    _k("delete", 111, "Delete"),
    _k("insert", 110, "Insert"),
    _k("home", 102, "Home"),
    _k("end", 107, "End"),
    _k("page_up", 104, "Prior"),
    _k("page_down", 109, "Next"),
    _k("up", 103, "Up"),
    _k("down", 108, "Down"),
    _k("left", 105, "Left"),
    _k("right", 106, "Right"),
    _k("caps_lock", 58, "Caps_Lock"),
    _k("num_lock", 69, "Num_Lock"),
    _k("scroll_lock", 70, "Scroll_Lock"),
    _k("print", 99, "Print"),
    _k("pause", 119, "Pause"),
    _k("menu", 127, "Menu"),
    _k("minus", 12, "minus"),
    _k("equal", 13, "equal"),
    _k("plus", 78, "KP_Add"),
    _k("bracketleft", 26, "bracketleft"),
    _k("bracketright", 27, "bracketright"),
    _k("semicolon", 39, "semicolon"),
    _k("apostrophe", 40, "apostrophe"),
    _k("grave", 41, "grave"),
    _k("backslash", 43, "backslash"),
    _k("comma", 51, "comma"),
    _k("period", 52, "period"),
    _k("slash", 53, "slash"),
    _k("volume_up", 115, "XF86AudioRaiseVolume"),
    _k("volume_down", 114, "XF86AudioLowerVolume"),
    _k("mute", 113, "XF86AudioMute"),
    _k("play_pause", 164, "XF86AudioPlay"),
    _k("next_track", 163, "XF86AudioNext"),
    _k("prev_track", 165, "XF86AudioPrev"),
    _k("brightness_up", 225, "XF86MonBrightnessUp"),
    _k("brightness_down", 224, "XF86MonBrightnessDown"),
]
_KEYS += [_k(f"f{n}", code, f"F{n}") for n, code in zip(range(1, 13), [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88], strict=True)]
_LETTER_CODES = dict(zip("qwertyuiop", range(16, 26), strict=True))
_LETTER_CODES |= dict(zip("asdfghjkl", range(30, 39), strict=True))
_LETTER_CODES |= dict(zip("zxcvbnm", range(44, 51), strict=True))
_KEYS += [_k(ch, code, ch) for ch, code in sorted(_LETTER_CODES.items())]
_KEYS += [_k(d, code, d) for d, code in zip("1234567890", range(2, 12), strict=True)]

KEYS: dict[str, Key] = {k.name: k for k in _KEYS}

ALIASES: dict[str, str] = {
    "control": "ctrl",
    "ctl": "ctrl",
    "control_l": "ctrl",
    "ctrl_l": "ctrl",
    "lctrl": "ctrl",
    "control_r": "ctrl_r",
    "rctrl": "ctrl_r",
    "shift_l": "shift",
    "lshift": "shift",
    "rshift": "shift_r",
    "alt_l": "alt",
    "lalt": "alt",
    "meta": "super",
    "win": "super",
    "windows": "super",
    "cmd": "super",
    "command": "super",
    "logo": "super",
    "super_l": "super",
    "alt_r": "altgr",
    "iso_level3_shift": "altgr",
    "enter": "return",
    "ret": "return",
    "esc": "escape",
    "del": "delete",
    "ins": "insert",
    "bksp": "backspace",
    "back_space": "backspace",
    "pageup": "page_up",
    "pgup": "page_up",
    "prior": "page_up",
    "pagedown": "page_down",
    "pgdn": "page_down",
    "next": "page_down",
    "arrowup": "up",
    "arrowdown": "down",
    "arrowleft": "left",
    "arrowright": "right",
    "capslock": "caps_lock",
    "numlock": "num_lock",
    "scrolllock": "scroll_lock",
    "printscreen": "print",
    "prtsc": "print",
    "sysrq": "print",
    "apps": "menu",
    "context_menu": "menu",
    "-": "minus",
    "=": "equal",
    "[": "bracketleft",
    "]": "bracketright",
    ";": "semicolon",
    "'": "apostrophe",
    "`": "grave",
    "\\": "backslash",
    ",": "comma",
    ".": "period",
    "/": "slash",
    " ": "space",
    "xf86audioraisevolume": "volume_up",
    "xf86audiolowervolume": "volume_down",
    "xf86audiomute": "mute",
    "xf86audioplay": "play_pause",
    "xf86audionext": "next_track",
    "xf86audioprev": "prev_track",
    "xf86monbrightnessup": "brightness_up",
    "xf86monbrightnessdown": "brightness_down",
    "kp_add": "plus",
}


class KeyParseError(ValueError):
    pass


@dataclass(frozen=True)
class Combo:
    keys: tuple[Key, ...]  # modifiers first, main key last

    def ydotool_args(self) -> list[str]:
        """Press in order, release in reverse: ``29:1 20:1 20:0 29:0``."""
        down = [f"{k.code}:1" for k in self.keys]
        up = [f"{k.code}:0" for k in reversed(self.keys)]
        return down + up

    def xdotool_name(self) -> str:
        return "+".join(k.keysym for k in self.keys)


def lookup(name: str) -> Key:
    raw = name.strip()
    lowered = raw.lower()
    if lowered in KEYS:
        return KEYS[lowered]
    if lowered in ALIASES:
        return KEYS[ALIASES[lowered]]
    if raw in ALIASES:
        return KEYS[ALIASES[raw]]
    choices = list(KEYS) + list(ALIASES)
    near = difflib.get_close_matches(lowered, choices, n=3, cutoff=0.6)
    hint = f" Did you mean: {', '.join(near)}?" if near else ""
    raise KeyParseError(f"Unknown key {name!r}.{hint} Examples: ctrl+alt+t, Return, super, alt+Tab, F5, shift+a.")


def _split_combo(text: str) -> list[str]:
    # "ctrl++" means ctrl + the plus key; a lone "+" is the plus key.
    if text == "+":
        return ["plus"]
    parts = text.split("+")
    if text.endswith("++"):
        parts = parts[:-2] + ["plus"]
    if any(p == "" for p in parts):
        raise KeyParseError(f"Malformed key combo {text!r}: use names joined by '+', e.g. ctrl+shift+t.")
    return parts


def parse_combo(text: str) -> Combo:
    names = _split_combo(text.strip())
    keys = [lookup(n) for n in names]
    *mods, main = keys
    for mod in mods:
        if not mod.modifier:
            raise KeyParseError(
                f"In {text!r}, {mod.name!r} is not a modifier; only ctrl/shift/alt/super/altgr can be held. "
                "Send separate combos separated by spaces to press keys one after another."
            )
    if len({k.code for k in keys}) != len(keys):
        raise KeyParseError(f"Key combo {text!r} repeats a key.")
    return Combo(tuple(mods + [main]))


def parse_keys(text: str) -> list[Combo]:
    """Parse one or more space-separated combos. Raises :class:`KeyParseError` with a hint."""
    if not text or not text.strip():
        raise KeyParseError("No keys given. Examples: Return, ctrl+c, ctrl+alt+t, super, alt+F4.")
    combos = [parse_combo(chunk) for chunk in text.split()]
    if len(combos) > 50:
        raise KeyParseError("Too many key combos in one call (max 50).")
    return combos
