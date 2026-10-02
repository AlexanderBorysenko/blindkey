---
description: Show blindkey connection status for this repo — profile, server, bound project, token state
---

Show the blindkey agent's status for this repository.

1. Call the `blindkey_status` MCP tool (if the MCP server isn't available, run `blindkey status` with the Bash tool).
2. Report: profile and server URL, bound project (or "not bound"), whether a token is stored, and — if known — its approved projects and expiry. Never show or look for the token itself.
3. Suggest the one next step that applies, if any:
   - no profile → `/blindkey:server <name> <url>`
   - not connected, expired, or expiring within a week → `/blindkey:connect`
   - bound project not among the token's projects → `/blindkey:connect` to widen
   - not bound → `/blindkey:bind <project>`
