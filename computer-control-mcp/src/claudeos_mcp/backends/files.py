"""File operations behind the files tools. Callers gate every call through the safety layer first;
this module enforces size limits, refuses binary content and keeps writes atomic."""

from __future__ import annotations

import fnmatch
import os
import shutil
import stat
import tempfile
import time
from dataclasses import dataclass

from ..config import READ_DEFAULT_BYTES, READ_MAX_BYTES
from ..runner import Runner
from ..safety.rules import is_credential_path

IMAGE_TYPES = {
    b"\x89PNG\r\n\x1a\n": "png",
    b"\xff\xd8\xff": "jpeg",
    b"GIF87a": "gif",
    b"GIF89a": "gif",
}
_SKIP_DIRS = frozenset({".git", "node_modules", "__pycache__", ".venv", ".cache"})
_SEARCH_MAX_FILE = 2 * 1024 * 1024


class FileToolError(RuntimeError):
    pass


def expand(path: str, home: str) -> str:
    """Absolute path: ``~``/``$HOME`` expanded, relative paths taken from the home folder."""
    path = path.strip()
    if not path:
        raise FileToolError("Empty path.")
    if path == "~" or path.startswith("~/"):
        path = home + path[1:]
    elif path == "$HOME" or path.startswith("$HOME/"):
        path = home + path[5:]
    if not os.path.isabs(path):
        path = os.path.join(home, path)
    return os.path.normpath(path)


def _image_type(head: bytes) -> str | None:
    for magic, kind in IMAGE_TYPES.items():
        if head.startswith(magic):
            return kind
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


@dataclass(frozen=True)
class ReadResult:
    text: str | None = None
    image: bytes | None = None
    image_format: str = ""


def read_file(path: str, *, offset: int = 0, max_bytes: int = READ_DEFAULT_BYTES) -> ReadResult:
    if not os.path.exists(path):
        raise FileToolError(f"{path} does not exist.")
    if os.path.isdir(path):
        raise FileToolError(f"{path} is a directory; use list_dir.")
    max_bytes = max(1, min(int(max_bytes), READ_MAX_BYTES))
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        head = fh.read(8192)
        kind = _image_type(head)
        if kind is not None:
            if size > READ_MAX_BYTES:
                raise FileToolError(f"{path} is a {size}-byte image; the limit is {READ_MAX_BYTES} bytes.")
            fh.seek(0)
            return ReadResult(image=fh.read(), image_format=kind)
        if b"\x00" in head:
            raise FileToolError(
                f"{path} looks like a binary file ({size} bytes); it is not shown. "
                "Use run_command with a suitable tool (file, xxd -l 256, strings) if you need to inspect it."
            )
        fh.seek(max(0, offset))
        data = fh.read(max_bytes)
    text = data.decode("utf-8", "replace")
    end = max(0, offset) + len(data)
    header = f"{path} ({size} bytes; showing bytes {max(0, offset)}–{end})"
    if end < size:
        header += f"; {size - end} more bytes: call again with offset={end}"
    return ReadResult(text=header + "\n" + text)


def write_file(path: str, content: str, *, append: bool = False, create_dirs: bool = False) -> str:
    parent = os.path.dirname(path)
    if not os.path.isdir(parent):
        if not create_dirs:
            raise FileToolError(f"Folder {parent} does not exist (pass create_dirs=true to create it).")
        os.makedirs(parent, exist_ok=True)
    if os.path.isdir(path):
        raise FileToolError(f"{path} is a directory.")
    data = content.encode("utf-8")
    if append:
        with open(path, "ab") as fh:
            fh.write(data)
        return f"Appended {len(data)} bytes to {path}."
    mode = stat.S_IMODE(os.stat(path).st_mode) if os.path.exists(path) else None
    fd, tmp = tempfile.mkstemp(prefix=".claudeos-", dir=parent)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return f"Wrote {len(data)} bytes to {path}."


def _human(size: int) -> str:
    value = float(size)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024 or unit == "GiB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{size} B"


def list_dir(path: str, *, show_hidden: bool = False, limit: int = 500) -> str:
    if not os.path.isdir(path):
        raise FileToolError(f"{path} is not a directory.")
    with os.scandir(path) as it:
        entries = sorted(
            (e for e in it if show_hidden or not e.name.startswith(".")),
            key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()),
        )
    lines = [f"{path} ({len(entries)} entries{'' if show_hidden else ', hidden files omitted'})"]
    for entry in entries[:limit]:
        try:
            st = entry.stat(follow_symlinks=False)
        except OSError:
            lines.append(f"?    {entry.name}")
            continue
        if entry.is_symlink():
            kind, size = "link", "-> " + os.readlink(entry.path)
        elif entry.is_dir(follow_symlinks=False):
            kind, size = "dir ", ""
        else:
            kind, size = "file", _human(st.st_size)
        mtime = time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))
        lines.append(f"{kind} {mtime}  {entry.name}{'/' if kind == 'dir ' else ''}  {size}".rstrip())
    if len(entries) > limit:
        lines.append(f"... {len(entries) - limit} more (raise limit to see them)")
    return "\n".join(lines)


def search_files(
    root: str,
    *,
    home: str,
    name_pattern: str = "*",
    contains: str | None = None,
    max_results: int = 200,
    max_depth: int = 8,
) -> str:
    if not os.path.isdir(root):
        raise FileToolError(f"{root} is not a directory.")
    max_results = max(1, min(max_results, 2000))
    results: list[str] = []
    needle = contains.lower() if contains else None
    root_depth = root.rstrip("/").count("/")
    skipped_secret = 0
    for dirpath, dirnames, filenames in os.walk(root):
        depth = dirpath.rstrip("/").count("/") - root_depth
        dirnames[:] = sorted(d for d in dirnames if d not in _SKIP_DIRS and depth < max_depth)
        for fname in sorted(filenames):
            full = os.path.join(dirpath, fname)
            if not fnmatch.fnmatch(fname.lower(), name_pattern.lower()):
                continue
            if needle is not None:
                if is_credential_path(full, home):
                    skipped_secret += 1
                    continue
                line = _first_match(full, needle)
                if line is None:
                    continue
                results.append(f"{full}:{line[0]}: {line[1][:200]}")
            else:
                results.append(full)
            if len(results) >= max_results:
                return "\n".join(results + [f"... stopped at {max_results} results"])
    footer = [f"({skipped_secret} credential files skipped)"] if skipped_secret else []
    return "\n".join(results + footer) if results else "No matches." + (" " + footer[0] if footer else "")


def _first_match(path: str, needle: str) -> tuple[int, str] | None:
    try:
        if os.path.getsize(path) > _SEARCH_MAX_FILE:
            return None
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError:
        return None
    if b"\x00" in data[:8192]:
        return None
    for number, line in enumerate(data.decode("utf-8", "replace").splitlines(), start=1):
        if needle in line.lower():
            return number, line.strip()
    return None


def move_path(source: str, destination: str, *, overwrite: bool = False) -> str:
    if not os.path.lexists(source):
        raise FileToolError(f"{source} does not exist.")
    target = os.path.join(destination, os.path.basename(source)) if os.path.isdir(destination) else destination
    if os.path.lexists(target) and not overwrite:
        raise FileToolError(f"{target} already exists (pass overwrite=true to replace it).")
    shutil.move(source, target)
    return f"Moved {source} → {target}."


def delete_path(path: str, *, permanent: bool, runner: Runner) -> str:
    if not os.path.lexists(path):
        raise FileToolError(f"{path} does not exist.")
    if not permanent:
        if not runner.which("gio"):
            raise FileToolError("gio is not installed, so nothing can be moved to the trash (libglib2.0-bin).")
        result = runner.run(["gio", "trash", "--", path], timeout=60)
        if not result.ok:
            raise FileToolError(f"Moving {path} to the trash failed: {result.describe_failure()}")
        return f"Moved {path} to the trash (restore it from the Files app's Trash)."
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    else:
        os.unlink(path)
    return f"Permanently deleted {path}."
