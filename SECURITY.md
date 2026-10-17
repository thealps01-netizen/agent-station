# Security policy

## Supported versions

Only the latest release receives fixes. Agent Station follows Hermes: each release lists the Hermes
versions it supports in `plugin.yaml` (`requires_hermes`) and in the README.

| Version | Supported |
| ------- | --------- |
| 3.x     | yes       |
| < 3.0   | no        |

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately on GitHub instead:
**Security → Report a vulnerability** on this repository
(<https://github.com/thealps01-netizen/agent-station/security/advisories/new>).

Include what you found, how to reproduce it, and the Agent Station and Hermes versions you used.
Fixes are made on a best-effort basis by a single maintainer. Expect an acknowledgement within a
week and a fix or a decision after that. Once a fix is released, the advisory is published with
credit to you unless you prefer to stay anonymous.

## What the plugin can reach

Use this to judge whether a finding is in scope:

- The backend opens Hermes' `state.db` read-only (SQLite `mode=ro`) and registers GET routes only.
- It answers only for the chat in the request. A worker, command or edit that belongs to another
  chat is refused with 403.
- It makes no network calls of its own and sends no telemetry.
- The desktop page uses only the Hermes plugin SDK. `hermes plugins validate` passes, including its
  security scan and desktop-surface checks.

A way to make the plugin write, reach another chat's data, run a command, or call the network is a
vulnerability. Please report it.
