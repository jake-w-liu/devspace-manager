---
name: devspace
description: Start, stop, status-check, or live-test a DevSpace MCP server that lets ChatGPT work directly with approved local project folders.
---

# DevSpace Manager

Use this skill when the user asks to set up DevSpace, connect ChatGPT to local files through DevSpace, replace upload/download workflows with MCP, or check whether the DevSpace bridge is running.

## Workflow

1. Use `scripts/devspace_manager.mjs` for all setup, start, stop, status, and harness operations. Do not hand-roll process management.
2. Default allowed roots to the current working directory unless the user asks for broader access. Keep roots narrow.
3. Prefer `harness` after setup or changes. It starts the tunnel/server if needed and verifies:
   - DevSpace CLI and Cloudflare Tunnel are installed.
   - Config and auth files exist with private file permissions.
   - `devspace doctor` passes.
   - OAuth discovery works on localhost and the HTTPS tunnel.
   - `/mcp` rejects unauthenticated requests with `401`.
4. Treat the Owner password as a secret. Do not paste it into chat unless the user explicitly asks. Point the user to `~/.devspace/auth.json` or the `owner-token-command` field returned by the script.
5. Make clear that DevSpace is the MCP connector surface for ChatGPT. A Codex plugin can manage DevSpace, but ChatGPT reads files through DevSpace MCP, not through the Codex plugin itself.

## Commands

From this plugin directory:

```bash
node scripts/devspace_manager.mjs harness --roots "$PWD"
node scripts/devspace_manager.mjs status
node scripts/devspace_manager.mjs stop
```

Useful options:

```bash
node scripts/devspace_manager.mjs start --roots "/path/project,/path/other" --port 7676
node scripts/devspace_manager.mjs doctor
```
