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

Use `--send none` only when the user explicitly does not want the prompt sent to ChatGPT. The `debug`, `audit`, `review`, `fix`, and `analyze` aliases default to `--send chatgpt-app-auto`, implemented inside DevSpace Manager. The default sender is automatic: hidden Accessibility first, visible Accessibility next, visible keyboard paste last. If visible fallback is needed, it submits automatically and hides ChatGPT again afterward. If the macOS GUI session is locked or not ready, the same background task waits until the session is verified safe and then sends automatically; control that wait with `--gui-wait-ms`. If the wait expires, GUI delivery fails closed with the specific session diagnostic such as `CHATGPT_SCREEN_LOCKED`, `CHATGPT_NOT_ON_CONSOLE`, or `CHATGPT_SESSION_STATE_UNKNOWN` instead of attempting paste or keyboard automation.
4. Prefer `harness --deep` after setup or changes. It starts the tunnel/server if needed and verifies:
   - DevSpace CLI is installed, plus at least one public tunnel provider: `npx` for deterministic localtunnel or Cloudflare Tunnel fallback.
   - Config and auth files exist with private file permissions.
   - `devspace doctor` passes.
   - OAuth discovery works on localhost and the HTTPS tunnel.
   - `/mcp` rejects unauthenticated requests with `401`.
   - Dynamic OAuth registration and token exchange work.
   - MCP initialize, tools/list, open_workspace, read, and bash work against the allowed root.
   - With `--write-test`, MCP write and edit work and the temporary smoke file is cleaned up.
5. Use `task`/`delegate` when the user wants Codex to outsource work to ChatGPT. It starts and verifies DevSpace, adds a narrow exchange root under `~/.devspace/manager/exchange/<task>`, writes a ChatGPT-ready prompt under `~/.devspace/manager/tasks`, sends that prompt through DevSpace Manager's built-in automatic ChatGPT sender by default, and waits for ChatGPT to write the result into the exchange root through DevSpace. If the expected completion token appears in the ChatGPT app transcript instead, treat that as a fallback response channel and still verify the content locally. Use `--send none` only when the user explicitly wants prompt/result metadata without contacting ChatGPT. The default sender tries hidden automation first and falls back to visible automation if the hidden composer is unavailable. The file access path remains DevSpace MCP, not zip upload.
6. After a sent task returns, do not stop at the delegated result. Read ChatGPT's result file path from the manager JSON, verify every actionable finding locally against files or commands, then implement and test the fix in Codex. If ChatGPT edited files through DevSpace, inspect the resulting local changes before continuing.
7. Use `live-check`/`chatgpt-check` for end-to-end verification. It writes a temporary marker file, sends ChatGPT a prompt that does not reveal the marker, requires ChatGPT to read it through DevSpace, requires ChatGPT to write the marker to the DevSpace exchange root, verifies that file, and cleans up the marker file. If ChatGPT reads the marker but replies in the app transcript instead of writing the result file, the check reports `resultChannel: "chatgpt-app-transcript"` so Codex can distinguish read-only delegation from full writeback.
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
node scripts/devspace_manager.mjs task --roots "/path/project" --allow-edits --send chatgpt-app-auto "fix the failing tests through DevSpace"
```
