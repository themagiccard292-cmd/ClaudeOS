"""Menu behaviour: what the extension offers for which selection."""

from __future__ import annotations

import importlib.util
import logging
import shutil
import sys
from pathlib import Path
from typing import Any

import pytest
from conftest import ROOT, FakeFileInfo, FakeGFile, build_fake_gi, file_info, import_extension


def only_item(items: list[Any]) -> Any:
    assert len(items) == 1
    return items[0]


def attached(item: Any) -> list[str]:
    """The paths the menu item will attach (the user data bound to its ``activate`` signal)."""
    ((_signal, _callback, user_data),) = item._handlers
    return list(user_data[0])


# --------------------------------------------------------------------------- the item itself


def test_item_label_name_tip_icon(provider: Any) -> None:
    item = only_item(provider.get_file_items([file_info("/home/u/a.txt")]))
    assert item.label == "Ask Claude"
    assert item.name == "ClaudeOS::AskClaude"
    assert item.tip == "Open the Claude side panel with the selected items attached"
    assert item.icon == "claudeos-panel"


def test_menu_item_is_created_with_keyword_properties_only(provider: Any) -> None:
    # The fake MenuItem is keyword-only like a real GObject constructor; this would TypeError.
    assert provider.get_file_items([file_info("/x")])


def test_provider_derives_from_gobject_and_menu_provider(ext: Any) -> None:
    nautilus = sys.modules["gi.repository.Nautilus"]
    gobject = sys.modules["gi.repository.GObject"]
    assert issubclass(ext.AskClaudeProvider, gobject.GObject)
    assert issubclass(ext.AskClaudeProvider, nautilus.MenuProvider)


# --------------------------------------------------------------------------- selections


def test_single_file(provider: Any) -> None:
    item = only_item(provider.get_file_items([file_info("/home/u/notes.md")]))
    assert attached(item) == ["/home/u/notes.md"]


def test_single_folder(provider: Any) -> None:
    item = only_item(provider.get_file_items([file_info("/home/u/Projects", directory=True)]))
    assert attached(item) == ["/home/u/Projects"]


def test_multi_selection_keeps_order(provider: Any) -> None:
    files = [file_info(p) for p in ("/z/last.txt", "/a/first.txt", "/m/middle.txt")]
    item = only_item(provider.get_file_items(files))
    assert attached(item) == ["/z/last.txt", "/a/first.txt", "/m/middle.txt"]


def test_mixed_files_and_folders(provider: Any) -> None:
    files = [
        file_info("/home/u/a.txt"),
        file_info("/home/u/dir", directory=True),
        file_info("/home/u/b.png"),
    ]
    item = only_item(provider.get_file_items(files))
    assert attached(item) == ["/home/u/a.txt", "/home/u/dir", "/home/u/b.png"]


@pytest.mark.parametrize(
    ("uri", "expected"),
    [
        ("file:///home/u/My%20Notes.txt", "/home/u/My Notes.txt"),
        ("file:///home/u/%E6%97%A5%E6%9C%AC%E8%AA%9E/%C3%A9t%C3%A9.txt", "/home/u/日本語/été.txt"),
        ("file:///home/u/100%25%20done%23final%3F.txt", "/home/u/100% done#final?.txt"),
        ("file://localhost/home/u/a.txt", "/home/u/a.txt"),
        ("file:///", "/"),
    ],
)
def test_percent_encoding_and_unicode(provider: Any, uri: str, expected: str) -> None:
    item = only_item(provider.get_file_items([FakeFileInfo(uri)]))
    assert attached(item) == [expected]


def test_paths_built_from_awkward_names_round_trip(provider: Any) -> None:
    names = ["/tmp/a b/c  d.txt", "/tmp/ünï/中文 文件.txt", "/tmp/x%20y/100%.txt", "/tmp/-rf"]
    item = only_item(provider.get_file_items([file_info(p) for p in names]))
    assert attached(item) == names


def test_gvfs_fuse_path_is_used_for_mounted_remote_locations(provider: Any) -> None:
    FakeGFile.fuse_mounts["sftp://nas.local"] = "/run/user/1000/gvfs/sftp:host=nas.local"
    remote = FakeFileInfo("sftp://nas.local/home/u/My%20Doc.txt")
    item = only_item(provider.get_file_items([remote]))
    assert attached(item) == ["/run/user/1000/gvfs/sftp:host=nas.local/home/u/My Doc.txt"]


@pytest.mark.parametrize(
    "uri",
    [
        "trash:///old.txt",
        "trash:///",
        "recent:///",
        "recent:///doc.pdf",
        "starred:///",
        "smb://server/share/file.txt",
        "sftp://host/home/u/file.txt",
        "ftp://host/pub/file",
        "https://example.com/file.txt",
        "network:///",
        "computer:///",
        "x-nautilus-desktop:///",
    ],
)
def test_items_without_a_local_path_are_skipped(provider: Any, uri: str) -> None:
    assert provider.get_file_items([FakeFileInfo(uri)]) == []


def test_non_local_items_are_dropped_from_a_mixed_selection(provider: Any) -> None:
    files = [FakeFileInfo("trash:///a"), file_info("/home/u/keep.txt"), FakeFileInfo("smb://h/s/b")]
    item = only_item(provider.get_file_items(files))
    assert attached(item) == ["/home/u/keep.txt"]


def test_relative_paths_are_never_attached(provider: Any) -> None:
    class RelativeLocation(FakeFileInfo):
        def get_location(self) -> Any:
            class Loc:
                def get_path(self) -> str:
                    return "relative/file.txt"

            return Loc()

    assert provider.get_file_items([RelativeLocation("file:///x")]) == []


def test_duplicates_are_removed_keeping_first_position(provider: Any) -> None:
    files = [file_info(p) for p in ("/a", "/b", "/a", "/c", "/b", "/a")]
    item = only_item(provider.get_file_items(files))
    assert attached(item) == ["/a", "/b", "/c"]


def test_different_uri_spellings_of_one_path_are_deduplicated(provider: Any) -> None:
    files = [FakeFileInfo("file:///home/u/a%20b"), FakeFileInfo("file://localhost/home/u/a%20b")]
    assert attached(only_item(provider.get_file_items(files))) == ["/home/u/a b"]


def test_no_menu_item_for_empty_selection(provider: Any) -> None:
    assert provider.get_file_items([]) == []


def test_no_menu_item_when_nothing_is_local(provider: Any) -> None:
    assert provider.get_file_items([FakeFileInfo("trash:///a"), FakeFileInfo("recent:///b")]) == []


# --------------------------------------------------------------------------- the 64-path cap


def test_collect_paths_stops_one_past_the_cap(ext: Any) -> None:
    seen = 0

    def many() -> Any:
        nonlocal seen
        for n in range(10_000):
            seen += 1
            yield file_info(f"/data/file-{n}")

    paths = ext.collect_paths(many())
    assert len(paths) == ext.MAX_PATHS + 1 == 65
    assert seen == 65  # a huge selection does not make the menu slow


def test_menu_still_appears_for_a_huge_selection(provider: Any) -> None:
    item = only_item(provider.get_file_items([file_info(f"/d/f{n}") for n in range(500)]))
    assert len(attached(item)) == 65


def test_cap_counts_unique_paths_not_selected_items(ext: Any) -> None:
    items = [file_info(f"/d/f{n % 10}") for n in range(1000)]
    assert len(ext.collect_paths(items)) == 10


# --------------------------------------------------------------------------- background


def test_background_item_attaches_the_current_folder(provider: Any) -> None:
    folder = file_info("/home/u/My Folder", directory=True)
    item = only_item(provider.get_background_items(folder))
    assert item.label == "Ask Claude"
    assert item.name == "ClaudeOS::AskClaude"
    assert attached(item) == ["/home/u/My Folder"]


@pytest.mark.parametrize("uri", ["trash:///", "recent:///", "network:///", "smb://h/share/"])
def test_background_item_absent_in_virtual_locations(provider: Any, uri: str) -> None:
    assert provider.get_background_items(FakeFileInfo(uri, directory=True)) == []


# --------------------------------------------------------------------------- API compatibility


def test_nautilus3_signatures_are_tolerated(provider: Any) -> None:
    window = object()
    files = [file_info("/home/u/a.txt")]
    assert attached(only_item(provider.get_file_items(window, files))) == ["/home/u/a.txt"]
    folder = file_info("/home/u", directory=True)
    assert attached(only_item(provider.get_background_items(window, folder))) == ["/home/u"]


def test_callbacks_without_arguments_return_nothing(provider: Any) -> None:
    assert provider.get_file_items() == []
    assert provider.get_background_items() == []


def test_requires_nautilus_4_first(ext: Any) -> None:
    assert sys.modules["gi"].required == [("Nautilus", "4.0")]


def test_falls_back_to_nautilus_3_typelib(monkeypatch: pytest.MonkeyPatch) -> None:
    module = import_extension(monkeypatch, nautilus_versions=("3.0",))
    assert sys.modules["gi"].required == [("Nautilus", "4.0"), ("Nautilus", "3.0")]
    assert module.Nautilus is not None
    assert module.AskClaudeProvider().get_file_items(object(), [file_info("/a")])


def test_module_imports_without_pygobject(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "gi", None)  # makes `import gi` raise ImportError
    for name in ("Nautilus", "GObject", "Gio", "GLib"):
        monkeypatch.setitem(sys.modules, f"gi.repository.{name}", None)
    monkeypatch.delitem(sys.modules, "claudeos_ask_claude", raising=False)
    import claudeos_ask_claude as bare

    assert bare.Nautilus is None
    assert bare.build_command("/usr/bin/claudeos-panel", ["/a"])[1:] == ["attach", "--", "/a"]
    provider = bare.AskClaudeProvider()
    assert provider.get_file_items([file_info("/a")]) == []
    assert provider.get_background_items(file_info("/a")) == []
    sys.modules.pop("claudeos_ask_claude", None)


# --------------------------------------------------------------------------- robustness


def test_location_missing_falls_back_to_the_uri(provider: Any) -> None:
    class NoLocation(FakeFileInfo):
        def get_location(self) -> Any:
            return None

    item = only_item(provider.get_file_items([NoLocation("file:///home/u/a%20b.txt")]))
    assert attached(item) == ["/home/u/a b.txt"]


def test_one_broken_item_does_not_hide_the_menu(
    provider: Any, caplog: pytest.LogCaptureFixture
) -> None:
    class Broken(FakeFileInfo):
        def get_location(self) -> Any:
            raise RuntimeError("boom")

    with caplog.at_level(logging.ERROR, logger="claudeos.nautilus"):
        item = only_item(provider.get_file_items([Broken("file:///x"), file_info("/ok")]))
    assert attached(item) == ["/ok"]
    assert "cannot resolve" in caplog.text


@pytest.mark.parametrize("payload", [None, 42, object()])
def test_never_raises_out_of_get_file_items(
    provider: Any, payload: Any, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.ERROR, logger="claudeos.nautilus"):
        assert provider.get_file_items(payload) == []
        assert provider.get_background_items(payload) == []
    assert "Ask Claude" in caplog.text


def test_loads_by_file_path_with_exactly_one_provider_class(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """nautilus-python loads the file by path and instantiates every provider class in it."""
    for name, module in build_fake_gi().items():
        monkeypatch.setitem(sys.modules, name, module)
    installed = tmp_path / "claudeos_ask_claude.py"
    shutil.copy(ROOT / "claudeos_ask_claude.py", installed)
    spec = importlib.util.spec_from_file_location("claudeos_ask_claude_by_path", installed)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    provider_base = sys.modules["gi.repository.Nautilus"].MenuProvider
    providers = [
        value
        for value in vars(module).values()
        if isinstance(value, type) and issubclass(value, provider_base)
    ]
    assert providers == [module.AskClaudeProvider]
    assert providers[0]().get_file_items([file_info("/a")])
