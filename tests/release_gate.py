"""Release gate: one version everywhere, and the installed desktop copy is this repo's panel.

Why a separate module: the static audit calls `check()` and reports what it finds like any other
rule, while `python release_gate.py` is this gate's own canary — every way it can fail is injected
once and must turn the audit red, and every file comes back byte for byte.

Rules:
  * `plugin.yaml` is the source of the version; `dashboard/manifest.json` and the top `## <version>`
    heading of `CHANGELOG.md` must carry the same one. A plugin that reports two versions depending on
    where you look has no version at all.
  * `plugin.yaml` `requires_hermes: ">=X"` is the oldest supported Hermes; README.md § Supported Hermes
    versions must say "X or newer". ci.yml's CORE_SHA pins the same core (a comment there, not checked).
  * The desktop app loads `$HERMES_HOME/desktop-plugins/<id>/plugin.js`, a COPY of
    `desktop/plugin.js`. The two must be identical up to line endings (a git checkout is LF by
    `.gitattributes`, a copy made on Windows may be CRLF, and the loader reads both alike); a missing
    copy (a clone, not an install) is a note, not a failure.

Running: python release_gate.py      (exit 0 = every rule fired on its injection, files restored)
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import env

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PLUGIN_YAML = ROOT / "plugin.yaml"
MANIFEST = ROOT / "dashboard" / "manifest.json"
CHANGELOG = ROOT / "CHANGELOG.md"
README = ROOT / "README.md"
JS = ROOT / "desktop" / "plugin.js"
AUDIT = HERE / "audit_static.py"


def _yaml_version() -> str | None:
    match = re.search(r"^version:\s*['\"]?([^'\"\s]+)", PLUGIN_YAML.read_text(encoding="utf-8"), re.M)
    return match.group(1) if match else None


def _yaml_min_hermes() -> str | None:
    """The floor `requires_hermes: ">=X"` declares (a bare version means >= to the core too)."""
    match = re.search(r"^requires_hermes:\s*['\"]?(?:>=)?\s*([0-9][^'\"\s,]*)['\"]?\s*$",
                      PLUGIN_YAML.read_text(encoding="utf-8"), re.M)
    return match.group(1) if match else None


def _readme_section(title: str) -> str:
    text = README.read_text(encoding="utf-8") if README.is_file() else ""
    match = re.search(rf"^## {re.escape(title)}\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    return match.group(1) if match else ""


def _lf(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n")


def check(report) -> None:
    version = _yaml_version()
    if version is None:
        report("plugin.yaml: `version:` is missing — the plugin would report no version")
        return
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        report(f"dashboard/manifest.json cannot be read ({exc}) — the card would report no version")
        manifest = {}
    if isinstance(manifest, dict) and manifest.get("version") != version:
        report(f"version drift: plugin.yaml says {version} while dashboard/manifest.json says "
               f"{manifest.get('version')!r} — bump both in the same change")
    if not CHANGELOG.is_file():
        report("CHANGELOG.md is missing — nothing records what shipped")
    else:
        heading = re.search(r"^##\s+([0-9][0-9A-Za-z.\-]*)", CHANGELOG.read_text(encoding="utf-8"), re.M)
        if not heading:
            report("CHANGELOG.md: no `## <version>` heading — nothing records what shipped")
        elif heading.group(1) != version:
            report(f"changelog drift: CHANGELOG.md starts at {heading.group(1)} but plugin.yaml says "
                   f"{version} — the top entry must be the version being shipped")
    floor = _yaml_min_hermes()
    if floor is None:
        report("supported-range drift: plugin.yaml declares no `requires_hermes: \">=X\"` — the README's "
               "supported range has nothing to match")
    elif f"{floor} or newer" not in _readme_section("Supported Hermes versions"):
        report(f"supported-range drift: plugin.yaml requires Hermes >={floor} but README.md § Supported Hermes "
               f"versions does not say \"{floor} or newer\" — move requires_hermes, the README and ci.yml CORE_SHA "
               "together")
    installed = env.installed_desktop_copy()
    if not installed.exists():
        print(f"note: no installed desktop copy at {installed} — sync check skipped")
    elif _lf(installed.read_bytes()) != _lf(JS.read_bytes()):
        report(f"installed copy drift: {installed} differs from desktop/plugin.js — copy the repo file "
               "over it (the app loads the copy, never this file)")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _audit(extra_env: dict[str, str] | None = None) -> tuple[int, str]:
    run_env = dict(os.environ)
    core = env.core_dir()
    if core:
        run_env["HERMES_AGENT_DIR"] = str(core)
    run_env.update(extra_env or {})
    proc = subprocess.run([sys.executable, str(AUDIT)], capture_output=True, text=True, cwd=HERE,
                          env=run_env, encoding="utf-8", errors="replace")
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def _in_tree(label: str, path: Path, old: str, new: str, fragment: str, failures: list[str]) -> None:
    original = path.read_bytes()
    digest = _sha(original)
    text = original.decode("utf-8")
    if old not in text:
        failures.append(f"{label}: anchor {old!r} not found — the canary could not be injected")
        return
    try:
        path.write_bytes(text.replace(old, new, 1).encode("utf-8"))
        code, out = _audit()
    finally:
        path.write_bytes(original)
    restored = _sha(path.read_bytes()) == digest
    ok = code == 1 and fragment in out and restored
    print(f"{'OK  ' if ok else 'FAIL'} {label}  ->  exit {code} · message {'found' if fragment in out else 'MISSING'}"
          f" · restored {restored}")
    if not ok:
        failures.append(label)


def _installed(failures: list[str]) -> None:
    with tempfile.TemporaryDirectory(prefix="release-gate-") as tmp:
        home = Path(tmp)
        copy = home / "desktop-plugins" / env.PLUGIN_ID / "plugin.js"
        copy.parent.mkdir(parents=True)
        copy.write_bytes(JS.read_bytes() + b"\n")
        code, out = _audit({"HERMES_HOME": str(home)})
        drift_ok = code == 1 and "installed copy drift" in out
        copy.write_bytes(JS.read_bytes())
        same_code, _ = _audit({"HERMES_HOME": str(home)})
        copy.unlink()
        absent_code, _ = _audit({"HERMES_HOME": str(home)})
    ok = drift_ok and same_code == 0 and absent_code == 0
    print(f"{'OK  ' if ok else 'FAIL'} installed copy  ->  drifted exit {code}, identical exit {same_code}, "
          f"absent exit {absent_code}")
    if not ok:
        failures.append("installed copy")


def main() -> int:
    code, out = _audit()
    if code != 0:
        print(f"the audit is not clean before the canaries run (exit {code}):\n{out}")
        return 1
    version = _yaml_version() or ""
    failures: list[str] = []
    _in_tree("changelog heading drifts", CHANGELOG, f"## {version}", "## 0.0.0-canary", "changelog drift",
             failures)
    _in_tree("manifest version drifts", MANIFEST, f'"version": "{version}"', '"version": "0.0.0-canary"',
             "version drift", failures)
    floor = _yaml_min_hermes() or ""
    _in_tree("requires_hermes drifts from the README", PLUGIN_YAML, f'requires_hermes: ">={floor}"',
             'requires_hermes: ">=99.0.0"', "supported-range drift", failures)
    _installed(failures)
    code, _ = _audit()
    if code != 0 or failures:
        print(f"RELEASE GATE CANARY: problems found ({', '.join(failures) or f'audit exit {code} after reverts'})")
        return 1
    print("RELEASE GATE CANARY clean — changelog, manifest, supported-range and installed-copy rules each fire, "
          "files restored")
    return 0


if __name__ == "__main__":
    sys.exit(main())
