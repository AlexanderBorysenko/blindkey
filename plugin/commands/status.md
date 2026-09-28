---
description: Show pidb connection status for this repo — profile, server, bound project, token state
---

Show the pidb agent's status for this repository.

1. Call the `pidb_status` MCP tool (if the MCP server isn't available, run `pidb status` with the Bash tool).
2. Report: profile and server URL, bound project (or "not bound"), whether a token is stored, and — if known — its approved projects and expiry. Never show or look for the token itself.
3. Suggest the one next step that applies, if any:
   - no profile → `/pidb:server <name> <url>`
   - not connected, expired, or expiring within a week → `/pidb:connect`
   - bound project not among the token's projects → `/pidb:connect` to widen
   - not bound → `/pidb:bind <project>`
