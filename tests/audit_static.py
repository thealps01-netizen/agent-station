"""Static audit of subagent-watch: the rules no render test can see, checked on the source.

Run: python audit_static.py        (exit 0 = clean, 1 = problems named, one per line)
Canary: python canary_audit.py     (breaks every rule once in a copy; each must turn this red)

Rules
  release      one version in plugin.yaml / manifest.json / CHANGELOG, installed copy in sync
               (release_gate.py; its own canary is `python release_gate.py`)
  i18n         every literal `t('sw.…')` key resolves in the English bundle, and every template key
               `t(`sw.status.${…}`)` has a leaf for each value the page can hand it
  nativeTitle  no `title:` prop on a DOM element — the themed Tip owns hover text (kit components
               such as PanelEmpty / ErrorState take `title` as their heading and are allowed)
  iconLabel    every icon-only button goes through IconButton, which sets `aria-label`
  expanded     every accordion row (`sw-acc`) carries `aria-expanded`
  markName     every status mark (`sw-mk`) and header count (`sw-stat`) carries `aria-label` — the svg is
               aria-hidden and the Tip is hover-only, so without it a screen reader hears nothing / a bare number
  hexColor     no hard-coded colour in the page's CSS or SVG — tokens only, so every skin follows; this
               covers hex and rgb()/rgba()/hsl() literals (a shadow in rgb(0 0 0/.22) ignores the skin too)
  toneInk      no theme tone (--ui-red / green / yellow / blue) as the `color:` of text — the tone rides
               the mark, the text uses a reading token (tone red on the dark card measured 3.3:1 < 4.5)
  silentCatch  every `catch` in the page logs or surfaces the error; every `except` in the backend
               re-raises, counts or continues on purpose (FileNotFoundError / ImportError)
  readOnly     the backend opens state.db `mode=ro`, registers GET routes only, and never writes
               a file (no write_text / write_bytes / open(..., 'w') / unlink / mkdir)
"""
from __future__ import annotations

import ast
import io
import tokenize
import re
import sys
from pathlib import Path

import release_gate

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
JS = ROOT / "desktop" / "plugin.js"
BACKEND = ROOT / "dashboard" / "plugin_api.py"

problems: list[str] = []


def report(message: str) -> None:
    problems.append(message)


def scan_js(src: str, collapse: bool = False) -> tuple[str, list[tuple[int, str]]]:
    """Strip JavaScript to its CODE: comments removed, string/template bodies blanked (newlines kept).

    The projection is what structural checks run on, so a rule that mentions `panes` or `#fff` inside
    a string cannot trip the check that guards against it. Positions stay aligned with the source
    unless *collapse* asks for the bodies to be dropped instead of blanked — which is what the line
    length check wants (a long string is not a long line of code). Returns (code, comments by line).
    """
    out: list[str] = []
    comments: list[tuple[int, str]] = []
    line = 1
    i, n = 0, len(src)

    def blob(text: str) -> None:
        for c in text:
            out.append(c if c == "\n" else ("" if collapse else " "))

    while i < n:
        ch = src[i]
        if ch in "'\"":
            quote = ch
            out.append(quote)
            i += 1
            start = i
            while i < n:
                c = src[i]
                if c == "\\":
                    i += 2
                    continue
                if c == quote:
                    break
                if c == "\n":
                    line += 1
                i += 1
            blob(src[start:i])
            if i < n:
                out.append(quote)
                i += 1
            continue
        if ch == "`":
            out.append("`")
            i += 1
            start = i
            while i < n:
                c = src[i]
                if c == "\\":
                    i += 2
                    continue
                if c == "`":
                    break
                if c == "\n":
                    line += 1
                i += 1
            blob(src[start:i])
            if i < n:
                out.append("`")
                i += 1
            continue
        if ch == "/" and i + 1 < n and src[i + 1] == "/":
            end = src.find("\n", i)
            end = n if end < 0 else end
            comments.append((line, src[i:end]))
            out.append("" if collapse else " " * (end - i))
            i = end
            continue
        if ch == "/" and i + 1 < n and src[i + 1] == "*":
            end = src.find("*/", i + 2)
            end = n if end < 0 else end + 2
            comments.append((line, src[i:end]))
            line += src.count("\n", i, end)
            blob(src[i:end])
            i = end
            continue
        if ch == "\n":
            line += 1
        out.append(ch)
        i += 1
    return "".join(out), comments



def check_no_comments(js: str, source: str) -> None:
    stylesheet = re.search(r"const CSS = `((?:\\.|[^`])*)`", js, re.S)
    if stylesheet and re.search(r"/\*.*?\*/", stylesheet.group(1), re.S):
        report("noComments: embedded CSS explanations belong in Docs/subagent-watch-notes.md")
    for line, _body in scan_js(js)[1]:
        report(f"noComments: plugin.js:{line}: move the explanation to Docs/subagent-watch-notes.md")
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT:
            report(f"noComments: plugin_api.py:{token.start[0]}: move the explanation to Docs/subagent-watch-notes.md")
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and ast.get_docstring(node):
            report(f"noComments: plugin_api.py:{node.body[0].lineno}: move the docstring to Docs/subagent-watch-notes.md")


def _bundle(js: str) -> dict:
    """The English bundle as a nested dict of leaf names (values are irrelevant)."""
    start = js.index("const BUNDLES = {")
    body, depth, i = "", 0, js.index("{", start)
    for i in range(i, len(js)):
        body += js[i]
        if js[i] == "{":
            depth += 1
        elif js[i] == "}":
            depth -= 1
            if depth == 0:
                break
    tree: dict = {}
    stack = [tree]
    # Strip strings and arrow bodies so only `name: {` / `name:` structure remains.
    flat = re.sub(r"'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`", "''", body)
    for token in re.finditer(r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\{)?|(\})", flat):
        if token.group(3):
            if len(stack) > 1:
                stack.pop()
            continue
        name = token.group(1)
        if token.group(2):
            stack[-1][name] = {}
            stack.append(stack[-1][name])
        else:
            stack[-1][name] = True
    return tree.get("en", {})


def _has(tree: dict, key: str) -> bool:
    node = tree
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            return False
        node = node[part]
    return node is True


def check_i18n(js: str) -> None:
    bundle = _bundle(js)
    literal = re.findall(r"\bt\(\s*'(sw\.[A-Za-z0-9_.]+)'", js)
    # `t(cond ? 'sw.a' : 'sw.b')` asks for either key.
    literal += re.findall(r"\bt\([^()'`]*\?\s*'(sw\.[A-Za-z0-9_.]+)'", js)
    literal += re.findall(r"\bt\([^()'`]*\?\s*'sw\.[A-Za-z0-9_.]+'\s*:\s*'(sw\.[A-Za-z0-9_.]+)'", js)
    for key in sorted(set(literal)):
        if not _has(bundle, key):
            report(f"i18n: key '{key}' is not in the English bundle — the page would print the raw key")
    statuses = {"completed", "failed", "running", "queued", "stopped"}
    templates = {
        "sw.status": statuses,
        "sw.proc.status": {"running", "completed", "failed", "stopped"},
        "sw.merge": {"waiting", "done", "partial"},
    }
    for prefix, values in templates.items():
        if f"t(`{prefix}.${{" not in js:
            report(f"i18n: template key `{prefix}.${{…}}` is no longer used — update this audit's table")
            continue
        for value in sorted(values):
            if not _has(bundle, f"{prefix}.{value}"):
                report(f"i18n: '{prefix}.{value}' is missing — `t(`{prefix}.${{…}}`)` can ask for it")


def check_markup(js: str) -> None:
    for line_no, line in enumerate(js.splitlines(), 1):
        # Only the props object of the DOM call itself: a kit child (`jsx(ErrorState, { title })`)
        # nested inside it takes `title` as its heading and is not a native tooltip.
        dom_props = re.search(r"jsx\('[a-z]+',\s*\{([^{}]*)", line)
        if dom_props and re.search(r"\btitle:", dom_props.group(1)):
            report(f"nativeTitle: line {line_no} puts `title:` on a DOM element — wrap it in Tip instead")
        if re.search(r"jsx\('button',", line) and "sw-ib" in line and "'aria-label'" not in line:
            report(f"iconLabel: line {line_no} draws an icon button without `aria-label`")
    # An accordion row's props can span lines: read the whole props object after the class name.
    for match in re.finditer(r"className:\s*[`'][^`']*\bsw-acc\b", js):
        tail = js[match.end():match.end() + 300]
        props = tail.split("onClick")[0]
        if "'aria-expanded'" not in props:
            line_no = js[:match.start()].count("\n") + 1
            report(f"expanded: line {line_no} is an accordion row without `aria-expanded`")
    for match in re.finditer(r"className:\s*'(sw-mk|sw-stat)'", js):
        props = js[match.end():match.end() + 200].split("children")[0]
        if "'aria-label'" not in props:
            line_no = js[:match.start()].count("\n") + 1
            report(f"markName: line {line_no} draws a `{match.group(1)}` without `aria-label` — "
                   "its meaning is only in a hover tooltip")
    for match in re.finditer(r"jsx\(IconButton,\s*\{([^}]*)\}", js):
        if not re.search(r"\blabel:\s*t\(", match.group(1)):
            report(f"iconLabel: an IconButton has no translated `label` ({match.group(1)[:60].strip()}…)")
    icon_button = re.search(r"function IconButton\(.*?\n\}", js, re.S)
    if not icon_button or "'aria-label': label" not in icon_button.group(0):
        report("iconLabel: IconButton no longer sets `aria-label` from its label")


def check_colors(js: str) -> None:
    for line_no, line in enumerate(js.splitlines(), 1):
        if line.lstrip().startswith(("//", "*")):
            continue
        for hex_value in re.findall(r"#[0-9a-fA-F]{3,8}\b", line):
            report(f"hexColor: line {line_no} hard-codes {hex_value} — use a theme token")
        for literal in re.findall(r"\b(?:rgba?|hsla?)\([^)]*\)", line):
            report(f"hexColor: line {line_no} hard-codes {literal} — use a theme token (e.g. var(--shadow-sm))")


def check_tone_ink(js: str) -> None:
    for match in re.finditer(r"(?<![-\w])color:\s*var\(--ui-(red|green|yellow|blue)\b", js):
        line_no = js[:match.start()].count("\n") + 1
        report(f"toneInk: line {line_no} inks text with --ui-{match.group(1)} — use a reading token, "
               "keep the tone on the mark")


def check_js_catches(js: str) -> None:
    for match in re.finditer(r"catch\s*\(\s*(\w*)\s*\)\s*\{(.*?)\n\s*\}", js, re.S):
        body = match.group(2)
        if not re.search(r"console\.(warn|error)|set[A-Z]\w*\(|throw\b|fails\.current", body):
            line_no = js[:match.start()].count("\n") + 1
            report(f"silentCatch: the catch at line {line_no} neither logs nor shows the error")
    for match in re.finditer(r"\.catch\(\s*\(?\s*\w*\s*\)?\s*=>\s*(\{.*?\n\s*\}\)|[^\n]*)", js, re.S):
        if not re.search(r"console\.(warn|error)|set[A-Z]\w*\(|onToast\(", match.group(1)):
            line_no = js[:match.start()].count("\n") + 1
            report(f"silentCatch: the .catch at line {line_no} neither logs nor shows the error")


def check_backend(source: str) -> None:
    tree = ast.parse(source)
    if "?mode=ro" not in source:
        report("readOnly: state.db is no longer opened with `?mode=ro`")
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "router" \
                and node.attr in {"post", "put", "delete", "patch"}:
            report(f"readOnly: the backend registers a `{node.attr.upper()}` route — this page never writes")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in {
                "write_text", "write_bytes", "unlink", "mkdir", "rmdir", "rename", "replace", "touch"}:
            if not (isinstance(node.func.value, ast.Name) and node.func.value.id in {"text", "str"}):
                report(f"readOnly: line {node.lineno} calls `.{node.func.attr}()` — the backend must not write")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "open":
            modes = [a.value for a in node.args[1:2] if isinstance(a, ast.Constant)]
            modes += [k.value.value for k in node.keywords if k.arg == "mode" and isinstance(k.value, ast.Constant)]
            if any(set(str(m)) & set("wax+") for m in modes):
                report(f"readOnly: line {node.lineno} opens a file for writing")
        if isinstance(node, ast.ExceptHandler):
            names = {n.id for n in ast.walk(node.type) if isinstance(n, ast.Name)} if node.type else {"<bare>"}
            body = node.body
            quiet = all(isinstance(s, (ast.Pass, ast.Continue)) for s in body) or \
                (len(body) == 1 and isinstance(body[0], ast.Return))
            intended = names & {"FileNotFoundError", "ImportError", "TypeError", "ValueError"}
            if "<bare>" in names or (quiet and not intended):
                report(f"silentCatch: the backend except at line {node.lineno} swallows "
                       f"{'everything' if '<bare>' in names else ', '.join(sorted(names))} without a trace")


def check_attention(js: str) -> None:
    for token, message in (
        ("className: 'sw-inspector'", "selected inspector missing"),
        ("entries.sort((a, b) => rank(b) - rank(a))", "failed work must lead the queue"),
        ("className: 'sw-original-output'", "original worker answer missing"),
        ("if (pending) { queued = true; return }", "reads must be single-flight"),
    ):
        missing = js.count(token) < 2 if token == "className: 'sw-original-output'" else token not in js
        if missing:
            report("attention: " + message)


def main() -> int:
    js = JS.read_text(encoding="utf-8")
    release_gate.check(report)
    check_no_comments(js, BACKEND.read_text(encoding="utf-8"))
    check_i18n(js)
    check_markup(js)
    check_colors(js)
    check_tone_ink(js)
    check_js_catches(js)
    check_attention(js)
    check_backend(BACKEND.read_text(encoding="utf-8"))
    for problem in problems:
        print(f"PROBLEM  {problem}")
    print(f"static audit: {'clean' if not problems else f'{len(problems)} problem(s)'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
