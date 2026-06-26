# DevSpace Manager

Codex plugin and local harness for running [Waishnav/devspace](https://github.com/Waishnav/devspace) as a ChatGPT MCP connector.

DevSpace Manager does not upload project archives to ChatGPT. It starts a local DevSpace MCP server, exposes it through an HTTPS tunnel, writes narrow allowed-root config, verifies the connector, and can send a ChatGPT-ready delegated task prompt that tells ChatGPT to inspect the repo through DevSpace MCP.

## What It Manages

- Installs as a Codex marketplace plugin.
- Provides a `devspace` skill for repeatable setup, status, stop, and live-test workflows.
- Starts `devspace serve` on `127.0.0.1:7676` by default.
- Requests a deterministic localtunnel URL when no public URL is provided, with random localtunnel and Cloudflare quick tunnel fallback when needed.
- Writes `~/.devspace/config.json` and `~/.devspace/auth.json` with `0600` permissions.
- Verifies OAuth discovery locally and over HTTPS.
- Verifies `/mcp` returns `401` without OAuth, so the endpoint is not open.
- Deep-tests OAuth token exchange and MCP calls against the allowed root.
- Generates delegated task prompts for ChatGPT, sends them through its own ChatGPT app sender, and waits for ChatGPT to write results back through a DevSpace exchange root so Codex can outsource audits or fixes without zip upload/download. If ChatGPT can read through DevSpace but cannot write the result file, DevSpace Manager also captures the ChatGPT app transcript as a fallback response channel.
- Uses automatic ChatGPT delivery by default: hidden Accessibility first, visible Accessibility next, visible keyboard paste last, then hides ChatGPT again after visible submission. If the macOS console session is locked or cannot be verified as unlocked, it fails fast with a diagnostic instead of attempting unsafe paste automation.

## Install In Codex

Add this repository as a marketplace source:

```bash
codex plugin marketplace add jake-w-liu/devspace-manager
```

Then open `/plugins`, install `devspace-manager`, restart Codex, and start a new thread.

## Local Commands

From the plugin directory:

```bash
node scripts/devspace_manager.mjs harness --roots "$PWD"
node scripts/devspace_manager.mjs harness --roots "$PWD" --deep --write-test
node scripts/devspace_manager.mjs debug --roots "$PWD" "debug audit this repo"
node scripts/devspace_manager.mjs task --roots "$PWD" "deep debug audit this repo; return verified findings only"
node scripts/devspace_manager.mjs status
node scripts/devspace_manager.mjs stop
```

Use multiple roots only when needed:

```bash
node scripts/devspace_manager.mjs harness --roots "/path/project,/path/other"
```

The harness returns the ChatGPT connector URL as `publicMcpUrl`. DevSpace Manager first requests a deterministic localtunnel URL for this machine:

```text
https://devspace<machine-id>.loca.lt/mcp
```

If the deterministic localtunnel subdomain is unavailable, DevSpace Manager automatically falls back to a random localtunnel or Cloudflare quick tunnel URL. The returned `publicMcpUrl` is always the source of truth:

```text
https://<generated>.loca.lt/mcp
https://<generated>.trycloudflare.com/mcp
```

## Connect ChatGPT

In ChatGPT developer mode, create a connector with:

- Connector URL: the `publicMcpUrl` from the harness
- Description: local coding workspace through DevSpace MCP

When ChatGPT connects, DevSpace asks for the Owner password. Retrieve it locally:

```bash
jq -r .ownerToken ~/.devspace/auth.json
```

Keep that password private.

## Delegate Work To ChatGPT

Use `task` when Codex should hand work to ChatGPT while DevSpace provides file access. `task`,
`delegate`, and the audit/debug/review/fix aliases send through the built-in automatic ChatGPT
app sender by default:

```bash
node scripts/devspace_manager.mjs task --roots "$PWD" "deep debug audit the codebase"
```

For audit/debug/review/fix style commands, use the direct aliases. These default to sending the generated prompt through DevSpace Manager's built-in automatic ChatGPT app sender:

```bash
node scripts/devspace_manager.mjs debug --roots "$PWD" "deep debug audit the codebase"
```

The command starts/verifies DevSpace, then writes:

- a ChatGPT instruction prompt under `~/.devspace/manager/tasks/*.prompt.md`
- a JSON result file under `~/.devspace/manager/tasks/*.json`
- a per-task result exchange root under `~/.devspace/manager/exchange/<task>/`

To be explicit about the automatic internal ChatGPT app sender:

```bash
node scripts/devspace_manager.mjs task --roots "$PWD" --send chatgpt-app-auto "deep debug audit the codebase"
```

`chatgpt-app-auto` tries hidden Accessibility first. If ChatGPT does not expose a hidden composer,
it falls back to visible Accessibility automation and then visible keyboard paste. Visible fallback
is transient: after submitting, the manager hides ChatGPT again. When the macOS console session is
locked or cannot be verified as unlocked, GUI delivery stops before paste/keyboard automation and
reports `CHATGPT_SCREEN_LOCKED` or `CHATGPT_SESSION_STATE_UNKNOWN`.
Use `--send chatgpt-app-hidden` to
require hidden-only behavior, or `--send chatgpt-app-visible` to force visible automation.

Use `--send none` only when you want DevSpace Manager to prepare the prompt/result metadata without
contacting ChatGPT.

That sends only instructions through the ChatGPT app. ChatGPT still reads, writes, and runs commands through the DevSpace MCP connector. Task completion is verified first by the result file ChatGPT writes back through DevSpace, and second by a captured ChatGPT app transcript only when the prompt's expected completion token is present there.

If all ChatGPT app delivery methods fail, the command fails closed with a diagnostic and preserves the prompt/result paths for inspection.

## Security Notes

DevSpace gives the connected MCP client local file and shell capability inside approved roots. Keep `--roots` narrow. Avoid using `~`, `/`, or broad workspace parents unless you intentionally want ChatGPT to reach everything under them.

localtunnel and Cloudflare quick tunnels are useful for live tests but are not production uptime guarantees. For stable long-running use, configure a named Cloudflare Tunnel, ngrok domain, Tailscale Funnel, or another HTTPS reverse proxy and pass it with:

```bash
node scripts/devspace_manager.mjs start --public-base-url "https://devspace.example.com" --roots "/path/project"
```
