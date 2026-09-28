---
description: Add, switch or list pidb server profiles
argument-hint: "[<name> <url> | use <name>]"
---

Manage pidb server profiles. Arguments: `$ARGUMENTS`

Run exactly one of these with the Bash tool:

- **No arguments** → `pidb profile list`, and show the profiles with the default marked.
- **`use <name>`** → `pidb profile use <name>`. Existing repo bindings keep their own profile; only unbound repos follow the default.
- **`<name> <url>`** → `pidb profile add <name> <url>`.
  - If it refuses because the profile exists, show the current URL (`pidb profile list`) and ask the user whether to change it. Only on a clear yes run `pidb profile set-url <name> <url>` — that clears the stored token, so `/pidb:connect <name>` is needed afterwards.
  - The URL must be the server's base URL (e.g. `https://pidb.example.com` or `http://localhost:8080`), not a page on it.

After adding a profile that has no token yet, tell the user the next step is `/pidb:connect <name>`, then `/pidb:bind <project>`.
