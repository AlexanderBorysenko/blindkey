---
description: Connect Claude to the pidb server — the user approves a project-scoped agent token in the browser
argument-hint: "[profile]"
---

Connect the pidb agent to its server with the browser device flow. Nothing secret passes through this chat.

Profile argument: `$ARGUMENTS` (empty means the repo's bound profile, else the default profile).

1. Run with the Bash tool, **in the background** (`run_in_background: true`) because it waits up to 10 minutes for the approval:
   - no argument: `pidb connect`
   - with a profile: `pidb connect --profile <profile>`
   If it fails immediately with "no server configured", tell the user to run `/pidb:server <name> <url>` first and stop.
2. Read the command's output as soon as it prints `Open <url> and approve code <code>`. Tell the user that URL and the code, and ask them to check that the approval page shows the same code, tick the projects this agent should reach (the bound project is pre-selected), and approve. The CLI tries to open the browser itself.
3. Wait for the background command to finish, then report what it printed: token name, projects, scopes and expiry. It never prints the token — never ask for it, and never try to read it.
4. If it reports denied or expired, say so and offer to run `/pidb:connect` again.
