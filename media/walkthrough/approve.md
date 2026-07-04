# The approval boundary

Nothing is edited or run without your OK:

- **Proposed diffs** must pass path-safety checks and `git apply --check` before approval, and are re-checked before apply.
- **Commands** are argv arrays validated against an allowlist; `rm`, `sudo`, `git reset`, `git clean`, and shell metacharacters are always blocked.
- **Agent handoffs** (sending a suggestion to pi/codex/a custom agent) open a visible terminal you control.

Queued actions pop a notification with **Approve / Preview / Reject** buttons and stay listed under *Pending approvals* in the sidebar. Ignored paths (`.env*`, `node_modules/`, …) never reach model providers.
