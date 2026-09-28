---
description: Bind this repo to a pidb project (local only, never committed)
argument-hint: "[project]"
---

Bind the current repository (its git top level) to a pidb project so every session here starts with that project's context. Project argument: `$ARGUMENTS`

- **With a project slug** → call the `pidb_bind` MCP tool with `project` set to it (or run `pidb bind <project>` with the Bash tool if the MCP server isn't available). Then call `get_project` for that slug to confirm the token can reach it:
  - 403 / not accessible → the token wasn't approved for this project: offer `/pidb:connect` so the user can tick it on the approval page.
  - 404 → the slug doesn't exist; show `list_projects` and ask which one was meant.
- **No argument** → call `list_projects`, show slugs with names and summaries, and ask the user which project this repo belongs to. Don't guess.

Finish by saying the binding takes full effect (project context injected) from the next session; for now, use `get_project` / `list_documents` / `list_secrets` for the details.
