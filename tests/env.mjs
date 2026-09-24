/**
 * Where the node gates find the Hermes install they verify against (the ESM twin of `env.py`).
 *
 * The gates used to reach the install with `HERE + '../../../hermes-agent'`, which is right only
 * when this repo sits inside a `plugins/` folder of that install. A clone elsewhere made the
 * preview report "kit stylesheet NOT FOUND" and quietly draw unstyled frames — a warning nobody
 * reads is how a gate stops gatekeeping.
 *
 * Env-first, same table as `env.py`:
 *   HERMES_HOME       the install root           (default: %LOCALAPPDATA%/hermes, else ~/.hermes)
 *   HERMES_AGENT_DIR  the core checkout          (default: <HERMES_HOME>/hermes-agent when present)
 *   HERMES_ELECTRON   the Electron binary        (default: the core's apps/desktop node_modules)
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const HERMES_HOME = process.env.HERMES_HOME
  ? path.resolve(process.env.HERMES_HOME)
  : process.env.LOCALAPPDATA
    ? path.resolve(process.env.LOCALAPPDATA, 'hermes')
    : path.resolve(homedir(), '.hermes')

export const CORE_DIR = process.env.HERMES_AGENT_DIR
  ? path.resolve(process.env.HERMES_AGENT_DIR)
  : existsSync(path.join(HERMES_HOME, 'hermes-agent'))
    ? path.join(HERMES_HOME, 'hermes-agent')
    : null

export const DESKTOP_APP = CORE_DIR ? path.join(CORE_DIR, 'apps', 'desktop') : null

export const ELECTRON_CANDIDATES = DESKTOP_APP
  ? [
      path.join(DESKTOP_APP, 'node_modules', 'electron', 'dist', 'electron.exe'),
      path.join(DESKTOP_APP, 'node_modules', 'electron', 'dist', 'electron'),
      path.join(DESKTOP_APP, 'node_modules', '.bin', 'electron.cmd'),
      path.join(DESKTOP_APP, 'node_modules', '.bin', 'electron')
    ]
  : []

const firstPresent = candidates => candidates.find(candidate => existsSync(candidate)) || null

export function electronBinary() {
  if (process.env.HERMES_ELECTRON) return path.resolve(process.env.HERMES_ELECTRON)
  return firstPresent(ELECTRON_CANDIDATES)
}

export function describe() {
  return `HERMES_HOME=${HERMES_HOME} · core=${CORE_DIR || 'not found'}`
}
