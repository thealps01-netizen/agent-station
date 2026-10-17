"""Core contract: everything agent-station reads from Hermes still exists under the name it reads.

Why: the panel never imports most of what it depends on. The backend opens `state.db` by column
name and reads Hermes' own process files by key; the desktop page listens for gateway events by
string and reads SDK atoms by property. A rename on the core side breaks none of that loudly — the
page just shows nothing, or every worker as "stopped". This gate reads the core's SOURCE (no import,
no running app) and fails naming the exact piece that moved.

Checked against the core checkout (`HERMES_AGENT_DIR`, see env.py):
  schema     every `sessions` / `messages` column the backend selects is in the CREATE TABLE
  markers    `_delegate_from` is still written by delegate_tool; `end_reason` 'compression' is
             still what a compression boundary writes (the lineage walk follows it)
  processes  receipts live in `logs/process-results/`, carry every field the backend reads, and a
             kill still records `completion_reason = "killed"`; `processes.json` keeps its fields;
             `ProcessRegistry._host_pid_is_ours` exists (the liveness test the backend borrows)
  gateway    every `subagent.*` event the page subscribes to is declared, `subagent.list` is a
             method, and every wire status of `SubagentStatus` maps to a mark (`STATUS_OF`)
  cost       a worker's complete frame still carries `cost_usd`; Hermes' CostStatus still names
             the statuses the backend and page read (actual / estimated / included / unknown)
  sdk        every name the page imports from `@hermes/plugin-sdk` is exported, the two
             `host.state` atoms it reads exist, `host.state.busyBySession` exists (the main agent's
             busy state), `host.navigate` exists (the progress chip opens the page), `ctx.pet` keeps
             `say` / `clear` / `visible` (the progress line), and `ctx.storage` keeps a synchronous
             `get(key, fallback)` / `set(key, value)` (the kept Cockpit / Terminal look)
  files      the file tools keep their names and `path` / `mode` / `patch` arguments (patch mode
             defaults to "replace"); Hermes' V4A parser keeps `parse_v4a_patch` and its update / add /
             delete / move operations with `new_path`; `tool.start` / `tool.complete` are declared with
             `tool_id` / `name` / `args`, and write_file / patch keep their lifecycle even with tool
             progress off (`_TOOL_LIFECYCLE_UI_TOOLS`, read from whichever of `tui_gateway/server.py`
             and `tui_gateway/agent_factory.py` defines it — the core moved it between releases); a
             compressed result stub still says ` FAILED:` / `BLOCKED, not run`;
             `ctx.setTimeout` exists (the shimmer's linger)

Running:
  python contract_core.py             exit 0 = contract holds; 1 = something moved (named); 2 = no core
  python contract_core.py --selftest  every rule is broken once in a copy and must fire
"""
from __future__ import annotations

import ast
import re
import shutil
import sys
import tempfile
from pathlib import Path

import env

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent / "dashboard" / "plugin_api.py"
PAGE = HERE.parent / "desktop" / "plugin.js"

SCHEMA_FILE = "hermes_state_common.py"
DELEGATE_FILE = "tools/delegate_tool.py"
COMPRESSION_FILE = "agent/conversation_compression.py"
RESULTS_FILE = "tools/process_registry_results.py"
REGISTRY_FILE = "tools/process_registry.py"
EVENTS_FILE = "tui_gateway/contracts/events.py"
STATUS_FILE = "tui_gateway/contracts/common.py"
CONTRACTS_DIR = "tui_gateway/contracts"
SDK_FILE = "apps/desktop/src/sdk/index.ts"
CHILD_RUN_FILE = "tools/delegate_tool_child_run.py"
PRICING_FILE = "agent/usage_pricing.py"
PET_FILE = "apps/desktop/src/contrib/plugin.ts"
FILE_TOOLS_FILE = "tools/file_tools.py"
PATCH_PARSER_FILE = "tools/patch_parser.py"
SERVER_FILE = "tui_gateway/server.py"
AGENT_FACTORY_FILE = "tui_gateway/agent_factory.py"
LIFECYCLE_FILES = (SERVER_FILE, AGENT_FACTORY_FILE)
LIFECYCLE = "<the file defining _TOOL_LIFECYCLE_UI_TOOLS>"  # a BREAKS target resolved per core
_LIFECYCLE_SET = re.compile(r"_TOOL_LIFECYCLE_UI_TOOLS = frozenset\(\{(.*?)\}\)", re.S)
COMPRESSOR_FILE = "agent/context_compressor.py"
FILE_TOOL_NAMES = ("read_file", "write_file", "patch")
V4A_OPS = ("update", "add", "delete", "move")
COST_STATUSES = ("actual", "estimated", "included", "unknown")
PET_MEMBERS = ("say", "clear", "visible")

# What the backend reads from each Hermes file, by key.
RECEIPT_KEYS = ("id", "command", "cwd", "parent_session_id", "started_at", "exit_code", "completion_reason")
CHECKPOINT_KEYS = ("command", "pid", "pid_scope", "host_start_time", "cwd", "started_at", "parent_session_id")
HOST_STATE_ATOMS = ("focusedSessionId", "focusedStoredSessionId")


def _read(core: Path, rel: str, problems: list[str]) -> str:
    path = core / rel
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        problems.append(f"{rel}: missing from the core — the file this panel's contract lives in moved")
        return ""


def _lifecycle_file(core: Path) -> str | None:
    """The core file that defines `_TOOL_LIFECYCLE_UI_TOOLS` (it moved from server.py to agent_factory.py)."""
    for rel in LIFECYCLE_FILES:
        path = core / rel
        if path.is_file() and _LIFECYCLE_SET.search(path.read_text(encoding="utf-8")):
            return rel
    return None


def _create_table_columns(schema: str, table: str) -> set[str]:
    match = re.search(rf"CREATE TABLE IF NOT EXISTS {table}\s*\((.*?)\n\s*\)", schema, re.S)
    if not match:
        return set()
    return {m.group(1) for m in re.finditer(r"^\s*([a-z_]+)\s+[A-Z]", match.group(1), re.M)}


def _backend_columns() -> dict[str, set[str]]:
    """Columns the backend names, by table, read off its SQL strings."""
    tree = ast.parse(BACKEND.read_text(encoding="utf-8"))
    sql = " ".join(n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)
                   and re.search(r"\b(select|where)\b", n.value))
    sessions = {"id", "parent_session_id", "end_reason", "model_config", "started_at", "source", "title"}
    listed = re.search(r"select (id, model, .*?) from sessions", sql)
    if listed:
        sessions |= {c.strip() for c in listed.group(1).split(",")}
    # Column lists kept in a module constant (`_WORKER_COLUMNS = "id, model, ..."`) and spliced into SQL.
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id.endswith("_COLUMNS") for t in node.targets):
            value = node.value
            text = value.value if isinstance(value, ast.Constant) else "".join(
                p.value for p in ast.walk(value) if isinstance(p, ast.Constant) and isinstance(p.value, str))
            sessions |= {c.strip() for c in text.split(",") if c.strip()}
    messages = {"session_id", "role", "content", "id"}
    if "def list_files" in BACKEND.read_text(encoding="utf-8"):
        sessions.add("cwd")
        messages |= {"tool_calls", "tool_call_id", "timestamp"}
    return {"sessions": sessions, "messages": messages}


def _tuple_of(source: str, name: str) -> set[str]:
    match = re.search(rf"^{name}\s*=\s*\((.*?)\)\s*$", source, re.S | re.M)
    return set(re.findall(r"\"([a-z_]+)\"", match.group(1))) if match else set()


def _page_imports(page: str) -> set[str]:
    match = re.search(r"import \{([^}]*)\} from '@hermes/plugin-sdk'", page)
    return {n.strip() for n in match.group(1).split(",") if n.strip()} if match else set()


def _page_events(page: str) -> set[str]:
    match = re.search(r"const SUBAGENT_EVENTS = \[(.*?)\]", page, re.S)
    return set(re.findall(r"'(subagent\.[a-z_]+)'", match.group(1))) if match else set()


def _page_status_keys(page: str) -> set[str]:
    match = re.search(r"const STATUS_OF = \{(.*?)\}", page, re.S)
    return set(re.findall(r"([a-z_]+):", match.group(1))) if match else set()


def check(core: Path) -> list[str]:
    problems: list[str] = []
    page = PAGE.read_text(encoding="utf-8")

    schema = _read(core, SCHEMA_FILE, problems)
    if schema:
        for table, wanted in _backend_columns().items():
            have = _create_table_columns(schema, table)
            if not have:
                problems.append(f"{SCHEMA_FILE}: no `CREATE TABLE IF NOT EXISTS {table}` — the backend reads it")
                continue
            for column in sorted(wanted - have):
                problems.append(f"{SCHEMA_FILE}: `{table}.{column}` is gone — the backend selects it")

    if "\"_delegate_from\"" not in _read(core, DELEGATE_FILE, problems):
        problems.append(f"{DELEGATE_FILE}: no longer writes `_delegate_from` — no worker would be found")
    if "reason=\"compression\"" not in _read(core, COMPRESSION_FILE, problems):
        problems.append(f"{COMPRESSION_FILE}: a compression boundary no longer ends with reason "
                        "\"compression\" — the lineage walk would stop at the first link")

    results = _read(core, RESULTS_FILE, problems)
    if results:
        if "\"logs\" / \"process-results\"" not in results:
            problems.append(f"{RESULTS_FILE}: receipts no longer live in logs/process-results — "
                            "finished commands would vanish")
        fields = _tuple_of(results, "_RESULT_FIELDS")
        for key in sorted(set(RECEIPT_KEYS) - fields):
            problems.append(f"{RESULTS_FILE}: receipt field `{key}` is gone from _RESULT_FIELDS — the backend reads it")
        if "record[\"output\"]" not in results:
            problems.append(f"{RESULTS_FILE}: receipts no longer carry `output` — /process_output reads it")

    registry = _read(core, REGISTRY_FILE, problems)
    if registry:
        fields = _tuple_of(registry, "_CHECKPOINT_FIELDS")
        for key in sorted(set(CHECKPOINT_KEYS) - fields):
            problems.append(f"{REGISTRY_FILE}: checkpoint field `{key}` is gone from _CHECKPOINT_FIELDS")
        if "def _host_pid_is_ours" not in registry:
            problems.append(f"{REGISTRY_FILE}: `ProcessRegistry._host_pid_is_ours` is gone — every "
                            "checkpointed command would read as running")
        if "completion_reason = \"killed\"" not in registry:
            problems.append(f"{REGISTRY_FILE}: a kill no longer records completion_reason \"killed\" — "
                            "stopped commands would read as failed")

    events = _read(core, EVENTS_FILE, problems)
    for name in sorted(_page_events(page)):
        if events and f"\"{name}\"" not in events:
            problems.append(f"{EVENTS_FILE}: event `{name}` is not declared — the page listens for it")
    contracts = "".join(p.read_text(encoding="utf-8") for p in sorted((core / CONTRACTS_DIR).glob("*.py"))) \
        if (core / CONTRACTS_DIR).is_dir() else ""
    if "method(\"subagent.list\"" not in contracts:
        problems.append(f"{CONTRACTS_DIR}: method `subagent.list` is not declared — the page polls it")

    status = _read(core, STATUS_FILE, problems)
    enum = re.search(r"class SubagentStatus\(WireEnum\):(.*?)\n\n\n", status, re.S)
    if status and not enum:
        problems.append(f"{STATUS_FILE}: `class SubagentStatus` is gone — the wire statuses are unknown")
    elif enum:
        wire = set(re.findall(r"^\s+([a-z_]+)\s*=\s*\"", enum.group(1), re.M))
        for name in sorted(wire - _page_status_keys(page)):
            problems.append(f"{STATUS_FILE}: wire status `{name}` has no entry in the page's STATUS_OF — "
                            "it would draw as stopped")

    if "complete_kwargs[\"cost_usd\"]" not in _read(core, CHILD_RUN_FILE, problems):
        problems.append(f"{CHILD_RUN_FILE}: a worker's complete frame no longer carries `cost_usd` — "
                        "the live batch and the progress chip would show no cost")
    pricing = _read(core, PRICING_FILE, problems)
    literal = re.search(r"^CostStatus = Literal\[(.*?)\]", pricing, re.M)
    if pricing and not literal:
        problems.append(f"{PRICING_FILE}: `CostStatus` is gone — the cost statuses the backend reads are unknown")
    elif literal:
        named = set(re.findall(r"\"([a-z_]+)\"", literal.group(1)))
        for status in sorted(set(COST_STATUSES) - named):
            problems.append(f"{PRICING_FILE}: cost status `{status}` is gone from CostStatus — the backend reads it")
        for status in sorted(named - set(COST_STATUSES)):
            problems.append(f"{PRICING_FILE}: new cost status `{status}` — the backend would read it as not priced")

    plugin_ts = _read(core, PET_FILE, problems)
    if plugin_ts and not re.search(r"^\s+storage: PluginStorage$", plugin_ts, re.M):
        problems.append(f"{PET_FILE}: `ctx.storage` is gone — the page keeps its look (Cockpit / Terminal) there")
    store = re.search(r"export interface PluginStorage \{(.*?)\n\}", plugin_ts, re.S)
    if plugin_ts and not (store and re.search(r"^\s+get<T>\(key: string, fallback: T\): T$", store.group(1), re.M)
                          and re.search(r"^\s+set\(key: string, value: unknown\): void$", store.group(1), re.M)):
        problems.append(f"{PET_FILE}: `PluginStorage.get/set` are no longer synchronous (get<T>(key, fallback): T) — "
                        "the page reads its kept look at first render")
    if plugin_ts and not re.search(r"^\s+pet: PluginPet$", plugin_ts, re.M):
        problems.append(f"{PET_FILE}: `ctx.pet` is gone — the progress line in the pet's bubble would never show")
    pet = re.search(r"export interface PluginPet \{(.*?)\n\}", plugin_ts, re.S)
    for member in PET_MEMBERS:
        if not pet or not re.search(rf"^\s+{member}:", pet.group(1), re.M):
            problems.append(f"{PET_FILE}: `PluginPet.{member}` is gone — the progress line uses it")

    sdk = _read(core, SDK_FILE, problems)
    if sdk:
        if not re.search(r"^\s+navigate: \(path", sdk, re.M):
            problems.append(f"{SDK_FILE}: `host.navigate` is gone — the progress chip opens the page with it")
        exported = set(re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\b", " ".join(
            re.findall(r"export \{([^}]*)\}", sdk) + re.findall(r"export (?:const|function) ([A-Za-z_]+)", sdk))))
        exported |= set(re.findall(r"as ([A-Za-z_]+)", " ".join(re.findall(r"export \{([^}]*)\}", sdk))))
        for name in sorted(_page_imports(page) - exported):
            problems.append(f"{SDK_FILE}: `{name}` is not exported — the page imports it")
        for atom in HOST_STATE_ATOMS:
            if not re.search(rf"^\s+{atom}: readonlyAtom", sdk, re.M):
                problems.append(f"{SDK_FILE}: `host.state.{atom}` is gone — the page scopes everything by it")
        if not re.search(r"^\s+busyBySession: readonlyAtom<Record<string, boolean>>", sdk, re.M):
            problems.append(f"{SDK_FILE}: `host.state.busyBySession` is gone or changed — the main agent unit would "
                            "never show it is busy")

    tools = _read(core, FILE_TOOLS_FILE, problems)
    if tools:
        for name in FILE_TOOL_NAMES:
            if f"\"name\": \"{name}\"" not in tools:
                problems.append(f"{FILE_TOOLS_FILE}: tool `{name}` is gone — the Files section reads its calls")
        if not re.search(r'"mode": \{[^}]*"default": "replace"', tools, re.S):
            problems.append(f"{FILE_TOOLS_FILE}: patch's `mode` no longer defaults to \"replace\" — a call without "
                            "a mode would be read as the wrong form")
        if not re.search(r'^\s+"patch": \{', tools, re.M):
            problems.append(f"{FILE_TOOLS_FILE}: patch's `patch` argument is gone — V4A patches would name no file")
    parser = _read(core, PATCH_PARSER_FILE, problems)
    if parser:
        if "def parse_v4a_patch(" not in parser:
            problems.append(f"{PATCH_PARSER_FILE}: `parse_v4a_patch` is gone — every V4A patch would read as unreadable")
        enum = re.search(r"class OperationType\(Enum\):(.*?)\n\n", parser, re.S)
        named = set(re.findall(r'=\s*"([a-z]+)"', enum.group(1))) if enum else set()
        for op in sorted(set(V4A_OPS) - named):
            problems.append(f"{PATCH_PARSER_FILE}: V4A operation `{op}` is gone from OperationType")
        for op in sorted(named - set(V4A_OPS)):
            problems.append(f"{PATCH_PARSER_FILE}: new V4A operation `{op}` — the backend would count it as a write")
        if "new_path" not in parser:
            problems.append(f"{PATCH_PARSER_FILE}: `new_path` is gone — a move's target would be lost")
    if events:
        for name in ("tool.start", "tool.complete"):
            if f"event(\"{name}\"" not in events:
                problems.append(f"{EVENTS_FILE}: event `{name}` is not declared — the shimmer listens for it")
        start = re.search(r"class ToolStartPayload\(Payload\):(.*?)\n\n\n", events, re.S)
        for field in ("tool_id", "name", "args"):
            if not start or not re.search(rf"^\s+{field}:", start.group(1), re.M):
                problems.append(f"{EVENTS_FILE}: `ToolStartPayload.{field}` is gone — the shimmer reads it")
    lifecycle_file = _lifecycle_file(core)
    if lifecycle_file is None:
        problems.append(f"{' / '.join(LIFECYCLE_FILES)}: neither defines _TOOL_LIFECYCLE_UI_TOOLS — with tool "
                        "progress off an edit would never shimmer")
    else:
        lifecycle = _LIFECYCLE_SET.search((core / lifecycle_file).read_text(encoding="utf-8"))
        for name in ("write_file", "patch"):
            if f"\"{name}\"" not in lifecycle.group(1):
                problems.append(f"{lifecycle_file}: `{name}` left _TOOL_LIFECYCLE_UI_TOOLS — with tool progress off "
                                "an edit would never shimmer")
    compressor = _read(core, COMPRESSOR_FILE, problems)
    if compressor:
        if 'label: str = "FAILED"' not in compressor or 'f" {label}: {preview}"' not in compressor:
            problems.append(f"{COMPRESSOR_FILE}: a compressed failure no longer says ' FAILED:' — failed edits "
                            "would read as done")
        if "BLOCKED, not run" not in compressor:
            problems.append(f"{COMPRESSOR_FILE}: a compressed refusal no longer says 'BLOCKED, not run' — refused "
                            "edits would read as done")
    if plugin_ts and not re.search(r"^\s+setTimeout: \(fn", plugin_ts, re.M):
        problems.append(f"{PET_FILE}: `ctx.setTimeout` is gone — the shimmer's linger uses it")
    return problems


# Each rule broken once in a copy of the core files it reads: (file, old, new, expected fragment).
BREAKS = [
    (SCHEMA_FILE, "    end_reason ", "    end_reason_renamed ", "`sessions.end_reason` is gone"),
    (SCHEMA_FILE, "    role ", "    speaker ", "`messages.role` is gone"),
    (DELEGATE_FILE, "\"_delegate_from\"", "\"_spawned_by\"", "no longer writes `_delegate_from`"),
    (COMPRESSION_FILE, "reason=\"compression\"", "reason=\"compacted\"", "no longer ends with reason"),
    (RESULTS_FILE, "\"logs\" / \"process-results\"", "\"logs\" / \"proc-receipts\"", "no longer live in logs/process-results"),
    (RESULTS_FILE, "\"parent_session_id\", \"started_at\"", "\"started_at\"", "receipt field `parent_session_id`"),
    (REGISTRY_FILE, "def _host_pid_is_ours", "def _pid_alive", "`ProcessRegistry._host_pid_is_ours` is gone"),
    (REGISTRY_FILE, "completion_reason = \"killed\"", "completion_reason = \"terminated\"", "no longer records completion_reason"),
    (EVENTS_FILE, "(\"subagent.tool\",", "(\"subagent.tool_call\",", "event `subagent.tool` is not declared"),
    (STATUS_FILE, "    timeout = \"timeout\"\n", "    timeout = \"timeout\"\n    paused = \"paused\"\n", "wire status `paused`"),
    (SDK_FILE, "export { Tip, Tooltip", "export { Tooltip", "`Tip` is not exported"),
    (SDK_FILE, "    busyBySession: readonlyAtom", "    busyMap: readonlyAtom", "`host.state.busyBySession` is gone"),
    (PET_FILE, "  storage: PluginStorage\n", "  store: PluginStorage\n", "`ctx.storage` is gone"),
    (PET_FILE, "get<T>(key: string, fallback: T): T", "get<T>(key: string, fallback: T): Promise<T>", "no longer synchronous"),
    (SDK_FILE, "    focusedStoredSessionId: readonlyAtom", "    storedSessionId: readonlyAtom", "`host.state.focusedStoredSessionId` is gone"),
    (SDK_FILE, "  navigate: (path", "  go: (path", "`host.navigate` is gone"),
    (SDK_FILE, "STATUSBAR_AREAS, ", "", "`STATUSBAR_AREAS` is not exported"),
    (SCHEMA_FILE, "    cost_status TEXT,", "    billing_status TEXT,", "`sessions.cost_status` is gone"),
    (CHILD_RUN_FILE, "complete_kwargs[\"cost_usd\"]", "complete_kwargs[\"spend\"]", "no longer carries `cost_usd`"),
    (PRICING_FILE, "\"included\", ", "", "cost status `included` is gone"),
    (PRICING_FILE, "\"unknown\"]", "\"unknown\", \"partial\"]", "new cost status `partial`"),
    (PET_FILE, "  pet: PluginPet\n", "  mascot: PluginPet\n", "`ctx.pet` is gone"),
    (PET_FILE, "  say: (text", "  speak: (text", "`PluginPet.say` is gone"),
    (SCHEMA_FILE, "    tool_calls TEXT,", "    calls TEXT,", "`messages.tool_calls` is gone"),
    (SCHEMA_FILE, "    cwd TEXT,", "    workdir TEXT,", "`sessions.cwd` is gone"),
    (FILE_TOOLS_FILE, "\"name\": \"read_file\"", "\"name\": \"file_read\"", "tool `read_file` is gone"),
    (FILE_TOOLS_FILE, "\"default\": \"replace\"", "\"default\": \"patch\"", "no longer defaults to \"replace\""),
    (PATCH_PARSER_FILE, "def parse_v4a_patch(", "def parse_patch(", "`parse_v4a_patch` is gone"),
    (PATCH_PARSER_FILE, "    MOVE = \"move\"\n", "    MOVE = \"move\"\n    COPY = \"copy\"\n", "new V4A operation `copy`"),
    (PATCH_PARSER_FILE, "    DELETE = \"delete\"\n", "\n", "V4A operation `delete` is gone"),
    (EVENTS_FILE, "event(\"tool.start\"", "event(\"tool.begin\"", "event `tool.start` is not declared"),
    (EVENTS_FILE, "    tool_id: str\n    name: str\n    context:", "    id: str\n    name: str\n    context:", "`ToolStartPayload.tool_id` is gone"),
    (LIFECYCLE, "\"edit_file\", \"patch\", \"write_file\",", "\"edit_file\",", "left _TOOL_LIFECYCLE_UI_TOOLS"),
    (COMPRESSOR_FILE, 'label: str = "FAILED"', 'label: str = "ERROR"', "no longer says ' FAILED:'"),
    (COMPRESSOR_FILE, "BLOCKED, not run", "refused", "no longer says 'BLOCKED, not run'"),
    (PET_FILE, "  setTimeout: (fn", "  delay: (fn", "`ctx.setTimeout` is gone"),
]


def selftest(core: Path) -> int:
    """Copy the files this gate reads, break each rule once, and require the gate to name it."""
    fails = 0
    with tempfile.TemporaryDirectory(prefix="sw-contract-") as tmp:
        fake = Path(tmp)
        rels = {SCHEMA_FILE, DELEGATE_FILE, COMPRESSION_FILE, RESULTS_FILE, REGISTRY_FILE, EVENTS_FILE,
                STATUS_FILE, SDK_FILE, CHILD_RUN_FILE, PRICING_FILE, PET_FILE, FILE_TOOLS_FILE, PATCH_PARSER_FILE,
                SERVER_FILE, COMPRESSOR_FILE} | {str(p.relative_to(core)).replace("\\", "/")
                                           for p in (core / CONTRACTS_DIR).glob("*.py")}
        if (core / AGENT_FACTORY_FILE).is_file():
            rels.add(AGENT_FACTORY_FILE)
        for rel in rels:
            (fake / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(core / rel, fake / rel)
        clean = check(fake)
        if clean:
            print(f"FAIL  the copied core is not clean before the breaks: {clean}")
            return 1
        for rel, old, new, fragment in BREAKS:
            rel = _lifecycle_file(fake) if rel == LIFECYCLE else rel
            path = fake / rel
            original = path.read_text(encoding="utf-8")
            if old not in original:
                print(f"FAIL  {rel}: anchor {old!r} not found — the break could not be injected")
                fails += 1
                continue
            # Every occurrence: a rule that still finds a second copy of its anchor is not broken.
            path.write_text(original.replace(old, new), encoding="utf-8")
            found = check(fake)
            path.write_text(original, encoding="utf-8")
            ok = any(fragment in p for p in found)
            print(f"{'OK  ' if ok else 'FAIL'}  {fragment}")
            fails += 0 if ok else 1
    print("contract selftest: every break named" if not fails else f"contract selftest: {fails} break(s) not caught")
    return 1 if fails else 0


def main() -> int:
    core = env.core_dir()
    if core is None:
        print("no Hermes core found — set HERMES_AGENT_DIR to a hermes-agent checkout")
        return 2
    if "--selftest" in sys.argv:
        return selftest(core)
    problems = check(core)
    for p in problems:
        print(f"CONTRACT  {p}")
    print(f"core contract ({core}): {'clean' if not problems else f'{len(problems)} problem(s)'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
