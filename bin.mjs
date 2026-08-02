#!/usr/bin/env node
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BRIDGE_VERSION,
  PAIRING_CODE_PATH,
  RUNTIME_HOME,
  readBridgeConfig,
  startBridge,
  writeBridgeConfig,
} from "./bridge.mjs";

const execFileAsync = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));
const SERVICE_LABEL = "com.roam-better-ai.bridge";
export const SERVICE_INSTALL_ROOT = resolve(RUNTIME_HOME, "app");
export const SERVICE_RUNTIME_FILES = Object.freeze([
  "bin.mjs",
  "bridge.mjs",
  "package.json",
  "runtime-agent.md",
  "runtime-work-agent.md",
]);
const PLIST_PATH = resolve(
  homedir(),
  "Library",
  "LaunchAgents",
  `${SERVICE_LABEL}.plist`,
);
const LOG_DIR = resolve(RUNTIME_HOME, "logs");

function say(message = "") {
  process.stdout.write(`${message}\n`);
}

async function which(command) {
  try {
    const { stdout } = await execFileAsync("which", [command]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function launchctl(args) {
  try {
    await execFileAsync("launchctl", args);
    return true;
  } catch {
    return false;
  }
}

export function plistXml({ nodeBin, servicePath, pathValue }) {
  const escape = (value) =>
    String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(nodeBin)}</string>
    <string>${escape(servicePath)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escape(resolve(LOG_DIR, "bridge.log"))}</string>
  <key>StandardErrorPath</key><string>${escape(resolve(LOG_DIR, "bridge.error.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escape(pathValue)}</string>
  </dict>
</dict>
</plist>
`;
}

export function serviceInstallPath({
  runtimeHome = RUNTIME_HOME,
  version = BRIDGE_VERSION,
} = {}) {
  return resolve(runtimeHome, "app", version);
}

export async function installServiceRuntime({
  sourceRoot = ROOT,
  runtimeHome = RUNTIME_HOME,
  version = BRIDGE_VERSION,
} = {}) {
  const installPath = serviceInstallPath({ runtimeHome, version });
  await mkdir(installPath, { recursive: true, mode: 0o700 });
  await chmod(installPath, 0o700);
  for (const filename of SERVICE_RUNTIME_FILES) {
    const destination = resolve(installPath, filename);
    await copyFile(resolve(sourceRoot, filename), destination);
    await chmod(destination, filename === "bin.mjs" ? 0o700 : 0o600);
  }
  return {
    installPath,
    servicePath: resolve(installPath, "bin.mjs"),
  };
}

async function setup() {
  const codexBin = await which("codex");
  if (!codexBin) {
    say("Codex CLI is not installed. Install and sign in first:");
    say();
    say("  npm install -g @openai/codex && codex login");
    say();
    process.exitCode = 1;
    return;
  }
  const nodeBin = process.execPath;

  const config = await readBridgeConfig();
  await writeBridgeConfig({ ...config, codexBin, nodeBin });
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 });

  if (process.platform !== "darwin") {
    say("Background service installation is macOS-only for now.");
    say("Start the bridge in a terminal instead:");
    say();
    say("  npx roam-codex-bridge run");
    say();
    return;
  }

  const { servicePath } = await installServiceRuntime();

  const pathValue = [
    dirname(nodeBin),
    dirname(codexBin),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((entry, index, all) => all.indexOf(entry) === index).join(":");

  await mkdir(dirname(PLIST_PATH), { recursive: true });
  await writeFile(
    PLIST_PATH,
    plistXml({ nodeBin, servicePath, pathValue }),
    "utf8",
  );

  const target = `gui/${process.getuid?.() ?? ""}`;
  await launchctl(["bootout", `${target}/${SERVICE_LABEL}`]);
  const started = await launchctl(["bootstrap", target, PLIST_PATH]);
  if (!started) {
    say("The service could not be started automatically. Run it manually:");
    say();
    say("  npx roam-codex-bridge run");
    say();
    process.exitCode = 1;
    return;
  }

  say("The Codex bridge is installed and running.");
  say("It starts at login and restarts itself if it stops.");
  say();
  say("Next: open Roam, click the Codex icon in the right sidebar, choose");
  say("Pair, and select Allow in the dialog that appears on this computer.");
}

async function status() {
  const config = await readBridgeConfig();
  say(config.graph ? `Paired graph: ${config.graph}` : "Paired graph: none yet");
  if (process.platform === "darwin") {
    const running = await launchctl([
      "print",
      `gui/${process.getuid?.() ?? ""}/${SERVICE_LABEL}`,
    ]);
    say(`Background service: ${running ? "installed" : "not installed"}`);
  }
  try {
    const response = await fetch("http://127.0.0.1:47321/health");
    const health = await response.json();
    say(`Bridge: responding (version ${health.version})`);
  } catch {
    say("Bridge: not responding on 127.0.0.1:47321");
  }
  say(`Logs: ${LOG_DIR}`);
}

async function showCode() {
  try {
    const code = (await readFile(PAIRING_CODE_PATH, "utf8")).trim();
    say(code);
  } catch {
    say("No pairing code is waiting. Click Pair in the Roam panel first.");
    process.exitCode = 1;
  }
}

async function stop() {
  if (process.platform !== "darwin") {
    say("Stop the foreground bridge with Ctrl-C.");
    return;
  }
  const stopped = await launchctl([
    "bootout",
    `gui/${process.getuid?.() ?? ""}/${SERVICE_LABEL}`,
  ]);
  say(stopped ? "Bridge stopped." : "Bridge was not running.");
}

async function uninstall() {
  await stop();
  await rm(PLIST_PATH, { force: true });
  await rm(SERVICE_INSTALL_ROOT, { recursive: true, force: true });
  say("Background service removed.");
  say(`Configuration and logs remain in ${RUNTIME_HOME}.`);
}

const commands = {
  setup,
  run: async () => {
    await startBridge();
  },
  status,
  code: showCode,
  stop,
  uninstall,
  help: async () => {
    say("Usage: roam-codex-bridge [command]");
    say();
    say("  setup      install and start the background bridge (default)");
    say("  run        run the bridge in this terminal");
    say("  status     show pairing, service, and health state");
    say("  code       print the pending pairing code");
    say("  stop       stop the background bridge");
    say("  uninstall  remove the background service");
  },
};

export async function runCli(command = process.argv[2] || "setup") {
  const handler = commands[command];
  if (!handler) {
    say(`Unknown command: ${command}`);
    await commands.help();
    process.exitCode = 1;
    return;
  }
  await handler();
}

async function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(
      fileURLToPath(import.meta.url),
    );
  } catch {
    return false;
  }
}

if (await isDirectInvocation()) {
  await runCli();
}
