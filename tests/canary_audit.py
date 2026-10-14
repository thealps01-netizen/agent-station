"""Canary run for subagent-watch: every lock is broken once and the gate that owns it must go red.

Why: a test that passes is only evidence when it is also known to FAIL on the bug it is named
after. The notes used to say "mutation canaries were run by hand"; this is that list, repeatable.
Each mutation is applied to a COPY of the panel (the repo is never edited) and the owning gate is
run against the copy:

  render    tests/render_check.mjs <copy of plugin.js>      (behaviour: scoping, marks, failures)
  backend   tests/check_api.py  with the copy's plugin_api  (read-only, lineage, statuses, 403s)
  audit     tests/audit_static.py over the copied tree      (i18n, a11y, colours, silent catches)

Run: python canary_audit.py        (exit 0 = every mutation caught, the repo untouched)
     SW_CANARY_ONLY=12,40 python canary_audit.py   re-runs only those mutations (numbers as printed)

Mutations run in parallel (`SW_CANARY_JOBS`, default 8): a render run mostly waits on poll timers,
and one at a time the list outgrew the CI job's time limit.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
JS = "desktop/plugin.js"
PY = "dashboard/plugin_api.py"

# (gate, file, old, new, what the mutation breaks)
MUTATIONS = [
    # ── 2.0.0 agents HUD ────────────────────────────────────────────────────────────────────
    ("render", JS, "completed: 'sw.hudAgents.coDone', failed:", "completed: 'sw.hudAgents.coRunning', failed:",
     "a callout says a finished subagent is still working"),
    ("render", JS, "className: 'sw-fco', 'data-to': u.key,", "className: 'sw-fco', 'data-to': '',",
     "a callout is not tied to its subagent's node"),
    ("render", JS, "k === 0 ? 'first' : ''", "''", "the callout spine runs above the first callout"),
    ("render", JS, "const ended = subs.every(u => TERMINAL.has(u.status))", "const ended = false",
     "a finished run is still called running"),
    ("render", JS, "[shortModel(main.rec?.model), statusWord(t, main, waitingOn)].filter(Boolean)",
     "[shortModel(main.rec?.model)].filter(Boolean)", "the main node does not say what it does"),
    ("render", JS, "className: 'sw-tk', 'data-st': u.status,", "className: 'sw-tk',",
     "time per agent is not coloured by status"),
    ("render", JS, "return s === 'failed' ? 'failed' : s === 'read' ? 'read' : 'changed'", "return 'changed'",
     "every file cell reads as changed"),
    ("render", JS, "jsx(FleetAgent, { t, u: sel,", "jsx(FleetAgent, { t, u: main,",
     "the agent card does not follow the selection"),
    ("render", JS, "'aria-pressed': selected === u.key, onClick: () => onSelect(u.key),\n            children: [\n              jsx('span', { className: 'sw-hlt'",
     "'aria-pressed': selected === u.key, onClick: () => {},\n            children: [\n              jsx('span', { className: 'sw-hlt'",
     "a log row click does not select its subagent"),
    ("render", JS, ".sw-fleg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11.5px;", ".sw-fleg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:10px;",
     "the files legend drops below the text floor"),
    ("audit", JS, ".sw-flead{position:relative;flex:1 1 0;min-width:10px;height:1px;background:var(--hud-wire)}",
     ".sw-flead{position:relative;flex:1 1 0;min-width:10px;height:1px;background:#a9a9ab}",
     "hexColor: a leader line painted with a colour literal"),
    # ── 1.6.0 command deck ──────────────────────────────────────────────────────────────────
    ("backend", PY, 'found[link["id"]] = row["id"]', 'found[link["id"]] = link["id"]',
     "a worker's compressed later half is named as a worker of its own"),
    ("backend", PY, 'if not failed and op != "read" and who not in f["editors"]:', 'if who not in f["editors"]:',
     "an agent that only read a file is counted as having changed it"),
    # ── 1.5.0 files: the page ───────────────────────────────────────────────────────────────
    ("render", JS, "return /^[A-Za-z]:\\//.test(folded) ? folded.toLowerCase() : folded", "return folded",
     "the page keys a drive path by its case, so the backend's row never shimmers"),
    ("render", JS, "if (name === 'patch' && (args.mode || 'replace') === 'patch') return []\n", "",
     "a V4A patch's text is taken for a path"),
    ("render", JS, "if (!cwd || text.startsWith('~')", "if (true || text.startsWith('~')",
     "a relative path is not joined to the chat's folder"),
    ("render", JS, "const TOUCH_LINGER_MS = 4000", "const TOUCH_LINGER_MS = 0",
     "the shimmer ends with the call, too fast to see"),
    ("render", JS, "      doneRef.current?.()\n", "",
     "a finished file call does not reload the list"),
    ("render", JS, "  if (active) return 'active'\n  if (f.last_failed) return 'failed'\n", "  if (active) return 'active'\n",
     "a failed last edit reads as edited"),
    ("render", JS, "    now.push(byKey.get(key) || {", "    if (byKey.get(key)) now.push(byKey.get(key) || {",
     "a file touched now but not yet recorded is not shown"),
    ("render", JS, "/files?session_id=${encodeURIComponent(storedId)}", "/files?session_id=st-1",
     "files are read for another chat"),
    # ── 1.5.0 files: the backend ────────────────────────────────────────────────────────────
    ("backend", PY, "    return folded.lower() if _DRIVE.match(folded) else folded", "    return folded",
     "the backend keys a drive path by its case: one file, two rows"),
    ("backend", PY, "    workers = _worker_ids(conn, ids)\n", "    workers = []\n",
     "a worker's files are not its chat's"),
    ("backend", PY, "    ids = _lineage(conn, session_id)\n    workers", "    ids = [session_id]\n    workers",
     "files before a compression are lost"),
    ("backend", PY, "        return \" FAILED:\" in line or", "        return False and",
     "a compressed failure stub reads as an edit"),
    ("backend", PY, "            out += [(op.file_path, \"delete\"), (op.new_path, \"write\")]",
     "            out.append((op.file_path, \"write\"))", "a V4A move loses its target"),
    ("backend", PY, "        if not targets:\n            unreadable += 1\n", "        if not targets:\n",
     "an unreadable file call is dropped, not counted"),
    ("backend", PY, "\"more\": max(0, len(ordered) - MAX_FILES)", "\"more\": 0", "files past MAX_FILES vanish silently"),
    ("backend", PY, "    if unixish.startswith(\"/\") or _DRIVE.match(unixish) or not cwd:", "    if True:",
     "a relative path is not joined to the chat's folder"),
    ("backend", PY, "            if failed:\n                f[\"failed\"] += 1\n", "            if False:\n                f[\"failed\"] += 1\n",
     "a refused write counts as an edit"),
    ("backend", PY, "    cached = _FILES_CACHE.get(key)", "    cached = _FILES_CACHE.get(key[0])",
     "the cache is keyed by chat only"),
    # ── render: the page ────────────────────────────────────────────────────────────────────
    ("render", JS, "if (event?.session_id !== runtimeId) return\n      const p = event.payload || {}\n      if (!p.subagent_id", "const p = event.payload || {}\n      if (!p.subagent_id",
     "events of another chat are no longer filtered out"),
    ("render", JS, "queued: 'queued', running", "queued: 'completed', running",
     "a queued worker is drawn as done"),
    ("render", JS, "failed: 'failed', error: 'failed'", "failed: 'failed', error: 'completed'",
     "an errored worker is drawn as done"),
    ("render", JS, "        if (fails.current >= MAX_POLL_FAILS) setError(String(err?.message || err))", "",
     "failed live polls are swallowed"),
    ("render", JS, "&worker_id=${encodeURIComponent(sid)}`", "&worker_id=c-b`",
     "copy reads another worker's output"),
    ("render", JS, "/output?session_id=${encodeURIComponent(storedId || '')}", "/output?session_id=",
     "copy output no longer names the chat it is read for"),
    ("render", JS, "    fails.current = 0\n    setError(null)\n    void pollRef.current?.()", "    void 0",
     "Refresh does not restart live polling that gave up"),
    ("render", JS, "    ok = await ctxRef.os.writeClipboard(text)\n  } catch (err) {\n    console.warn(`[${ID}] clipboard write failed`, err)\n  }",
     "    ok = await ctxRef.os.writeClipboard(text)\n  } finally {}", "a clipboard rejection escapes the copy button"),
    ("render", JS, "  const past = stored\n    .filter(b => !isLiveStored(b))\n", "  const past = stored\n",
     "a running batch is repeated under Earlier"),
    ("render", JS, "'aria-hidden': 'true', children: jsx('span', { children: t(`sw.proc.short.${p.status}`) }) }",
     "'aria-hidden': 'true' }", "a command row does not say its status"),
    ("render", JS, "p.status === 'stopped' ? '—' : fmtDuration(p.duration_s, t)", "fmtDuration(p.duration_s, t)",
     "a killed command shows a duration"),
    ("render", JS, "err => alive && setOut({ id: p.id, loading: false, data: null, error: String(err?.message || err) })",
     "() => alive && setOut({ id: p.id, loading: false, data: null, error: null })", "a failed output read is swallowed"),
    ("render", JS, "process_id=${encodeURIComponent(p.id)}`", "process_id=proc_ok`",
     "a command's output is read for the wrong process"),
    ("render", JS, "b.started_at >= liveFrom && ", "", "a crashed running batch is hidden while a live tree shows"),
    ("render", JS, "{ key: storedId, data: null, error: null, loading: true }", "{ ...prev, key: storedId, data: null, loading: true }",
     "a chat switch carries the previous chat's history error"),
    ("render", JS, "            if (gone.current.has(r.subagent_id)) continue\n", "",
     "a finished batch still listed by subagent.list is re-added"),
    ("render", JS, "'aria-busy': busy ? 'true' : undefined,", "", "copy has no busy state"),
    ("render", JS, "            className: 'sw-live', role: 'status', 'aria-live': 'polite',", "            className: 'sw-live',",
     "the toast live region is not a status region"),
    ("render", JS, "  if (words.length < 2 || words.join(' ').length < 12) return names", "  return names",
     "sibling names sharing a prefix stay identical at 380 px"),
    ("render", JS, "return m && effort ? `${m} · ${effort}` : m", "return m",
     "the model chip drops the reasoning effort"),
    ("render", JS, "      held.current = heldBy(event.target, pageRef.current)", "      held.current = false",
     "a click inside the panel moves it to the app's main chat"),
    ("render", JS, "  return HOLD_PANES.some(p => pane.startsWith(p))", "  return false",
     "a click on another page's tab moves the panel to the app's main chat"),
    ("render", JS, "    return ctxRef.setTimeout(() => {\n      if (!held.current)", "    return ((fn) => fn())(() => {\n      if (!held.current)",
     "the follow runs before the click is classified (the app's own listener fires first)"),
    # ── render: 1.3.0 locks ──────────────────────────────────────────────────────────────────
    ("render", JS, "            if (r.status === 'queued' && at - (r.queued_at ?? at) < QUEUE_GRACE_S) {", "            if (false) {",
     "a queued worker Hermes has not listed yet reads stopped"),
    ("render", JS, "const status = TERMINAL.has(had?.status) ? had.status : (STATUS_OF[r.status] || r.status)",
     "const status = STATUS_OF[r.status] || r.status", "a stale subagent.list snapshot revives a finished worker"),
    ("render", JS, "    return ctxRef.rest(`/children?session_id=", "    ctxRef.rest(`/children?session_id=",
     "a finished batch leaves Now before history has it (the empty state flashes)"),
    ("render", JS, "        if (!alive) return // a poll of the chat the page has left: its failure is not this chat's\n", "",
     "a failed poll of the chat the page left counts against the new chat"),
    ("render", JS, "const fetches = p.status !== 'running' && p.has_output !== false", "const fetches = p.status !== 'running'",
     "a command with no receipt asks for output and shows a 404"),
    ('render', JS, "cut ? jsx('p', { className: 'sw-cmcut'", "false ? jsx('p', { className: 'sw-cmcut'",
     'a cut command does not say it is cut'),
    ("render", JS, "  if (!text) return onToast(t('sw.nothingToCopy'), true)\n", "", "copying an empty output reads Copied"),
    ("render", JS, "watched.held ? jsx(Tip", "false ? jsx(Tip", "a held chat is not marked as held"),
    ("render", JS, "className: 'sw-erra', children: jsx(IconButton, { label: t('sw.retry')", "className: 'sw-erra', children: jsx(IconButton, { label: t('sw.refresh')", "the alert has no Try again button"),
    # ── render: 1.4.0 cost and progress ─────────────────────────────────────────────────────
    ('render', JS, "return status === 'estimated' ? t('sw.cost.est', amount) : amount", 'return amount',
     'an estimated cost reads as a billed amount'),
    ('render', JS, "  if (status === 'included') return t('sw.cost.included')\n", '',
     'a subscription worker shows no cost'),
    ('render', JS, '    } else unknown++', '    } else { priced++ }',
     'an unpriced worker is summed as $0'),
    ('render', JS, "const status = priced ? (estimated ? 'estimated' : 'actual')", "const status = priced ? 'actual'",
     'a sum with an estimate reads as billed'),
    ('render', JS, 'Number.isFinite(p.cost_usd) && p.cost_usd > 0', 'Number.isFinite(p.cost_usd) && p.cost_usd >= 0',
     'a $0 complete frame (subscription or unpriced) reads as a price'),
    ('render', JS, '          ...eventCost(p)\n', '',
     'a live batch drops the cost its workers reported'),
    ('render', JS, "className: 'sw-money', tabIndex: 0,", "className: 'sw-money',",
     "the live batch's cost chip is not reachable by keyboard"),
    ('render', JS, '  const sid = event?.session_id\n', '  const sid = host.state.focusedSessionId.get()\n',
     "another chat's worker is counted on the focused chat's chip"),
    ('render', JS, '  const had = track.workers.get(p.subagent_id)\n  if (TERMINAL.has(had?.status)) return\n', '  const had = track.workers.get(p.subagent_id)\n',
     'a late frame changes a worker that already ended'),
    ('render', JS, "    track.workers.set(id, { ...w, status: 'stopped' })\n", '',
     'a worker the list dropped runs forever on the chip'),
    ('render', JS, '  if (!prev && !live.length) return\n', '  if (!prev) return\n',
     'a batch already running when the app loaded is not picked up'),
    ('render', JS, '  if (!track?.workers.size || (endedAt && Date.now() - endedAt > PROGRESS_LINGER_MS)) return null', '  if (!track?.workers.size) return null',
     'a finished batch never leaves the chip'),
    ('render', JS, '  if (!pet?.visible?.get?.()) return\n', '  if (!pet) return\n',
     'the pet is spoken to when none is on screen'),
    ('render', JS, '  if (text === petLine) return\n', '',
     'every tool call re-sends the pet line (rate limit)'),
    ('render', JS, "tone: pr.ended ? (pr.failed ? 'error' : 'info') : 'wait'", "tone: 'info'",
     'the pet line does not say a batch failed'),
    ('render', JS, '        if (fails >= MAX_POLL_FAILS) setStalled(String(err?.message || err))', '',
     'failed progress polls are swallowed'),
    ('render', JS, 'onClick: () => host.navigate(ROUTE)', 'onClick: () => {}',
     'the chip does not open the page'),
    ('render', JS, "'data-st': st, 'aria-label': tip,", "'data-st': st,",
     'the chip has no accessible name'),
    ('render', JS, 'const pct = pr.total ? Math.round((pr.finished / pr.total) * 100) : 0', 'const pct = 0',
     'the progress bar does not fill'),
    # ── backend: plugin_api.py ──────────────────────────────────────────────────────────────
    ("backend", PY, "?mode=ro", "?mode=rw", "state.db is opened writable"),
    ("backend", PY, "or not _owned(entry, owners)", "",
     "another chat's running commands are listed"),
    ("backend", PY, "if not _owned(record, owners):\n            continue", "if False:\n            continue",
     "another chat's finished commands are listed"),
    ("backend", PY, "if record.get(\"completion_reason\") == \"killed\":\n        return \"stopped\"", "",
     "a killed command reads as failed"),
    ("backend", PY, "return \"completed\" if record.get(\"exit_code\") == 0 else \"failed\"", "return \"completed\"",
     "a non-zero exit reads as completed"),
    ("backend", PY, "\"status\": \"running\" if alive else \"stopped\"", "\"status\": \"running\"",
     "a dead checkpoint PID reads as running"),
    ("backend", PY, "        except (OSError, ValueError):\n            unreadable += 1\n            continue\n",
     "        except (OSError, ValueError):\n            continue\n", "unreadable receipts are hidden"),
    ("backend", PY, "raise HTTPException(status_code=403, detail=\"process belongs to another conversation\")", "pass",
     "a command's output is served to another chat"),
    ("backend", PY, "raise HTTPException(status_code=403, detail=\"not a delegated worker session\")", "pass",
     "/output serves any session"),
    ("backend", PY, "elif final:\n        status = \"completed\"", "elif True:\n        status = \"completed\"",
     "a worker closed without an answer reads as completed"),
    ("backend", PY, "    elif ended is None:\n        status = \"running\"\n    elif final:", "    elif final:\n        status = \"completed\"\n    elif ended is None:",
     "a running worker that already wrote text reads as completed"),
    ("backend", PY, "raise HTTPException(status_code=403, detail=\"worker belongs to another conversation\")", "pass",
     "/output serves another chat's worker"),
    ("backend", PY, "    except Exception as exc:  # noqa: BLE001 - a private core API", "    except ImportError as exc:  # noqa: BLE001 - a private core API",
     "a changed liveness API becomes a 500"),
    ("backend", PY, "    if ended is None and now - _last_seen(conn, row) > STALE_S:", "    if False:",
     "a crashed worker reads running forever"),
    ("backend", PY, "        return False\n\n\ndef _read_running", "        return True\n\n\ndef _read_running",
     "liveness fails open: a process nobody can check reads running"),
    ("backend", PY, "detail=\"state.db not found in this Hermes home\"", "detail=f\"state.db not found: {path}\"",
     "the 503 prints the absolute state.db path"),
    ("backend", PY, "    with closing(_connect()) as conn:\n        return list_children", "    with _connect() as conn:\n        return list_children",
     "a route leaves its state.db connection open"),
    ("backend", PY, 'detail=f"{what} unreadable ({type(exc).__name__})"', 'detail=f"{what} unreadable: {exc}"',
     "a 503 prints the exception text with its absolute path"),
    ("backend", PY, "\"effort\": _effort(row[\"model_config\"]),", "\"effort\": None,",
     "a worker's reasoning effort is not reported"),
    ("backend", PY, "reasoning.get(\"enabled\") is False", "False",
     "a disabled reasoning config still reports an effort"),
    # ── backend: 1.3.0 locks ─────────────────────────────────────────────────────────────────
    ("backend", PY, "    if row[\"source\"] == \"tool\":\n        return True\n", "", "a tool child is taken as a compression continuation"),
    ("backend", PY, "markers = [cfg.get(\"_branched_from\"), cfg.get(\"_delegate_from\")]", "markers = [cfg.get(\"_delegate_from\")]",
     "a /branch is taken as its source chat's continuation"),
    ("backend", PY, "        markers.append(cfg.get(\"_reset_from\"))", "        pass", "a reset fork is taken as a continuation"),
    ("backend", PY, "        if _is_continuation(conn, row):\n            continue", "        if False:\n            continue",
     "a worker compressed mid-run is listed twice"),
    ("backend", PY, "    tip = _chain(conn, row)[-1][\"id\"]", "    tip = child_id", "a compressed worker's output is its interim note"),
    ("backend", PY, "\"tool_calls\": sum(r[\"tool_call_count\"] or 0 for r in chain),", "\"tool_calls\": root[\"tool_call_count\"] or 0,",
     "a compressed worker counts only its first half's tools"),
    ("backend", PY, "    entries = [e for e in data if isinstance(e, dict)]", "    entries = data",
     "a non-object checkpoint entry becomes a 500"),
    ("backend", PY, "    return isinstance(parent, str) and parent in owners", "    return parent in owners",
     "a list-valued owner becomes a 500"),
    ("backend", PY, "\"started_at\": started, \"ended_at\": mtime,", "\"started_at\": record.get(\"started_at\"), \"ended_at\": mtime,",
     "a text started_at is passed through (and breaks the sort)"),
    ("backend", PY, "        if not isinstance(record, dict):\n            raise ValueError", "        if False:\n            raise ValueError",
     "a receipt that is a JSON list becomes a 500 on /process_output"),
    ("backend", PY, "\"has_output\": False,", "\"has_output\": True,", "a checkpoint-only row claims it has output"),
    ("backend", PY, "\"title\": _title(conn, ids),", "\"title\": None,", "/children does not name the conversation"),
    # ── backend: 1.4.0 cost ──────────────────────────────────────────────────────────────────
    ('backend', PY, '            kinds.append("included")\n            continue', '            kinds.append("unknown")\n            continue',
     'a subscription worker reads unpriced'),
    ('backend', PY, 'amount = actual if isinstance(actual, (int, float)) and status == "actual" else estimate', 'amount = estimate',
     'a billed worker reports its estimate'),
    ('backend', PY, 'if status not in _PRICED or not isinstance(amount, (int, float)):', 'if not isinstance(amount, (int, float)):',
     'an unknown status with a stored amount reads as a price'),
    ('backend', PY, 'cost_usd, cost_status = _cost(chain)', 'cost_usd, cost_status = _cost([row])',
     "a compressed worker's cost counts only its tip"),
    ('backend', PY, '"actual" if all(k == "actual" for k in priced) else "estimated"', '"estimated"',
     'a billed worker reads as an estimate'),
    # ── audit: the static rules ─────────────────────────────────────────────────────────────
    ("audit", JS, "t('sw.refresh')", "t('sw.refreshNow')", "i18n: a key missing from the bundle"),
    ("audit", JS, "          stopped: 'Stopped — closed before it finished'\n        },\n        did:", "          halted: 'Stopped'\n        },\n        did:",
     "i18n: a template leaf the page can ask for"),
    ("audit", JS, "'aria-label': label, 'aria-busy'", "'aria-busy'", "iconLabel: an icon button without a name"),
    ("audit", JS, "const GLYPH_INK = 'var(--dt-background)'", "const GLYPH_INK = '#fff'",
     "hexColor: a hard-coded colour"),
    ("audit", JS, "className: 'sw-more', onClick: () => setOlder(true)", "className: 'sw-more', title: 'more', onClick: () => setOlder(true)",
     "nativeTitle: a native tooltip"),
    ("audit", JS, "console.warn(`[${ID}] openSession failed`, err)\n      onToast(String(err?.message || err), true)", "void err",
     "silentCatch: a page catch that hides the error"),
    ("audit", PY, "        except FileNotFoundError:\n            continue", "        except OSError:\n            continue",
     "silentCatch: a backend except that hides every error"),
    ("audit", PY, "@router.get(\"/output\")", "@router.post(\"/output\")", "readOnly: a writing route"),
    ('audit', JS, '.sw-sb[data-st=failed]{--sw-tint:var(--ui-red)}', '.sw-sb[data-st=failed]{--sw-tint:#e5484d}',
     'hexColor: a hard-coded colour on the progress chip'),
    ('audit', JS, "t('sw.progress.stalled', stalled)", "t('sw.progress.stall', stalled)",
     'i18n: a progress key missing from the bundle'),
    # ── 1.7.0 looks: units, focus panel, run picker, swarm, motion ─────────────────────
    ("render", JS, ".sw-toast{width:max-content;", ".sw-toast{",
     "a toast is as narrow as its region: one word a line"),
    ("render", JS, "const THEMES = ['terminal']", "const THEMES = ['dots', 'terminal']",
     "a removed look is back, and the page opens in it instead of Terminal"),
    ("render", JS, "    return THEMES.includes(kept) ? kept : THEMES[0]\n  } catch", "    return kept || THEMES[0]\n  } catch",
     "a kept value that is not a look is used as one"),
    ("render", JS, "  try {\n    const kept = ctxRef?.storage?.get?.(THEME_KEY, THEMES[0])\n    return THEMES.includes(kept) ? kept : THEMES[0]\n  } catch (err) {\n    console.warn(`[${ID}] could not read the kept look; using ${THEMES[0]}`, err)\n    return THEMES[0]\n  }",
     "  const kept = ctxRef.storage.get(THEME_KEY, THEMES[0])\n  return THEMES.includes(kept) ? kept : THEMES[0]",
     "a storage that fails (or is missing) breaks the page"),
    ("render", JS, "      jsx('pre', { className: 'sw-spr', 'aria-hidden': 'true', children: sprite(icon) }, 'v'),",
     "      jsx('span', { className: 'sw-sprx', 'aria-hidden': 'true' }, 'v'),", "a unit draws no ASCII sprite"),
    ("render", JS, "children: sprite(icon) }, 'v'),", "children: u.name.slice(0, 1).toUpperCase() }, 'v'),",
     "a unit shows a letter badge instead of what it is doing"),
    ("render", JS, "  if (u.status === 'running') return u.act || 'think'\n", "",
     "a running unit's icon does not say what it is doing"),
    ("render", JS, "  return { completed: 'ok', failed: 'bad', stopped: 'stop', queued: 'wait' }[u.status] || 'idle'",
     "  return { completed: 'ok', failed: 'ok', stopped: 'stop', queued: 'ok' }[u.status] || 'idle'",
     "a failed or queued unit draws the done check"),
    ("render", JS, "  return VERB[name] ? t(`sw.verb.${VERB[name]}`) : t('sw.verb.other', name)", "  return t('sw.verb.other', name)",
     "a unit says the raw tool name instead of what it does"),
    ("render", JS, "jsx(Unit, { t, theme, u: main, selected: selected === main.key, onSelect, flash: flash.get(main.key),",
     "jsx(Unit, { t, theme, u: subs[0], selected: selected === main.key, onSelect, flash: flash.get(main.key),",
     "the main agent is not the node on the left of the fleet"),
    ("render", JS, "children: [sel.main\n                ? jsx(MainPanel", "children: [false\n                ? jsx(MainPanel",
     "the focus panel does not show the main agent by default"),
    ("render", JS, "    if (!by.includes(who) && !editors.includes(who)) continue\n", "",
     "every file is every agent's"),
    ("render", JS, "    const edit = editors.includes(who) || (f.last_failed && !editors.length && f.last_op !== 'read')",
     "    const edit = true", "a file an agent only read is listed as changed"),
    ('render', JS, "const lit = f.state === 'delete' ? 0 : pips(edits)", "const lit = f.state === 'delete' ? 0 : pips(1)",
     'every file card lights one block, however often it was edited'),
    ('render', JS, "active: 'now', write: n => `${n} edit${n === 1 ? '' : 's'}`", "active: 'now', write: 'edited'",
     'a changed card does not say how often it was edited'),
    ("render", JS, "      if (event?.session_id !== runtimeId) return\n      const p = event.payload || {}\n      if (!p.tool_id) return",
     "      const p = event.payload || {}\n      if (!p.tool_id) return", "another chat's tool call is shown as this chat's work now"),
    ('render', JS, "  const now = fileGroups(all, touching).filter(f => f.state === 'active')", '  const now = []',
     "the main agent's panel drops its NOW card"),
    ("render", JS, "unreadable ? jsx('p', { className: 'sw-fnote is-bad'", "false ? jsx('p', { className: 'sw-fnote is-bad'",
     "unreadable file calls are hidden"),
    ("render", JS, "more ? jsx('p', { className: 'sw-fnote', children: t('sw.file.notListed', more) }", "false ? jsx('p', { className: 'sw-fnote', children: t('sw.file.notListed', more) }",
     "files past the list are dropped silently"),
    ("render", JS, "      jsx('p', { className: 'sw-note', children: t('sw.focus.note') }, 'n')", "      null",
     "the panel no longer says what it cannot see"),
    ("render", JS, "longTask ? jsx('button', { type: 'button', className: 'sw-more sw-inl'", "false ? jsx('button', { type: 'button', className: 'sw-more sw-inl'",
     "a cut task has no Show all"),
    ('render', JS, "chipText ? jsx(Tip, { label: t('sw.modelTip', rec.model, rec.effort)", "chipText ? jsx(Tip, { label: ''",
     'the model chip has no tooltip with the full model id and effort'),
    ('render', JS, "{ k: 'cost', label: t('sw.tile.cost'), v: cost }", "{ k: 'cost', label: t('sw.tile.cost'), v: '' }",
     "a subagent's panel drops its cost"),
    ("render", JS, "    if (sid) setSelected(sid)\n", "", "the selected subagent is lost when its run finishes"),
    ("render", JS, "    el.focus()\n", "", "focus does not follow a finished run to its selected unit"),
    ("render", JS, "  const earlier = isLive ? past : past.slice(1)", "  const earlier = past",
     "the last run is drawn twice: as the run shown and in the picker"),
    ("render", JS, "  const shown = older ? runs.earlier : runs.earlier.slice(0, HISTORY_PAGE)", "  const shown = runs.earlier",
     "the run picker lists every earlier run at once"),
    ("render", JS, "older: n => `Show ${n} older run${n === 1 ? '' : 's'}`", "older: n => `Show ${n} older runs`",
     "'Show 1 older runs'"),
    ("render", JS, "t('sw.run.name', workerName(b.workers[0]?.goal), b.workers.length - 1)", "t('sw.run.name', workerName(b.workers[0]?.goal), 0)",
     "a run of several workers is named as its first worker alone"),
    ("render", JS, "units.length, fmtCost(cost.usd, cost.status, t)),", "units.length, ''),",
     "an earlier run in the picker drops its cost"),
    ("render", JS, "'data-calm': calm ? 'true' : undefined", "'data-calm': undefined",
     "an earlier run is drawn with the live glow"),
    ("render", JS, "onBack: () => pickRun('now')", "onBack: () => {}", "Back to now does not return"),
    ("render", JS, "  const swarm = subs.length > SWARM_AT", "  const swarm = false", "more than 8 subagents never become a swarm"),
    ("render", JS, "      groups.failed.length ? jsxs('section', {", "      false ? jsxs('section', {",
     "the swarm does not list failed subagents by name"),
    ("render", JS, "shown.has(key) ? cells(groups[key]) : null", "cells(groups[key])",
     "the swarm's Waiting and Done groups do not start collapsed"),
    ("render", JS, "@media (prefers-reduced-motion:reduce){.sw-page *,.sw-page *::before,.sw-page *::after{animation:none!important;transition:none!important}}", "",
     "the page animates under reduced motion"),
    ("render", JS, "@keyframes sw-shake{", "@keyframes sw-shook{", "a failing unit no longer shakes"),
    ("render", JS, "(u.status === 'completed' || u.status === 'failed'))", "u.status === 'completed')",
     "a failure plays no moment"),
    ("render", JS, " .sw-hgrid.sw-fleet{grid-template-columns:minmax(0,1fr);grid-template-rows:none;", " .sw-hgrid.sw-fleet{grid-template-rows:none;",
     "the fleet keeps three columns at narrow width (the page scrolls sideways)"),
    ("render", JS, " .sw-fleet .sw-fco,.sw-fleet .sw-frun,", " .sw-fleet .sw-frun,",
     "a narrow fleet keeps the callouts it has no room for"),
    ("render", JS, "    jsx(ReadFiles, { t, rows: mine.read.filter(f => !nowKeys.has(f.key)), cwd, onToast }, 'r')", "    jsx(ReadFiles, { t, rows: mine.read, cwd, onToast }, 'r')",
     "a file worked on now shows again under Only read"),
    ("render", JS, "    jsx(ChangedFiles, { t, theme, count: changed.length, rows: changed, cwd, onToast }, 'c'),", "    jsx(ChangedFiles, { t, theme, count: mine.changed.length, rows: changed, cwd, onToast }, 'c'),",
     "the Changed heading counts the file worked on now that is not under it"),
    ("render", JS, "    jsx(NowFiles, { t, rows: nowRows, cwd, verbOf, onToast }, 'n'),", "",
     "the file worked on now is not shown at all"),
    ("render", JS, " .sw-page[data-theme=terminal] .sw-panel .sw-fd,.sw-page[data-theme=terminal] .sw-panel .sw-nowb{display:none}", " .sw-page[data-theme=terminal] .sw-panel .sw-fd,.sw-page[data-theme=terminal] .sw-panel .sw-nowb,.sw-page[data-theme=terminal] .sw-panel .sw-pips{display:none}",
     "a narrow Terminal file row drops its blocks"),
    ("render", JS, "@container (max-width:460px){.sw-page[data-theme=terminal] .sw-panel .sw-flist{grid-template-columns:14px fit-content(22ch) 0 39px max-content 0 1fr;column-gap:6px}", "@container (max-width:460px){.sw-page[data-theme=terminal] .sw-panel .sw-ft{grid-template-columns:14px minmax(0,1fr) auto}",
     "a narrow Terminal file row leaves the shared columns and pushes its label to the far edge"),
    ("render", JS, "  return jsxs('div', {\n    className: 'sw-flist',", "  return jsxs('div', {\n    className: 'sw-flistx',",
     "the file lists are not wrapped, so each keeps its own columns"),
    ("render", JS, "14px fit-content(32ch) fit-content(24ch) 64px max-content max-content 1fr;", "14px minmax(0,1.3fr) minmax(0,1fr) 64px 76px 30px 0;",
     "Terminal file columns stretch, leaving a gap in the middle of each row"),
    ("render", JS, ".sw-page[data-theme=terminal] .sw-flist .sw-fgrid{display:grid;grid-template-columns:subgrid;", ".sw-page[data-theme=terminal] .sw-flist .sw-fgrid{display:block;grid-template-columns:none;",
     "a Terminal list stops sharing the columns"),
    ("render", JS, ".sw-page[data-theme=terminal] .sw-fl{margin-left:0;text-align:left}", ".sw-page[data-theme=terminal] .sw-fl{margin-left:auto;text-align:right}",
     "Terminal labels are right-aligned and drift with their length"),
    ("render", JS, ".sw-page[data-theme=terminal] .sw-leg{gap:0}\n", ".sw-page[data-theme=terminal] .sw-leg{gap:0}\n.sw-page[data-theme=terminal] .sw-fh .sw-k::after{content:\"·\";margin:0 .7ch}\n",
     "a heading with no legend ends in a stray dot"),
    ("render", JS, ".sw-1l{display:block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}", ".sw-1l{display:block}",
     "run text wraps over as many lines as it has"),
    ("render", JS, "  return s.length > TIP_CHARS ? `${s.slice(0, TIP_CHARS - 1)}…` : s", "  return s",
     "a tooltip holds the whole of a long run text"),
    ("render", JS, "children: [where ? jsx(OneLine, { text: where, className: 'sw-metat' }, 'w') : null, chip]", "children: [where, chip]",
     "the focus status line is laid out in full"),
    ("render", JS, "jsx(OneLine, { text: p.cwd, className: 'sw-cmkv' })", "jsx('b', { children: p.cwd })",
     "a command's folder is laid out in full"),
    ("render", JS, "errors.map(e => jsx('li', { children: jsx(OneLine, { text: e }) }, e))", "errors.map(e => jsx('li', { children: e }, e))",
     "a long error is laid out in full in the alert"),
    ("render", JS, "allFailed: 'Nothing to show while every read fails.',", "allFailed: 'Nothing could be read. Use Try again in the box above.',",
     "the empty view repeats the alert's Try again"),
    # ── 1.7.0: the 1.6.0 behaviour on the new markup ────────────────────────────────────────
    ("render", JS, "children: fmtWhen(p.started_at, now, t) || '—' }", "children: '—' }",
     "a command row does not say when it started"),
    ("render", JS, "children: procs.error ? '—' : procsRunning })", "children: procsRunning })",
     "a failed count reads 0 like real data"),
    ("render", JS, "  const procsRunning = procRows.filter(p => p.status === 'running').length", "  const procsRunning = 0",
     "the Commands badge ignores running commands"),
    ("render", JS, "    files.error ? t('sw.err.item', t('sw.err.files'), files.error) : null", "    null",
     "a failed files read is not in the alert"),
    ("render", JS, "    body = jsx('p', { className: 'sw-empty', children: t('sw.allFailed') })", "    body = null",
     "the all-failed view is blank"),
    ("render", JS, "      procs.loading\n        ? jsxs('p', { className: 'sw-cmnote sw-cmwait'", "      false\n        ? jsxs('p', { className: 'sw-cmnote sw-cmwait'",
     "background commands have no loading state"),
    ('render', JS, "[t('sw.proc.dirK'), p.cwd ?", "[t('sw.proc.dirK'), false ?",
     'a picked command does not say where it ran'),
    ("render", JS, "unreadable ? jsx('p', { className: 'sw-pu', children: t('sw.proc.unreadable'",
     "false ? jsx('p', { className: 'sw-pu', children: t('sw.proc.unreadable'", "unreadable command records are hidden"),
    ("render", JS, "chatName ? jsx('span', { className: 'sw-chatn'", "false ? jsx('span', { className: 'sw-chatn'",
     "the header does not name the watched chat"),
    ("render", JS, "  return jsxs('button', {\n    type: 'button', className: 'sw-cmrow',", "  return jsxs(selected ? 'div' : 'button', {\n    type: 'button', className: 'sw-cmrow',",
     "picking a command row remounts it and drops focus"),
    # ── audit: 1.7.0 ─────────────────────────────────────────────────────────────────────────
    ("audit", JS, "t(busy ? 'sw.copying' : 'sw.focus.copy')", "t(busy ? 'sw.copyingNow' : 'sw.focus.copy')",
     "i18n: a key picked by a ternary is missing from the bundle"),
    ("audit", JS, "className: 'sw-fold sw-acc', 'aria-expanded': shown.has(key),", "className: 'sw-fold sw-acc',",
     "expanded: an accordion row without aria-expanded"),
    ("audit", JS, "box-shadow:0 8px 24px color-mix(in srgb,var(--bg) 60%,transparent),inset 0 0 0 1px var(--a)}",
     "box-shadow:0 8px 24px rgb(0 0 0 / .4),inset 0 0 0 1px var(--a)}", "hexColor: a hard-coded rgb() shadow"),
    ("audit", JS, "--raised:color-mix(in srgb,var(--ink) 8%,var(--bg));", "--raised:#1a1a1c;",
     "hexColor: a literal colour in the page CSS"),
    ('audit', JS, '--tm-acc:color-mix(in srgb,var(--ui-accent) 70%,var(--ui-text-primary));', '--tm-acc:#7cf29a;',
     'hexColor: a fixed literal in the Terminal palette (the old exception is gone)'),
    ('audit', JS, '--tm-bad:color-mix(in srgb,var(--ui-red) 82%,var(--ui-text-primary));', '--tm-bad:rgb(255 90 90);',
     'hexColor: an rgb() literal in the Terminal palette'),
    ("audit", JS, ".sw-note{margin:12px 0 0;font-size:12px;line-height:1.45;color:var(--dim)}", ".sw-note{margin:12px 0 0;font-size:12px;line-height:1.45;color:var(--ui-red)}",
     "toneInk: a tone used as text ink"),
    ("audit", JS, "className: 'sw-tabn', role: 'img', 'aria-label': procs.error ? t('sw.countFailed') : t('sw.tabs.running', procsRunning), ",
     "className: 'sw-tabn', role: 'img', ", "markName: a tab count without an accessible name"),
    # ── 1.7.0 focus panel and opened areas (the approved panel mock) ─────────────────────────
    ('render', JS, "if (u.status !== 'running') return t(`sw.hero.${u.status}`)", "if (u.status !== 'running') return t('sw.hero.working')",
     "a finished subagent's verb line does not say how it ended"),
    ('render', JS, "head = jsx('code', { className: 'sw-nowf', children: splitPath(newest.path).name }, `c-${newest.key}`)", "head = t('sw.focus.main.busy')",
     "the main agent's headline is not the file it works on now"),
    ('render', JS, "const tag = u.main ? t('sw.main.tag')", "const tag = u.main ? t('sw.st.idle')",
     "the main agent's portrait is not tagged MAIN"),
    ('render', JS, "jsx('span', { className: 'sw-tl', children: x.label }, 'l')", 'null',
     "a stat tile's number has no label"),
    ('render', JS, "'data-count': x.n, style: { '--sw-n': x.n },", '',
     "a tile's number does not count up"),
    ('render', JS, 'return firsts.length && lasts.length ? Math.max(0, Math.max(...lasts) - Math.min(...firsts)) : null', 'return null',
     "the main agent's on-task tile is always empty"),
    ('render', JS, 'Math.max(0, Math.min(PIPS, Math.floor(Number(n) || 0)))', 'Math.max(0, Math.floor(Number(n) || 0))',
     'a file card lights more blocks than its row holds'),
    ('render', JS, 'const text = label || t(`sw.file.op.${f.state}`, edits)', 'const text = label || t(`sw.file.op.${f.state}`, Math.min(edits, PIPS))',
     'a card past 8 edits says 8, not its real count'),
    ('render', JS, "jsx('span', { className: 'sw-leg', children: t(theme === 'terminal' ? 'sw.focus.legendTm' : 'sw.focus.legend') }, 'l')", 'null',
     'the blocks are not explained (no 1 block = 1 edit)'),
    ('render', JS, "now ? jsx('span', { className: 'sw-nowb', 'aria-hidden': 'true', children: t('sw.file.nowBadge') }, 'now') : null", 'null',
     'the file worked on now has no NOW badge'),
    ('render', JS, "className: `sw-fr sw-ft${now ? ' is-now' : ''}`", "className: 'sw-fr sw-ft'",
     'the file worked on now does not glow as the NOW card'),
    ('render', JS, "      jsx(NowFiles, { t, rows: nowRows, cwd, verbOf, onToast }, 'n'),\n", '',
     'the files worked on now are not listed above the lists'),
    ('render', JS, 'const shown = all ? rows : rows.slice(0, READ_ROWS)', 'const shown = all ? rows : rows.slice(0, 3)',
     'only-read files show too few rows before Show N more'),
    ('render', JS, "jsx(FileCard, { t, f: { ...f, state: 'read' }, cwd, order: i, onToast }, f.key)", "jsx('span', { className: 'sw-fr sw-chip', children: f.path }, f.key)",
     'an only-read file is a bare chip, not a row like a changed one'),
    ('render', JS, '.sw-page[data-theme=terminal] .sw-ft{display:grid;width:100%;', '.sw-page[data-theme=terminal] .sw-ft{display:grid;',
     'Terminal file rows size to their content and no longer line up'),
    ('render', JS, '.sw-headt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}', '.sw-headt{min-width:0}',
     'a long headline wraps over several lines'),
    ('render', JS, "full ? jsx(Tip, { label: tipText(full), children: headline(0) }, 'h') : headline(undefined),", 'headline(undefined),',
     'a cut headline has no tooltip with the whole text'),
    ('render', JS, "className: `sw-anst${longAnswer && !allAnswer ? ' is-folded' : ''}`", "className: 'sw-anst'",
     'a long answer is shown in full, never folded'),
    ('render', JS, "onClick: () => setAllAnswer(v => !v)", "onClick: () => setAllAnswer(true)",
     'a folded answer cannot be folded again'),
    ('render', JS, "className: 'sw-ans', 'data-st': u.status,", "className: 'sw-ans',",
     'the answer card does not take its status colour'),
    ('render', JS, "[0, 1, 2, 3].map(i => jsx('i', {}, i))", '[]',
     'the answer card has no signal mark'),
    ('render', JS, "if (p.status === 'running') return jsx('span', { className: 'sw-radar'", "if (false) return jsx('span', { className: 'sw-radar'",
     'a running command shows an exit mark instead of the radar'),
    ('render', JS, "children: [jsx('b', { children: code }, 'b'),", "children: [jsx('b', { children: '' }, 'b'),",
     'the exit hex does not show the exit code'),
    ('render', JS, "className: 'sw-exit', 'data-st': p.status,", "className: 'sw-exit',",
     'the exit hex does not take its status colour'),
    ('render', JS, 'export const ERROR_LINE = /error|failed|exception|traceback/i', 'export const ERROR_LINE = /error/',
     'failed / exception / traceback lines (or any case) are not errors'),
    ('render', JS, "className: `sw-ol${l.bad ? ' is-bad' : ''}`", "className: 'sw-ol'",
     'error lines in the output are not highlighted'),
    ('render', JS, "'data-n': l.n,", '',
     'output lines are not numbered'),
    ('render', JS, "whileRunning: 'Still running — its output appears here when it finishes.'", "whileRunning: 'Running.'",
     'a running command does not say when its output appears'),
    ('render', JS, "jsx('div', { className: 'sw-scan', 'aria-hidden': 'true' }, 's')", 'null',
     'reading the output shows no scan bar'),
    ('render', JS, "jsx('span', { className: 'sw-nosig', children: t('sw.proc.noSignal') }, 'g'), ", '',
     'an unreadable output does not say NO SIGNAL'),
    ('render', JS, "className: 'sw-crt', 'data-state': 'quiet'", "className: 'sw-crt', 'data-state': 'output'",
     'an empty output is not the IT PRINTED NOTHING state'),
    ('render', JS, '.sw-page[data-theme=terminal]{--a:var(--tm-acc);', '.sw-page[data-theme=terminal]{--a:var(--tm-ok);',
     "Terminal paints in its green status, not the theme's accent"),
    ('render', JS, '--tm-ok:color-mix(in srgb,var(--ui-green) 82%', '--tm-ok:color-mix(in srgb,var(--ui-accent) 82%',
     "Terminal's done status is not the theme's green"),
    ('render', JS, '@keyframes sw-count{', '@keyframes sw-counted{',
     'the stat numbers do not count up'),
    ('render', JS, '.sw-page .sw-ft{animation:sw-in', '.sw-ft{animation:sw-in',
     'the file cards animate outside the reduced-motion lock'),
    ('render', JS, '.sw-page .sw-ft.is-now::after{animation:sw-sweep', '.sw-ft.is-now::after{animation:sw-sweep',
     'the NOW sweep runs outside the reduced-motion lock'),
    ('render', JS, '.sw-page .sw-ans{animation:sw-reveal', '.sw-ans{animation:sw-reveal',
     'the answer reveal runs outside the reduced-motion lock'),
    # ── 1.8.0 replay: the backend ───────────────────────────────────────────────────────────
    ("backend", PY, "            if once in seen:\n                continue\n", "",
     "a compressed copy of an edit counts as a second edit"),
    ("backend", PY, '        if r["kind"] not in (None, "") or _NOT_A_REQUEST.match(text.lstrip()):', "        if False:",
     "a finished delegation or a compression summary reads as one of your requests"),
    ("backend", PY, '            if t["at"] <= (at or 0):', "            if True:",
     "an edit lands under the newest request, not the one it followed"),
    ("backend", PY, "lines = _unified(diff) if isinstance(diff, str) and diff.strip() else _snippet_diff(", "lines = _snippet_diff(",
     "an applied patch loses its real line numbers"),
    ("backend", PY, '    raise HTTPException(status_code=403, detail="edit belongs to another conversation")',
     '    return {"id": step_id, "lines": [], "cut": 0}', "an edit is served under another chat"),
    ("backend", PY, '"error": _error(result) if failed else ""', '"error": ""', "a failed edit does not say why"),
    ("backend", PY, "        if not steps:\n            unreadable += 1\n", "        if not steps:\n",
     "an unreadable edit is dropped, not counted"),
    ("backend", PY, '    kept = [[tag, text if len(text) <= LINE_CHARS else text[: LINE_CHARS - 1] + "\\u2026"] for tag, text in lines[:STEP_LINES]]',
     '    kept = [[tag, text] for tag, text in lines]', "a huge edit is served whole"),
    # ── 1.8.0 replay: the page ──────────────────────────────────────────────────────────────
    ("render", JS, "const replay = useReplay(storedId, tab === 'replay')", "const replay = useReplay(storedId, true)",
     "the replay is read while its tab is closed"),
    ("render", JS, "ctxRef.rest(`/replay_step?session_id=${encodeURIComponent(storedId)}", "ctxRef.rest(`/replay_step?session_id=st-x",
     "an edit's lines are read for another chat"),
    ("render", JS, "  const shown = all ? lines : lines.slice(0, PEEK_LINES)", "  const shown = lines",
     "a long edit is laid out in full"),
    ("render", JS, "    return ctxRef.setTimeout(() => setIndex(index + 1), hold)", "    return undefined",
     "Play does not step on"),
    ("render", JS, "  if (gap < 7) return `${d.toLocaleDateString('en', { weekday: 'short' })} ${clock}`\n", "",
     "a time from this week reads as a date"),
    ("render", JS, "      got.data?.cut ? jsx('p', { className: 'sw-cmnote', children: t('sw.replay.notLoaded', got.data.cut) }, 'c') : null", "      null",
     "lines the backend cut are not counted"),
    ("render", JS, "jsx(DiffLines, { t, step, got, typing: playing && !step.failed }, step.id),", "jsx(DiffLines, { t, step, got, typing: false }, step.id),",
     "Play shows each edit standing still: nothing is struck out or typed in"),
    ("render", JS, "return ctxRef.setTimeout(() => setIndex(index + 1), hold)", "return ctxRef.setTimeout(() => setIndex(index + 1), PLAY_MS)",
     "Play moves on before a long edit has finished typing"),
    ("render", JS, "jsx('span', { className: 'sw-hpn', children: name }, 'n')", "jsx('span', { className: 'sw-hpn', children: hudCaps(name) }, 'n')",
     "a command or a file name in a HUD title is capitalised"),
    ("render", JS, "  const gauge = p.status === 'failed' ? 'sw.hudCommands.failed' : finished", "  const gauge = finished",
     "a failed command's gauge says FINISHED"),
    ("render", JS, "  const shown = [...kinds].sort((a, b) => order[a] - order[b]).slice(0, FILE_CELLS)", "  const shown = kinds.slice(0, FILE_CELLS)",
     "FILES cells come in no order"),
    ("render", JS, "jsx(DiffLines, { t, step, got, typing: playing && !step.failed }, step.id),", "jsx(DiffLines, { t, step, got, typing: playing }, step.id),",
     "Play types in an edit that was never applied"),
    # ── 2.0.0 the HUD ───────────────────────────────────────────────────────────────────────
    ("render", JS, "...hunks.slice(0, 3).map(h => ", "...[].map(h => ", "the diff's parts get no callouts"),
    ("render", JS, "const sizes = steps.map(s => (s.failed ? 0 :", "const sizes = steps.map(s => (false ? 0 :",
     "a failed edit counts as applied lines"),
    ("render", JS, "onClick: () => go(k),\n            children: [", "onClick: () => {},\n            children: [", "a log row does not open its edit"),
    ("render", JS, "jsx('span', { className: 'sw-sr', children: plain }, 's')", "null", "a HUD title is read out with Ø"),
    ("audit", JS, ".sw-hp{position:relative;grid-column:span 6;min-width:0;padding:11px 12px 13px;background:var(--raised);",
     ".sw-hp{position:relative;grid-column:span 6;min-width:0;padding:11px 12px 13px;background:#101010;",
     "hexColor: a colour literal in a HUD panel"),
    ("audit", JS, ".sw-page[data-theme=terminal]{--hud-fg:var(--ui-base);--hud-bgc:var(--dt-background);", ".sw-page[data-theme=terminal]{--hud-fg:var(--ui-base);--hud-bgc:#000;",
     "hexColor: the HUD palette pins its ground to a literal instead of the theme"),
    ("render", JS, "--tm-acc:light-dark(oklch(from var(--ui-accent) min(l,.5) c h),oklch(from var(--ui-accent) max(l,.76) c h));", "--tm-acc:var(--tm-name);",
     "the HUD accent ignores the theme accent"),
    ("render", JS, "export const wireScale = (onScreen, layout) => (layout ? onScreen / layout || 1 : 1)", "export const wireScale = (onScreen, layout) => 1",
     "leader lines ignore the page scale"),
    ("render", JS, ".sw-page[data-theme=terminal]{zoom:.9565;", ".sw-page[data-theme=terminal]{zoom:.5;",
     "the HUD shrinks its text under 11px"),
    # ── 2.0.0 commands HUD ──────────────────────────────────────────────────────────────────
    ("render", JS, "onPick: () => onPick(x.id)", "onPick: () => {}", "a command row does not pick its command"),
    ("render", JS, "className: 'sw-cmrow', 'data-st': p.status, 'aria-pressed': selected,", "className: 'sw-cmrow', 'data-st': p.status, 'aria-pressed': false,",
     "the picked command's row is not marked"),
    ("render", JS, "const bad = lines.find(l => l.bad)", "const bad = lines.findLast(l => l.bad)",
     "FIRST ERROR points at the last failing line"),
    ("render", JS, "'data-n': l.n, 'data-o': l.n,", "'data-n': l.n,", "the FIRST ERROR leader line has no row to point at"),
    ("render", JS, "const command = got.data?.command || p.command || ''", "const command = p.command || ''",
     "the PROCESS card shows the row's cut command, not the receipt's"),
    ("render", JS, "children: finished ? '100%' : running ? ran || '…' : '—' }", "children: '100%' }",
     "a running command's gauge reads 100%"),
    ("render", JS, ".sw-hp[data-span=\"4\"]{grid-column:span 4}", ".sw-hp[data-span=\"4\"]{grid-column:span 6}",
     "the COMMANDS list spans the whole grid"),
    ("render", JS, "const sel = rows.find(p => p.id === pick) || rows[0]", "const sel = rows.find(p => p.id === pick) || rows[rows.length - 1]",
     "with none picked the console shows the oldest command"),
]


def _sha_tree(root: Path) -> str:
    digest = hashlib.sha256()
    for rel in (JS, PY):
        digest.update((root / rel).read_bytes())
    return digest.hexdigest()


def _copy_panel(dest: Path) -> None:
    for rel in ("desktop", "dashboard", "plugin.yaml", "CHANGELOG.md"):
        src = ROOT / rel
        if src.is_dir():
            shutil.copytree(src, dest / rel, ignore=shutil.ignore_patterns("__pycache__"))
        else:
            shutil.copy2(src, dest / rel)
    (dest / "tests").mkdir()
    for name in ("audit_static.py", "release_gate.py", "env.py", "check_api.py", "path_vectors.json"):
        shutil.copy2(HERE / name, dest / "tests" / name)


def _run(gate: str, tree: Path) -> tuple[int, str]:
    run_env = dict(os.environ)
    if gate == "render":
        run_env["SW_RENDER_OUT"] = f"canary-{tree.name}"  # its own build folder, under tests/.out/
        cmd, cwd = ["node", "render_check.mjs", str(tree / JS).replace("\\", "/")], HERE
    elif gate == "backend":
        cmd, cwd = [sys.executable, str(tree / "tests" / "check_api.py")], tree / "tests"
    else:
        # A copy has no installed twin of its own; point the release gate at an empty home.
        run_env["HERMES_HOME"] = str(tree / "_no_home")
        cmd, cwd = [sys.executable, str(tree / "tests" / "audit_static.py")], tree / "tests"
    proc = subprocess.run(cmd, cwd=cwd, env=run_env, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=300)
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    before = _sha_tree(ROOT)
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="sw-canary-") as tmp:
        base = Path(tmp) / "clean"
        _copy_panel(base)
        for gate in ("render", "backend", "audit"):
            code, out = _run(gate, base)
            if code != 0:
                print(f"the {gate} gate is not green on the unmutated copy (exit {code}):\n{out[-2000:]}")
                return 1
        def one(n: int, gate: str, rel: str, old: str, new: str, what: str) -> tuple[bool, str]:
            tree = Path(tmp) / f"m{n}"
            _copy_panel(tree)
            path = tree / rel
            text = path.read_text(encoding="utf-8")
            # An anchor that occurs twice mutates whichever comes first, not necessarily the code the
            # mutation is named after: a later copy of the same line elsewhere would silently move it.
            if text.count(old) != 1:
                return False, (f"FAIL  #{n:02d} {what}: anchor found {text.count(old)} times — it must name one "
                               "place; widen it until it is unique")
            path.write_text(text.replace(old, new, 1), encoding="utf-8")
            try:
                code, out = _run(gate, tree)
            finally:
                shutil.rmtree(tree, ignore_errors=True)
                shutil.rmtree(HERE / ".out" / f"canary-{tree.name}", ignore_errors=True)
            caught = code != 0
            fired = next((line.strip() for line in out.splitlines()
                          if line.startswith(("FAIL", "PROBLEM"))), f"exit {code}")
            return caught, f"{'OK  ' if caught else 'FAIL'}  #{n:02d} [{gate}] {what}  ->  {fired[:110]}"

        jobs = max(1, int(os.environ.get("SW_CANARY_JOBS", "8")))
        only = {int(x) for x in os.environ.get("SW_CANARY_ONLY", "").split(",") if x.strip()}
        picked = [(n, m) for n, m in enumerate(MUTATIONS, 1) if not only or n in only]
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            runs = [pool.submit(one, n, *m) for n, m in picked]
            for (_, (*_, what)), run in zip(picked, runs):  # printed in list order
                caught, line = run.result()
                print(line, flush=True)
                if not caught:
                    failures.append(what)
    untouched = _sha_tree(ROOT) == before
    if not untouched:
        failures.append("the repo's own files changed during the run")
    ran = len(picked)
    print(f"\ncanary: {ran - len(failures)}/{ran} caught · repo untouched {untouched}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
