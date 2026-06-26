---
name: devspace
description: Start, stop, status-check, live-test, or delegate coding tasks through a DevSpace MCP server that lets ChatGPT work directly with approved local project folders.
---

# DevSpace Manager

Use this skill when the user asks to set up DevSpace, connect ChatGPT to local files through DevSpace, replace upload/download workflows with MCP, delegate a codebase task to ChatGPT through DevSpace, or check whether the DevSpace bridge is running.

## Workflow

1. Use `scripts/devspace_manager.mjs` for all setup, start, stop, status, task/delegation, and harness operations. Do not hand-roll process management.
2. Default allowed roots to the current working directory unless the user asks for broader access. Keep roots narrow.
3. Prefer `harness --deep` after setup or changes. It starts the tunnel/server if needed and verifies:
   - DevSpace CLI and Cloudflare Tunnel are installed.
   - Config and auth files exist with private file permissions.
   - `devspace doctor` passes.
   - OAuth discovery works on localhost and the HTTPS tunnel.
   - `/mcp` rejects unauthenticated requests with `401`.
   - Dynamic OAuth registration and token exchange work.
   - MCP initialize, tools/list, open_workspace, read, and bash work against the allowed root.
   - With `--write-test`, MCP write and edit work and the temporary smoke file is cleaned up.
4. Use `task`/`delegate` when the user wants Codex to outsource work to ChatGPT. It starts and verifies DevSpace, writes a ChatGPT-ready prompt under `~/.devspace/manager/tasks`, and optionally sends that prompt through PsstGPT with `--send psst-gpt`. The file access path remains DevSpace MCP, not zip upload.
5. Treat the Owner password as a secret. Do not paste it into chat unless the user explicitly asks. Point the user to `~/.devspace/auth.json` or the `owner-token-command` field returned by the script.
6. Make clear that DevSpace is the MCP connector surface for ChatGPT. A Codex plugin can manage DevSpace and create/send the task prompt, but ChatGPT reads files through DevSpace MCP.

## Commands

From this plugin directory:

```bash
node scripts/devspace_manager.mjs harness --roots "$PWD"
node scripts/devspace_manager.mjs harness --roots "$PWD" --deep --write-test
node scripts/devspace_manager.mjs task --roots "$PWD" "deep debug audit this repo; return verified findings only"
node scripts/devspace_manager.mjs status
node scripts/devspace_manager.mjs stop
```

Useful options:

```bash
node scripts/devspace_manager.mjs start --roots "/path/project,/path/other" --port 7676
node scripts/devspace_manager.mjs doctor
node scripts/devspace_manager.mjs task --roots "/path/project" --allow-edits --send psst-gpt "fix the failing tests through DevSpace"
```
