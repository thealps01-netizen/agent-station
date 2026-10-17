"""Static audit of agent-station: the rules no render test can see, checked on the source.

Run: python audit_static.py        (exit 0 = clean, 1 = problems named, one per line)
Canary: python canary_audit.py     (breaks every rule once in a copy; each must turn this red)

Rules
  release      one version in plugin.yaml / manifest.json / CHANGELOG, the README's supported range
               matches `requires_hermes`, installed copy in sync
               (release_gate.py; its own canary is `python release_gate.py`)
  i18n         every literal `t('sw.…')` key resolves in the English bundle, and every template key
               `t(`sw.status.${…}`)` has a leaf for each value the page can hand it
  nativeTitle  no `title:` prop on a DOM element — the themed Tip owns hover text (kit components
               such as PanelEmpty / ErrorState take `title` as their heading and are allowed)
  iconLabel    every icon-only button goes through IconButton, which sets `aria-label`
  expanded     every accordion row (`sw-acc`) carries `aria-expanded`
  markName     every status mark (`sw-mk`), header count (`sw-stat`) and tab count (`sw-tabn`) carries
               `aria-label` — the svg is
               aria-hidden and the Tip is hover-only, so without it a screen reader hears nothing / a bare number
  hexColor     no hard-coded colour in the page's CSS or SVG — tokens only, so every skin follows; this
               covers hex and rgb()/rgba()/hsl() literals (a shadow in rgb(0 0 0/.22) ignores the skin too).
               The HUD palette too: it is drawn from the app theme, so it has no exception.
  toneInk      no theme tone (--ui-red / green / yellow / blue) as the `color:` of text — the tone rides
               the mark, the text uses a reading token (tone red on the dark card measured 3.3:1 < 4.5)
  silentCatch  every `catch` in the page logs or surfaces the error; every `except` in the backend
               re-raises, counts or continues on purpose (FileNotFoundError / ImportError)
  readOnly     the backend opens state.db `mode=ro`, registers GET routes only, and never writes
               a file (no write_text / write_bytes / open(..., 'w') / unlink / mkdir)
  identity     the old name (subagent-watch / Subagent Watch, any case or separator) is gone from
               plugin.yaml, manifest.json, plugin.js, plugin_api.py, __init__.py and from README.md
               outside its `## Moving from Subagent Watch` section — a stale name splits the install
  license      LICENSE exists and its first line is `MIT License` (plugin.yaml says `license: MIT`)
  privacy      no shipped file (`git ls-files`; every file of a copy that is not a git work tree)
               names the author's account or a `<drive>:/Users/<name>` path other than the fixture
               names `someone` and `x` — the repository is meant to be public
"""
from __future__ import annotations

import ast
import re
import subprocess
import sys
from pathlib import Path

import release_gate

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
JS = ROOT / "desktop" / "plugin.js"
BACKEND = ROOT / "dashboard" / "plugin_api.py"
OLD_NAME = re.compile(r"subagent[-_ ]?watch", re.I)
IDENTITY_FILES = ("plugin.yaml", "dashboard/manifest.json", "desktop/plugin.js", "dashboard/plugin_api.py", "__init__.py")
MOVING_SECTION = "## Moving from Subagent Watch"
# Assembled so this file does not name the account it looks for.
ACCOUNT = re.compile("ene" + "sa", re.I)
USER_PATH = re.compile(r"[A-Za-z]:[/\\]+Users[/\\]+([A-Za-z0-9._-]+)", re.I)
FIXTURE_USERS = {"someone", "x"}

problems: list[str] = []


def report(message: str) -> None:
    problems.append(message)


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
        "sw.st": statuses | {"idle"},
        "sw.act": {"edit", "read", "run", "think", "wait"},
        "sw.tag": (statuses - {"running"}) | {"idle", "edit", "read", "run", "think", "wait"},
        "sw.verb": {"read", "write", "edit", "search", "run", "code", "delegate", "web", "other"},
        "sw.file.op": {"active", "write", "delete", "read", "failed"},
        "sw.proc.status": {"running", "completed", "failed", "stopped"},
        "sw.proc.short": {"running", "completed", "failed", "stopped"},
        "sw.tabs": {"agents", "commands"},
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
    # An accordion row's props can span lines: read the whole props object after the class name. The
    # class can sit in a ternary (`className: open ? 'sw-bh' : 'sw-card sw-acc'`), so match the line.
    for match in re.finditer(r"className:[^\n]*?\bsw-acc\b", js):
        tail = js[match.end():match.end() + 300]
        props = tail.split("onClick")[0]
        if "'aria-expanded'" not in props:
            line_no = js[:match.start()].count("\n") + 1
            report(f"expanded: line {line_no} is an accordion row without `aria-expanded`")
    for match in re.finditer(r"className:\s*'(sw-mk|sw-stat|sw-tabn)'", js):
        props = js[match.end():match.end() + 200].split("children")[0]
        if "'aria-label'" not in props and "'aria-hidden'" not in props:  # aria-hidden: decorative, text beside it
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


def _shipped_files() -> list[Path]:
    """What a release ships: `git ls-files` in a work tree; every plain file of a copy that is not one."""
    try:
        top = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--show-toplevel"], capture_output=True,
                             text=True, encoding="utf-8", errors="replace")
        tracked = top.returncode == 0 and Path(top.stdout.strip()).resolve() == ROOT.resolve()
    except OSError as exc:  # no git on PATH: scan the folder instead
        print(f"note: git unavailable ({exc}); privacy scans every file under {ROOT}")
        tracked = False
    if tracked:
        listed = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"], capture_output=True, check=True)
        return [ROOT / rel for rel in listed.stdout.decode("utf-8").split("\0") if rel and (ROOT / rel).is_file()]
    skip = {"node_modules", "__pycache__"}
    return [p for p in ROOT.rglob("*") if p.is_file()
            and not any(part in skip or part.startswith(".") for part in p.relative_to(ROOT).parts[:-1])]


def check_identity() -> None:
    for rel in IDENTITY_FILES:
        path = ROOT / rel
        if not path.is_file():
            continue
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if OLD_NAME.search(line):
                report(f"identity: {rel} line {line_no} still names the old plugin ({OLD_NAME.search(line).group(0)}) "
                       "— the plugin is Agent Station / agent-station")
    readme = ROOT / "README.md"
    if readme.is_file():
        moving = False
        for line_no, line in enumerate(readme.read_text(encoding="utf-8").splitlines(), 1):
            if line.startswith("## "):
                moving = line.strip() == MOVING_SECTION
            if not moving and OLD_NAME.search(line):
                report(f"identity: README.md line {line_no} names the old plugin outside "
                       f"`{MOVING_SECTION}` — only that section may mention it")


def check_license() -> None:
    path = ROOT / "LICENSE"
    first = path.read_text(encoding="utf-8").splitlines()[:1] if path.is_file() else []
    if first != ["MIT License"]:
        report(f"license: LICENSE {'first line is ' + repr(first[0]) if first else 'is missing'} — it must start "
               "`MIT License` (plugin.yaml and the README say MIT)")


def check_privacy() -> None:
    for path in _shipped_files():
        data = path.read_bytes()
        if b"\0" in data[:8192]:
            continue  # binary (images): no text to leak
        rel = path.relative_to(ROOT).as_posix()
        for line_no, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
            if ACCOUNT.search(line):
                report(f"privacy: {rel} line {line_no} names the author's account — use a fixture name or a "
                       "generic path")
            for match in USER_PATH.finditer(line):
                if match.group(1).lower() not in FIXTURE_USERS:
                    report(f"privacy: {rel} line {line_no} carries a personal path ({match.group(0)}) — use "
                           "C:/Users/someone or a generic placeholder")


def main() -> int:
    js = JS.read_text(encoding="utf-8")
    release_gate.check(report)
    check_i18n(js)
    check_markup(js)
    check_colors(js)
    check_tone_ink(js)
    check_js_catches(js)
    check_backend(BACKEND.read_text(encoding="utf-8"))
    check_identity()
    check_license()
    check_privacy()
    for problem in problems:
        print(f"PROBLEM  {problem}")
    print(f"static audit: {'clean' if not problems else f'{len(problems)} problem(s)'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
