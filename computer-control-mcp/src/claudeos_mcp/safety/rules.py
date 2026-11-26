"""The C4 block / confirm / allow table, as data.

Each :class:`Rule` has an ``id``, a ``domain`` (what kind of subject it inspects), a ``level``
(``block`` never runs; ``confirm`` needs a human click in the panel), a ``risk`` shown on the
approval card, a human ``reason`` and a predicate (or regex for ``raw`` rules).

Domains and predicate signatures:

- ``raw``       – regex over the whole shell string, checked before parsing (fork bombs);
- ``command``   – ``predicate(cmd: Command, ctx: Ctx)`` for every simple command found in a shell string;
- ``path``      – ``predicate(target: PathTarget)`` for every path an action reads/writes/deletes;
- ``dbus`` / ``systemd`` / ``gsettings`` – ``predicate(params: dict)`` for the matching MCP tools.

The classifier (``classifier.py``) evaluates every rule of the relevant domain and the WORST
match wins (block > confirm > allow, then by risk).
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from fnmatch import fnmatch
from typing import Any

from .shellparse import DYNAMIC, Word

LEVELS = ("allow", "confirm", "block")
RISKS = ("low", "medium", "high", "critical")


@dataclass(frozen=True)
class Verdict:
    level: str
    risk: str
    reason: str
    rule_id: str

    @property
    def rank(self) -> tuple[int, int]:
        return LEVELS.index(self.level), RISKS.index(self.risk)


ALLOW = Verdict("allow", "low", "No safety rule matched.", "allow.default")


def worst(verdicts: list[Verdict]) -> Verdict:
    """The most severe verdict (level first, then risk); ALLOW for an empty list."""
    return max(verdicts, key=lambda v: v.rank, default=ALLOW)


@dataclass(frozen=True)
class Rule:
    id: str
    domain: str
    level: str
    risk: str
    reason: str
    predicate: Callable[..., bool] | None = None
    pattern: re.Pattern[str] | None = None

    def verdict(self) -> Verdict:
        return Verdict(self.level, self.risk, self.reason, self.id)

    def matches(self, *subject: Any) -> bool:
        if self.pattern is not None:
            return bool(self.pattern.search(subject[0]))
        assert self.predicate is not None
        return bool(self.predicate(*subject))


# --------------------------------------------------------------------------------------
# Subjects the predicates look at
# --------------------------------------------------------------------------------------


@dataclass
class Ctx:
    """Where a shell command would run."""

    home: str
    cwd: str
    user: str = ""

    def lexical(self, value: str) -> str:
        """Absolute, normalised path for ``value`` (no symlink resolution)."""
        value = value.replace(DYNAMIC, "*")
        return os.path.normpath(value if os.path.isabs(value) else os.path.join(self.cwd, value))


@dataclass
class Command:
    """One simple command after wrappers (sudo, env, nice, bash -c, ...) were peeled off."""

    name: str
    args: list[Word] = field(default_factory=list)
    redirects: list[tuple[str, Word]] = field(default_factory=list)
    elevated: bool = False  # ran through sudo/pkexec/doas/su/run0
    dynamic_name: bool = False  # command name only known at run time
    unknown_args: bool = False  # extra arguments appended at run time (xargs)
    pipe_from: list[str] = field(default_factory=list)  # upstream commands in the same pipeline
    stdin_piped: bool = False
    sub_sources: list[str] = field(default_factory=list)  # $(...) bodies used in its words

    @property
    def argv(self) -> list[str]:
        return [a.value for a in self.args]


@dataclass(frozen=True)
class PathTarget:
    """A path an action touches. ``paths`` holds the lexical and the symlink-resolved forms."""

    op: str  # "read" | "write" | "delete"
    paths: tuple[str, ...]
    home: str
    via_shell: bool = False


# --------------------------------------------------------------------------------------
# Shared vocabularies
# --------------------------------------------------------------------------------------

# Deleting (or recursively chmod/chown-ing) one of these is never something to do from a chat.
SYSTEM_ROOTS = frozenset(
    {
        "/",
        "/bin",
        "/boot",
        "/dev",
        "/efi",
        "/etc",
        "/home",
        "/lib",
        "/lib32",
        "/lib64",
        "/libx32",
        "/opt",
        "/proc",
        "/root",
        "/sbin",
        "/snap",
        "/srv",
        "/sys",
        "/usr",
        "/var",
        # merged-/usr: /bin, /lib... resolve to these, so they are just as fatal.
        "/usr/bin",
        "/usr/sbin",
        "/usr/lib",
        "/usr/lib32",
        "/usr/lib64",
        "/usr/libx32",
        "/usr/libexec",
        "/usr/local",
        "/usr/share",
        "/var/lib",
    }
)

# Writes/deletes below these need a human.
SYSTEM_WRITE_PREFIXES = (
    "/etc",
    "/usr",
    "/boot",
    "/efi",
    "/var",
    "/opt",
    "/sys",
    "/proc",
    "/bin",
    "/sbin",
    "/lib",
    "/lib32",
    "/lib64",
    "/libx32",
    "/root",
    "/srv",
    "/snap",
    "/dev",
)
SYSTEM_WRITE_EXCEPTIONS = (
    "/var/tmp",
    "/dev/null",
    "/dev/zero",
    "/dev/stdout",
    "/dev/stderr",
    "/dev/stdin",
    "/dev/tty",
    "/dev/fd",
    "/dev/shm",
    "/dev/pts",
    "/proc/self/fd",
)

# ClaudeOS's own safety configuration: the model must never edit or delete it.
CLAUDEOS_PROTECTED = ("/etc/claude-code", "/etc/claudeos", "/opt/claudeos", "/usr/lib/claudeos")

BLOCK_DEVICE_RE = re.compile(
    r"^/dev/(sd[a-z]+\d*|hd[a-z]+\d*|vd[a-z]+\d*|xvd[a-z]+\d*|nvme\d+(n\d+(p\d+)?)?|mmcblk\d+(p\d+)?"
    r"|dm-\d+|md\d+|loop\d+|sr\d+|mapper/.+|disk/.+|mem|kmem|port)$"
)

PRIVILEGE_COMMANDS = frozenset({"sudo", "su", "pkexec", "doas", "run0", "sudoedit"})
DOWNLOADERS = frozenset({"curl", "wget", "fetch", "aria2c", "http", "https", "xh", "lwp-request"})
SHELLS = frozenset({"sh", "bash", "dash", "zsh", "ksh", "mksh", "fish", "csh", "tcsh", "ash"})
INTERPRETERS = frozenset({"python", "python3", "perl", "ruby", "node", "php"})

# Direct children of $HOME that a "local" recursive delete must not hit silently.
HOME_PROTECTED_CHILDREN = frozenset(
    {"Desktop", "Documents", "Downloads", "Music", "Pictures", "Public", "Templates", "Videos", "snap"}
)


def within(path: str, prefix: str) -> bool:
    """``path`` is ``prefix`` or below it."""
    if prefix == "/":
        return path.startswith("/")
    return path == prefix or path.startswith(prefix.rstrip("/") + "/")


def strictly_within(path: str, prefix: str) -> bool:
    return path != prefix and within(path, prefix)


def options(cmd: Command) -> tuple[set[str], set[str], list[str]]:
    """Generic option split: (short flag letters, long option names, positional args)."""
    shorts: set[str] = set()
    longs: set[str] = set()
    positional: list[str] = []
    end_of_opts = False
    for arg in cmd.argv:
        if end_of_opts or arg == "-" or not arg.startswith("-"):
            positional.append(arg)
        elif arg == "--":
            end_of_opts = True
        elif arg.startswith("--"):
            longs.add(arg[2:].split("=", 1)[0])
        else:
            shorts.update(arg[1:])
    return shorts, longs, positional


def _first_positional(cmd: Command) -> str:
    _, _, pos = options(cmd)
    return pos[0] if pos else ""


# --------------------------------------------------------------------------------------
# Command predicates
# --------------------------------------------------------------------------------------


def rm_parts(cmd: Command) -> tuple[bool, list[Word]]:
    """(recursive?, path words) for an rm invocation."""
    recursive = False
    paths: list[Word] = []
    end_of_opts = False
    for word in cmd.args:
        arg = word.value
        if end_of_opts or not arg.startswith("-") or arg == "-":
            paths.append(word)
        elif arg == "--":
            end_of_opts = True
        elif arg.startswith("--"):
            recursive |= arg == "--recursive"
        else:
            recursive |= "r" in arg or "R" in arg
    return recursive, paths


def is_local_relative(word: Word, ctx: Ctx) -> bool:
    """A relative path that stays strictly inside the working directory (e.g. ``./build``)."""
    value = word.value
    if not value or value.startswith("/") or word.dynamic or (word.glob and "/" not in value):
        return False
    norm = os.path.normpath(value)
    if norm in (".", "") or norm == ".." or norm.startswith("../"):
        return False
    if word.glob and norm.split("/", 1)[0].strip("*?[]") == "":
        return False  # "*" or "*/x": the whole working directory
    target = ctx.lexical(value)
    if os.path.dirname(target) == ctx.home:
        name = os.path.basename(target)
        if name.startswith(".") or name in HOME_PROTECTED_CHILDREN:
            return False
    return True


def _rm_recursive_nonlocal(cmd: Command, ctx: Ctx) -> bool:
    if cmd.name != "rm":
        return False
    recursive, paths = rm_parts(cmd)
    return recursive and (cmd.unknown_args or not paths or not all(is_local_relative(p, ctx) for p in paths))


def _rm_many(cmd: Command, _ctx: Ctx) -> bool:
    if cmd.name not in ("rm", "unlink"):
        return False
    _, paths = rm_parts(cmd)
    return cmd.unknown_args or len(paths) > 5 or any(p.glob for p in paths)


def _rm_unresolved_var(cmd: Command, _ctx: Ctx) -> bool:
    if cmd.name != "rm":
        return False
    recursive, paths = rm_parts(cmd)
    return recursive and any(p.value.startswith(DYNAMIC) for p in paths)


def _rm_no_preserve_root(cmd: Command, _ctx: Ctx) -> bool:
    return cmd.name == "rm" and "--no-preserve-root" in cmd.argv


_MKFS_RE = re.compile(r"^(mkfs(\..+)?|mke2fs|mkntfs|mkdosfs|mkexfatfs|mkfs_\w+|mkudffs)$")


def _mkfs(cmd: Command, _ctx: Ctx) -> bool:
    if _MKFS_RE.match(cmd.name):
        return True
    return cmd.name == "mkswap" and any(a.startswith("/dev/") for a in cmd.argv)


def _wipe(cmd: Command, _ctx: Ctx) -> bool:
    if cmd.name in ("wipefs", "shred", "blkdiscard"):
        return True
    return cmd.name == "cryptsetup" and any(
        a in ("luksFormat", "erase", "luksErase", "reencrypt") for a in cmd.argv
    )


_HARMLESS_DEV = ("/dev/null", "/dev/zero", "/dev/stdout", "/dev/stderr", "/dev/tty")


def _dd_device(cmd: Command, _ctx: Ctx) -> bool:
    if cmd.name != "dd":
        return False
    for arg in cmd.argv:
        if arg.startswith("of="):
            target = arg[3:]
            if target.startswith("/dev/") and target not in _HARMLESS_DEV:
                return True
    return False


_PARTITION_TOOLS = frozenset({"fdisk", "sfdisk", "cfdisk", "gdisk", "cgdisk", "sgdisk", "parted"})
_PARTITION_READONLY = {
    "fdisk": ({"l"}, {"list", "help", "version"}),
    "gdisk": ({"l"}, {"help", "version"}),
    "sfdisk": ({"l", "d", "J", "s", "V"}, {"list", "dump", "json", "show-size", "verify", "help", "version"}),
    "sgdisk": ({"p", "v", "i", "O"}, {"print", "verify", "info", "help", "version"}),
    "parted": ({"l"}, {"list", "help", "version"}),
}


def _partition_write(cmd: Command, _ctx: Ctx) -> bool:
    if cmd.name not in _PARTITION_TOOLS:
        return False
    shorts, longs, positional = options(cmd)
    ro_shorts, ro_longs = _PARTITION_READONLY.get(cmd.name, (set(), set()))
    if cmd.name == "parted":
        # `parted -s /dev/sda print` and `parted -l` only read.
        script = positional[1:]
        if (shorts - {"s", "m"}) <= ro_shorts and (shorts & ro_shorts or longs & ro_longs):
            return False
        if script and all(word in ("print", "unit", "s", "B", "MB", "GB", "MiB", "GiB") for word in script):
            return False
        return True
    # Read-only only when at least one listing option is given and nothing else is.
    has_listing = bool(shorts & ro_shorts or longs & ro_longs)
    only_listing = shorts <= ro_shorts | {"u"} and longs <= ro_longs | {"units", "bytes"}
    return not (has_listing and only_listing)


def _chmod_system(cmd: Command, ctx: Ctx) -> bool:
    if cmd.name not in ("chmod", "chown", "chgrp", "setfacl"):
        return False
    shorts, longs, positional = options(cmd)
    if "R" not in shorts and "recursive" not in longs:
        return False
    targets = positional if any(o.startswith("reference") for o in longs) else positional[1:]
    for target in targets:
        lexical = ctx.lexical(target)
        if lexical in SYSTEM_ROOTS or lexical == ctx.home or os.path.realpath(lexical) in SYSTEM_ROOTS:
            return True
    return False


def reads_code_from_stdin(cmd: Command) -> bool:
    """An interpreter that would execute whatever arrives on stdin (``| sh``, ``| python3``)."""
    shorts, longs, positional = options(cmd)
    if cmd.name in SHELLS:
        if "c" in shorts:
            return False
        return not positional or positional[0] == "-" or "s" in shorts
    if cmd.name in INTERPRETERS or re.fullmatch(r"python3(\.\d+)?", cmd.name):
        return not positional and not shorts & {"c", "e", "m", "p", "r"} and "eval" not in longs
    return False


_DOWNLOAD_RE = re.compile(r"(^|[\s;&|(`])(" + "|".join(sorted(DOWNLOADERS)) + r")(\s|$)")


def _downloads_into_interpreter(cmd: Command) -> bool:
    if cmd.stdin_piped and reads_code_from_stdin(cmd) and any(n in DOWNLOADERS for n in cmd.pipe_from):
        return True
    # bash -c "$(curl ...)"  /  bash <(curl ...)  /  sh -c "`wget -O- ...`"
    is_interp = cmd.name in SHELLS or cmd.name in INTERPRETERS or cmd.name == "eval"
    return is_interp and any(_DOWNLOAD_RE.search(src) for src in cmd.sub_sources)


def _download_root_shell(cmd: Command, _ctx: Ctx) -> bool:
    return cmd.elevated and _downloads_into_interpreter(cmd)


def _download_pipe_shell(cmd: Command, _ctx: Ctx) -> bool:
    return _downloads_into_interpreter(cmd)


def _privilege(cmd: Command, _ctx: Ctx) -> bool:
    return cmd.elevated or cmd.name in PRIVILEGE_COMMANDS


_APT_MUTATING = frozenset(
    {
        "install",
        "remove",
        "purge",
        "autoremove",
        "autopurge",
        "upgrade",
        "full-upgrade",
        "dist-upgrade",
        "reinstall",
        "update",
        "build-dep",
        "satisfy",
        "markauto",
        "hold",
        "unhold",
    }
)
_DPKG_SHORT = {"i", "r", "P", "a"}
_DPKG_LONG = {"install", "remove", "purge", "unpack", "configure", "set-selections", "clear-selections"}
_SNAP_MUTATING = frozenset({"install", "remove", "refresh", "revert", "disable", "enable", "switch"})
_FLATPAK_MUTATING = frozenset({"install", "uninstall", "update", "remove"})
_NPM_MUTATING = frozenset(
    {"install", "i", "add", "uninstall", "remove", "rm", "un", "r", "update", "up", "upgrade", "link"}
)
_PIP_MUTATING = frozenset({"install", "uninstall"})


def _package_manage(cmd: Command, _ctx: Ctx) -> bool:
    name = cmd.name
    shorts, longs, positional = options(cmd)
    sub = positional[0] if positional else ""
    if name in ("apt", "apt-get", "aptitude"):
        return sub in _APT_MUTATING
    if name == "dpkg":
        return bool(shorts & _DPKG_SHORT or longs & _DPKG_LONG)
    if name == "snap":
        return sub in _SNAP_MUTATING
    if name == "flatpak":
        return sub in _FLATPAK_MUTATING
    if name in ("npm", "pnpm"):
        is_global = "g" in shorts or "global" in longs or any(a == "--location=global" for a in cmd.argv)
        return is_global and sub in _NPM_MUTATING
    if name == "yarn":
        return sub == "global" and len(positional) > 1 and positional[1] in _NPM_MUTATING
    if re.fullmatch(r"pip(3(\.\d+)?)?|pipx", name):
        return sub in _PIP_MUTATING
    if re.fullmatch(r"python(3(\.\d+)?)?", name):
        argv = cmd.argv
        for i, arg in enumerate(argv[:-1]):
            if arg == "-m" and argv[i + 1] in ("pip", "pip3"):
                rest = [a for a in argv[i + 2 :] if not a.startswith("-")]
                return bool(rest) and rest[0] in _PIP_MUTATING
        return False
    if name in ("gem", "cargo"):
        return sub in ("install", "uninstall")
    return False


_SYSTEMCTL_MUTATING = frozenset(
    {
        "stop",
        "disable",
        "mask",
        "restart",
        "try-restart",
        "reload-or-restart",
        "try-reload-or-restart",
        "kill",
        "isolate",
        "edit",
        "revert",
        "set-property",
        "link",
        "preset",
        "preset-all",
        "daemon-reexec",
    }
)
_POWER_VERBS = frozenset(
    {
        "reboot",
        "poweroff",
        "halt",
        "kexec",
        "suspend",
        "hibernate",
        "hybrid-sleep",
        "suspend-then-hibernate",
        "soft-reboot",
        "rescue",
        "emergency",
    }
)


def _systemctl_system(cmd: Command, _ctx: Ctx) -> bool:
    if cmd.name != "systemctl":
        return False
    _, longs, positional = options(cmd)
    return "user" not in longs and bool(positional) and positional[0] in _SYSTEMCTL_MUTATING


def _power(cmd: Command, _ctx: Ctx) -> bool:
    name = cmd.name
    if name in ("reboot", "shutdown", "poweroff", "halt", "gnome-session-quit"):
        return True
    if name in ("init", "telinit"):
        return _first_positional(cmd) in ("0", "6", "1", "s", "S", "single")
    if name == "systemctl":
        return _first_positional(cmd) in _POWER_VERBS
    if name == "loginctl":
        return _first_positional(cmd) in _POWER_VERBS | {
            "terminate-session",
            "terminate-user",
            "kill-session",
            "kill-user",
        }
    return False


def _kill(cmd: Command, _ctx: Ctx) -> bool:
    if cmd.name in ("pkill", "killall", "killall5", "xkill"):
        return True
    if cmd.name != "kill":
        return False
    argv = cmd.argv
    for i, arg in enumerate(argv):
        if arg.upper() in ("-9", "-KILL", "-SIGKILL"):
            return True
        if arg in ("-s", "-n", "--signal") and i + 1 < len(argv):
            if argv[i + 1].upper().removeprefix("SIG") in ("KILL", "9"):
                return True
        if arg.startswith("--signal=") and arg.split("=", 1)[1].upper().removeprefix("SIG") in ("KILL", "9"):
            return True
    return False


def _git_force_push(cmd: Command, _ctx: Ctx) -> bool:
    if cmd.name != "git":
        return False
    argv = cmd.argv
    if "push" not in argv:
        return False
    rest = argv[argv.index("push") + 1 :]
    for arg in rest:
        if arg in ("-f", "--force", "--mirror", "--delete", "-d", "--prune") or arg.startswith(
            ("--force-with-lease", "--force-if-includes")
        ):
            return True
        if not arg.startswith("-") and (arg.startswith("+") or arg.startswith(":")):
            return True
        if re.fullmatch(r"-[a-zA-Z]*f[a-zA-Z]*", arg):
            return True
    return False


def _crontab_remove(cmd: Command, _ctx: Ctx) -> bool:
    shorts, _, _ = options(cmd)
    return cmd.name == "crontab" and "r" in shorts


def _settings_reset_recursive(cmd: Command, _ctx: Ctx) -> bool:
    if cmd.name == "gsettings":
        return "reset-recursively" in cmd.argv
    if cmd.name == "dconf":
        shorts, _, positional = options(cmd)
        return bool(positional) and positional[0] == "reset" and "f" in shorts
    return False


def _dbus_system(cmd: Command, _ctx: Ctx) -> bool:
    shorts, longs, positional = options(cmd)
    if cmd.name == "gdbus":
        return "system" in longs or "y" in shorts
    if cmd.name == "dbus-send":
        return "system" in longs
    if cmd.name == "busctl":
        mutating = bool(positional) and positional[0] in ("call", "set-property", "emit")
        return mutating and "user" not in longs
    return False


def _dynamic_command(cmd: Command, _ctx: Ctx) -> bool:
    return cmd.dynamic_name


# --------------------------------------------------------------------------------------
# Path predicates
# --------------------------------------------------------------------------------------


def _home_rel(path: str, home: str) -> str | None:
    if strictly_within(path, home):
        return path[len(home.rstrip("/")) + 1 :]
    return None


def is_credential_path(path: str, home: str) -> bool:
    rel = _home_rel(path, home)
    if rel is not None:
        if fnmatch(rel, ".claude/.credentials*"):
            return True
        if rel.startswith(".config/claudeos/") and "token" in os.path.basename(rel).lower():
            return True
    if path in ("/etc/shadow", "/etc/shadow-", "/etc/gshadow", "/etc/gshadow-"):
        return True
    return bool(re.fullmatch(r"/etc/ssh/ssh_host_\w+_key", path))


_SECRET_DIRS = (".ssh", ".gnupg", ".password-store", ".local/share/keyrings", ".pki")
_SECRET_FILES = (
    ".netrc",
    ".git-credentials",
    ".pgpass",
    ".aws/credentials",
    ".docker/config.json",
    ".config/gh/hosts.yml",
    ".kube/config",
)


def is_secret_path(path: str, home: str) -> bool:
    rel = _home_rel(path, home)
    if rel is None:
        return False
    return rel in _SECRET_FILES or any(rel.startswith(d + "/") for d in _SECRET_DIRS)


def _any(target: PathTarget, test: Callable[[str], bool]) -> bool:
    return any(test(p) for p in target.paths)


def _credentials_read(t: PathTarget) -> bool:
    return t.op == "read" and _any(t, lambda p: is_credential_path(p, t.home))


def _credentials_modify(t: PathTarget) -> bool:
    return t.op != "read" and _any(t, lambda p: is_credential_path(p, t.home))


def _claudeos_config(t: PathTarget) -> bool:
    return t.op != "read" and _any(t, lambda p: any(within(p, pre) for pre in CLAUDEOS_PROTECTED))


def _block_device(t: PathTarget) -> bool:
    return t.op != "read" and _any(t, lambda p: bool(BLOCK_DEVICE_RE.match(p)))


def _system_root_delete(t: PathTarget) -> bool:
    return t.op == "delete" and _any(t, lambda p: p in SYSTEM_ROOTS or p == t.home)


def _system_write(t: PathTarget) -> bool:
    if t.op == "read":
        return False

    def test(p: str) -> bool:
        if within(p, t.home) or any(within(p, e) for e in SYSTEM_WRITE_EXCEPTIONS):
            return False
        return any(within(p, pre) for pre in SYSTEM_WRITE_PREFIXES)

    return _any(t, test)


_DOTDIR_ROOTS = (".ssh", ".gnupg", ".config", ".claude", ".local", ".local/share", ".mozilla")


def _home_dotdir_root(t: PathTarget) -> bool:
    return t.op == "delete" and _any(t, lambda p: _home_rel(p, t.home) in _DOTDIR_ROOTS)


def _secret_files(t: PathTarget) -> bool:
    return _any(t, lambda p: is_secret_path(p, t.home))


# --------------------------------------------------------------------------------------
# Tool-parameter predicates (dbus_call, systemd, gsettings)
# --------------------------------------------------------------------------------------


def _dbus_secret_read(p: dict) -> bool:
    dest = str(p.get("dest", ""))
    method = str(p.get("method", ""))
    secret_service = dest in ("org.freedesktop.secrets", "org.gnome.keyring") or "Secret" in method
    return secret_service and "GetSecret" in method


def _dbus_system_bus(p: dict) -> bool:
    return str(p.get("bus", "session")).lower() != "session"


def _dbus_secret_service(p: dict) -> bool:
    return str(p.get("dest", "")) in ("org.freedesktop.secrets", "org.gnome.keyring")


_SESSION_POWER_RE = re.compile(
    r"(org\.gnome\.SessionManager\.(Logout|Shutdown|Reboot|RequestShutdown|RequestReboot)"
    r"|org\.freedesktop\.login1\..*(PowerOff|Reboot|Halt|Suspend|Hibernate|Terminate|Kill))$"
)


def _dbus_session_power(p: dict) -> bool:
    return bool(_SESSION_POWER_RE.search(str(p.get("method", ""))))


_SYSTEMD_READONLY = frozenset({"status", "is-active", "is-enabled", "is-failed", "show", "cat", "list-dependencies"})
_POWER_UNITS_RE = re.compile(r"^(poweroff|reboot|halt|kexec|rescue|emergency|soft-reboot|suspend|hibernate)\.target$")


def _systemd_system_mutate(p: dict) -> bool:
    return str(p.get("scope", "user")) != "user" and str(p.get("action", "")) not in _SYSTEMD_READONLY


def _systemd_power_target(p: dict) -> bool:
    return str(p.get("action", "")) not in _SYSTEMD_READONLY and bool(
        _POWER_UNITS_RE.match(str(p.get("unit", "")))
    )


def _gsettings_reset_recursive(p: dict) -> bool:
    return str(p.get("action", "")) == "reset-recursively"


_MANUAL = " If you really mean it, do it yourself in a terminal."

RULES: tuple[Rule, ...] = (
    # ---- raw shell text -------------------------------------------------------------
    Rule(
        "shell.fork-bomb",
        "raw",
        "block",
        "critical",
        "Fork bomb: would exhaust the process table and freeze the machine." + _MANUAL,
        pattern=re.compile(r"(\S+)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*\1\s*&"),
    ),
    # ---- BLOCK: shell commands -------------------------------------------------------
    Rule("shell.rm-no-preserve-root", "command", "block", "critical",
         "rm --no-preserve-root deletes the whole filesystem." + _MANUAL, _rm_no_preserve_root),
    Rule("shell.mkfs", "command", "block", "critical",
         "Formatting a filesystem destroys everything on it." + _MANUAL, _mkfs),
    Rule("shell.wipe", "command", "block", "critical",
         "wipefs/shred/blkdiscard/cryptsetup-format irreversibly destroy data." + _MANUAL, _wipe),
    Rule("shell.dd-device", "command", "block", "critical",
         "dd writing to a device node overwrites a disk." + _MANUAL, _dd_device),
    Rule("shell.partition-write", "command", "block", "critical",
         "Changing a partition table can destroy every file on the disk." + _MANUAL, _partition_write),
    Rule("shell.chmod-recursive-system", "command", "block", "critical",
         "Recursive chmod/chown of a system directory breaks the OS." + _MANUAL, _chmod_system),
    Rule("shell.download-root-shell", "command", "block", "critical",
         "Piping a network download into a root shell runs unreviewed code as root." + _MANUAL,
         _download_root_shell),
    # ---- CONFIRM: shell commands -----------------------------------------------------
    Rule("shell.rm-unresolved-var", "command", "confirm", "critical",
         "Recursive rm on a path that starts with a variable: if it is empty this deletes from /.",
         _rm_unresolved_var),
    Rule("shell.privilege", "command", "confirm", "high",
         "Runs with administrator privileges (sudo/pkexec/su/doas).", _privilege),
    Rule("shell.download-pipe-shell", "command", "confirm", "high",
         "Executes code downloaded from the network without review.", _download_pipe_shell),
    Rule("shell.package-manage", "command", "confirm", "high",
         "Installs, removes or upgrades software packages.", _package_manage),
    Rule("shell.systemctl-system", "command", "confirm", "high",
         "Stops, restarts, disables or masks a system service.", _systemctl_system),
    Rule("shell.power", "command", "confirm", "high",
         "Reboots, shuts down, suspends or logs out the machine.", _power),
    Rule("shell.git-force-push", "command", "confirm", "high",
         "Force-push / remote delete can destroy commits on the remote.", _git_force_push),
    Rule("shell.crontab-remove", "command", "confirm", "high",
         "crontab -r deletes all scheduled jobs.", _crontab_remove),
    Rule("shell.dbus-system", "command", "confirm", "high",
         "Calls a method on the system D-Bus.", _dbus_system),
    Rule("shell.rm-recursive", "command", "confirm", "medium",
         "Recursive delete outside the working directory's own subfolders.", _rm_recursive_nonlocal),
    Rule("shell.rm-many", "command", "confirm", "medium",
         "Deletes many files at once (more than 5 paths, wildcards or xargs).", _rm_many),
    Rule("shell.kill", "command", "confirm", "medium",
         "Force-kills processes (kill -9 / pkill / killall); unsaved work may be lost.", _kill),
    Rule("shell.settings-reset-recursive", "command", "confirm", "medium",
         "Resets a whole tree of desktop settings.", _settings_reset_recursive),
    Rule("shell.dynamic-command", "command", "confirm", "medium",
         "The command name is computed at run time, so it cannot be checked.", _dynamic_command),
    # ---- paths (file tools, Write/Edit/Read, and every path a shell command touches) -----
    Rule("path.credentials-read", "path", "block", "critical",
         "Reads a credential/token file; its contents must never enter the conversation." + _MANUAL,
         _credentials_read),
    Rule("path.claudeos-config", "path", "block", "critical",
         "Modifies ClaudeOS's own safety configuration." + _MANUAL, _claudeos_config),
    Rule("path.block-device", "path", "block", "critical",
         "Writes directly to a disk device." + _MANUAL, _block_device),
    Rule("path.system-root-delete", "path", "block", "critical",
         "Deletes a top-level system directory or the whole home folder." + _MANUAL, _system_root_delete),
    Rule("path.credentials-modify", "path", "confirm", "high",
         "Changes or deletes a credential/token file (you may be signed out).", _credentials_modify),
    Rule("path.secret-files", "path", "confirm", "high",
         "Touches SSH/GPG keys or other secrets.", _secret_files),
    Rule("path.system-write", "path", "confirm", "high",
         "Writes or deletes under a system directory (/etc, /usr, /boot, /var, /opt, ...).", _system_write),
    Rule("path.home-dotdir-root", "path", "confirm", "high",
         "Deletes or moves a whole configuration folder (~/.ssh, ~/.gnupg, ~/.config, ...).",
         _home_dotdir_root),
    # ---- other tools -----------------------------------------------------------------
    Rule("dbus.secret-read", "dbus", "block", "critical",
         "Reads secrets from the keyring over D-Bus." + _MANUAL, _dbus_secret_read),
    Rule("dbus.system-bus", "dbus", "confirm", "high",
         "Calls a method on the system D-Bus.", _dbus_system_bus),
    Rule("dbus.secret-service", "dbus", "confirm", "high",
         "Talks to the keyring (Secret Service).", _dbus_secret_service),
    Rule("dbus.session-power", "dbus", "confirm", "high",
         "Logs out, reboots or shuts down via D-Bus.", _dbus_session_power),
    Rule("systemd.power-target", "systemd", "confirm", "high",
         "Starts a power/rescue target (reboot, poweroff, ...).", _systemd_power_target),
    Rule("systemd.system-mutate", "systemd", "confirm", "high",
         "Changes the state of a system service.", _systemd_system_mutate),
    Rule("gsettings.reset-recursive", "gsettings", "confirm", "medium",
         "Resets every key of a settings schema.", _gsettings_reset_recursive),
)

# Verdicts produced by the classifier itself rather than by a table lookup.
UNPARSEABLE = Verdict("confirm", "medium", "The shell command could not be parsed reliably.", "shell.unparseable")
TOO_DEEP = Verdict("confirm", "medium", "Too many nested shells/substitutions to check.", "shell.too-deep")
PERMANENT_DELETE = Verdict("confirm", "high", "Permanently deletes (bypasses the trash).", "file.permanent-delete")
UNKNOWN_TOOL = Verdict("confirm", "medium", "Unknown tool: asking the user.", "tool.unknown")


def rules_for(domain: str) -> tuple[Rule, ...]:
    return tuple(r for r in RULES if r.domain == domain)


def all_rule_ids() -> list[str]:
    extra = [UNPARSEABLE.rule_id, TOO_DEEP.rule_id, PERMANENT_DELETE.rule_id, UNKNOWN_TOOL.rule_id]
    return [r.id for r in RULES] + extra
