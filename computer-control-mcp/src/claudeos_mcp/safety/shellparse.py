"""A small, quote-aware POSIX shell lexer for the safety classifier.

It is NOT a shell. It understands enough of bash's surface syntax to find every command
a string would run, so that obfuscation does not hide one:

- quoting: '...', "...", $'...' (ANSI-C, decoded), backslash escapes (``\\rm`` → ``rm``, ``r""m`` → ``rm``);
- operators ``; & && || | |& ( )`` and unquoted newlines split commands;
- redirections (``> >> &> 2> < <<< <<``) are kept apart from words; here-doc bodies are skipped as data;
- ``$(...)``, backticks and ``<(...)``/``>(...)`` are extracted as nested sources to classify recursively;
- ``~``, ``~user``, ``$HOME``/``${HOME}``/``$USER`` are expanded; any other expansion becomes the
  :data:`DYNAMIC` marker so rules can treat the value as unknown.

Anything it cannot make sense of raises :class:`ParseError`; the classifier answers that with
"confirm" (fail closed).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field

DYNAMIC = "\x00"  # stands for text only known at run time (unknown $VAR, $(...), $((...)))

OPERATORS = ("&&", "||", ";;", "|&", ";", "&", "|", "(", ")")
REDIRECTS = ("&>>", "<<<", "<<-", "&>", ">>", ">|", ">&", "<&", "<>", "<<", ">", "<")
_WORD_BREAK = set(" \t\n;&|()<>")
_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_KNOWN_VARS = ("HOME", "USER", "LOGNAME", "PWD")


class ParseError(ValueError):
    """Raised for input the lexer cannot tokenize reliably (e.g. unbalanced quotes)."""


@dataclass
class Word:
    value: str
    quoted: bool = False  # some part was quoted or escaped
    glob: bool = False  # contains an unquoted * ? or [
    subs: list[str] = field(default_factory=list)  # command substitutions inside this word

    @property
    def dynamic(self) -> bool:
        return DYNAMIC in self.value


@dataclass
class Token:
    kind: str  # "word" | "op" | "redir"
    text: str = ""
    word: Word | None = None


@dataclass
class Segment:
    """One simple command: words, its redirections and the operator that preceded it."""

    words: list[Word] = field(default_factory=list)
    redirects: list[tuple[str, Word]] = field(default_factory=list)
    connector: str = ""  # operator before this segment ("" for the first)

    @property
    def piped(self) -> bool:
        return self.connector in ("|", "|&")


@dataclass
class Parsed:
    segments: list[Segment]
    substitutions: list[str]  # every $(...) / `...` / <(...) body, to classify recursively


_ANSI_SIMPLE = {
    "a": "\a",
    "b": "\b",
    "e": "\x1b",
    "E": "\x1b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
}


def decode_ansi_c(body: str) -> str:
    """Decode the body of a ``$'...'`` string (\\xHH, \\uHHHH, \\NNN octal, \\n, ...)."""
    out: list[str] = []
    i = 0
    while i < len(body):
        c = body[i]
        if c != "\\" or i + 1 >= len(body):
            out.append(c)
            i += 1
            continue
        n = body[i + 1]
        if n in _ANSI_SIMPLE:
            out.append(_ANSI_SIMPLE[n])
            i += 2
        elif n == "x":
            m = re.match(r"[0-9A-Fa-f]{1,2}", body[i + 2 :])
            if m:
                out.append(chr(int(m.group(), 16)))
                i += 2 + len(m.group())
            else:
                out.append("\\x")
                i += 2
        elif n in "uU":
            m = re.match(r"[0-9A-Fa-f]{1,8}" if n == "U" else r"[0-9A-Fa-f]{1,4}", body[i + 2 :])
            if m:
                out.append(chr(min(int(m.group(), 16), 0x10FFFF)))
                i += 2 + len(m.group())
            else:
                out.append("\\" + n)
                i += 2
        elif n in "01234567":
            m = re.match(r"[0-7]{1,3}", body[i + 1 :])
            assert m is not None
            out.append(chr(int(m.group(), 8) & 0xFF))
            i += 1 + len(m.group())
        elif n == "c" and i + 2 < len(body):
            out.append(chr(ord(body[i + 2]) & 0x1F))
            i += 3
        else:
            out.append("\\" + n)
            i += 2
    return "".join(out)


class _Lexer:
    def __init__(self, src: str, env: Mapping[str, str]) -> None:
        self.s = src
        self.i = 0
        self.env = env
        self.tokens: list[Token] = []
        self.subs: list[str] = []
        self._pending_heredocs: list[tuple[str, bool]] = []
        self._want_heredoc: str | None = None

    # -- helpers -------------------------------------------------------------------------
    def _peek(self, offset: int = 0) -> str:
        j = self.i + offset
        return self.s[j] if j < len(self.s) else ""

    def _startswith_any(self, options: tuple[str, ...]) -> str | None:
        for opt in options:
            if self.s.startswith(opt, self.i):
                return opt
        return None

    def _capture_balanced(self, start: int) -> tuple[str, int]:
        """Return (body, index after closing paren) for a '(' that opened just before ``start``."""
        depth = 1
        j = start
        s = self.s
        while j < len(s):
            c = s[j]
            if c == "\\":
                j += 2
                continue
            if c == "'":
                end = s.find("'", j + 1)
                if end < 0:
                    raise ParseError("unterminated single quote inside $(...)")
                j = end + 1
                continue
            if c == '"':
                j = self._skip_dquote(j + 1)
                continue
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    return s[start:j], j + 1
            j += 1
        raise ParseError("unbalanced parentheses")

    def _skip_dquote(self, j: int) -> int:
        s = self.s
        while j < len(s):
            if s[j] == "\\":
                j += 2
                continue
            if s[j] == '"':
                return j + 1
            j += 1
        raise ParseError("unterminated double quote")

    def _capture_backtick(self, start: int) -> tuple[str, int]:
        j = start
        out: list[str] = []
        while j < len(self.s):
            c = self.s[j]
            if c == "\\" and j + 1 < len(self.s):
                out.append(self.s[j + 1])
                j += 2
                continue
            if c == "`":
                return "".join(out), j + 1
            out.append(c)
            j += 1
        raise ParseError("unterminated backtick")

    def _substitution(self, body: str) -> str:
        """Record a nested command and return its best-effort static value."""
        self.subs.append(body)
        return _static_echo_value(body, self.env)

    # -- main loop -----------------------------------------------------------------------
    def run(self) -> list[Token]:
        s = self.s
        while self.i < len(s):
            c = s[self.i]
            if c in " \t\r":
                self.i += 1
            elif c == "\\" and self._peek(1) == "\n":
                self.i += 2
            elif c == "\n":
                self.tokens.append(Token("op", ";"))
                self.i += 1
                self._read_heredoc_bodies()
            elif c == "#":
                end = s.find("\n", self.i)
                self.i = len(s) if end < 0 else end
            elif c in "<>" and self._peek(1) == "(":
                body, self.i = self._capture_balanced(self.i + 2)
                self.subs.append(body)
                self.tokens.append(Token("word", word=Word(DYNAMIC, subs=[body])))
            elif (redir := self._startswith_any(REDIRECTS)) is not None:
                self.i += len(redir)
                self.tokens.append(Token("redir", redir))
                if redir in ("<<", "<<-"):
                    self._want_heredoc = redir
            elif (op := self._startswith_any(OPERATORS)) is not None:
                self.i += len(op)
                self.tokens.append(Token("op", op))
            else:
                word = self._word()
                # "2>file": a bare number glued to a redirection is a file descriptor, not an argument.
                if not word.quoted and word.value.isdigit() and self._peek() in ("<", ">"):
                    continue
                if self._want_heredoc is not None:
                    self._pending_heredocs.append((word.value, self._want_heredoc == "<<-"))
                    self._want_heredoc = None
                self.tokens.append(Token("word", word=word))
        return self.tokens

    def _read_heredoc_bodies(self) -> None:
        """Skip here-document bodies: they are data, not commands."""
        while self._pending_heredocs:
            delim, strip_tabs = self._pending_heredocs.pop(0)
            while self.i < len(self.s):
                end = self.s.find("\n", self.i)
                line = self.s[self.i : len(self.s) if end < 0 else end]
                self.i = len(self.s) if end < 0 else end + 1
                if (line.lstrip("\t") if strip_tabs else line) == delim:
                    break

    def _word(self) -> Word:
        s = self.s
        buf: list[str] = []
        word = Word("")
        start = self.i
        while self.i < len(s):
            c = s[self.i]
            if c in _WORD_BREAK:
                break
            if c == "'":
                end = s.find("'", self.i + 1)
                if end < 0:
                    raise ParseError("unterminated single quote")
                buf.append(s[self.i + 1 : end])
                word.quoted = True
                self.i = end + 1
            elif c == '"':
                self.i += 1
                buf.append(self._dquote(word))
                word.quoted = True
            elif c == "\\":
                if self.i + 1 < len(s):
                    if s[self.i + 1] != "\n":
                        buf.append(s[self.i + 1])
                    self.i += 2
                else:
                    buf.append("\\")
                    self.i += 1
                word.quoted = True
            elif c == "$":
                buf.append(self._dollar(word, in_dquote=False))
            elif c == "`":
                body, self.i = self._capture_backtick(self.i + 1)
                word.subs.append(body)
                buf.append(self._substitution(body))
            elif c == "~" and self.i == start:
                buf.append(self._tilde())
            else:
                if c in "*?[":
                    word.glob = True
                buf.append(c)
                self.i += 1
        word.value = "".join(buf)
        return word

    def _tilde(self) -> str:
        s = self.s
        j = self.i + 1
        while j < len(s) and s[j] not in _WORD_BREAK and s[j] != "/":
            j += 1
        user = s[self.i + 1 : j]
        self.i = j
        home = self.env.get("HOME", "")
        if user == "":
            return home or DYNAMIC
        if user == "+":
            return self.env.get("PWD", DYNAMIC)
        if _NAME_RE.fullmatch(user) or re.fullmatch(r"[a-z_][a-z0-9_-]*\$?", user):
            if user == self.env.get("USER") and home:
                return home
            return "/root" if user == "root" else f"/home/{user}"
        return "~" + user

    def _dquote(self, word: Word) -> str:
        s = self.s
        out: list[str] = []
        while self.i < len(s):
            c = s[self.i]
            if c == '"':
                self.i += 1
                return "".join(out)
            if c == "\\" and self.i + 1 < len(s):
                nxt = s[self.i + 1]
                if nxt in '$`"\\':
                    out.append(nxt)
                elif nxt != "\n":
                    out.append("\\" + nxt)
                self.i += 2
            elif c == "$":
                out.append(self._dollar(word, in_dquote=True))
            elif c == "`":
                body, self.i = self._capture_backtick(self.i + 1)
                word.subs.append(body)
                out.append(self._substitution(body))
            else:
                out.append(c)
                self.i += 1
        raise ParseError("unterminated double quote")

    def _dollar(self, word: Word, *, in_dquote: bool) -> str:
        s = self.s
        nxt = self._peek(1)
        if nxt == "'" and not in_dquote:
            end = self.i + 2
            while end < len(s) and s[end] != "'":
                end += 2 if s[end] == "\\" else 1
            if end >= len(s):
                raise ParseError("unterminated $'...' string")
            word.quoted = True
            value = decode_ansi_c(s[self.i + 2 : end])
            self.i = end + 1
            return value
        if nxt == '"' and not in_dquote:
            self.i += 2
            word.quoted = True
            return self._dquote(word)
        if s.startswith("$((", self.i):
            _, self.i = self._capture_balanced(self.i + 3)
            if self._peek() == ")":
                self.i += 1
            return DYNAMIC
        if nxt == "(":
            body, self.i = self._capture_balanced(self.i + 2)
            word.subs.append(body)
            return self._substitution(body)
        if nxt == "{":
            end = s.find("}", self.i + 2)
            if end < 0:
                raise ParseError("unterminated ${...}")
            name = s[self.i + 2 : end]
            self.i = end + 1
            if name in _KNOWN_VARS and self.env.get(name):
                return self.env[name]
            return DYNAMIC
        m = _NAME_RE.match(s, self.i + 1)
        if m:
            self.i = m.end()
            name = m.group()
            if name in _KNOWN_VARS and self.env.get(name):
                return self.env[name]
            return DYNAMIC
        if nxt and (nxt.isdigit() or nxt in "@*#?$!-"):
            self.i += 2
            return DYNAMIC
        self.i += 1
        return "$"


def _static_echo_value(body: str, env: Mapping[str, str]) -> str:
    """Value of ``$(echo rm)`` / ``$(printf rm)`` style substitutions; DYNAMIC otherwise."""
    try:
        tokens = _Lexer(body, env).run()
    except ParseError:
        return DYNAMIC
    if not tokens or any(t.kind != "word" for t in tokens):
        return DYNAMIC
    words = [t.word for t in tokens if t.word is not None]
    if any(w.dynamic or w.glob for w in words):
        return DYNAMIC
    name, args = words[0].value, [w.value for w in words[1:]]
    if name == "echo":
        while args and args[0] in ("-n", "-e", "-E", "-ne", "-en"):
            args = args[1:]
        return " ".join(args)
    if name == "printf" and args:
        fmt, rest = args[0], args[1:]
        if "%" not in fmt and not rest:
            return decode_ansi_c(fmt)
        if fmt in ("%s", "%s\\n") and rest:
            return "".join(rest)
    return DYNAMIC


def tokenize(source: str, env: Mapping[str, str]) -> tuple[list[Token], list[str]]:
    lexer = _Lexer(source, env)
    tokens = lexer.run()
    return tokens, lexer.subs


def parse(source: str, env: Mapping[str, str]) -> Parsed:
    """Split ``source`` into simple-command segments (see module docstring)."""
    tokens, subs = tokenize(source, env)
    segments: list[Segment] = []
    current = Segment()
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok.kind == "op":
            if current.words or current.redirects:
                segments.append(current)
            current = Segment(connector=tok.text)
        elif tok.kind == "redir":
            target = tokens[i + 1] if i + 1 < len(tokens) else None
            if target is None or target.kind != "word" or target.word is None:
                raise ParseError(f"redirection {tok.text!r} without a target")
            current.redirects.append((tok.text, target.word))
            i += 1
        elif tok.word is not None:
            current.words.append(tok.word)
        i += 1
    if current.words or current.redirects:
        segments.append(current)
    return Parsed(segments, subs)
