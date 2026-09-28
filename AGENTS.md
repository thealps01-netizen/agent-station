# AGENTS.md — subagent-watch

Rules for anyone (person or coding agent) changing this repository. Build, test and release steps
are in `README.md`; the design notes are in `Docs/subagent-watch-notes.md`.

## `main` changes only through a green pull request

- Never push to `main` directly. Commit on a branch, push the branch, open a pull request.
- Merge only when every CI check on the pull request is green (`gh pr checks <n>`). A red or
  pending check blocks the merge, including a failure that looks unrelated to the change: fix it or
  report it, do not merge past it.
- Why: GitHub cannot enforce this here (branch protection and rulesets need GitHub Pro on a private
  repository), so the rule is the only guard. 1.1.9 was pushed straight to `main` and left it red:
  canary #12 had stopped applying and nobody saw it until the next change.
- After a merge, check that the `push` run on `main` is green too.
