# Repo-aware suggestions

Run **Master Hand: Refresh Suggestions** (or click the refresh icon in the sidebar) and Master Hand combines:

- open editors and recent edit locations
- diagnostics (errors and warning hotspots)
- git status and uncommitted diffs
- ripgrep hits and a bounded repo index

Local heuristics always run first, so you get useful suggestions even with no model configured. Merge conflicts, oversized diffs, missing test updates, and diagnostic hotspots all surface here.

Suggestions are **advisory** — reading them never edits a file or runs a command.
