---
description: Add, switch or list blindkey server profiles
argument-hint: "[<name> <url> | use <name>]"
---

Manage blindkey server profiles. Arguments: `$ARGUMENTS`

Run exactly one of these with the Bash tool:

- **No arguments** → `blindkey profile list`, and show the profiles with the default marked.
- **`use <name>`** → `blindkey profile use <name>`. Existing repo bindings keep their own profile; only unbound repos follow the default.
- **`<name> <url>`** → `blindkey profile add <name> <url>`.
  - If it refuses because the profile exists, show the current URL (`blindkey profile list`) and ask the user whether to change it. Only on a clear yes run `blindkey profile set-url <name> <url>` — that clears the stored token, so `/blindkey:connect <name>` is needed afterwards.
  - The URL must be the server's base URL (e.g. `https://blindkey.example.com` or `http://localhost:8080`), not a page on it.

After adding a profile that has no token yet, tell the user the next step is `/blindkey:connect <name>`, then `/blindkey:bind <project>`.
