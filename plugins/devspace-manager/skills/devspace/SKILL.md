---
name: devspace
description: Start, stop, status-check, live-test, or delegate coding tasks through a DevSpace MCP server that lets ChatGPT work directly with approved local project folders.
---

# DevSpace Manager

Use this skill when the user asks to set up DevSpace, connect ChatGPT to local files through DevSpace, replace upload/download workflows with MCP, delegate a codebase task to ChatGPT through DevSpace, or check whether the DevSpace bridge is running.

## Workflow

1. Use `scripts/devspace_manager.mjs` for all setup, start, stop, status, task/delegation, and harness operations. Do not hand-roll process management.
2. Default allowed roots to the current working directory unless the user asks for broader access. Keep roots narrow.
3. If the user asks for a debug, audit, review, analysis, fix, or codebase task, immediately use the delegation path. Do not perform a local audit first and do not substitute local findings for ChatGPT delegation:

```bash
node scripts/devspace_manager.mjs debug --roots "$PWD" "the user's task text"
```

Use `--send none` only when the user explicitly does not want the prompt sent to ChatGPT. The `debug`, `audit`, `review`, `fix`, and `analyze` aliases default to `--send chatgpt-app`, implemented inside DevSpace Manager. The default sender is strict background: it uses hidden ChatGPT app automation only when ChatGPT exposes an accessible hidden window, never activates or shows ChatGPT, and waits for ChatGPT to write a result file through DevSpace.
4. Prefer `harness --deep` after setup or changes. It starts the tunnel/server if needed and verifies:
   - DevSpace CLI and Cloudflare Tunnel are installed.
   - Config and auth files exist with private file permissions.
   - `devspace doctor` passes.
   - OAuth discovery works on localhost and the HTTPS tunnel.
   - `/mcp` rejects unauthenticated requests with `401`.
   - Dynamic OAuth registration and token exchange work.
   - MCP initialize, tools/list, open_workspace, read, and bash work against the allowed root.
   - With `--write-test`, MCP write and edit work and the temporary smoke file is cleaned up.
5. Use `task`/`delegate` when the user wants Codex to outsource work to ChatGPT. It starts and verifies DevSpace, adds a narrow exchange root under `~/.devspace/manager/exchange/<task>`, writes a ChatGPT-ready prompt under `~/.devspace/manager/tasks`, sends that prompt through DevSpace Manager's built-in strict-background ChatGPT sender by default, and waits for ChatGPT to write the result into the exchange root through DevSpace. Use `--send none` only when the user explicitly wants prompt/result metadata without contacting ChatGPT. If ChatGPT has no accessible hidden window, the sender must fail closed rather than showing a window. The file access path remains DevSpace MCP, not zip upload.
6. After a sent task returns, do not stop at the delegated result. Read ChatGPT's result file path from the manager JSON, verify every actionable finding locally against files or commands, then implement and test the fix in Codex. If ChatGPT edited files through DevSpace, inspect the resulting local changes before continuing.
7. Use `live-check`/`chatgpt-check` for end-to-end verification. It writes a temporary marker file, sends ChatGPT a prompt that does not reveal the marker, requires ChatGPT to read it through DevSpace, requires ChatGPT to write the marker to the DevSpace exchange root, verifies that file, and cleans up the marker file.
8. If Codex reports `EPERM` or `EACCES` for `~/.devspace`, do not fall back to local audit. Explain that DevSpace Manager must write managed config/status under `~/.devspace` and rerun the manager command with user approval for that filesystem access.
9. Treat the Owner password as a secret. Do not paste it into chat unless the user explicitly asks. Point the user to `~/.devspace/auth.json` or the `owner-token-command` field returned by the script.
10. Make clear that DevSpace is the MCP connector surface for ChatGPT. A Codex plugin can manage DevSpace and create/send the task prompt, but ChatGPT reads files through DevSpace MCP.

## Commands

From this plugin directory:

```bash
node scripts/devspace_manager.mjs harness --roots "$PWD"
node scripts/devspace_manager.mjs harness --roots "$PWD" --deep --write-test
node scripts/devspace_manager.mjs debug --roots "$PWD" "debug audit this repo"
node scripts/devspace_manager.mjs live-check --roots "$PWD"
node scripts/devspace_manager.mjs task --roots "$PWD" "deep debug audit this repo; return verified findings only"
node scripts/devspace_manager.mjs status
node scripts/devspace_manager.mjs stop
```

Useful options:

```bash
node scripts/devspace_manager.mjs start --roots "/path/project,/path/other" --port 7676
node scripts/devspace_manager.mjs doctor
node scripts/devspace_manager.mjs task --roots "/path/project" --allow-edits --send chatgpt-app "fix the failing tests through DevSpace"
```
