#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";

const DEFAULT_PORT = 7676;
const CONFIG_DIR = join(homedir(), ".devspace");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const AUTH_PATH = join(CONFIG_DIR, "auth.json");
const MANAGER_DIR = join(CONFIG_DIR, "manager");
const STATUS_PATH = join(MANAGER_DIR, "status.json");
const CLOUDFLARED_LOG = join(MANAGER_DIR, "cloudflared.log");
const DEVSPACE_LOG = join(MANAGER_DIR, "devspace.log");
const URL_RE = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i;

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
    case "help":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function parseArgs(args) {
  const options = {};
  const command = args.shift() ?? "status";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--roots") {
      options.roots = args[++i];
    } else if (arg === "--port") {
      options.port = Number(args[++i]);
    } else if (arg === "--reuse") {
      options.reuse = true;
    } else if (arg === "--no-tunnel") {
      options.noTunnel = true;
    } else if (arg === "--public-base-url") {
      options.publicBaseUrl = args[++i];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "-h" || arg === "--help") {
      return { command: "help", options };
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { command, options };
}

async function harness(options) {
  const started = await start({ ...options, reuse: true, silent: true });
  const checks = await runChecks(started);
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
  if (options.reuse && existing && isAlive(existing.devspacePid) && isAlive(existing.cloudflaredPid)) {
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
  const checks = status ? await runChecks(status) : [];
  printJson({
    ok: result.status === 0 && checks.every((check) => check.ok),
    devspaceDoctorExitCode: result.status,
    devspaceDoctorStdout: result.stdout.trim(),
    devspaceDoctorStderr: result.stderr.trim(),
    checks,
  });
}

async function runChecks(status) {
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
  return checks;
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
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Cloudflare tunnel URL. See ${CLOUDFLARED_LOG}`);
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
  node scripts/devspace_manager.mjs harness [--roots /path/a,/path/b] [--port 7676]
  node scripts/devspace_manager.mjs status
  node scripts/devspace_manager.mjs doctor
  node scripts/devspace_manager.mjs stop

The Owner password is stored in ~/.devspace/auth.json.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
