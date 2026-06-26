# DevSpace Manager

Codex plugin and local harness for running [Waishnav/devspace](https://github.com/Waishnav/devspace) as a ChatGPT MCP connector.

DevSpace Manager does not upload project archives to ChatGPT. It starts a local DevSpace MCP server, exposes it through an HTTPS tunnel, writes narrow allowed-root config, verifies the connector, and can generate a ChatGPT-ready delegated task prompt that tells ChatGPT to inspect the repo through DevSpace MCP.

## What It Manages

- Installs as a Codex marketplace plugin.
- Provides a `devspace` skill for repeatable setup, status, stop, and live-test workflows.
- Starts `devspace serve` on `127.0.0.1:7676` by default.
- Starts a Cloudflare quick tunnel when no public URL is provided.
- Writes `~/.devspace/config.json` and `~/.devspace/auth.json` with `0600` permissions.
- Verifies OAuth discovery locally and over HTTPS.
- Verifies `/mcp` returns `401` without OAuth, so the endpoint is not open.
- Deep-tests OAuth token exchange and MCP calls against the allowed root.
- Generates delegated task prompts for ChatGPT so Codex can outsource audits or fixes without zip upload/download.

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
node scripts/devspace_manager.mjs task --roots "$PWD" "deep debug audit this repo; return verified findings only"
node scripts/devspace_manager.mjs status
node scripts/devspace_manager.mjs stop
```

Use multiple roots only when needed:

```bash
node scripts/devspace_manager.mjs harness --roots "/path/project,/path/other"
```

The harness returns the ChatGPT connector URL as `publicMcpUrl`, usually:

```text
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

Use `task` when Codex should hand work to ChatGPT while DevSpace provides file access:

```bash
node scripts/devspace_manager.mjs task --roots "$PWD" "deep debug audit the codebase"
```

The command starts/verifies DevSpace, then writes:

- a ChatGPT instruction prompt under `~/.devspace/manager/tasks/*.prompt.md`
- a JSON result file under `~/.devspace/manager/tasks/*.json`

If the ChatGPT desktop-app control channel is available through PsstGPT, the manager can send the prompt automatically:

```bash
node scripts/devspace_manager.mjs task --roots "$PWD" --send psst-gpt "deep debug audit the codebase"
```

That sends only instructions. ChatGPT still reads, writes, and runs commands through the DevSpace MCP connector.

## Security Notes

DevSpace gives the connected MCP client local file and shell capability inside approved roots. Keep `--roots` narrow. Avoid using `~`, `/`, or broad workspace parents unless you intentionally want ChatGPT to reach everything under them.

Cloudflare quick tunnels are useful for live tests but are not a production uptime guarantee. For stable long-running use, configure a named Cloudflare Tunnel, ngrok domain, Tailscale Funnel, or another HTTPS reverse proxy and pass it with:

```bash
node scripts/devspace_manager.mjs start --public-base-url "https://devspace.example.com" --roots "/path/project"
```
