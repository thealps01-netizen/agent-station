"""Where the gates find the Hermes install they verify against.

Why a module instead of the relative hop the gates used to take: `JS.parents[3] / "hermes-agent"`
is right only when the repo sits inside a `plugins/` folder of the install it was written in, so a
clone anywhere else made `check_css_vars` skip itself and the preview lose the application's
stylesheet — a check quietly stopping is worse than one failing, because the run still says clean.

Every path is env-first with a documented default and every miss is NAMED by the gate that wanted
it, so a gate can say which piece is missing instead of going silent:

  HERMES_HOME       the install root           (default: %LOCALAPPDATA%/hermes, else ~/.hermes)
  HERMES_AGENT_DIR  the core checkout          (default: <HERMES_HOME>/hermes-agent when present)
  HERMES_PYTHON     interpreter for the core   (default: the core's own venv, else this one)
  HERMES_ELECTRON   the Electron binary        (default: the core's apps/desktop node_modules)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_ID = "subagent-watch"
VENV_PYTHONS = ("venv/Scripts/python.exe", "venv/bin/python", ".venv/bin/python")


def hermes_home() -> Path:
    """The install root: `HERMES_HOME`, else `%LOCALAPPDATA%/hermes`, else `~/.hermes`."""
    configured = os.environ.get("HERMES_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return (Path(local_app_data) / "hermes").resolve()
    return (Path.home() / ".hermes").resolve()


def core_dir() -> Path | None:
    """The core checkout, or None when this machine keeps it somewhere undeclared."""
    configured = os.environ.get("HERMES_AGENT_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    candidate = hermes_home() / "hermes-agent"
    return candidate if candidate.is_dir() else None


def core_python() -> Path:
    """The interpreter the backend selftest must run under: the core's venv, else this one."""
    configured = os.environ.get("HERMES_PYTHON")
    if configured:
        return Path(configured).expanduser().resolve()
    core = core_dir()
    if core:
        for relative in VENV_PYTHONS:
            candidate = core / relative
            if candidate.exists():
                return candidate
    return Path(sys.executable)


def desktop_app_dir() -> Path | None:
    """`apps/desktop` of the core checkout — the source of the kit stylesheet and the CSS tokens."""
    core = core_dir()
    if not core:
        return None
    app = core / "apps" / "desktop"
    return app if app.is_dir() else None


def installed_desktop_copy() -> Path:
    """The panel copy the DESKTOP app loads — not this repo's file, its installed twin."""
    return hermes_home() / "desktop-plugins" / PLUGIN_ID / "plugin.js"


def describe() -> str:
    """One line for a gate's banner: what the run resolved, so a skip is never a mystery."""
    core = core_dir()
    return (f"HERMES_HOME={hermes_home()} · core={core if core else 'not found'} · "
            f"python={core_python()} · installed copy={installed_desktop_copy()}")


if __name__ == "__main__":
    print(describe())
