#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lookup, Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve, join } from "node:path";

const DEFAULT_PORT = 7676;
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const LOCAL_DISCOVERY_TIMEOUT_MS = 30_000;
const PUBLIC_DISCOVERY_TIMEOUT_MS = 120_000;
const QUICK_TUNNEL_URL_TIMEOUT_MS = 90_000;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
const CONFIG_DIR = join(homedir(), ".devspace");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const AUTH_PATH = join(CONFIG_DIR, "auth.json");
const MANAGER_DIR = join(CONFIG_DIR, "manager");
const STATUS_PATH = join(MANAGER_DIR, "status.json");
const SMOKE_CLIENT_PATH = join(MANAGER_DIR, "mcp-smoke-client.json");
const TASKS_DIR = join(MANAGER_DIR, "tasks");
const EXCHANGE_DIR = join(MANAGER_DIR, "exchange");
const LOCK_DIR = join(MANAGER_DIR, "lock");
const LOCK_INFO_PATH = join(LOCK_DIR, "owner.json");
const CLOUDFLARED_LOG = join(MANAGER_DIR, "cloudflared.log");
const DEVSPACE_LOG = join(MANAGER_DIR, "devspace.log");
const LOCALTUNNEL_LOG = join(MANAGER_DIR, "localtunnel.log");
const URL_RE = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i;
const LOCALTUNNEL_URL_RE = /https:\/\/[-a-z0-9]+\.loca\.lt/i;
const TASK_ALIAS_COMMANDS = new Set(["audit", "debug", "review", "fix", "analyze"]);
const DEFAULT_CHATGPT_SEND = "chatgpt-app-auto";
const CHATGPT_SEND_TARGETS = new Set([
  "chatgpt-app",
  "chatgpt-app-auto",
  "chatgpt-app-hidden",
  "chatgpt-app-visible",
]);
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
  if (requiresManagerLock(command)) {
    await withManagerLock(() => runCommand(command, options));
    return;
  }
  await runCommand(command, options);
}

async function runCommand(command, options) {
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
      await task({ ...options, send: options.send ?? DEFAULT_CHATGPT_SEND });
      return;
    case "live-check":
    case "chatgpt-check":
      await chatGptLiveCheck(options);
      return;
    case "audit":
    case "debug":
    case "review":
    case "fix":
    case "analyze":
      await task({
        ...options,
        send: options.send ?? DEFAULT_CHATGPT_SEND,
        prompt: options.prompt || `${command} this codebase through DevSpace MCP. Return verified findings only.`,
      });
      return;
    case "help":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function requiresManagerLock(command) {
  return command === "start" ||
    command === "stop" ||
    command === "harness" ||
    command === "task" ||
    command === "delegate" ||
    command === "live-check" ||
    command === "chatgpt-check" ||
    TASK_ALIAS_COMMANDS.has(command);
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
        options.send = DEFAULT_CHATGPT_SEND;
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

async function withManagerLock(callback) {
  acquireManagerLock();
  try {
    return await callback();
  } finally {
    releaseManagerLock();
  }
}

function acquireManagerLock() {
  mkdirSync(MANAGER_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(LOCK_DIR, { mode: 0o700 });
      writeJson(LOCK_INFO_PATH, {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        command: process.argv.slice(2),
      }, 0o600);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw permissionAwareError(error, `Unable to create DevSpace Manager lock at ${LOCK_DIR}.`);
      }
      const owner = readJson(LOCK_INFO_PATH, null);
      if (Number.isInteger(owner?.pid) && isAlive(owner.pid)) {
        throw new Error(`Another DevSpace Manager command is already running with pid ${owner.pid}. Wait for it to finish before starting a second start/stop/task/harness command.`);
      }
      safeRemovePath(LOCK_DIR, "stale manager lock");
    }
  }
  throw new Error(`Unable to acquire DevSpace Manager lock at ${LOCK_DIR}.`);
}

function releaseManagerLock() {
  const owner = readJson(LOCK_INFO_PATH, null);
  if (owner?.pid && owner.pid !== process.pid) return;
  safeRemovePath(LOCK_DIR, "manager lock");
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
    publicBaseUrl: started.publicBaseUrl,
    publicMcpUrl: `${started.publicBaseUrl}/mcp`,
    localMcpUrl: `http://127.0.0.1:${started.port}/mcp`,
    tunnelProvider: started.tunnelProvider,
    allowedRoots: started.allowedRoots,
    checks,
    ownerTokenCommand: "jq -r .ownerToken ~/.devspace/auth.json",
    logs: {
      cloudflared: CLOUDFLARED_LOG,
      localtunnel: LOCALTUNNEL_LOG,
      devspace: DEVSPACE_LOG,
    },
  };
  printJson(result);
  if (!ok) process.exitCode = 1;
}

async function task(options) {
  const taskId = `devspace-task-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const exchangeRoot = prepareExchangeRoot(taskId);
  const started = await start({
    ...options,
    roots: appendRootOption(options.roots ?? process.cwd(), exchangeRoot),
    reuse: true,
    silent: true,
  });
  const checks = await runChecks(started, { deep: true, writeTest: false });
  checks.push(...await mcpSmokeChecks(started, { rootOverride: exchangeRoot, writeTest: true }));
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
  const taskRoot = firstExistingRoot(started.allowedRoots.filter((root) => root !== exchangeRoot));
  const resultFileName = "result.md";
  const resultFilePath = join(exchangeRoot, resultFileName);
  const doneToken = `DEVSPACE_MANAGER_TASK_DONE ${taskId}`;
  const chatGptPrompt = buildChatGptTaskPrompt({
    task: prompt,
    status: started,
    root: taskRoot,
    exchangeRoot,
    resultFileName,
    doneToken,
    promptId: taskId,
    allowEdits: Boolean(options.allowEdits),
  });
  const outputDir = resolve(options.outputDir ?? TASKS_DIR);
  mkdirSync(outputDir, { recursive: true });
  const promptPath = join(outputDir, `${taskId}.prompt.md`);
  const resultPath = join(outputDir, `${taskId}.json`);
  writeFileSync(promptPath, chatGptPrompt, { mode: 0o600 });
  chmodSync(promptPath, 0o600);

  let sendResult = null;
  if (options.send && options.send !== "none") {
    if (!CHATGPT_SEND_TARGETS.has(options.send)) {
      throw new Error(`Unsupported --send target: ${options.send}`);
    }
    sendResult = await sendPromptWithChatGptAppResult({
      prompt: chatGptPrompt,
      timeoutMs: parseTimeoutMs(options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS),
      resultFilePath,
      expectText: doneToken,
      sendTarget: options.send,
    });
  }

  const result = {
    ok: sendResult ? Boolean(sendResult.ok) : true,
    prompt,
    publicMcpUrl: started.publicMcpUrl,
    localMcpUrl: started.localMcpUrl,
    allowedRoots: started.allowedRoots,
    chatGptPromptPath: promptPath,
    resultPath,
    exchangeRoot,
    chatGptResultPath: resultFilePath,
    ownerTokenCommand: "jq -r .ownerToken ~/.devspace/auth.json",
    connectorSetup: connectorSetupForStatus(started),
    checks,
    send: sendResult,
    chatGptPrompt: options.printPrompt ? chatGptPrompt : undefined,
  };
  writeJson(resultPath, result, 0o600);
  printJson(result);
  if (!result.ok) process.exitCode = 1;
}

async function chatGptLiveCheck(options) {
  const taskId = `devspace-live-check-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const exchangeRoot = prepareExchangeRoot(taskId);
  const started = await start({
    ...options,
    roots: appendRootOption(options.roots ?? process.cwd(), exchangeRoot),
    reuse: true,
    silent: true,
  });
  const checks = await runChecks(started, { deep: true, writeTest: false });
  checks.push(...await mcpSmokeChecks(started, { rootOverride: exchangeRoot, writeTest: true }));
  const ok = checks.every((check) => check.ok);
  if (!ok) {
    printJson({
      ok: false,
      publicMcpUrl: started.publicMcpUrl,
      localMcpUrl: started.localMcpUrl,
      allowedRoots: started.allowedRoots,
      checks,
      reason: "DevSpace did not pass the live-check preflight checks.",
    });
    process.exitCode = 1;
    return;
  }

  const root = firstExistingRoot(started.allowedRoots.filter((candidate) => candidate !== exchangeRoot));
  const marker = `DEVSPACE_MANAGER_LIVE_OK_${Date.now()}_${randomBytes(6).toString("hex")}`;
  const markerDir = mkdtempSync(join(root, ".devspace-manager-live-check-"));
  chmodSync(markerDir, 0o700);
  const markerPath = join(markerDir, "marker.txt");
  const relativeMarkerPath = relative(root, markerPath);
  writeFileSync(markerPath, `marker=${marker}\n`, { mode: 0o600 });
  chmodSync(markerPath, 0o600);

  const outputDir = resolve(options.outputDir ?? TASKS_DIR);
  mkdirSync(outputDir, { recursive: true });
  const resultPath = join(outputDir, `${taskId}.json`);
  const promptPath = join(outputDir, `${taskId}.prompt.md`);
  const resultFileName = "live-check-result.txt";
  const resultFilePath = join(exchangeRoot, resultFileName);
  const chatGptPrompt = buildChatGptLiveCheckPrompt({
    status: started,
    root,
    exchangeRoot,
    relativeMarkerPath,
    resultFileName,
    promptId: taskId,
  });
  writeFileSync(promptPath, chatGptPrompt, { mode: 0o600 });
  chmodSync(promptPath, 0o600);

  let sendResult;
  try {
    sendResult = await sendPromptWithChatGptAppResult({
      prompt: chatGptPrompt,
      timeoutMs: parseTimeoutMs(options.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS),
      resultFilePath,
      expectText: marker,
      sendTarget: options.send ?? DEFAULT_CHATGPT_SEND,
    });
  } finally {
    safeRemovePath(markerDir, "live-check marker directory");
  }

  const resultFileText = readTextFileIfExists(resultFilePath);
  const appTranscriptText = String(sendResult?.appAssistantText ?? "");
  const resultFileMarkerFound = resultFileText.includes(marker);
  const appTranscriptMarkerFound = appTranscriptText.includes(marker);
  const markerFound = resultFileMarkerFound || appTranscriptMarkerFound;
  const resultChannel = resultFileMarkerFound
    ? "devspace-result-file"
    : appTranscriptMarkerFound
      ? "chatgpt-app-transcript"
      : null;
  const result = {
    ok: markerFound,
    markerFound,
    resultFileMarkerFound,
    appTranscriptMarkerFound,
    resultChannel,
    expectedMarker: marker,
    publicMcpUrl: started.publicMcpUrl,
    localMcpUrl: started.localMcpUrl,
    allowedRoots: started.allowedRoots,
    chatGptPromptPath: promptPath,
    resultPath,
    exchangeRoot,
    chatGptResultPath: resultFilePath,
    ownerTokenCommand: "jq -r .ownerToken ~/.devspace/auth.json",
    connectorSetup: connectorSetupForStatus(started),
    checks,
    send: sendResult,
    reason: markerFound
      ? resultChannel === "devspace-result-file"
        ? "ChatGPT wrote the marker to the DevSpace exchange file after reading it through the DevSpace connector."
        : "ChatGPT returned the marker in the ChatGPT app transcript after reading it through the DevSpace connector; DevSpace result-file write was not observed."
      : sendResult?.reason
        ? `ChatGPT sender did not complete the live check: ${sendResult.reason}`
      : "ChatGPT did not write the live-check marker to the DevSpace exchange file. The ChatGPT app may not have accepted the hidden deep link, may not have the DevSpace connector configured, or did not use it.",
  };
  writeJson(resultPath, result, 0o600);
  printJson(result);
  if (!markerFound) process.exitCode = 1;
}

async function start(options) {
  const attempts = options.publicBaseUrl || options.noTunnel ? 1 : 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const lifecycle = { changedRuntimeState: false };
    try {
      return await startOnce({ ...options, reuse: attempt === 1 && options.reuse }, lifecycle);
    } catch (error) {
      lastError = error;
      if (lifecycle.changedRuntimeState) await stop({ print: false });
      if (attempt >= attempts || !isRetryableTunnelError(error)) throw error;
      await sleep(1_000);
    }
  }
  throw lastError;
}

async function startOnce(options, lifecycle = { changedRuntimeState: false }) {
  const port = parsePort(options.port ?? DEFAULT_PORT);
  const roots = parseRoots(options.roots ?? process.cwd());
  if (options.noTunnel && options.publicBaseUrl) {
    throw new Error("--no-tunnel and --public-base-url are mutually exclusive.");
  }
  const requestedPublicBaseUrl = options.publicBaseUrl
    ? normalizePublicBaseUrl(options.publicBaseUrl)
    : null;
  ensureCommand("devspace");
  if (!options.noTunnel && !requestedPublicBaseUrl) ensureAnyTunnelCommand();
  mkdirSync(MANAGER_DIR, { recursive: true });
  assertManagerWritable();

  let existing = loadStatus();
  if (options.reuse && canReuseStatus(existing, { port, roots, options })) {
    const checks = await quickReachability(existing.publicBaseUrl, existing.port);
    if (checks.localDiscovery && checks.publicDiscovery) return existing;
  }

  const reusableTunnel = canReuseManagedTunnelForRestart(existing, { port, options })
    ? existing
    : null;
  if (reusableTunnel?.devspacePid) {
    await waitForKilledProcesses(killPidGroup(reusableTunnel.devspacePid, "devspace"));
  } else {
    await stop({ print: false });
  }
  lifecycle.changedRuntimeState = true;
  assertPortFree(port);

  const tunnel = reusableTunnel || requestedPublicBaseUrl || options.noTunnel
    ? null
    : await startPublicTunnel(port);
  const publicBaseUrl = requestedPublicBaseUrl
    ? requestedPublicBaseUrl
    : options.noTunnel
      ? `http://127.0.0.1:${port}`
      : reusableTunnel
        ? reusableTunnel.publicBaseUrl
        : tunnel.publicBaseUrl;

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
    tunnelProvider: reusableTunnel?.tunnelProvider ?? tunnel?.provider ?? (options.publicBaseUrl ? "external" : options.noTunnel ? "none" : null),
    cloudflaredPid: reusableTunnel?.cloudflaredPid ?? (tunnel?.provider === "cloudflared" ? readCloudflaredPid() : null),
    localtunnelPid: reusableTunnel?.localtunnelPid ?? (tunnel?.provider === "localtunnel" ? readLocaltunnelPid() : null),
    devspacePid,
    logs: {
      cloudflared: CLOUDFLARED_LOG,
      localtunnel: LOCALTUNNEL_LOG,
      devspace: DEVSPACE_LOG,
    },
  };
  writeJson(STATUS_PATH, status, 0o600);
  await waitFor(async () => (await httpStatus(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)) === 200, LOCAL_DISCOVERY_TIMEOUT_MS, "local OAuth discovery");
  if (publicBaseUrl.startsWith("https://")) {
    await waitFor(async () => (await httpStatus(`${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`)) === 200, PUBLIC_DISCOVERY_TIMEOUT_MS, "public OAuth discovery");
  }
  if (!options.silent) {
    printJson({
      ok: true,
      publicMcpUrl: status.publicMcpUrl,
      localMcpUrl: status.localMcpUrl,
      allowedRoots: status.allowedRoots,
      devspacePid: status.devspacePid,
      tunnelProvider: status.tunnelProvider,
      cloudflaredPid: status.cloudflaredPid,
      localtunnelPid: status.localtunnelPid,
      ownerTokenCommand: "jq -r .ownerToken ~/.devspace/auth.json",
      logs: status.logs,
    });
  }
  return status;
}

function isRetryableTunnelError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Cloudflare tunnel URL") ||
    message.includes("Cloudflare tunnel hostname") ||
    message.includes("public OAuth discovery");
}

function canReuseStatus(status, { port, roots, options }) {
  if (!status || !isAlive(status.devspacePid) || !managedTunnelAlive(status)) return false;
  if (status.port !== port) return false;
  if (!sameStringArray(status.allowedRoots, roots)) return false;
  if (options.publicBaseUrl && status.publicBaseUrl !== normalizePublicBaseUrl(options.publicBaseUrl)) return false;
  if (options.noTunnel && status.publicBaseUrl !== `http://127.0.0.1:${port}`) return false;
  if (!options.noTunnel && !options.publicBaseUrl && !status.publicBaseUrl.startsWith("https://")) return false;
  return true;
}

function managedTunnelAlive(status) {
  if (status.cloudflaredPid && !isAlive(status.cloudflaredPid)) return false;
  if (status.localtunnelPid && !isAlive(status.localtunnelPid)) return false;
  return true;
}

function canReuseManagedTunnelForRestart(status, { port, options }) {
  if (!status || status.port !== port) return false;
  if (options.publicBaseUrl || options.noTunnel) return false;
  if (status.tunnelProvider !== "cloudflared" && status.tunnelProvider !== "localtunnel") return false;
  if (!status.publicBaseUrl?.startsWith("https://")) return false;
  return managedTunnelAlive(status);
}

function sameStringArray(left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function assertManagerWritable() {
  const probePath = join(MANAGER_DIR, `.write-check-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probePath, "ok\n", { mode: 0o600 });
    safeRemoveFile(probePath, "manager write probe");
  } catch (error) {
    throw permissionAwareError(error, `DevSpace Manager needs write access to ${MANAGER_DIR}. In Codex, approve the command that writes outside the workspace or run with a filesystem profile that permits ~/.devspace.`);
  }
}

function safeRemoveFile(path, label) {
  safeRemovePath(path, label);
}

function safeRemovePath(path, label) {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { recursive: true, force: true });
    return;
  } catch (firstError) {
    try {
      makePathTreeRemovable(path);
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (secondError) {
      throw permissionAwareError(secondError, `Unable to remove ${label} at ${path}.`);
    }
  }
}

function makePathTreeRemovable(path) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    try {
      chmodSync(path, 0o700);
    } catch {}
    let entries = [];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      makePathTreeRemovable(join(path, entry.name));
    }
    return;
  }
  try {
    chmodSync(path, 0o600);
  } catch {}
}

function permissionAwareError(error, prefix) {
  if (error?.code === "EPERM" || error?.code === "EACCES") {
    return new Error(`${prefix} Permission was denied by the OS or Codex sandbox (${error.code}).`);
  }
  return error;
}

async function stop({ print }) {
  const status = loadStatus();
  const killed = [];
  if (status?.devspacePid) killed.push(...killPidGroup(status.devspacePid, "devspace"));
  if (status?.cloudflaredPid) killed.push(...killPidGroup(status.cloudflaredPid, "cloudflared"));
  if (status?.localtunnelPid) killed.push(...killPidGroup(status.localtunnelPid, "localtunnel"));
  const pidFileCloudflaredPid = readCloudflaredPid();
  if (pidFileCloudflaredPid && pidFileCloudflaredPid !== status?.cloudflaredPid) {
    killed.push(...killPidGroup(pidFileCloudflaredPid, "cloudflared"));
  }
  const pidFileLocaltunnelPid = readLocaltunnelPid();
  if (pidFileLocaltunnelPid && pidFileLocaltunnelPid !== status?.localtunnelPid) {
    killed.push(...killPidGroup(pidFileLocaltunnelPid, "localtunnel"));
  }
  await waitForKilledProcesses(killed);
  safeRemoveFile(STATUS_PATH, "managed status file");
  safeRemoveFile(join(MANAGER_DIR, "cloudflared.pid"), "managed cloudflared pid file");
  safeRemoveFile(join(MANAGER_DIR, "localtunnel.pid"), "managed localtunnel pid file");
  const ok = killed.every((entry) => !entry.error);
  if (print) printJson({ ok, killed });
  if (!ok) process.exitCode = 1;
}

async function printStatus() {
  const status = loadStatus();
  if (!status) {
    printJson({ ok: false, running: false, reason: "No managed DevSpace status file found." });
    process.exitCode = 1;
    return;
  }
  const checks = await quickReachability(status.publicBaseUrl, status.port);
  const devspaceAlive = isAlive(status.devspacePid);
  const cloudflaredAlive = status.cloudflaredPid ? isAlive(status.cloudflaredPid) : null;
  const localtunnelAlive = status.localtunnelPid ? isAlive(status.localtunnelPid) : null;
  const processesAlive = Boolean(devspaceAlive && (cloudflaredAlive ?? true) && (localtunnelAlive ?? true));
  const reachable = Boolean(checks.localDiscovery && checks.publicDiscovery);
  const result = {
    ok: processesAlive && reachable,
    running: true,
    devspaceAlive,
    cloudflaredAlive,
    localtunnelAlive,
    ...status,
    reachability: checks,
  };
  printJson(result);
  if (!result.ok) process.exitCode = 1;
}

async function doctor() {
  ensureCommand("devspace");
  const result = spawnSync("devspace", ["doctor"], { encoding: "utf8" });
  const status = loadStatus();
  const checks = status ? await runChecks(status, { deep: false }) : [];
  const output = {
    ok: result.status === 0 && checks.every((check) => check.ok),
    devspaceDoctorExitCode: result.status,
    devspaceDoctorStdout: result.stdout.trim(),
    devspaceDoctorStderr: result.stderr.trim(),
    checks,
  };
  printJson(output);
  if (!output.ok) process.exitCode = 1;
}

async function runChecks(status, options = {}) {
  const localBase = `http://127.0.0.1:${status.port}`;
  const publicBase = status.publicBaseUrl;
  const checks = [];
  checks.push(devspaceDoctorCheck());
  checks.push(check("devspace process alive", isAlive(status.devspacePid)));
  if (status.cloudflaredPid) checks.push(check("cloudflared process alive", isAlive(status.cloudflaredPid)));
  if (status.localtunnelPid) checks.push(check("localtunnel process alive", isAlive(status.localtunnelPid)));
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

function devspaceDoctorCheck() {
  const result = spawnSync("devspace", ["doctor"], {
    encoding: "utf8",
    timeout: DEFAULT_HTTP_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return check("devspace doctor", result.status === 0 && !result.error, {
    exitCode: result.status,
    stdout: preview(result.stdout),
    stderr: preview(result.stderr),
    error: result.error?.message,
  });
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

  const root = options.rootOverride ?? firstExistingRoot(status.allowedRoots);
  if (!status.allowedRoots.includes(root)) {
    throw new Error(`MCP smoke root is not in allowed roots: ${root}`);
  }
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
  let writeDir = null;
  if (options.writeTest) {
    if (!toolNames.write || !toolNames.edit) {
      throw new Error("MCP write-test requested, but write/edit tools are not available.");
    }
    writeDir = mkdtempSync(join(root, ".devspace-manager-smoke-"));
    chmodSync(writeDir, 0o700);
    writePath = relative(root, join(writeDir, `smoke-${Date.now()}.txt`));
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
      if (writeDir) safeRemovePath(writeDir, "MCP write/edit smoke directory");
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
  const authorize = await fetchWithTimeout(`${localBase}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorizeBody,
  }, "OAuth authorization");
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
  const response = await fetchWithTimeout(url, options, label);
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
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }, `MCP ${payload?.method ?? "request"}`);
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

function prepareExchangeRoot(taskId) {
  const exchangeRoot = join(EXCHANGE_DIR, taskId);
  safeRemovePath(exchangeRoot, "stale DevSpace exchange directory");
  mkdirSync(exchangeRoot, { recursive: true, mode: 0o700 });
  chmodSync(exchangeRoot, 0o700);
  writeFileSync(join(exchangeRoot, "README.txt"), "DevSpace Manager result exchange root.\n", { mode: 0o600 });
  return exchangeRoot;
}

function connectorSetupForStatus(status) {
  return {
    connectorUrl: status.publicMcpUrl,
    ownerTokenCommand: "jq -r .ownerToken ~/.devspace/auth.json",
    description: "Add this URL as a ChatGPT MCP connector, then authorize with the Owner password from the local command.",
  };
}

function appendRootOption(rawRoots, extraRoot) {
  const roots = parseRoots(rawRoots);
  if (!roots.includes(extraRoot)) roots.push(extraRoot);
  return roots.join(",");
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

function buildChatGptTaskPrompt({ task, status, root, exchangeRoot, resultFileName, doneToken, promptId, allowEdits }) {
  const editInstruction = allowEdits
    ? "You may edit files through DevSpace when the fix is clear. Prefer targeted edit calls over full rewrites. After edits, run the relevant tests and summarize the exact files changed."
    : "Do not edit files unless I explicitly follow up asking you to do so. Return verified findings and concrete fix guidance; Codex will implement locally.";
  return [
    "# DevSpace Delegated Coding Task",
    "",
    "You are ChatGPT working with the DevSpace MCP connector. Use DevSpace to inspect this local codebase directly. Do not ask for a zip, file upload, pasted source, screenshots, or manual download.",
    `Prompt ID: DEVSPACE_MANAGER_PROMPT_ID ${promptId}`,
    "",
    "Connector details:",
    `- MCP connector URL: ${status.publicMcpUrl}`,
    `- Workspace path to open: ${root}`,
    `- Result exchange workspace path to open when finished: ${exchangeRoot}`,
    `- Result file to write inside the result exchange workspace: ${resultFileName}`,
    `- Allowed roots: ${status.allowedRoots.join(", ")}`,
    "- If the connector is not already configured in ChatGPT, ask the user to add the MCP connector URL above and authorize with the Owner password from this local command: jq -r .ownerToken ~/.devspace/auth.json",
    "",
    "Required DevSpace workflow:",
    "1. Call open_workspace with the workspace path above.",
    "2. Follow any AGENTS.md, CLAUDE.md, or skill instructions returned by open_workspace before making claims.",
    "3. Use read, grep/glob/ls when available, and bash for builds, tests, package scripts, git inspection, and other read-only command-line inspection.",
    "4. Verify every finding against actual files or command output before stating it.",
    `5. ${editInstruction}`,
    "6. When finished, open the result exchange workspace path above and write the final answer to the result file above through DevSpace. The last line of the file must be exactly:",
    doneToken,
    "7. If and only if you cannot write the result file through DevSpace, return the complete final answer in this ChatGPT conversation instead, and make the last line exactly the same token above.",
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

function buildChatGptLiveCheckPrompt({ status, root, exchangeRoot, relativeMarkerPath, resultFileName, promptId }) {
  return [
    "# DevSpace Live Connector Check",
    "",
    "You are ChatGPT with a DevSpace MCP connector. This is an end-to-end connector check.",
    `Prompt ID: DEVSPACE_MANAGER_PROMPT_ID ${promptId}`,
    "",
    "Connector details:",
    `- MCP connector URL: ${status.publicMcpUrl}`,
    `- Workspace path to open: ${root}`,
    `- Result exchange workspace path to open after reading the marker: ${exchangeRoot}`,
    `- Result file to write inside the result exchange workspace: ${resultFileName}`,
    `- Marker file path to read after opening the workspace: ${relativeMarkerPath}`,
    "- If the DevSpace connector is not configured, say exactly: DEVSPACE_MANAGER_CONNECTOR_NOT_CONFIGURED",
    "",
    "Required steps:",
    "1. Use the DevSpace MCP connector, not uploaded files or pasted source.",
    "2. Call open_workspace with the workspace path above.",
    "3. Read the marker file path above through DevSpace.",
    "4. Open the result exchange workspace path above.",
    "5. Write exactly the marker line from that file, and nothing else, to the result file above through DevSpace.",
    "6. If and only if you can read the marker through DevSpace but cannot write the result file, reply in this ChatGPT conversation with exactly the marker line and nothing else.",
    "",
    "The marker value is intentionally not included in this prompt. You must read the file through DevSpace to know it.",
  ].join("\n");
}

async function sendPromptWithChatGptAppResult(args) {
  try {
    return await sendPromptWithChatGptApp(args);
  } catch (error) {
    const finalHide = process.platform === "darwin" ? hideChatGptAppQuietly() : null;
    return {
      ok: false,
      status: "failed",
      transport: args.sendTarget ?? DEFAULT_CHATGPT_SEND,
      backgroundOnly: true,
      resultFilePath: args.resultFilePath,
      finalDeliveryText: readTextFileIfExists(args.resultFilePath),
      finalHide,
      reason: error instanceof Error ? error.message : String(error),
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function sendPromptWithChatGptApp({ prompt, timeoutMs, resultFilePath, expectText, sendTarget = DEFAULT_CHATGPT_SEND }) {
  if (process.platform !== "darwin") {
    throw new Error("ChatGPT app sending is only supported on macOS.");
  }
  if (!resultFilePath) {
    throw new Error("ChatGPT app sending requires a DevSpace result file path to poll.");
  }
  safeRemoveFile(resultFilePath, "stale ChatGPT result file");
  const sent = sendPromptWithChatGptTransport(prompt, sendTarget);
  const started = Date.now();
  let lastText = "";
  let lastAppAssistantText = "";
  let lastAppSnapshot = null;
  let lastAppSnapshotError = null;

  while (Date.now() - started < timeoutMs) {
    await sleep(2_000);
    const text = readTextFileIfExists(resultFilePath);
    const matched = expectText ? text.includes(expectText) : Boolean(text.trim());
    if (matched) {
      return {
        ok: true,
        status: "complete",
        transport: sent.transport,
        delivery: sent,
        resultChannel: "devspace-result-file",
        resultFilePath,
        finalDeliveryText: text,
        appAssistantText: lastAppAssistantText,
        appSnapshot: lastAppSnapshot,
        appSnapshotError: lastAppSnapshotError,
        matchedText: expectText ?? null,
      };
    }
    if (text !== lastText) {
      lastText = text;
    }

    const appSnapshotResult = readChatGptAppAssistantSnapshot(prompt);
    if (appSnapshotResult.ok) {
      lastAppSnapshotError = null;
      lastAppSnapshot = {
        ...appSnapshotResult.snapshot,
        promptMatched: appSnapshotResult.promptMatched,
      };
      if (appSnapshotResult.assistantText !== lastAppAssistantText) {
        lastAppAssistantText = appSnapshotResult.assistantText;
      }
      const appMatched = expectText
        ? lastAppAssistantText.includes(expectText)
        : Boolean(lastAppAssistantText.trim());
      if (appMatched && appSnapshotResult.complete) {
        return {
          ok: true,
          status: "complete",
          transport: sent.transport,
          delivery: sent,
          resultChannel: "chatgpt-app-transcript",
          resultFilePath,
          finalDeliveryText: lastAppAssistantText,
          appAssistantText: lastAppAssistantText,
          appSnapshot: lastAppSnapshot,
          matchedText: expectText ?? null,
          reason: "ChatGPT did not write the DevSpace result file, but its app transcript contained the expected completion text.",
        };
      }
      if (
        appSnapshotResult.complete &&
        lastAppAssistantText.trim() &&
        /\bDEVSPACE_MANAGER_CONNECTOR_NOT_CONFIGURED\b/i.test(lastAppAssistantText)
      ) {
        return {
          ok: false,
          status: "connector-not-configured",
          transport: sent.transport,
          delivery: sent,
          resultChannel: "chatgpt-app-transcript",
          resultFilePath,
          finalDeliveryText: lastText,
          appAssistantText: lastAppAssistantText,
          appSnapshot: lastAppSnapshot,
          reason: "ChatGPT reported that the DevSpace connector is not configured.",
        };
      }
    } else {
      lastAppSnapshotError = appSnapshotResult.reason;
    }
  }

  return {
    ok: false,
    status: "timeout",
    transport: sent.transport,
    delivery: sent,
    resultFilePath,
    finalDeliveryText: lastText,
    appAssistantText: lastAppAssistantText,
    appSnapshot: lastAppSnapshot,
    appSnapshotError: lastAppSnapshotError,
    reason: expectText
      ? "Timed out waiting for ChatGPT to write the expected text to the DevSpace result file."
      : "Timed out waiting for ChatGPT to write a DevSpace result file.",
  };
}

function readChatGptAppAssistantSnapshot(prompt) {
  try {
    const state = runChatGptSnapshotAx();
    const promptMatched = transcriptContainsPrompt(state, prompt);
    const assistantText = extractAssistantTextFromAppState(state, prompt);
    const complete = isAppResponseCompleteSnapshot({
      assistantText,
      isAnswering: Boolean(state.isAnswering),
    });
    return {
      ok: true,
      assistantText,
      complete,
      promptMatched,
      snapshot: publicChatGptSnapshot(state),
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function runChatGptSnapshotAx() {
  const result = spawnSync("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    CHATGPT_SNAPSHOT_JXA,
  ], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error("CHATGPT_SNAPSHOT_TIMEOUT: ChatGPT Accessibility snapshot timed out.");
    }
    throw new Error(`CHATGPT_SNAPSHOT_FAILED: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`CHATGPT_SNAPSHOT_FAILED: ${preview(result.stderr || result.stdout)}`);
  }
  const raw = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  const parsed = readJsonFromString(raw, null);
  if (!parsed) {
    throw new Error(`CHATGPT_SNAPSHOT_FAILED: non-JSON output from osascript: ${preview(result.stdout || result.stderr)}`);
  }
  if (!parsed.ok) {
    throw new Error(`${parsed.code || "CHATGPT_SNAPSHOT_FAILED"}: ${parsed.message || "ChatGPT Accessibility snapshot failed."}`);
  }
  return parsed.value;
}

function extractAssistantTextFromAppState(state = {}, prompt = "") {
  const transcript = Array.isArray(state.transcriptTexts)
    ? state.transcriptTexts
    : [];
  const promptIndex = findPromptIndexInTranscript(transcript, prompt);
  if (promptIndex < 0) return "";
  const promptNeedle = normalizeForMatch(prompt);

  const candidates = transcript.slice(promptIndex + 1)
    .map((entry) => String(entry?.text ?? entry ?? "").trim())
    .filter(Boolean)
    .filter((text) => !isAppUiText(text))
    .filter((text) => normalizeForMatch(text) !== promptNeedle)
    .filter((text) => !isAppTransientText(text));

  return normalizeAssistantText(dedupeAdjacent(candidates).join("\n"));
}

function transcriptContainsPrompt(state = {}, prompt = "") {
  const transcript = Array.isArray(state.transcriptTexts)
    ? state.transcriptTexts
    : [];
  return findPromptIndexInTranscript(transcript, prompt) >= 0;
}

function findPromptIndexInTranscript(transcript, prompt) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const text = normalizeForMatch(transcript[index]?.text ?? transcript[index]);
    if (!text) continue;
    if (textMatchesPrompt(text, prompt)) return index;
  }
  return -1;
}

function textMatchesPrompt(normalizedText, prompt) {
  const ids = promptIdentityNeedles(prompt);
  if (ids.length > 0) return ids.some((id) => normalizedText.includes(id));
  const promptNeedle = normalizeForMatch(prompt);
  return normalizedText === promptNeedle ||
    (promptNeedle.length >= 80 && normalizedText.includes(promptNeedle.slice(0, 80))) ||
    (normalizedText.length >= 80 && promptNeedle.includes(normalizedText.slice(0, 80)));
}

function promptIdentityNeedles(prompt) {
  return [...String(prompt ?? "").matchAll(/DEVSPACE_MANAGER_PROMPT_ID\s+\S+/g)]
    .map((match) => normalizeForMatch(match[0]))
    .filter(Boolean);
}

function isAppResponseCompleteSnapshot({ assistantText, isAnswering }) {
  return Boolean(
    assistantText?.trim() &&
    !isAppTransientText(assistantText) &&
    !isAnswering
  );
}

function publicChatGptSnapshot(state = {}) {
  return {
    title: state.title ?? null,
    visibleModelLabel: state.visibleModelLabel ?? null,
    frontmostProcessName: state.frontmostProcessName ?? null,
    visible: state.visible ?? null,
    windows: state.windows ?? null,
    isAnswering: Boolean(state.isAnswering),
    transcriptCount: Array.isArray(state.transcriptTexts) ? state.transcriptTexts.length : 0,
  };
}

function isAppUiText(text = "") {
  const normalized = normalizeWhitespace(text)
    .replace(/\u2019/g, "'")
    .replace(/\u2018/g, "'");
  return (
    normalized === "Ask anything" ||
    normalized === "Turn on notifications" ||
    normalized === "Get notified when there's an update on your tasks." ||
    normalized === "Get notified when there is an update on your tasks." ||
    /^ChatGPT can make mistakes/i.test(normalized) ||
    /^Message ChatGPT/i.test(normalized)
  );
}

function isAppTransientText(text = "") {
  const normalized = normalizeWhitespace(text);
  return (
    normalized === "Thinking" ||
    normalized === "Pro thinking" ||
    normalized === "Searching" ||
    normalized === "Searching the web" ||
    /^Thought for \d+s$/i.test(normalized) ||
    /^Analyzing images?$/i.test(normalized) ||
    /^Processing images?$/i.test(normalized) ||
    /^Reading images?$/i.test(normalized)
  );
}

function normalizeAssistantText(text = "") {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function normalizeForMatch(text = "") {
  return normalizeWhitespace(text).toLowerCase();
}

function normalizeWhitespace(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function dedupeAdjacent(values) {
  const output = [];
  for (const value of values) {
    if (output.at(-1) !== value) output.push(value);
  }
  return output;
}

const CHATGPT_SNAPSHOT_JXA = String.raw`
function run() {
  try {
    return JSON.stringify({ ok: true, value: readChatGptState() });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      code: error.code || "CHATGPT_SNAPSHOT_FAILED",
      message: String(error.message || error)
    });
  }
}

function readChatGptState() {
  var systemEvents = Application("System Events");
  if (!systemEvents.uiElementsEnabled()) {
    fail("MACOS_ACCESSIBILITY_DISABLED", "macOS Accessibility automation is not enabled for the current process.");
  }
  var proc = systemEvents.processes.byName("ChatGPT");
  if (!proc.exists()) fail("CHATGPT_APP_NOT_RUNNING", "ChatGPT.app is not running.");
  var windows = [];
  try { windows = proc.windows(); } catch (_) {}
  if (windows.length === 0) fail("CHATGPT_WINDOW_MISSING", "No ChatGPT app window is available for snapshot.");
  var window = windows[0];
  var nodes = descendants(window);
  var composer = firstNode(nodes, function(node) {
    return safeString(function() { return node.role(); }) === "AXTextArea";
  });
  var composerRecord = composer ? recordForNode(composer, -1) : null;
  var composerTop = composerRecord && composerRecord.position
    ? composerRecord.position.y
    : Number.POSITIVE_INFINITY;

  var staticTexts = [];
  for (var index = 0; index < nodes.length; index += 1) {
    var node = nodes[index];
    if (safeString(function() { return node.role(); }) !== "AXStaticText") continue;
    var record = recordForNode(node, index);
    var text = staticTextForRecord(record);
    if (!text) continue;
    if (record.position && record.position.y >= composerTop - 8) continue;
    staticTexts.push({
      text: text,
      position: record.position,
      size: record.size
    });
  }

  staticTexts.sort(function(a, b) {
    var ay = a.position ? a.position.y : 0;
    var by = b.position ? b.position.y : 0;
    var ax = a.position ? a.position.x : 0;
    var bx = b.position ? b.position.x : 0;
    return ay - by || ax - bx;
  });

  var buttons = [];
  for (var buttonIndex = 0; buttonIndex < nodes.length; buttonIndex += 1) {
    var buttonNode = nodes[buttonIndex];
    if (safeString(function() { return buttonNode.role(); }) !== "AXButton") continue;
    buttons.push(recordForNode(buttonNode, buttonIndex));
  }
  var buttonLabels = buttons.map(function(button) {
    return normalizeText([button.name, button.description, button.value].filter(Boolean).join(" "));
  }).filter(Boolean);
  var isAnswering = buttonLabels.some(function(label) {
    return /\b(stop|cancel)\b/i.test(label) && /\b(generating|answer|response|stream|thinking)\b/i.test(label);
  });

  return {
    title: safeString(function() { return window.name(); }) || "ChatGPT",
    bundleId: "com.openai.chat",
    processName: "ChatGPT",
    frontmostProcessName: frontmostProcessName(systemEvents),
    visible: safeValue(function() { return proc.visible(); }),
    windows: windows.length,
    hasComposer: Boolean(composer),
    composerValue: composer ? safeString(function() { return composer.value(); }) : "",
    visibleModelLabel: findVisibleModelLabel(buttons),
    transcriptTexts: staticTexts.map(function(entry) { return entry.text; }),
    visibleText: staticTexts.map(function(entry) { return entry.text; }).join("\n"),
    buttonLabels: buttonLabels,
    isAnswering: isAnswering
  };
}

function descendants(root) {
  var output = [];
  var stack = [root];
  while (stack.length > 0 && output.length < 4000) {
    var current = stack.pop();
    var children = [];
    try { children = current.uiElements(); } catch (_) {}
    for (var i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    for (var j = 0; j < children.length; j++) output.push(children[j]);
  }
  return output;
}

function firstNode(nodes, predicate) {
  for (var i = 0; i < nodes.length; i++) {
    if (predicate(nodes[i])) return nodes[i];
  }
  return null;
}

function recordForNode(node, index) {
  return {
    index: index,
    role: safeString(function() { return node.role(); }),
    name: safeString(function() { return node.name(); }),
    description: safeString(function() { return node.description(); }),
    value: safeString(function() { return node.value(); }),
    enabled: safeString(function() { return node.enabled(); }),
    position: pointFromArray(safeValue(function() { return node.position(); })),
    size: sizeFromArray(safeValue(function() { return node.size(); }))
  };
}

function staticTextForRecord(record) {
  return normalizeText([record.value, record.name, record.description].filter(Boolean).join(" "));
}

function findVisibleModelLabel(buttons) {
  for (var i = 0; i < buttons.length; i++) {
    var label = normalizeText([buttons[i].name, buttons[i].description, buttons[i].value].filter(Boolean).join(" "));
    if (/^(?:ChatGPT\s*)?(?:5\.\d|4\.5|4o|o3).*/i.test(label) || /\b(Instant|Thinking|Pro)\b/i.test(label)) {
      return label.replace(/^ChatGPT\s*/i, "").trim();
    }
  }
  return "";
}

function frontmostProcessName(systemEvents) {
  try {
    var frontmost = systemEvents.processes.whose({ frontmost: true })();
    if (frontmost.length > 0) return safeString(function() { return frontmost[0].name(); });
  } catch (_) {}
  return "";
}

function pointFromArray(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  return { x: Number(value[0]), y: Number(value[1]) };
}

function sizeFromArray(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  return { width: Number(value[0]), height: Number(value[1]) };
}

function safeValue(callback) {
  try { return callback(); } catch (_) { return null; }
}

function safeString(callback) {
  var value = safeValue(callback);
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function fail(code, message) {
  var error = new Error(message);
  error.code = code;
  throw error;
}
`;

function sendPromptWithChatGptTransport(prompt, sendTarget) {
  if (sendTarget === "chatgpt-app-visible") return sendPromptWithVisibleChatGpt(prompt);
  if (sendTarget === "chatgpt-app-hidden" || sendTarget === "chatgpt-app") {
    return sendPromptWithHiddenChatGptAccessibility(prompt);
  }
  if (sendTarget !== DEFAULT_CHATGPT_SEND) {
    throw new Error(`Unsupported ChatGPT send target: ${sendTarget}`);
  }
  try {
    return sendPromptWithHiddenChatGptAccessibility(prompt);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fallback = sendPromptWithVisibleChatGpt(prompt);
    return {
      ...fallback,
      hiddenAttempt: {
        ok: false,
        reason,
      },
    };
  }
}

function sendPromptWithHiddenChatGptAccessibility(prompt) {
  const launch = spawnSync("/usr/bin/open", ["-gj", "-b", "com.openai.chat"], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (launch.error) {
    throw new Error(`ChatGPT app launch failed: ${launch.error.message}`);
  }
  if (launch.status !== 0) {
    throw new Error(`ChatGPT app launch failed with exit ${launch.status}: ${preview(launch.stderr || launch.stdout)}`);
  }
  const initialHide = hideChatGptAppQuietly();
  if (!initialHide.ok) {
    throw new Error(`ChatGPT remained visible after hidden launch: ${initialHide.reason}`);
  }
  ensureChatGptHiddenWindow();
  let delivery;
  let finalHide;
  try {
    delivery = runChatGptHiddenAx("sendPrompt", { prompt });
  } finally {
    finalHide = hideChatGptAppQuietly();
  }
  if (!finalHide.ok) {
    throw new Error(`ChatGPT remained visible after hidden automation: ${finalHide.reason}`);
  }
  return {
    ok: true,
    transport: "chatgpt-app-hidden-accessibility",
    backgroundOnly: true,
    delivery,
    hideState: finalHide.state,
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    responseMode: "devspace-result-file",
  };
}

function sendPromptWithVisibleChatGpt(prompt) {
  try {
    return sendPromptWithVisibleChatGptAx(prompt);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/CHATGPT_WINDOW_MISSING/i.test(reason)) throw error;
    const fallback = sendPromptWithVisibleChatGptKeyboard(prompt);
    return {
      ...fallback,
      visibleAxAttempt: {
        ok: false,
        reason,
      },
    };
  }
}

function sendPromptWithVisibleChatGptAx(prompt) {
  const launch = spawnSync("/usr/bin/open", ["-b", "com.openai.chat", "-u", "chatgpt://new-conversation"], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (launch.error) {
    throw new Error(`ChatGPT visible launch failed: ${launch.error.message}`);
  }
  if (launch.status !== 0) {
    throw new Error(`ChatGPT visible launch failed with exit ${launch.status}: ${preview(launch.stderr || launch.stdout)}`);
  }

  const windowState = ensureVisibleChatGptWindow("visible Accessibility automation");
  const delivery = runChatGptVisibleAx("sendPrompt", { prompt });
  const finalHide = hideChatGptAppQuietly();
  return {
    ok: true,
    transport: "chatgpt-app-visible-accessibility",
    backgroundOnly: false,
    delivery,
    windowState,
    finalHide,
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    responseMode: "devspace-result-file",
  };
}

function sendPromptWithVisibleChatGptKeyboard(prompt) {
  const launch = spawnSync("/usr/bin/open", ["-b", "com.openai.chat", "-u", "chatgpt://new-conversation"], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (launch.error) {
    throw new Error(`ChatGPT visible launch failed: ${launch.error.message}`);
  }
  if (launch.status !== 0) {
    throw new Error(`ChatGPT visible launch failed with exit ${launch.status}: ${preview(launch.stderr || launch.stdout)}`);
  }

  const windowState = ensureVisibleChatGptWindow("visible keyboard automation");
  const oldClipboard = readClipboardText();
  writeClipboardText(prompt);
  let delivery;
  try {
    delivery = runChatGptVisibleKeyboard();
  } finally {
    if (oldClipboard.ok) writeClipboardText(oldClipboard.text);
  }
  const finalHide = hideChatGptAppQuietly();

  return {
    ok: true,
    transport: "chatgpt-app-visible-keyboard",
    backgroundOnly: false,
    delivery,
    windowState,
    finalHide,
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    responseMode: "devspace-result-file",
  };
}

function ensureVisibleChatGptWindow(label) {
  let state = waitForChatGptWindow(5_000);
  if (state?.windows > 0) return state;

  runChatGptWindowRecovery();
  state = waitForChatGptWindow(12_000);
  if (state?.windows > 0) return state;

  throw new Error(`CHATGPT_WINDOW_MISSING: ChatGPT has no accessible window for ${label}. Last state: ${JSON.stringify(state ?? chatGptVisibilityState())}`);
}

function waitForChatGptWindow(timeoutMs) {
  const started = Date.now();
  let state = chatGptVisibilityState();
  while (Date.now() - started < timeoutMs) {
    state = chatGptVisibilityState();
    if (state.exists && state.windows > 0) return state;
    sleepSync(250);
  }
  return state;
}

function runChatGptWindowRecovery() {
  spawnSync("/usr/bin/open", ["-b", "com.openai.chat"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  spawnSync("/usr/bin/open", ["-u", "chatgpt://new-conversation"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  spawnSync("/usr/bin/osascript", ["-e", CHATGPT_VISIBLE_WINDOW_RECOVERY_APPLESCRIPT], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
}

function runChatGptVisibleAx(action, payload) {
  const result = spawnSync("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    CHATGPT_VISIBLE_AX_JXA,
    JSON.stringify({ action, payload }),
  ], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error("CHATGPT_VISIBLE_AX_TIMEOUT: Visible ChatGPT Accessibility automation timed out before submitting the prompt.");
    }
    throw new Error(`CHATGPT_VISIBLE_AX_FAILED: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`CHATGPT_VISIBLE_AX_FAILED: ${preview(result.stderr || result.stdout)}`);
  }
  const raw = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  const parsed = readJsonFromString(raw, null);
  if (!parsed) {
    throw new Error(`CHATGPT_VISIBLE_AX_FAILED: non-JSON output from osascript: ${preview(result.stdout || result.stderr)}`);
  }
  if (!parsed.ok) {
    throw new Error(`${parsed.code || "CHATGPT_VISIBLE_AX_FAILED"}: ${parsed.message || "Visible ChatGPT Accessibility automation failed."}`);
  }
  return parsed.value;
}

const CHATGPT_VISIBLE_AX_JXA = String.raw`
function run(argv) {
  try {
    var request = JSON.parse(argv[0] || "{}");
    if (request.action !== "sendPrompt") fail("CHATGPT_UNKNOWN_ACTION", "Unknown ChatGPT action: " + request.action);
    return JSON.stringify({ ok: true, value: sendPrompt(String((request.payload || {}).prompt || "")) });
  } catch (error) {
    return JSON.stringify({ ok: false, code: error.code || "CHATGPT_VISIBLE_AX_FAILED", message: String(error.message || error), details: error.details || null });
  }
}

function sendPrompt(prompt) {
  if (!prompt.trim()) fail("CHATGPT_EMPTY_PROMPT", "Refusing to send an empty ChatGPT prompt.");
  var systemEvents = Application("System Events");
  if (!systemEvents.uiElementsEnabled()) fail("MACOS_ACCESSIBILITY_DISABLED", "macOS Accessibility automation is not enabled for the current process.");
  var frontmostBefore = frontmostProcessName(systemEvents);
  var chatgpt = Application("ChatGPT");
  try {
    if (chatgpt.id() !== "com.openai.chat") fail("CHATGPT_BUNDLE_MISMATCH", "The application named ChatGPT did not resolve to bundle id com.openai.chat.");
  } catch (error) {
    fail("CHATGPT_APP_NOT_FOUND", "The ChatGPT desktop app is not installed or registered with LaunchServices.");
  }
  chatgpt.activate();
  var proc = waitForProcessWindow(systemEvents, "ChatGPT", 15000);
  proc.frontmost = true;
  delay(0.3);
  var window = proc.windows()[0];
  clickNewChatIfAvailable(window);
  delay(0.5);
  var composer = waitForComposer(window, 15000);
  composer.value = prompt;
  delay(0.2);
  var actual = String(safeValue(function() { return composer.value(); }) || "");
  if (actual.trim() !== prompt.trim()) {
    fail("CHATGPT_PROMPT_NOT_SET", "Could not set the ChatGPT app composer text through Accessibility.", {
      actualLength: actual.length,
      promptLength: prompt.length
    });
  }
  sendComposerPrompt(window, composer);
  var accepted = waitForPromptAccepted(composer, prompt, 5000);
  return {
    composerRole: safeString(function() { return composer.role(); }),
    accepted: accepted,
    frontmostBefore: frontmostBefore,
    frontmostProcessName: frontmostProcessName(systemEvents),
    visible: proc.visible(),
    windows: proc.windows().length
  };
}

function waitForProcessWindow(systemEvents, name, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  var proc = systemEvents.processes.byName(name);
  while (Date.now() < deadline) {
    try {
      if (proc.exists() && proc.windows().length > 0) return proc;
    } catch (_) {}
    delay(0.25);
    proc = systemEvents.processes.byName(name);
  }
  fail("CHATGPT_WINDOW_MISSING", "No ChatGPT app window is available for visible automation.");
}

function clickNewChatIfAvailable(window) {
  var buttons = toolbarButtons(window);
  if (buttons.length === 0) {
    buttons = descendants(window).filter(function(node) {
      return safeString(function() { return node.role(); }) === "AXButton";
    });
  }
  for (var i = 0; i < buttons.length; i++) {
    var label = normalizeText([
      safeString(function() { return buttons[i].description(); }),
      safeString(function() { return buttons[i].name(); }),
      safeString(function() { return buttons[i].value(); })
    ].join(" "));
    if (/^New chat$/i.test(label)) {
      pressElement(buttons[i]);
      return;
    }
  }
}

function toolbarButtons(window) {
  var buttons = [];
  try {
    var toolbars = window.toolbars();
    for (var t = 0; t < toolbars.length; t++) {
      var list = toolbars[t].buttons();
      for (var i = 0; i < list.length; i++) buttons.push(list[i]);
    }
  } catch (_) {}
  return buttons;
}

function waitForComposer(window, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    var nodes = descendants(window);
    for (var i = 0; i < nodes.length; i++) {
      if (safeString(function() { return nodes[i].role(); }) === "AXTextArea") return nodes[i];
    }
    delay(0.25);
  }
  fail("CHATGPT_COMPOSER_MISSING", "Could not find the ChatGPT app composer text area.");
}

function sendComposerPrompt(window, composer) {
  var sendButton = findSendButton(descendants(window), composer);
  if (!sendButton) fail("CHATGPT_SEND_BUTTON_MISSING", "Could not find the ChatGPT app send button after setting the composer text.");
  pressElement(sendButton);
  delay(0.4);
}

function waitForPromptAccepted(composer, promptText, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    var value = safeString(function() { return composer.value(); });
    if (normalizeText(value) !== normalizeText(promptText)) return true;
    delay(0.25);
  }
  fail("CHATGPT_SEND_NOT_CONFIRMED", "The ChatGPT app composer still contained the prompt after pressing Send.", {
    composerValueLength: String(safeString(function() { return composer.value(); }) || "").length,
    promptLength: String(promptText || "").length
  });
}

function findSendButton(nodes, composer) {
  var composerRecord = recordForNode(composer);
  var best = null;
  var bestScore = -Infinity;
  for (var i = 0; i < nodes.length; i++) {
    if (safeString(function() { return nodes[i].role(); }) !== "AXButton") continue;
    var record = recordForNode(nodes[i]);
    if (record.enabled === "false" || !record.position || !record.size) continue;
    if (!isPossibleSendButton(record, composerRecord)) continue;
    var score = sendButtonScore(record, composerRecord);
    if (score > bestScore) {
      best = nodes[i];
      bestScore = score;
    }
  }
  return best;
}

function isPossibleSendButton(button, composer) {
  if (!composer.position || !composer.size || !button.position || !button.size) return false;
  var label = buttonLabel(button);
  if (/ChatGPT|New chat|Share|Move|Sidebar|close|minimize|full screen|5\.\d|4\.5|o3|Pro|Thinking|Instant/i.test(label)) return false;
  var buttonCenterY = button.position.y + button.size.height / 2;
  var composerBottomY = composer.position.y + Math.min(composer.size.height, 360);
  var nearComposerControlsRow = buttonCenterY >= composer.position.y - 40 && buttonCenterY <= composerBottomY + 80;
  var rightOfComposer = button.position.x > composer.position.x + Math.max(180, composer.size.width * 0.35);
  var reasonableSize = button.size.width >= 16 && button.size.width <= 80 && button.size.height >= 16 && button.size.height <= 80;
  return nearComposerControlsRow && rightOfComposer && reasonableSize;
}

function sendButtonScore(button, composer) {
  var verticalPenalty = Math.abs((button.position.y + button.size.height / 2) - (composer.position.y + composer.size.height / 2));
  return button.position.x - verticalPenalty * 4;
}

function descendants(root) {
  var output = [];
  var stack = [root];
  while (stack.length > 0 && output.length < 4000) {
    var current = stack.pop();
    var children = [];
    try { children = current.uiElements(); } catch (_) {}
    for (var i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    for (var j = 0; j < children.length; j++) output.push(children[j]);
  }
  return output;
}

function recordForNode(node) {
  return {
    role: safeString(function() { return node.role(); }),
    name: safeString(function() { return node.name(); }),
    description: safeString(function() { return node.description(); }),
    value: safeString(function() { return node.value(); }),
    enabled: safeString(function() { return node.enabled(); }),
    position: pointFromArray(safeValue(function() { return node.position(); })),
    size: sizeFromArray(safeValue(function() { return node.size(); }))
  };
}

function buttonLabel(record) {
  return normalizeText([record.description, record.name, record.value].filter(Boolean).join(" "));
}

function pressElement(element) {
  try {
    element.actions.byName("AXPress").perform();
    return;
  } catch (_) {}
  try {
    element.click();
    return;
  } catch (_) {}
  fail("CHATGPT_AXPRESS_UNAVAILABLE", "A required ChatGPT app control did not expose a usable press action.");
}

function pointFromArray(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  return { x: Number(value[0]), y: Number(value[1]) };
}

function sizeFromArray(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  return { width: Number(value[0]), height: Number(value[1]) };
}

function safeValue(callback) {
  try { return callback(); } catch (_) { return null; }
}

function safeString(callback) {
  var value = safeValue(callback);
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function frontmostProcessName(systemEvents) {
  try {
    var frontmost = systemEvents.processes.whose({ frontmost: true })();
    if (frontmost.length > 0) return safeString(function() { return frontmost[0].name(); });
  } catch (_) {}
  return "";
}

function fail(code, message, details) {
  var error = new Error(message);
  error.code = code;
  error.details = details || null;
  throw error;
}
`;

function readClipboardText() {
  const result = spawnSync("/usr/bin/pbpaste", [], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, text: "" };
  }
  return { ok: true, text: result.stdout };
}

function writeClipboardText(text) {
  const result = spawnSync("/usr/bin/pbcopy", [], {
    input: text,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`Unable to write ChatGPT prompt to clipboard: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Unable to write ChatGPT prompt to clipboard: ${preview(result.stderr || result.stdout)}`);
  }
}

function runChatGptVisibleKeyboard() {
  const result = spawnSync("/usr/bin/osascript", ["-e", CHATGPT_VISIBLE_KEYBOARD_APPLESCRIPT], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error("CHATGPT_VISIBLE_AUTOMATION_TIMEOUT: Visible ChatGPT keyboard automation timed out before submitting the prompt.");
    }
    throw new Error(`CHATGPT_VISIBLE_AUTOMATION_FAILED: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`CHATGPT_VISIBLE_AUTOMATION_FAILED: ${preview(result.stderr || result.stdout)}`);
  }
  const parsed = readJsonFromString(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "", null);
  if (!parsed) {
    throw new Error(`CHATGPT_VISIBLE_AUTOMATION_FAILED: non-JSON output from osascript: ${preview(result.stdout || result.stderr)}`);
  }
  if (!parsed.ok) {
    throw new Error(`${parsed.code || "CHATGPT_VISIBLE_AUTOMATION_FAILED"}: ${parsed.message || "Visible ChatGPT automation failed."}`);
  }
  return parsed.value;
}

const CHATGPT_VISIBLE_KEYBOARD_APPLESCRIPT = `
on run
  try
    tell application "ChatGPT" to activate
    tell application "System Events"
      set deadline to ((current date) + 15)
      repeat while (current date) is less than deadline
        if exists process "ChatGPT" then
          tell process "ChatGPT"
            set frontmost to true
            if (count of windows) > 0 then exit repeat
          end tell
        end if
        delay 0.2
      end repeat
      if not (exists process "ChatGPT") then error "ChatGPT process not found after launch."
      tell process "ChatGPT"
        if (count of windows) = 0 then error "ChatGPT has no window for visible keyboard automation."
        set frontmost to true
      end tell
      delay 0.5
      keystroke "v" using {command down}
      delay 0.5
      key code 36
      delay 0.5
      tell process "ChatGPT"
        set isFrontmost to frontmost
        set isVisible to visible
        set windowCount to count of windows
      end tell
      return "{\\"ok\\":true,\\"value\\":{\\"frontmost\\":" & isFrontmost & ",\\"visible\\":" & isVisible & ",\\"windows\\":" & windowCount & "}}"
    end tell
  on error errMsg number errNum
    return "{\\"ok\\":false,\\"code\\":\\"CHATGPT_VISIBLE_AUTOMATION_FAILED\\",\\"message\\":\\"Visible ChatGPT automation failed with AppleScript error " & errNum & ".\\"}"
  end try
end run
`;

const CHATGPT_VISIBLE_WINDOW_RECOVERY_APPLESCRIPT = `
on run
  try
    tell application "ChatGPT" to activate
  end try
  delay 0.5
  tell application "System Events"
    if not (exists process "ChatGPT") then return
    tell process "ChatGPT"
      try
        set visible to true
      end try
      try
        set frontmost to true
      end try
      if (count of windows) > 0 then return
    end tell
    try
      tell process "Dock"
        if exists UI element "ChatGPT" of list 1 then click UI element "ChatGPT" of list 1
      end tell
    end try
    delay 0.5
    tell process "ChatGPT"
      if (count of windows) > 0 then return
      try
        click menu item "Show All" of menu "ChatGPT" of menu bar 1
      end try
      delay 0.5
      if (count of windows) > 0 then return
      try
        set chatMenuItems to menu items of menu "Chats" of menu bar 1
        repeat with chatMenuItem in chatMenuItems
          try
            if enabled of chatMenuItem then
              click chatMenuItem
              exit repeat
            end if
          end try
        end repeat
      end try
    end tell
  end tell
end run
`;

function ensureChatGptHiddenWindow() {
  let state = chatGptVisibilityState();
  if (state.exists && state.windows > 0) {
    if (state.visible === false) return state;
    const hidden = hideChatGptAppQuietly();
    if (hidden.ok && hidden.state?.windows > 0 && hidden.state?.visible === false) return hidden.state;
    throw new Error(`ChatGPT did not expose an existing hidden window. Last state: ${JSON.stringify(hidden.state ?? state)}`);
  }
  const create = spawnSync("/usr/bin/open", ["-gj", "-b", "com.openai.chat", "-u", "chatgpt://new-conversation"], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (create.error) throw new Error(`Unable to create hidden ChatGPT window: ${create.error.message}`);
  if (create.status !== 0) {
    throw new Error(`Unable to create hidden ChatGPT window: ${preview(create.stderr || create.stdout)}`);
  }
  const started = Date.now();
  while (Date.now() - started < 12_000) {
    const hidden = hideChatGptAppQuietly();
    state = hidden.state ?? chatGptVisibilityState();
    if (hidden.ok && state.exists && state.windows > 0 && state.visible === false) return state;
    spawnSync("/bin/sleep", ["0.2"]);
  }
  throw new Error(`ChatGPT did not create a hidden window. Last state: ${JSON.stringify(state)}`);
}

function runChatGptHiddenAx(action, payload) {
  const result = spawnSync("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    CHATGPT_HIDDEN_AX_JXA,
    JSON.stringify({ action, payload }),
  ], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error("CHATGPT_HIDDEN_AUTOMATION_TIMEOUT: Hidden ChatGPT accessibility automation timed out before it could find and submit through a hidden composer.");
    }
    throw new Error(`CHATGPT_HIDDEN_AUTOMATION_FAILED: ${result.error.message}`);
  }
  const raw = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  const parsed = readJsonFromString(raw, null);
  if (!parsed) {
    throw new Error(`ChatGPT hidden automation returned non-JSON output: ${preview(result.stdout || result.stderr)}`);
  }
  if (!parsed.ok) {
    throw new Error(`${parsed.code || "CHATGPT_HIDDEN_AUTOMATION_FAILED"}: ${parsed.message || "ChatGPT hidden automation failed."}`);
  }
  return parsed.value;
}

const CHATGPT_HIDDEN_AX_JXA = String.raw`
function run(argv) {
  try {
    var request = JSON.parse(argv[0] || "{}");
    if (request.action !== "sendPrompt") fail("CHATGPT_UNKNOWN_ACTION", "Unknown ChatGPT action: " + request.action);
    return JSON.stringify({ ok: true, value: sendPrompt(String((request.payload || {}).prompt || "")) });
  } catch (error) {
    return JSON.stringify({ ok: false, code: error.code || "CHATGPT_HIDDEN_AUTOMATION_FAILED", message: String(error.message || error) });
  }
}

function sendPrompt(prompt) {
  if (!prompt.trim()) fail("CHATGPT_EMPTY_PROMPT", "Refusing to send an empty ChatGPT prompt.");
  var systemEvents = Application("System Events");
  var proc = systemEvents.processes.byName("ChatGPT");
  if (!proc.exists()) fail("CHATGPT_APP_NOT_RUNNING", "ChatGPT.app is not running.");
  proc.visible = false;
  dismissBlockingAlerts(proc);
  var context = waitForComposer(proc, 12000);
  setValue(context.composer.element, prompt);
  delay(0.3);
  var actual = String(readProperty(context.composer.element, "value") || "");
  if (actual.trim() !== prompt.trim()) {
    fail("CHATGPT_PROMPT_NOT_SET", "Could not set the hidden ChatGPT composer text.");
  }
  var button = findSendButton(context.window, context.composer);
  if (!button) fail("CHATGPT_SEND_BUTTON_NOT_FOUND", "Could not find the hidden ChatGPT send button.");
  press(button.element);
  delay(0.5);
  proc.visible = false;
  return {
    composerRole: context.composer.role,
    sendButton: publicRecord(button),
    state: processState(proc),
  };
}

function waitForComposer(proc, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    var windows = [];
    try { windows = proc.windows(); } catch (_) {}
    for (var i = 0; i < windows.length; i++) {
      var composer = findComposer(windows[i]);
      if (composer) return { window: windows[i], composer: composer };
    }
    delay(0.2);
  }
  fail("CHATGPT_COMPOSER_NOT_FOUND", "Could not find a hidden ChatGPT composer. Visible UI summary: " + debugUiSummary(proc));
}

function dismissBlockingAlerts(proc) {
  var windows = [];
  try { windows = proc.windows(); } catch (_) {}
  for (var i = 0; i < windows.length; i++) {
    var sheets = collectByRole(windows[i], 0, /Sheet|Dialog/i, []);
    for (var j = 0; j < sheets.length; j++) {
      var buttons = collectByRole(sheets[j].element, 0, /Button/i, []);
      for (var k = 0; k < buttons.length; k++) {
        var label = String(buttons[k].label || "");
        if (/(^| )OK( |$)|(^| )Close( |$)|(^| )Dismiss( |$)/i.test(label)) {
          press(buttons[k].element);
          delay(0.2);
          proc.visible = false;
          return;
        }
      }
    }
  }
}

function findComposer(window) {
  var records = collect(window, 0, []);
  for (var i = 0; i < records.length; i++) {
    var record = records[i];
    if (!/TextArea|TextField|TextView/i.test(record.role || "")) continue;
    if (record.enabled === false) continue;
    return record;
  }
  return null;
}

function findSendButton(window, composer) {
  var records = collect(window, 0, []);
  var best = null;
  var bestScore = -Infinity;
  for (var i = 0; i < records.length; i++) {
    var record = records[i];
    if (!/Button/i.test(record.role || "")) continue;
    if (record.enabled === false) continue;
    if (!record.position || !record.size || !composer.position || !composer.size) continue;
    if (/new chat|toggle sidebar|share|move to new window|close|minimize|full screen|model|gpt|5\.5/i.test(record.label || "")) continue;
    var buttonCenterY = pointY(record.position) + sizeHeight(record.size) / 2;
    var composerCenterY = pointY(composer.position) + sizeHeight(composer.size) / 2;
    var score = 0;
    if (pointX(record.position) > pointX(composer.position) + sizeWidth(composer.size) * 0.65) score += 400;
    if (Math.abs(buttonCenterY - composerCenterY) < Math.max(48, sizeHeight(composer.size))) score += 300;
    if (sizeWidth(record.size) >= 20 && sizeWidth(record.size) <= 80 && sizeHeight(record.size) >= 20 && sizeHeight(record.size) <= 80) score += 100;
    score += pointX(record.position) / 1000;
    if (score > bestScore) {
      best = record;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function collect(element, depth, records) {
  if (depth > 10) return records;
  var record = elementRecord(element);
  if (record) records.push(record);
  var children = [];
  try { children = element.uiElements(); } catch (_) {}
  for (var i = 0; i < children.length; i++) collect(children[i], depth + 1, records);
  return records;
}

function collectByRole(element, depth, pattern, records) {
  if (depth > 10) return records;
  var record = elementRecord(element);
  if (record && pattern.test(record.role || "")) records.push(record);
  var children = [];
  try { children = element.uiElements(); } catch (_) {}
  for (var i = 0; i < children.length; i++) collectByRole(children[i], depth + 1, pattern, records);
  return records;
}

function debugUiSummary(proc) {
  var windows = [];
  try { windows = proc.windows(); } catch (_) {}
  var summary = [];
  for (var i = 0; i < windows.length && summary.length < 80; i++) {
    var records = collect(windows[i], 0, []);
    for (var j = 0; j < records.length && summary.length < 80; j++) {
      summary.push({
        role: records[j].role,
        label: String(records[j].label || "").slice(0, 80),
        position: records[j].position,
        size: records[j].size,
        enabled: records[j].enabled,
      });
    }
  }
  return JSON.stringify({ state: processState(proc), summary: summary });
}

function elementRecord(element) {
  var role = String(readProperty(element, "role") || "");
  var name = readProperty(element, "name");
  var description = readProperty(element, "description");
  var value = readProperty(element, "value");
  var position = readProperty(element, "position");
  var size = readProperty(element, "size");
  var enabled = readProperty(element, "enabled");
  var label = [String(description || ""), String(name || ""), String(value || "")].join(" ").replace(/\s+/g, " ").trim();
  return { element: element, role: role, label: label, position: position, size: size, enabled: enabled };
}

function setValue(element, value) {
  try {
    element.value = value;
    return;
  } catch (_) {}
  try {
    element.value.set(value);
    return;
  } catch (_) {}
  fail("CHATGPT_PROMPT_NOT_SET", "Could not set text on the hidden ChatGPT composer.");
}

function press(element) {
  try {
    element.actions.byName("AXPress").perform();
    return;
  } catch (_) {}
  try {
    element.click();
    return;
  } catch (_) {}
  fail("CHATGPT_BUTTON_PRESS_FAILED", "Could not press the hidden ChatGPT send button.");
}

function readProperty(element, propertyName) {
  try {
    var value = element[propertyName];
    if (typeof value === "function") return value.call(element);
    return value;
  } catch (_) {
    return null;
  }
}

function publicRecord(record) {
  return { role: record.role, label: record.label, position: record.position, size: record.size, enabled: record.enabled };
}

function pointX(position) {
  if (!position) return 0;
  if (position.length !== undefined) return Number(position[0]) || 0;
  return Number(position.x) || 0;
}

function pointY(position) {
  if (!position) return 0;
  if (position.length !== undefined) return Number(position[1]) || 0;
  return Number(position.y) || 0;
}

function sizeWidth(size) {
  if (!size) return 0;
  if (size.length !== undefined) return Number(size[0]) || 0;
  return Number(size.width) || 0;
}

function sizeHeight(size) {
  if (!size) return 0;
  if (size.length !== undefined) return Number(size[1]) || 0;
  return Number(size.height) || 0;
}

function processState(proc) {
  var windows = 0;
  try { windows = proc.windows().length; } catch (_) {}
  return { frontmost: proc.frontmost(), visible: proc.visible(), windows: windows };
}

function fail(code, message) {
  var error = new Error(message);
  error.code = code;
  throw error;
}
`;

function readTextFileIfExists(path) {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function hideChatGptApp() {
  const hide = spawnSync("/usr/bin/osascript", [
    "-e",
    'tell application "System Events" to if exists process "ChatGPT" then set visible of process "ChatGPT" to false',
  ], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (hide.error) throw new Error(`Unable to hide ChatGPT after deep link: ${hide.error.message}`);
  if (hide.status !== 0) {
    throw new Error(`Unable to hide ChatGPT after deep link: ${preview(hide.stderr || hide.stdout)}`);
  }
  const state = chatGptVisibilityState();
  if (state.exists && state.visible) {
    throw new Error("ChatGPT remained visible after hidden deep-link delivery.");
  }
  return state;
}

function hideChatGptAppQuietly(attempts = 3) {
  let state = null;
  let reason = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      state = hideChatGptApp();
      return { ok: true, state };
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      state = chatGptVisibilityState();
      spawnSync("/bin/sleep", ["0.2"]);
    }
  }
  return { ok: false, state, reason };
}

function chatGptVisibilityState() {
  const script = [
    'tell application "System Events"',
    '  if exists process "ChatGPT" then',
    '    set isFrontmost to frontmost of process "ChatGPT"',
    '    set isVisible to visible of process "ChatGPT"',
    '    set windowCount to count of windows of process "ChatGPT"',
    '    return "{\\"exists\\":true,\\"frontmost\\":" & isFrontmost & ",\\"visible\\":" & isVisible & ",\\"windows\\":" & windowCount & "}"',
    '  else',
    '    return "{\\"exists\\":false,\\"frontmost\\":null,\\"visible\\":null,\\"windows\\":0}"',
    '  end if',
    'end tell',
  ].join("\n");
  const result = spawnSync("/usr/bin/osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      exists: null,
      frontmost: null,
      visible: null,
      windows: null,
      error: result.error?.message || preview(result.stderr || result.stdout),
    };
  }
  return readJsonFromString(result.stdout.trim(), {
    exists: null,
    frontmost: null,
    visible: null,
    windows: null,
    raw: result.stdout.trim(),
  });
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
  const fetchStatus = await httpStatusWithFetch(url);
  if (fetchStatus !== null) return fetchStatus;
  return httpStatusWithResolvedPublicDns(url);
}

async function httpStatusWithFetch(url) {
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(url, { redirect: "manual", signal: controller.signal });
    return response.status;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function httpStatusWithResolvedPublicDns(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const addresses = await resolvePublicHostname(parsed.hostname);
  const address = addresses[0];
  if (!address) return null;
  const requester = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolveStatus) => {
    const request = requester({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      timeout: 10_000,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      headers: { "user-agent": "node" },
    }, (response) => {
      response.resume();
      resolveStatus(response.statusCode ?? null);
    });
    request.on("timeout", () => {
      request.destroy();
      resolveStatus(null);
    });
    request.on("error", () => resolveStatus(null));
    request.end();
  });
}

function ensureAnyTunnelCommand() {
  if (commandExists("cloudflared") || commandExists("npx")) return;
  throw new Error("Missing required tunnel command: install cloudflared or npx for localtunnel fallback.");
}

async function startPublicTunnel(port) {
  const failures = [];
  if (commandExists("npx")) {
    try {
      return {
        provider: "localtunnel",
        publicBaseUrl: await startLocaltunnel(port, { stable: true }),
      };
    } catch (error) {
      failures.push(`localtunnel stable: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      return {
        provider: "localtunnel",
        publicBaseUrl: await startLocaltunnel(port, { stable: false }),
      };
    } catch (error) {
      failures.push(`localtunnel random: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    failures.push("localtunnel: npx command not found");
  }

  if (commandExists("cloudflared")) {
    try {
      return {
        provider: "cloudflared",
        publicBaseUrl: await startCloudflared(port),
      };
    } catch (error) {
      failures.push(`cloudflared: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    failures.push("cloudflared: command not found");
  }

  throw new Error(`Unable to start a public HTTPS tunnel. ${failures.join(" | ")}`);
}

function startCloudflared(port) {
  writeFileSync(CLOUDFLARED_LOG, "", { mode: 0o600 });
  const pid = startDetached("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], CLOUDFLARED_LOG);
  writeFileSync(join(MANAGER_DIR, "cloudflared.pid"), String(pid), { mode: 0o600 });
  return waitForCloudflaredUrl().catch((error) => {
    killPidGroup(pid, "cloudflared");
    safeRemoveFile(join(MANAGER_DIR, "cloudflared.pid"), "managed cloudflared pid file");
    throw error;
  });
}

function startLocaltunnel(port, { stable }) {
  writeFileSync(LOCALTUNNEL_LOG, "", { mode: 0o600 });
  const args = ["--yes", "localtunnel", "--port", String(port), "--local-host", "127.0.0.1"];
  const expectedSubdomain = stable ? stableLocaltunnelSubdomain() : null;
  if (expectedSubdomain) args.push("--subdomain", expectedSubdomain);
  const pid = startDetached("npx", args, LOCALTUNNEL_LOG);
  writeFileSync(join(MANAGER_DIR, "localtunnel.pid"), String(pid), { mode: 0o600 });
  return waitForLocaltunnelUrl({ expectedSubdomain }).catch((error) => {
    killPidGroup(pid, "localtunnel");
    safeRemoveFile(join(MANAGER_DIR, "localtunnel.pid"), "managed localtunnel pid file");
    throw error;
  });
}

function stableLocaltunnelSubdomain() {
  const seed = `${homedir()}:${process.env.USER ?? ""}:devspace-manager`;
  return `devspace${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;
}

async function waitForCloudflaredUrl() {
  const started = Date.now();
  let seenUrl = null;
  while (Date.now() - started < QUICK_TUNNEL_URL_TIMEOUT_MS) {
    if (existsSync(CLOUDFLARED_LOG)) {
      const log = readFileSync(CLOUDFLARED_LOG, "utf8");
      const match = log.match(URL_RE);
      if (match) {
        seenUrl = normalizePublicBaseUrl(match[0]);
        if (await publicHostnameResolves(seenUrl)) return seenUrl;
      }
      const fatal = cloudflaredFatalMessage(log);
      if (fatal) throw new Error(`Cloudflare tunnel URL failed: ${fatal}. See ${CLOUDFLARED_LOG}`);
      const pid = readCloudflaredPid();
      if (pid && !isAlive(pid) && log.trim()) {
        throw new Error(`Cloudflare tunnel URL failed before publishing a URL. See ${CLOUDFLARED_LOG}`);
      }
    }
    await sleep(500);
  }
  if (seenUrl) {
    throw new Error(`Cloudflare tunnel hostname did not resolve in ${QUICK_TUNNEL_URL_TIMEOUT_MS}ms: ${new URL(seenUrl).hostname}. See ${CLOUDFLARED_LOG}`);
  }
  throw new Error(`Timed out waiting for Cloudflare tunnel URL. See ${CLOUDFLARED_LOG}`);
}

async function waitForLocaltunnelUrl({ expectedSubdomain = null } = {}) {
  const started = Date.now();
  let seenUrl = null;
  while (Date.now() - started < QUICK_TUNNEL_URL_TIMEOUT_MS) {
    if (existsSync(LOCALTUNNEL_LOG)) {
      const log = readFileSync(LOCALTUNNEL_LOG, "utf8");
      const match = log.match(LOCALTUNNEL_URL_RE);
      if (match) {
        seenUrl = normalizePublicBaseUrl(match[0]);
        if (expectedSubdomain && new URL(seenUrl).hostname !== `${expectedSubdomain}.loca.lt`) {
          throw new Error(`Localtunnel did not assign requested stable subdomain ${expectedSubdomain}; got ${new URL(seenUrl).hostname}. See ${LOCALTUNNEL_LOG}`);
        }
        if (await publicHostnameResolves(seenUrl)) return seenUrl;
      }
      const pid = readLocaltunnelPid();
      if (pid && !isAlive(pid) && log.trim()) {
        throw new Error(`Localtunnel URL failed before publishing a URL. See ${LOCALTUNNEL_LOG}`);
      }
    }
    await sleep(500);
  }
  if (seenUrl) {
    throw new Error(`Localtunnel hostname did not resolve in ${QUICK_TUNNEL_URL_TIMEOUT_MS}ms: ${new URL(seenUrl).hostname}. See ${LOCALTUNNEL_LOG}`);
  }
  throw new Error(`Timed out waiting for localtunnel URL. See ${LOCALTUNNEL_LOG}`);
}

async function publicHostnameResolves(baseUrl) {
  return (await resolvePublicHostname(new URL(baseUrl).hostname)).length > 0;
}

async function resolvePublicHostname(hostname) {
  try {
    const systemResult = await lookup(hostname, { all: true, family: 4 });
    const addresses = systemResult.map((entry) => entry.address).filter(Boolean);
    if (addresses.length > 0) return addresses;
  } catch {}
  const resolver = new Resolver();
  resolver.setServers(PUBLIC_DNS_SERVERS);
  try {
    return await resolver.resolve4(hostname);
  } catch {
    return [];
  }
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

function readLocaltunnelPid() {
  const path = join(MANAGER_DIR, "localtunnel.pid");
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isInteger(pid) ? pid : null;
}

function startDetached(command, args, logPath, env = process.env) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `\n--- ${new Date().toISOString()} ${command} ${args.join(" ")} ---\n`, { mode: 0o600 });
  chmodSync(logPath, 0o600);
  const stdoutFd = openForAppend(logPath);
  const stderrFd = openForAppend(logPath);
  let child;
  try {
    child = spawn(command, args, {
      detached: true,
      env,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    child.on("error", () => {});
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error(`Failed to start ${command}; no child pid was returned.`);
  }
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

function readJsonFromString(value, fallback) {
  try {
    return JSON.parse(value);
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
    .map((root) => resolve(expandHomePath(root)));
  if (roots.length === 0) throw new Error("At least one allowed root is required.");
  for (const root of roots) {
    if (!existsSync(root)) throw new Error(`Allowed root does not exist: ${root}`);
    let rootStats;
    try {
      rootStats = statSync(root);
    } catch (error) {
      throw permissionAwareError(error, `Unable to inspect allowed root at ${root}.`);
    }
    if (!rootStats.isDirectory()) throw new Error(`Allowed root is not a directory: ${root}`);
  }
  return roots;
}

function expandHomePath(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function parsePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return port;
}

function normalizePublicBaseUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`--public-base-url must use http:// or https://, got: ${parsed.protocol}`);
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("--public-base-url must use https:// unless it points at localhost or 127.0.0.1.");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost");
}

async function fetchWithTimeout(url, options = {}, label = "HTTP request", timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertPortFree(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error(`Port ${port} is already in use:\n${result.stdout.trim()}`);
  }
}

function ensureCommand(command) {
  if (!commandExists(command)) throw new Error(`Missing required command: ${command}`);
}

function commandExists(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0;
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

async function waitForKilledProcesses(killed) {
  const entries = killed.filter((entry) => !entry.error && Number.isInteger(entry.pid));
  if (entries.length === 0) return;
  if (await waitUntilProcessesExit(entries, 5_000)) return;

  for (const entry of entries) {
    if (!isKillTargetAlive(entry.pid)) continue;
    try {
      process.kill(entry.pid, "SIGKILL");
      entry.escalated = "SIGKILL";
    } catch (error) {
      if (error?.code !== "ESRCH") entry.error = `SIGKILL failed: ${error.message}`;
    }
  }
  await waitUntilProcessesExit(entries.filter((entry) => !entry.error), 2_000);
  for (const entry of entries) {
    if (!entry.error && isKillTargetAlive(entry.pid)) {
      entry.error = "Process did not exit after SIGTERM/SIGKILL.";
    }
  }
}

async function waitUntilProcessesExit(entries, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (entries.every((entry) => !isKillTargetAlive(entry.pid))) return true;
    await sleep(100);
  }
  return entries.every((entry) => !isKillTargetAlive(entry.pid));
}

function isKillTargetAlive(pid) {
  if (!Number.isInteger(pid) || pid === 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    return false;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
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

function sleepSync(ms) {
  spawnSync("/bin/sleep", [String(Math.max(0, ms) / 1000)]);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`DevSpace Manager

Usage:
  node scripts/devspace_manager.mjs start [--roots /path/a,/path/b] [--port 7676]
  node scripts/devspace_manager.mjs harness [--roots /path/a,/path/b] [--port 7676] [--deep] [--write-test]
  node scripts/devspace_manager.mjs debug [--roots /path/a] "debug audit this repo"
  node scripts/devspace_manager.mjs task "deep debug audit this repo" [--roots /path/a] [--allow-edits] [--send chatgpt-app-auto|chatgpt-app-hidden|chatgpt-app-visible|none]
  node scripts/devspace_manager.mjs status
  node scripts/devspace_manager.mjs doctor
  node scripts/devspace_manager.mjs stop

The task command starts and verifies DevSpace, writes a ChatGPT-ready delegated task prompt,
and sends that prompt through DevSpace Manager's built-in ChatGPT app control channel by default.
The default sender is automatic: it tries hidden Accessibility first, then visible Accessibility,
then visible keyboard paste, and hides ChatGPT again after visible submission.
Use --send none only to generate the prompt/result metadata without contacting ChatGPT.
The debug/audit/review/fix/analyze aliases use the same task flow and default to --send chatgpt-app-auto.
Only one start/stop/task/harness command may run at a time.
The Owner password is stored in ~/.devspace/auth.json.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
