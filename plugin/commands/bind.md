---
description: Bind this repo to a pidb project (local only, never committed)
argument-hint: "[project]"
---

Bind the current repository (its git top level) to a pidb project so every session here starts with that project's context. Project argument: `$ARGUMENTS`

- **With a project slug** → call the `pidb_bind` MCP tool with `project` set to it (or run `pidb bind <project>` with the Bash tool if the MCP server isn't available). Then call `get_project` for that slug to confirm the token can reach it:
  - `not_found` / "project not found" → the server gives the same answer when the project doesn't exist **and** when the token wasn't approved for it. First offer `/pidb:connect` so the user can tick that project on the approval page; only if they say it doesn't exist, show `list_projects` and ask which one was meant.
  - `missing_scope` / `forbidden` → the token lacks a scope: offer `/pidb:connect` to widen.
- **No argument** → call `list_projects`, show slugs with names and summaries, and ask the user which project this repo belongs to. Don't guess.

Finish by saying the binding takes full effect (project context injected) from the next session; for now, use `get_project` / `list_documents` / `list_secrets` for the details.
