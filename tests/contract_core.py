"""Core contract: everything subagent-watch reads from Hermes still exists under the name it reads.

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
  sdk        every name the page imports from `@hermes/plugin-sdk` is exported, and the two
             `host.state` atoms it reads exist

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
    sessions = {"id", "parent_session_id", "end_reason", "model_config", "started_at"}
    listed = re.search(r"select (id, model, .*?) from sessions", sql)
    if listed:
        sessions |= {c.strip() for c in listed.group(1).split(",")}
    messages = {"session_id", "role", "content", "id"}
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

    sdk = _read(core, SDK_FILE, problems)
    if sdk:
        exported = set(re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\b", " ".join(
            re.findall(r"export \{([^}]*)\}", sdk) + re.findall(r"export (?:const|function) ([A-Za-z_]+)", sdk))))
        exported |= set(re.findall(r"as ([A-Za-z_]+)", " ".join(re.findall(r"export \{([^}]*)\}", sdk))))
        for name in sorted(_page_imports(page) - exported):
            problems.append(f"{SDK_FILE}: `{name}` is not exported — the page imports it")
        for atom in HOST_STATE_ATOMS:
            if not re.search(rf"^\s+{atom}: readonlyAtom", sdk, re.M):
                problems.append(f"{SDK_FILE}: `host.state.{atom}` is gone — the page scopes everything by it")
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
    (SDK_FILE, "  PanelEmpty,\n", "\n", "`PanelEmpty` is not exported"),
    (SDK_FILE, "    focusedStoredSessionId: readonlyAtom", "    storedSessionId: readonlyAtom", "`host.state.focusedStoredSessionId` is gone"),
]


def selftest(core: Path) -> int:
    """Copy the files this gate reads, break each rule once, and require the gate to name it."""
    fails = 0
    with tempfile.TemporaryDirectory(prefix="sw-contract-") as tmp:
        fake = Path(tmp)
        rels = {SCHEMA_FILE, DELEGATE_FILE, COMPRESSION_FILE, RESULTS_FILE, REGISTRY_FILE, EVENTS_FILE,
                STATUS_FILE, SDK_FILE} | {str(p.relative_to(core)).replace("\\", "/")
                                           for p in (core / CONTRACTS_DIR).glob("*.py")}
        for rel in rels:
            (fake / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(core / rel, fake / rel)
        clean = check(fake)
        if clean:
            print(f"FAIL  the copied core is not clean before the breaks: {clean}")
            return 1
        for rel, old, new, fragment in BREAKS:
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
