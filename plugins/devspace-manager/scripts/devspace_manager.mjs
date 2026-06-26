#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PORT = 7676;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const CONFIG_DIR = join(homedir(), ".devspace");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const AUTH_PATH = join(CONFIG_DIR, "auth.json");
const MANAGER_DIR = join(CONFIG_DIR, "manager");
const STATUS_PATH = join(MANAGER_DIR, "status.json");
const SMOKE_CLIENT_PATH = join(MANAGER_DIR, "mcp-smoke-client.json");
const TASKS_DIR = join(MANAGER_DIR, "tasks");
const CLOUDFLARED_LOG = join(MANAGER_DIR, "cloudflared.log");
const DEVSPACE_LOG = join(MANAGER_DIR, "devspace.log");
const URL_RE = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i;
const TEXT_PROBE_FILENAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "README",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
];
const TEXT_PROBE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const SEARCH_EXCLUDED_DIRS = new Set([
  ".git",
  ".devspace-manager-smoke",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
]);

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "start":
      await start(options);
      return;
    case "stop":
      await stop({ print: true });
      return;
    case "status":
      await printStatus();
      return;
    case "doctor":
      await doctor();
      return;
    case "harness":
      await harness(options);
      return;
    case "task":
    case "delegate":
      await task(options);
      return;
    case "help":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function parseArgs(args) {
  const options = { positionals: [] };
  const command = args.shift() ?? "status";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--roots") {
      options.roots = requireOptionValue(args, ++i, arg);
    } else if (arg === "--port") {
      options.port = Number(requireOptionValue(args, ++i, arg));
    } else if (arg === "--reuse") {
      options.reuse = true;
    } else if (arg === "--no-tunnel") {
      options.noTunnel = true;
    } else if (arg === "--public-base-url") {
      options.publicBaseUrl = requireOptionValue(args, ++i, arg);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--deep") {
      options.deep = true;
    } else if (arg === "--shallow") {
      options.deep = false;
    } else if (arg === "--write-test") {
      options.writeTest = true;
    } else if (arg === "--allow-edits") {
      options.allowEdits = true;
    } else if (arg === "--send") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        options.send = next;
        i += 1;
      } else {
        options.send = "psst-gpt";
      }
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(requireOptionValue(args, ++i, arg));
    } else if (arg === "--output-dir") {
      options.outputDir = requireOptionValue(args, ++i, arg);
    } else if (arg === "--prompt") {
      options.positionals.push(requireOptionValue(args, ++i, arg));
    } else if (arg === "--print-prompt") {
      options.printPrompt = true;
    } else if (arg === "--") {
      options.positionals.push(...args.slice(i + 1));
      break;
    } else if (arg === "-h" || arg === "--help") {
      return { command: "help", options };
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.positionals.push(arg);
    }
  }
  options.prompt = options.positionals.join(" ").trim();
  return { command, options };
}

function requireOptionValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value.`);
  return value;
}

async function harness(options) {
  const started = await start({ ...options, reuse: true, silent: true });
  const checks = await runChecks(started, {
    deep: options.deep !== false,
    writeTest: Boolean(options.writeTest),
  });
  const ok = checks.every((check) => check.ok);
  const result = {
    ok,
    publicMcpUrl: `${started.publicBaseUrl}/mcp`,
    localMcpUrl: `http://127.0.0.1:${started.port}/mcp`,
    allowedRoots: started.allowedRoots,
    checks,
    ownerTokenCommand: "jq -r .ownerToken ~/.devspace/auth.json",
    logs: {
      cloudflared: CLOUDFLARED_LOG,
      devspace: DEVSPACE_LOG,
    },
  };
  printJson(result);
  if (!ok) process.exitCode = 1;
}

async function task(options) {
  const started = await start({ ...options, reuse: true, silent: true });
  const checks = await runChecks(started, { deep: true, writeTest: false });
  const ok = checks.every((check) => check.ok);
  if (!ok) {
    printJson({
      ok: false,
      publicMcpUrl: started.publicMcpUrl,
      localMcpUrl: started.localMcpUrl,
      allowedRoots: started.allowedRoots,
      checks,
      reason: "DevSpace did not pass the delegation preflight checks.",
    });
    process.exitCode = 1;
    return;
  }

  const prompt = options.prompt || "Deep debug audit this codebase and return verified findings.";
  const taskRoot = firstExistingRoot(started.allowedRoots);
  const chatGptPrompt = buildChatGptTaskPrompt({
    task: prompt,
    status: started,
    root: taskRoot,
    allowEdits: Boolean(options.allowEdits),
  });
  const outputDir = resolve(options.outputDir ?? TASKS_DIR);
  mkdirSync(outputDir, { recursive: true });
  const taskId = `devspace-task-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const promptPath = join(outputDir, `${taskId}.prompt.md`);
  const resultPath = join(outputDir, `${taskId}.json`);
  writeFileSync(promptPath, chatGptPrompt, { mode: 0o600 });
  chmodSync(promptPath, 0o600);

  let sendResult = null;
  if (options.send && options.send !== "none") {
    if (options.send !== "psst-gpt") {
      throw new Error(`Unsupported --send target: ${options.send}`);
    }
    sendResult = await sendPromptWithPsstGpt({
      prompt: chatGptPrompt,
      root: taskRoot,
      timeoutMs: parseTimeoutMs(options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS),
    });
  }

  const result = {
    ok: true,
    prompt,
    publicMcpUrl: started.publicMcpUrl,
    localMcpUrl: started.localMcpUrl,
    allowedRoots: started.allowedRoots,
    chatGptPromptPath: promptPath,
    resultPath,
    ownerTokenCommand: "jq -r .ownerToken ~/.devspace/auth.json",
    checks,
    send: sendResult,
    chatGptPrompt: options.printPrompt ? chatGptPrompt : undefined,
  };
  writeJson(resultPath, result, 0o600);
  printJson(result);
}

async function start(options) {
  const attempts = options.publicBaseUrl || options.noTunnel ? 1 : 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await startOnce({ ...options, reuse: attempt === 1 && options.reuse });
    } catch (error) {
      lastError = error;
      await stop({ print: false });
      if (attempt >= attempts || !isRetryableTunnelError(error)) throw error;
      await sleep(1_000);
    }
  }
  throw lastError;
}

async function startOnce(options) {
  const port = parsePort(options.port ?? DEFAULT_PORT);
  const roots = parseRoots(options.roots ?? process.cwd());
  ensureCommand("devspace");
  if (!options.noTunnel && !options.publicBaseUrl) ensureCommand("cloudflared");
  mkdirSync(MANAGER_DIR, { recursive: true });

  let existing = loadStatus();
  if (options.reuse && canReuseStatus(existing, { port, roots, options })) {
    const checks = await quickReachability(existing.publicBaseUrl, existing.port);
    if (checks.localDiscovery && checks.publicDiscovery) return existing;
  }

  await stop({ print: false });
  assertPortFree(port);

  const publicBaseUrl = options.publicBaseUrl
    ? normalizePublicBaseUrl(options.publicBaseUrl)
    : options.noTunnel
      ? `http://127.0.0.1:${port}`
      : await startCloudflared(port);

  writeDevspaceFiles({ port, roots, publicBaseUrl });
  const devspaceEnv = {
    ...process.env,
    DEVSPACE_TRUST_PROXY: publicBaseUrl.startsWith("https://") ? "1" : (process.env.DEVSPACE_TRUST_PROXY ?? "0"),
  };
  const devspacePid = startDetached("devspace", ["serve"], DEVSPACE_LOG, devspaceEnv);
  const status = {
    startedAt: new Date().toISOString(),
    port,
    allowedRoots: roots,
    publicBaseUrl,
    publicMcpUrl: `${publicBaseUrl}/mcp`,
    localMcpUrl: `http://127.0.0.1:${port}/mcp`,
    cloudflaredPid: options.noTunnel || options.publicBaseUrl ? null : readCloudflaredPid(),
    devspacePid,
    logs: {
      cloudflared: CLOUDFLARED_LOG,
      devspace: DEVSPACE_LOG,
    },
  };
  writeJson(STATUS_PATH, status, 0o600);
  await waitFor(async () => (await httpStatus(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)) === 200, 30_000, "local OAuth discovery");
  if (publicBaseUrl.startsWith("https://")) {
    await waitFor(async () => (await httpStatus(`${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`)) === 200, 60_000, "public OAuth discovery");
  }
  if (!options.silent) {
    printJson({
      ok: true,
      publicMcpUrl: status.publicMcpUrl,
      localMcpUrl: status.localMcpUrl,
      allowedRoots: status.allowedRoots,
      devspacePid: status.devspacePid,
      cloudflaredPid: status.cloudflaredPid,
      ownerTokenCommand: "jq -r .ownerToken ~/.devspace/auth.json",
      logs: status.logs,
    });
  }
  return status;
}

function isRetryableTunnelError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Cloudflare tunnel URL") || message.includes("public OAuth discovery");
}

function canReuseStatus(status, { port, roots, options }) {
  if (!status || !isAlive(status.devspacePid) || (status.cloudflaredPid && !isAlive(status.cloudflaredPid))) return false;
  if (status.port !== port) return false;
  if (!sameStringArray(status.allowedRoots, roots)) return false;
  if (options.publicBaseUrl && status.publicBaseUrl !== normalizePublicBaseUrl(options.publicBaseUrl)) return false;
  if (options.noTunnel && status.publicBaseUrl !== `http://127.0.0.1:${port}`) return false;
  if (!options.noTunnel && !options.publicBaseUrl && !status.publicBaseUrl.startsWith("https://")) return false;
  return true;
}

function sameStringArray(left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

async function stop({ print }) {
  const status = loadStatus();
  const killed = [];
  if (status?.devspacePid) killed.push(...killPidGroup(status.devspacePid, "devspace"));
  if (status?.cloudflaredPid) killed.push(...killPidGroup(status.cloudflaredPid, "cloudflared"));
  if (existsSync(STATUS_PATH)) rmSync(STATUS_PATH, { force: true });
  if (print) printJson({ ok: true, killed });
}

async function printStatus() {
  const status = loadStatus();
  if (!status) {
    printJson({ ok: false, running: false, reason: "No managed DevSpace status file found." });
    return;
  }
  const checks = await quickReachability(status.publicBaseUrl, status.port);
  printJson({
    ok: Boolean(isAlive(status.devspacePid) && (!status.cloudflaredPid || isAlive(status.cloudflaredPid))),
    running: true,
    devspaceAlive: isAlive(status.devspacePid),
    cloudflaredAlive: status.cloudflaredPid ? isAlive(status.cloudflaredPid) : null,
    ...status,
    reachability: checks,
  });
}

async function doctor() {
  ensureCommand("devspace");
  const result = spawnSync("devspace", ["doctor"], { encoding: "utf8" });
  const status = loadStatus();
  const checks = status ? await runChecks(status, { deep: false }) : [];
  printJson({
    ok: result.status === 0 && checks.every((check) => check.ok),
    devspaceDoctorExitCode: result.status,
    devspaceDoctorStdout: result.stdout.trim(),
    devspaceDoctorStderr: result.stderr.trim(),
    checks,
  });
}

async function runChecks(status, options = {}) {
  const localBase = `http://127.0.0.1:${status.port}`;
  const publicBase = status.publicBaseUrl;
  const checks = [];
  checks.push(check("devspace process alive", isAlive(status.devspacePid)));
  if (status.cloudflaredPid) checks.push(check("cloudflared process alive", isAlive(status.cloudflaredPid)));
  checks.push(check("config file exists", existsSync(CONFIG_PATH)));
  checks.push(check("auth file exists", existsSync(AUTH_PATH)));
  checks.push(check("config file is private", fileMode(CONFIG_PATH) === "600", { mode: fileMode(CONFIG_PATH) }));
  checks.push(check("auth file is private", fileMode(AUTH_PATH) === "600", { mode: fileMode(AUTH_PATH) }));
  checks.push(await httpCheck("local OAuth protected resource", `${localBase}/.well-known/oauth-protected-resource/mcp`, 200));
  checks.push(await httpCheck("local OAuth authorization server", `${localBase}/.well-known/oauth-authorization-server`, 200));
  checks.push(await httpCheck("local MCP requires auth", `${localBase}/mcp`, 401));
  if (publicBase.startsWith("https://")) {
    checks.push(await httpCheck("public OAuth protected resource", `${publicBase}/.well-known/oauth-protected-resource/mcp`, 200));
    checks.push(await httpCheck("public OAuth authorization server", `${publicBase}/.well-known/oauth-authorization-server`, 200));
    checks.push(await httpCheck("public MCP requires auth", `${publicBase}/mcp`, 401));
  }
  if (options.deep) {
    checks.push(...await mcpSmokeChecks(status, options));
  }
  return checks;
}

async function mcpSmokeChecks(status, options = {}) {
  try {
    const smoke = await runMcpSmoke(status, options);
    const checks = [
      check("MCP OAuth token exchange", true),
      check("MCP initialize", true, { server: smoke.serverName, sessionIdPrefix: smoke.sessionId.slice(0, 8) }),
      check("MCP tools/list", smoke.requiredTools.every((tool) => smoke.tools.includes(tool)), {
        tools: smoke.tools,
        requiredTools: smoke.requiredTools,
      }),
      check("MCP open_workspace", true, { root: smoke.root, workspaceIdPrefix: smoke.workspaceId.slice(0, 12) }),
      check("MCP read", true, { path: smoke.readPath }),
      check("MCP bash", true, { command: "pwd" }),
    ];
    if (options.writeTest) {
      checks.push(check("MCP write/edit cleanup", smoke.writeEditOk, { path: smoke.writePath }));
    }
    return checks;
  } catch (error) {
    return [
      check("MCP deep smoke", false, {
        error: error instanceof Error ? error.message : String(error),
      }),
    ];
  }
}

async function runMcpSmoke(status, options = {}) {
  const localBase = `http://127.0.0.1:${status.port}`;
  const localMcpUrl = `${localBase}/mcp`;
  const accessToken = await getMcpAccessToken({ status, localBase });
  const init = await mcpRpc({
    url: localMcpUrl,
    accessToken,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "devspace-manager-smoke", version: "0.1.0" },
      },
    },
  });
  assertJsonRpcOk(init, "initialize");
  if (!init.sessionId) throw new Error("MCP initialize did not return an mcp-session-id header.");
  const serverName = init.json.result?.serverInfo?.name ?? "unknown";

  await mcpRpc({
    url: localMcpUrl,
    accessToken,
    sessionId: init.sessionId,
    payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    allowEmpty: true,
  });

  const toolsResponse = await mcpRpc({
    url: localMcpUrl,
    accessToken,
    sessionId: init.sessionId,
    payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  assertJsonRpcOk(toolsResponse, "tools/list");
  const tools = toolsResponse.json.result?.tools?.map((tool) => tool.name).sort() ?? [];
  const toolNames = resolveMcpToolNames(tools);
  const requiredTools = [toolNames.openWorkspace, toolNames.read, toolNames.shell];
  for (const tool of requiredTools) {
    if (!tools.includes(tool)) throw new Error(`MCP tools/list did not include required tool: ${tool}`);
  }

  const root = firstExistingRoot(status.allowedRoots);
  const openResponse = await callMcpTool({
    url: localMcpUrl,
    accessToken,
    sessionId: init.sessionId,
    id: 3,
    name: toolNames.openWorkspace,
    arguments: { path: root },
  });
  const workspaceId = workspaceIdFromToolResult(openResponse.json.result);

  const readPath = findTextProbeFile(root);
  if (!readPath) throw new Error(`No small text file found for MCP read smoke under ${root}.`);
  const readResponse = await callMcpTool({
    url: localMcpUrl,
    accessToken,
    sessionId: init.sessionId,
    id: 4,
    name: toolNames.read,
    arguments: { workspaceId, path: readPath, limit: 20 },
  });
  assertToolText(readResponse.json.result, "read");

  const bashResponse = await callMcpTool({
    url: localMcpUrl,
    accessToken,
    sessionId: init.sessionId,
    id: 5,
    name: toolNames.shell,
    arguments: { workspaceId, command: "pwd", timeout: 10 },
  });
  const bashText = assertToolText(bashResponse.json.result, "bash");
  if (!bashText.includes(root)) throw new Error(`MCP bash pwd did not report workspace root: ${root}`);

  let writeEditOk = false;
  let writePath = null;
  if (options.writeTest) {
    if (!toolNames.write || !toolNames.edit) {
      throw new Error("MCP write-test requested, but write/edit tools are not available.");
    }
    writePath = `.devspace-manager-smoke/smoke-${Date.now()}.txt`;
    try {
      await callMcpTool({
        url: localMcpUrl,
        accessToken,
        sessionId: init.sessionId,
        id: 6,
        name: toolNames.write,
        arguments: { workspaceId, path: writePath, content: "one\n" },
      });
      await callMcpTool({
        url: localMcpUrl,
        accessToken,
        sessionId: init.sessionId,
        id: 7,
        name: toolNames.edit,
        arguments: {
          workspaceId,
          path: writePath,
          edits: [{ oldText: "one\n", newText: "one\ntwo\n" }],
        },
      });
      const reread = await callMcpTool({
        url: localMcpUrl,
        accessToken,
        sessionId: init.sessionId,
        id: 8,
        name: toolNames.read,
        arguments: { workspaceId, path: writePath, limit: 20 },
      });
      const rereadText = assertToolText(reread.json.result, "read after write/edit");
      writeEditOk = rereadText.includes("one") && rereadText.includes("two");
      if (!writeEditOk) throw new Error("MCP write/edit smoke file did not contain expected edited content.");
    } finally {
      rmSync(join(root, ".devspace-manager-smoke"), { recursive: true, force: true });
    }
  }

  return {
    serverName,
    sessionId: init.sessionId,
    tools,
    requiredTools,
    toolNames,
    root,
    workspaceId,
    readPath,
    writeEditOk,
    writePath,
  };
}

async function getMcpAccessToken({ status, localBase }) {
  const auth = readJson(AUTH_PATH, {});
  const ownerToken = auth.ownerToken;
  if (typeof ownerToken !== "string" || ownerToken.length < 16) {
    throw new Error("Missing usable Owner password in ~/.devspace/auth.json.");
  }
  let client = readJson(SMOKE_CLIENT_PATH, null);
  if (!client?.client_id || !client?.redirect_uri) {
    client = await registerSmokeClient(localBase);
  }
  try {
    return await exchangeSmokeToken({ status, localBase, ownerToken, client });
  } catch (error) {
    if (!String(error?.message ?? error).includes("Invalid client_id")) throw error;
    rmSync(SMOKE_CLIENT_PATH, { force: true });
    client = await registerSmokeClient(localBase);
    return exchangeSmokeToken({ status, localBase, ownerToken, client });
  }
}

async function registerSmokeClient(localBase) {
  const redirectUri = "http://127.0.0.1/callback";
  const response = await fetchJson(`${localBase}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "devspace-manager smoke",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
    expectedStatus: 201,
    label: "OAuth client registration",
  });
  const client = { ...response, redirect_uri: redirectUri };
  writeJson(SMOKE_CLIENT_PATH, client, 0o600);
  return client;
}

async function exchangeSmokeToken({ status, localBase, ownerToken, client }) {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const resource = status.publicMcpUrl;
  const authorizeBody = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: "devspace",
    resource,
    owner_token: ownerToken,
  });
  const authorize = await fetch(`${localBase}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorizeBody,
  });
  const location = authorize.headers.get("location");
  if (authorize.status !== 302 || !location) {
    const text = await authorize.text();
    throw new Error(`OAuth authorization failed with HTTP ${authorize.status}: ${preview(text)}`);
  }
  const redirect = new URL(location);
  const error = redirect.searchParams.get("error");
  if (error) {
    throw new Error(`${redirect.searchParams.get("error_description") || error}`);
  }
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("OAuth authorization redirect did not include a code.");
  const token = await fetchJson(`${localBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: codeVerifier,
      redirect_uri: client.redirect_uri,
      resource,
    }),
    expectedStatus: 200,
    label: "OAuth token exchange",
  });
  if (typeof token.access_token !== "string") throw new Error("OAuth token response did not include access_token.");
  return token.access_token;
}

async function fetchJson(url, { expectedStatus, label, ...options }) {
  const response = await fetch(url, options);
  const text = await response.text();
  let value = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${preview(text)}`);
    }
  }
  if (response.status !== expectedStatus) {
    const description = value?.error_description || value?.error || preview(text);
    throw new Error(`${label} failed with HTTP ${response.status}: ${description}`);
  }
  return value;
}

async function mcpRpc({ url, accessToken, sessionId, payload, allowEmpty = false }) {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!text && allowEmpty) {
    return { status: response.status, sessionId: response.headers.get("mcp-session-id") ?? sessionId, json: null };
  }
  const json = parseMcpResponse(text);
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
    json,
  };
}

async function callMcpTool({ url, accessToken, sessionId, id, name, arguments: toolArguments }) {
  const response = await mcpRpc({
    url,
    accessToken,
    sessionId,
    payload: {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: toolArguments },
    },
  });
  assertJsonRpcOk(response, `tools/call ${name}`);
  if (response.json.result?.isError) {
    throw new Error(`MCP tool ${name} failed: ${assertToolText(response.json.result, name)}`);
  }
  return response;
}

function parseMcpResponse(text) {
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
  const payload = dataLines.length > 0 ? dataLines.join("\n") : text;
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error(`MCP returned non-JSON payload: ${preview(text)}`);
  }
}

function assertJsonRpcOk(response, label) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${JSON.stringify(response.json)}`);
  }
  if (response.json?.error) {
    throw new Error(`${label} returned JSON-RPC error: ${JSON.stringify(response.json.error)}`);
  }
  if (!response.json?.result && response.json !== null) {
    throw new Error(`${label} returned no JSON-RPC result.`);
  }
}

function workspaceIdFromToolResult(result) {
  const workspaceId = result?.structuredContent?.workspaceId ?? result?._meta?.card?.workspaceId;
  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new Error(`open_workspace did not return a workspaceId: ${JSON.stringify(result)}`);
  }
  return workspaceId;
}

function assertToolText(result, label) {
  const text = result?.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n") ?? "";
  if (!text.trim()) throw new Error(`${label} returned no text content.`);
  return text;
}

function resolveMcpToolNames(tools) {
  const names = new Set(tools);
  return {
    openWorkspace: requireAnyTool(names, ["open_workspace"]),
    read: requireAnyTool(names, ["read", "read_file"]),
    shell: requireAnyTool(names, ["bash", "run_shell"]),
    write: firstAvailableTool(names, ["write", "write_file"]),
    edit: firstAvailableTool(names, ["edit", "edit_file"]),
  };
}

function requireAnyTool(names, candidates) {
  const tool = firstAvailableTool(names, candidates);
  if (!tool) throw new Error(`MCP tools/list did not include any of: ${candidates.join(", ")}`);
  return tool;
}

function firstAvailableTool(names, candidates) {
  return candidates.find((candidate) => names.has(candidate)) ?? null;
}

function firstExistingRoot(roots) {
  const root = roots.find((candidate) => existsSync(candidate));
  if (!root) throw new Error("No allowed root exists on disk.");
  return root;
}

function findTextProbeFile(root) {
  for (const filename of TEXT_PROBE_FILENAMES) {
    const candidate = join(root, filename);
    if (isSmallTextProbe(candidate)) return filename;
  }
  return findFirstTextProbe(root, root, 0);
}

function findFirstTextProbe(root, dir, depth) {
  if (depth > 4) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") || entry.name === ".env.example")
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolutePath = join(dir, entry.name);
    if (!isSmallTextProbe(absolutePath)) continue;
    return relative(root, absolutePath);
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || SEARCH_EXCLUDED_DIRS.has(entry.name)) continue;
    const found = findFirstTextProbe(root, join(dir, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

function isSmallTextProbe(path) {
  if (!existsSync(path)) return false;
  let file;
  try {
    file = statSync(path);
  } catch {
    return false;
  }
  if (!file.isFile() || file.size > 512 * 1024) return false;
  const name = path.split("/").at(-1) ?? path;
  if (TEXT_PROBE_FILENAMES.includes(name)) return true;
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return TEXT_PROBE_EXTENSIONS.has(extension);
}

function buildChatGptTaskPrompt({ task, status, root, allowEdits }) {
  const editInstruction = allowEdits
    ? "You may edit files through DevSpace when the fix is clear. Prefer targeted edit calls over full rewrites. After edits, run the relevant tests and summarize the exact files changed."
    : "Do not edit files unless I explicitly follow up asking you to do so. Return verified findings and concrete fix guidance; Codex will implement locally.";
  return [
    "# DevSpace Delegated Coding Task",
    "",
    "You are ChatGPT working with the DevSpace MCP connector. Use DevSpace to inspect this local codebase directly. Do not ask for a zip, file upload, pasted source, screenshots, or manual download.",
    "",
    "Connector details:",
    `- MCP connector URL: ${status.publicMcpUrl}`,
    `- Workspace path to open: ${root}`,
    `- Allowed roots: ${status.allowedRoots.join(", ")}`,
    "- If the connector is not already configured in ChatGPT, ask the user to add the MCP connector URL above and authorize with the Owner password from this local command: jq -r .ownerToken ~/.devspace/auth.json",
    "",
    "Required DevSpace workflow:",
    "1. Call open_workspace with the workspace path above.",
    "2. Follow any AGENTS.md, CLAUDE.md, or skill instructions returned by open_workspace before making claims.",
    "3. Use read, grep/glob/ls when available, and bash for builds, tests, package scripts, git inspection, and other read-only command-line inspection.",
    "4. Verify every finding against actual files or command output before stating it.",
    `5. ${editInstruction}`,
    "",
    "Task:",
    task,
    "",
    "Return format:",
    "- Verdict: whether you found correctness issues.",
    "- Findings: ordered by severity, with file paths, line references when available, evidence, and impact.",
    "- Fix plan or edits made: concise and specific.",
    "- Tests run: commands and results.",
    "- Residual risk: anything still unverified.",
  ].join("\n");
}

async function sendPromptWithPsstGpt({ prompt, root, timeoutMs }) {
  const script = findPsstGptScript();
  const { runPsstGPT } = await import(pathToFileURL(script).href);
  const result = await runPsstGPT({
    prompt,
    root,
    timeoutMs,
    background: true,
    newChat: true,
    tags: ["devspace-manager"],
  });
  return {
    ok: result.status === "complete",
    status: result.status,
    finalDeliveryText: result.finalDeliveryText,
    relaySessionId: result.record?.relaySessionId,
  };
}

function findPsstGptScript() {
  const candidates = [];
  if (process.env.PSST_GPT_SCRIPT) candidates.push(process.env.PSST_GPT_SCRIPT);
  candidates.push(join(homedir(), "gpt-relay", "PsstGPT-Codex-Plugin", "plugins", "psst-gpt", "scripts", "psst_gpt.mjs"));

  const cacheRoot = join(homedir(), ".codex", "plugins", "cache", "psst-gpt", "psst-gpt");
  if (existsSync(cacheRoot)) {
    const direct = join(cacheRoot, "scripts", "psst_gpt.mjs");
    candidates.push(direct);
    for (const version of readdirSync(cacheRoot).sort().reverse()) {
      candidates.push(join(cacheRoot, version, "scripts", "psst_gpt.mjs"));
    }
  }

  const script = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!script) {
    throw new Error("Could not find PsstGPT script. Set PSST_GPT_SCRIPT or install the psst-gpt plugin.");
  }
  return script;
}

function parseTimeoutMs(value) {
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error(`Invalid timeoutMs: ${value}`);
  }
  return timeoutMs;
}

function preview(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

async function quickReachability(publicBaseUrl, port) {
  const localDiscovery = (await httpStatus(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)) === 200;
  const publicDiscovery = publicBaseUrl?.startsWith("https://")
    ? (await httpStatus(`${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`)) === 200
    : true;
  return { localDiscovery, publicDiscovery };
}

function check(name, ok, extra = {}) {
  return { name, ok, ...extra };
}

async function httpCheck(name, url, expectedStatus) {
  const status = await httpStatus(url);
  return check(name, status === expectedStatus, { expectedStatus, status, url });
}

async function httpStatus(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(url, { redirect: "manual", signal: controller.signal });
    clearTimeout(timer);
    return response.status;
  } catch {
    return null;
  }
}

function startCloudflared(port) {
  writeFileSync(CLOUDFLARED_LOG, "", { mode: 0o600 });
  const pid = startDetached("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], CLOUDFLARED_LOG);
  writeFileSync(join(MANAGER_DIR, "cloudflared.pid"), String(pid), { mode: 0o600 });
  return waitForCloudflaredUrl();
}

async function waitForCloudflaredUrl() {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (existsSync(CLOUDFLARED_LOG)) {
      const log = readFileSync(CLOUDFLARED_LOG, "utf8");
      const match = log.match(URL_RE);
      if (match) return normalizePublicBaseUrl(match[0]);
      const fatal = cloudflaredFatalMessage(log);
      if (fatal) throw new Error(`Cloudflare tunnel URL failed: ${fatal}. See ${CLOUDFLARED_LOG}`);
      const pid = readCloudflaredPid();
      if (pid && !isAlive(pid) && log.trim()) {
        throw new Error(`Cloudflare tunnel URL failed before publishing a URL. See ${CLOUDFLARED_LOG}`);
      }
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Cloudflare tunnel URL. See ${CLOUDFLARED_LOG}`);
}

function cloudflaredFatalMessage(log) {
  const normalized = log.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const fatalPatterns = [
    /failed to unmarshal quick Tunnel:[^.]+/i,
    /Error unmarshaling QuickTunnel response:[^.]+/i,
    /status_code="[^"]+"/i,
    /Unable to reach the origin service[^.]+/i,
  ];
  for (const pattern of fatalPatterns) {
    const match = normalized.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function readCloudflaredPid() {
  const path = join(MANAGER_DIR, "cloudflared.pid");
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(pid) ? pid : null;
}

function startDetached(command, args, logPath, env = process.env) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `\n--- ${new Date().toISOString()} ${command} ${args.join(" ")} ---\n`, { mode: 0o600 });
  chmodSync(logPath, 0o600);
  const child = spawn(command, args, {
    detached: true,
    env,
    stdio: ["ignore", openForAppend(logPath), openForAppend(logPath)],
  });
  child.unref();
  return child.pid;
}

function openForAppend(logPath) {
  return openSync(logPath, "a", 0o600);
}

function writeDevspaceFiles({ port, roots, publicBaseUrl }) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const auth = readJson(AUTH_PATH, {});
  const ownerToken = typeof auth.ownerToken === "string" && auth.ownerToken.length >= 16
    ? auth.ownerToken
    : randomBytes(32).toString("base64url");
  writeJson(CONFIG_PATH, {
    host: "127.0.0.1",
    port,
    allowedRoots: roots,
    publicBaseUrl,
  }, 0o600);
  writeJson(AUTH_PATH, { ownerToken }, 0o600);
}

function writeJson(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(path, mode);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function loadStatus() {
  return readJson(STATUS_PATH, null);
}

function parseRoots(raw) {
  const roots = String(raw)
    .split(",")
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => resolve(root.replace(/^~/, homedir())));
  if (roots.length === 0) throw new Error("At least one allowed root is required.");
  for (const root of roots) {
    if (!existsSync(root)) throw new Error(`Allowed root does not exist: ${root}`);
  }
  return roots;
}

function parsePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return port;
}

function normalizePublicBaseUrl(value) {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function assertPortFree(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error(`Port ${port} is already in use:\n${result.stdout.trim()}`);
  }
}

function ensureCommand(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Missing required command: ${command}`);
}

function killPidGroup(pid, name) {
  const killed = [];
  if (!Number.isInteger(pid) || pid <= 0) return killed;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGTERM");
      killed.push({ name, pid: target });
      return killed;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        killed.push({ name, pid: target, error: error.message });
      }
    }
  }
  return killed;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fileMode(path) {
  if (!existsSync(path)) return null;
  return (statSync(path).mode & 0o777).toString(8);
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`DevSpace Manager

Usage:
  node scripts/devspace_manager.mjs start [--roots /path/a,/path/b] [--port 7676]
  node scripts/devspace_manager.mjs harness [--roots /path/a,/path/b] [--port 7676] [--deep] [--write-test]
  node scripts/devspace_manager.mjs task "deep debug audit this repo" [--roots /path/a] [--allow-edits] [--send psst-gpt]
  node scripts/devspace_manager.mjs status
  node scripts/devspace_manager.mjs doctor
  node scripts/devspace_manager.mjs stop

The task command starts and verifies DevSpace, writes a ChatGPT-ready delegated task prompt,
and can optionally send that prompt through PsstGPT as the ChatGPT app control channel.
The Owner password is stored in ~/.devspace/auth.json.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
