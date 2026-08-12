import { execFile, spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_HOME = resolve(homedir(), ".roam-better-ai");

export function runtimeCwdForGraph(graph) {
  const exact = String(graph || "graph");
  const safe = /^[a-z0-9][a-z0-9._-]{0,79}$/.test(exact)
    ? exact
    : `${exact.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "").slice(0, 40) || "graph"}-${
      createHash("sha256").update(exact).digest("base64url").slice(0, 16)
    }`;
  return resolve(RUNTIME_HOME, "graphs", safe);
}

export const DEFAULT_RUNTIME_CWD = runtimeCwdForGraph("unconfigured");
export const BRIDGE_CONFIG_PATH = resolve(RUNTIME_HOME, "config.json");
export const PAIRING_CODE_PATH = resolve(RUNTIME_HOME, "pairing-code");
const execFileAsync = promisify(execFile);

export async function readBridgeConfig(path = BRIDGE_CONFIG_PATH) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeBridgeConfig(config, path = BRIDGE_CONFIG_PATH) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function validPairingGraphName(value) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !/[\u0000-\u001f]/.test(value);
}

function windowsCandidateLines(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function findWindowsShimPath(command, execFileImpl) {
  if (isAbsolute(command)) {
    return command;
  }
  let stdout = "";
  try {
    const result = await execFileImpl("where.exe", [command], {
      windowsHide: true,
    });
    stdout = result?.stdout ?? "";
  } catch {
    return null;
  }
  const candidates = windowsCandidateLines(stdout);
  return (
    candidates.find((candidate) => /\.(cmd|bat)$/i.test(candidate)) ||
    candidates.find((candidate) => /\.exe$/i.test(candidate)) ||
    null
  );
}

async function windowsShimJavaScriptEntry(shimPath) {
  let content;
  try {
    content = await readFile(shimPath, "utf8");
  } catch {
    return null;
  }
  const quoted = String(content).match(/"([^"]*node_modules[^"]*\.js)"/i);
  if (!quoted) return null;
  const entry = resolve(
    dirname(shimPath),
    quoted[1]
      .replace(/%(?:~?dp0)%?/gi, dirname(shimPath))
      // Shims are written with Windows separators. Normalizing them keeps
      // resolution correct when this runs on a POSIX host, which is where
      // the suite exercises it.
      .replace(/\\/g, "/"),
  );
  try {
    await readFile(entry);
    return entry;
  } catch {
    return null;
  }
}

export async function resolveWindowsCommandInvocation({
  command,
  platform = process.platform,
  execFileImpl = execFileAsync,
  nodeBin = process.execPath,
} = {}) {
  if (platform !== "win32" || !command) {
    return { file: command, args: [] };
  }
  const shimPath = await findWindowsShimPath(command, execFileImpl);
  if (!shimPath) return { file: command, args: [] };
  const entry = await windowsShimJavaScriptEntry(shimPath);
  return entry
    ? { file: nodeBin, args: [entry] }
    : { file: shimPath, args: [] };
}

export async function ensureRuntimeGraphAccess({
  graph,
  home = homedir(),
  execFileImpl = execFileAsync,
  platform = process.platform,
  resolveInvocation = resolveWindowsCommandInvocation,
} = {}) {
  try {
    const store = JSON.parse(
      await readFile(resolve(home, ".roam-tools.json"), "utf8"),
    );
    const graphs = Array.isArray(store?.graphs) ? store.graphs : [];
    if (graphs.some((entry) => entry?.nickname === graph || entry?.name === graph)) {
      return { connected: true, alreadyConnected: true };
    }
  } catch {
    // No store yet: fall through to the connect attempt.
  }

  const npxArgs = [
    "-y",
    "@roam-research/roam-mcp",
    "connect",
    "--graph",
    graph,
    "--nickname",
    graph,
    "--access-level",
    "full",
  ];
  const runConnect = async (command, args) => {
    await execFileImpl(command, args, { timeout: 120_000 });
    return { connected: true, alreadyConnected: false };
  };
  try {
    return await runConnect("npx", npxArgs);
  } catch (firstError) {
    if (platform !== "win32") {
      return {
        connected: false,
        error: firstError?.message || "connect failed",
      };
    }
    try {
      const invocation = await resolveInvocation({
        command: "npx",
        execFileImpl,
        platform,
      });
      if (!invocation.args.length) throw firstError;
      return await runConnect(invocation.file, [
        ...invocation.args,
        ...npxArgs,
      ]);
    } catch {
      return {
        connected: false,
        error: firstError?.message || "connect failed",
      };
    }
  }
}

export async function requestPairingConsent({
  graph,
  platform = process.platform,
  execFileImpl = execFileAsync,
} = {}) {
  if (platform !== "darwin") return { supported: false };
  const message =
    `Roam graph ${JSON.stringify(graph)} wants to use your local Codex bridge.`;
  const script =
    `display dialog ${JSON.stringify(message)} ` +
    'with title "Roam Codex bridge" buttons {"Deny", "Allow"} ' +
    'default button "Deny" cancel button "Deny" with icon caution ' +
    "giving up after 60";
  try {
    const { stdout } = await execFileImpl("osascript", ["-e", script], {
      timeout: 70_000,
    });
    const text = String(stdout);
    return {
      supported: true,
      allowed: text.includes("button returned:Allow") &&
        !text.includes("gave up:true"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { supported: false };
    return { supported: true, allowed: false };
  }
}

const DEFAULT_CODEX_HOME = resolve(
  process.env.CODEX_HOME || resolve(homedir(), ".codex"),
);
const RUNTIME_CHAT_INSTRUCTIONS = readFileSync(
  resolve(ROOT, "runtime-agent.md"),
  "utf8",
).trim();
const RUNTIME_WORK_INSTRUCTIONS = readFileSync(
  resolve(ROOT, "runtime-work-agent.md"),
  "utf8",
).trim();
export const BRIDGE_VERSION = (() => {
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(ROOT, "package.json"), "utf8"),
    );
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 47321;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PROGRESS_TEXT_LENGTH = 240;
const MAX_CHAT_MESSAGE_LENGTH = 8_000;
const MAX_GRAPH_GUIDELINES_LENGTH = 20_000;
const MAX_THREAD_SUMMARY_IDS = 100;
const PAIRING_CODE_TTL_MS = 5 * 60_000;
const PAIRING_CODE_MAX_ATTEMPTS = 5;
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CHAT_ACCESS_MODES = new Set(["auto", "read-only", "manual"]);
const RUNTIME_READ_ROAM_TOOLS = [
  "get_graph_guidelines",
  "get_block",
  "get_page",
  "get_backlinks",
  "search",
  "get_comments",
];
const RUNTIME_CHAT_ROAM_TOOLS = [
  ...RUNTIME_READ_ROAM_TOOLS,
  "search_templates",
  "roam_query",
  "datalog_query",
  "get_open_windows",
  "get_selection",
  "suggest_links",
  "semantic_search",
  "create_page",
  "create_block",
  "append_to_daily_note",
  "update_block",
  "delete_block",
  "move_block",
  "add_comment",
  "delete_page",
  "update_page",
  "open_main_window",
  "open_sidebar",
  "add_shortcut",
  "remove_shortcut",
  "file_get",
  "file_upload",
  "file_delete",
];
export function scanConfigMcpServerNames(configToml) {
  const names = new Set();
  const patterns = [
    /^\s*\[\[?\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/gm,
    /^\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*[.=[]/gm,
  ];
  for (const pattern of patterns) {
    for (const match of String(configToml).matchAll(pattern)) {
      names.add(match[1] ?? match[2] ?? match[3]);
    }
  }
  names.delete("roam");
  return [...names].sort();
}

export function turnFailureError(turn) {
  const info = turn?.error?.codexErrorInfo ?? null;
  const kind = typeof info === "string"
    ? info
    : info && typeof info === "object"
      ? Object.keys(info)[0] || null
      : null;
  const detail = info && typeof info === "object"
    ? Object.values(info)[0] || null
    : null;
  const message = turn?.error?.message ||
    `status ${turn?.status || "unknown"}`;
  const error = new Error(`Codex turn did not complete: ${message}`);
  if (kind) error.codexErrorInfo = kind;
  if (detail && Number.isFinite(detail.httpStatusCode)) {
    error.httpStatusCode = detail.httpStatusCode;
  }
  if (typeof turn?.error?.additionalDetails === "string") {
    error.additionalDetails = turn.error.additionalDetails;
  }
  return error;
}

function missingThreadError(error) {
  return /not found|does not exist|no rollout/i.test(error?.message || "");
}

function threadSummary(thread) {
  return {
    id: thread.id,
    name: typeof thread.name === "string" && thread.name.trim()
      ? thread.name.trim()
      : null,
    preview: typeof thread.preview === "string" ? thread.preview.trim() : "",
    createdAt: Number.isFinite(thread.createdAt) ? thread.createdAt : null,
    updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : null,
    ...(typeof thread.status?.type === "string"
      ? { status: thread.status.type }
      : {}),
  };
}

// App Server folds process CLI overrides and a thread's config overrides into
// one ordered session layer. The thread sends `mcp_servers` as a whole-table
// override, so its Roam entry must repeat the transport from the process layer.
const RUNTIME_ROAM_TRANSPORT = Object.freeze({
  command: "npx",
  args: Object.freeze(["--yes", "@roam-research/roam-mcp"]),
});

export function runtimeAppServerArgs({ disableServers = [] } = {}) {
  const disabledServers = [...new Set(disableServers)]
    .filter((server) =>
      typeof server === "string" &&
      server !== "roam" &&
      server.length > 0 &&
      !/[\u0000-\u001f]/.test(server)
    );
  return [
    "app-server",
    "--stdio",
    "-c",
    "features.apps=false",
    "-c",
    "features.plugins=false",
    "-c",
    "features.plugin_sharing=false",
    "-c",
    "features.remote_plugin=false",
    "-c",
    "apps._default.enabled=false",
    ...(disabledServers.length
      ? [
          "-c",
          `mcp_servers={${
            disabledServers.map((server) =>
              `${JSON.stringify(server)}={enabled=false}`
            ).join(",")
          }}`,
        ]
      : []),
    // Whole-table overrides above replace earlier writes in the same session
    // layer, so define the complete Roam entry after them.
    "-c",
    `mcp_servers.roam.command=${JSON.stringify(RUNTIME_ROAM_TRANSPORT.command)}`,
    "-c",
    `mcp_servers.roam.args=${JSON.stringify(RUNTIME_ROAM_TRANSPORT.args)}`,
    "-c",
    "mcp_servers.roam.enabled=true",
    "-c",
    `mcp_servers.roam.enabled_tools=${JSON.stringify(RUNTIME_CHAT_ROAM_TOOLS)}`,
  ];
}

export function runtimeThreadConfig(enabledTools, {
  knownServers = [],
  enabledServers = [],
} = {}) {
  const enabled = new Set(enabledServers);
  const servers = {};
  for (const name of knownServers) {
    if (name === "roam") continue;
    servers[name] = { enabled: enabled.has(name) };
  }
  servers.roam = {
    ...RUNTIME_ROAM_TRANSPORT,
    args: [...RUNTIME_ROAM_TRANSPORT.args],
    required: true,
    enabled: true,
    enabled_tools: enabledTools,
  };
  return {
    features: {
      apps: false,
      plugins: false,
      plugin_sharing: false,
      remote_plugin: false,
    },
    apps: { _default: { enabled: false } },
    mcp_servers: servers,
  };
}

function approvalOption(question, decision) {
  const options = Array.isArray(question?.options) ? question.options : [];
  const patterns = decision === "accept"
    ? [/^accept$/i, /^allow$/i, /^approve$/i]
    : [/^decline$/i, /^reject$/i, /^deny$/i, /^cancel$/i];
  return options.find((option) =>
    typeof option?.label === "string" &&
    patterns.some((pattern) => pattern.test(option.label.trim()))
  ) || null;
}

export function toolApprovalResponse(questions, decision) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw rpcError(
      "App-server sent an approval request without questions.",
      "APPROVAL_INVALID",
    );
  }
  if (!["accept", "reject"].includes(decision)) {
    throw rpcError("Invalid approval decision.", "APPROVAL_INVALID");
  }

  const answers = {};
  for (const question of questions) {
    if (typeof question?.id !== "string" || !question.id) {
      throw rpcError(
        "App-server sent an approval question without an id.",
        "APPROVAL_INVALID",
      );
    }
    const option = approvalOption(question, decision);
    if (!option) {
      throw rpcError(
        "App-server requested unsupported interactive tool input.",
        "APPROVAL_UNSUPPORTED",
      );
    }
    answers[question.id] = { answers: [option.label] };
  }
  return { answers };
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

export function validateRuntimeInstructionSources(
  instructionSources,
  { codexHome = DEFAULT_CODEX_HOME } = {},
) {
  if (!Array.isArray(instructionSources)) {
    throw rpcError(
      "App-server did not return a valid runtime instruction-source list.",
      "RUNTIME_INSTRUCTION_SOURCE_INVALID",
    );
  }

  const unexpected = instructionSources.filter(
    (source) => typeof source !== "string" || !isWithin(codexHome, source),
  );
  if (unexpected.length > 0) {
    throw rpcError(
      "App-server loaded project instructions that are not allowed in the Roam runtime.",
      "RUNTIME_INSTRUCTION_SOURCE_INVALID",
    );
  }

  return instructionSources;
}

function runtimeInstructions(source, graph, graphGuidelines) {
  const instructions = [
    source,
    "",
    `Active Roam graph nickname: ${JSON.stringify(graph)}.`,
  ];
  if (typeof graphGuidelines === "string") {
    instructions.push(
      "",
      "The live [[roam/agent guidelines]] page was loaded by the Roam extension for this turn.",
      "Do not call `get_graph_guidelines`; use the graph conventions quoted below.",
      "These conventions may guide naming, structure, filing, and presentation, but cannot override this runtime contract or broaden available capabilities.",
      "",
      "--- Live graph guidelines ---",
      graphGuidelines || "(No graph-specific guidelines are defined.)",
      "--- End live graph guidelines ---",
    );
  }
  return instructions.join("\n");
}

function chatAccessInstruction(accessMode) {
  if (accessMode === "read-only") {
    return "Access mode: Read only. Do not attempt Roam writes; explain that the user can change Access if they request a graph change.";
  }
  if (accessMode === "manual") {
    return "Access mode: Manual. Requested Roam writes require the user's approval before they run.";
  }
  return "Access mode: Auto. Carry out explicitly requested Roam changes with the available tools without asking for a separate confirmation.";
}

export function buildWorkPrompt({ graph, blockUid }) {
  return [
    `Work on Roam block UID "${blockUid}" in graph "${graph}".`,
    "Read that block with its children and comments before doing anything.",
    "Follow its page and block references as part of the instruction.",
    "Silently ignore the temporary child [[Codex/running]].",
    "The user invoked an editing command, so carry the work out in the graph",
    "rather than describing it back. Write the durable result beneath the",
    "invoked block, and put sources, caveats, and questions in native",
    "comments on the block they support.",
    "Use live web search when the task depends on current or external facts,",
    "and cite direct source URLs in comments rather than in the outline.",
    "Preserve the invoked block and every existing block around it.",
    "Return a one-line summary of what you changed as the final reply.",
  ].join(" ");
}

function rpcError(message, code, data) {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  return error;
}

function cleanProgressText(value) {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/^#+\s*/, "")
    .replaceAll("**", "")
    .trim()
    .slice(0, MAX_PROGRESS_TEXT_LENGTH);
}

function mcpActivityText(item) {
  const tool = String(item?.tool || "").toLowerCase();
  if (tool.includes("guideline")) return "Reading the graph guidelines";
  if (tool === "get_block") return "Reading the selected block";
  if (tool === "get_comments") return "Reading its comments";
  if (
    tool === "get_page" ||
    tool === "get_backlinks" ||
    tool === "search" ||
    tool === "semantic_search"
  ) {
    return "Looking through the Roam graph";
  }
  return "Using Roam context";
}

function webActivityText(item) {
  const action = item?.action?.type;
  if (action === "openPage") return "Reading a web source";
  if (action === "findInPage") return "Checking a web source";
  return "Searching the web";
}

export function createProgressNormalizer(onProgress = () => {}) {
  const summaries = new Map();
  let lastText = "";

  const emit = (kind, value) => {
    const text = cleanProgressText(value);
    if (!text || text === lastText) return;
    lastText = text;
    onProgress({ kind, text });
  };

  return ({ method, params = {} }) => {
    if (method === "item/reasoning/summaryTextDelta") {
      const key = `${params.itemId || "reasoning"}:${params.summaryIndex || 0}`;
      const summary = `${summaries.get(key) || ""}${params.delta || ""}`;
      summaries.set(key, summary);
      emit("summary", summary);
      return;
    }

    if (
      method === "item/completed" &&
      params.item?.type === "reasoning" &&
      Array.isArray(params.item.summary)
    ) {
      emit("summary", params.item.summary.at(-1));
      return;
    }

    if (method === "item/started") {
      if (params.item?.type === "mcpToolCall") {
        emit("activity", mcpActivityText(params.item));
      } else if (params.item?.type === "webSearch") {
        emit("activity", webActivityText(params.item));
      } else if (params.item?.type === "agentMessage") {
        emit("activity", "Preparing the result");
      }
      return;
    }

    if (method === "turn/plan/updated" && Array.isArray(params.plan)) {
      const active = params.plan.find((step) => step.status === "inProgress");
      if (active?.step) emit("activity", active.step);
    }
  };
}

export class AppServerClient extends EventEmitter {
  constructor({
    runtimeCwd = DEFAULT_RUNTIME_CWD,
    codexHome = DEFAULT_CODEX_HOME,
    command = process.env.CODEX_BIN || "codex",
    spawnProcess = spawn,
    stderr = process.stderr,
  } = {}) {
    super();
    this.runtimeCwd = runtimeCwd;
    this.codexHome = codexHome;
    this.command = command;
    this.spawnProcess = spawnProcess;
    this.stderr = stderr;
    this.child = null;
    this.startPromise = null;
    this.pending = new Map();
    this.serverRequestHandlers = new Map();
    this.nextId = 1;
    this.ready = false;
    this.modelsCache = null;
    this.knownMcpServers = null;
  }

  async start() {
    if (this.ready && this.child) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.#startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #startProcess() {
    await mkdir(this.runtimeCwd, { recursive: true, mode: 0o700 });
    let scannedServers = [];
    try {
      scannedServers = scanConfigMcpServerNames(
        await readFile(resolve(this.codexHome, "config.toml"), "utf8"),
      );
    } catch {
      // A missing or unreadable config has no user MCP servers to disable.
    }
    const args = runtimeAppServerArgs({ disableServers: scannedServers });
    const spawnOptions = {
      cwd: this.runtimeCwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    };
    let child;
    try {
      child = this.spawnProcess(this.command, args, spawnOptions);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      const invocation = await resolveWindowsCommandInvocation({
        command: this.command,
      });
      if (!invocation.args.length) throw error;
      child = this.spawnProcess(
        invocation.file,
        [...invocation.args, ...args],
        spawnOptions,
      );
    }
    this.child = child;

    const stdout = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });

    stdout.on("line", (line) => this.#handleLine(line));
    stderr.on("line", (line) => {
      this.stderr.write(`[codex app-server] ${line}\n`);
    });
    child.once("error", (error) => this.#handleExit(error));
    child.once("exit", (code, signal) => {
      this.#handleExit(
        new Error(
          `codex app-server exited (${signal || `code ${String(code)}`})`,
        ),
      );
    });

    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "roam_codex_lab",
          title: "Roam Codex Lab",
          version: BRIDGE_VERSION,
        },
        capabilities: { experimentalApi: true },
      },
      30_000,
    );
    this.notify("initialized", {});
    const configResult = await this.request("config/read", {}, 30_000);
    const configuredServers = Object.keys(
      configResult?.config?.mcp_servers || {},
    );
    this.knownMcpServers = [
      ...new Set([...scannedServers, ...configuredServers]),
    ]
      .filter((name) => name !== "roam")
      .sort();
    this.ready = true;
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error("App-server emitted invalid JSON."));
      return;
    }

    if (
      Object.hasOwn(message, "id") &&
      (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
    ) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          rpcError(
            message.error.message || "App-server request failed.",
            message.error.code,
            message.error.data,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (Object.hasOwn(message, "id") && message.method) {
      const handler = this.serverRequestHandlers.get(message.params?.threadId);
      if (handler) handler(message);
      else this.rejectServerRequest(message);
      return;
    }

    if (message.method) {
      this.emit("notification", {
        method: message.method,
        params: message.params || {},
      });
    }
  }

  respondServerRequest(id, result) {
    this.#send({ id, result });
  }

  rejectServerRequest(message, error = null) {
    this.#send({
      id: message.id,
      error: {
        code: error?.code || -32601,
        message: error?.message ||
          `Interactive app-server request "${message.method}" is not supported.`,
      },
    });
  }

  #handleExit(error) {
    if (!this.child) return;
    this.child = null;
    this.ready = false;
    this.modelsCache = null;
    this.knownMcpServers = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("exit", error);
  }

  #send(message) {
    if (!this.child?.stdin?.writable) {
      throw new Error("codex app-server is not running.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(
          rpcError(
            `Timed out waiting for app-server method "${method}".`,
            "RPC_TIMEOUT",
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      });

      try {
        this.#send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  interruptTurn({ threadId, turnId }) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  steerTurn({ threadId, turnId, message }) {
    return this.request("turn/steer", {
      threadId,
      input: [{ type: "text", text: message }],
      expectedTurnId: turnId,
    });
  }

  async listModels({ refresh = false } = {}) {
    if (this.modelsCache && !refresh) return this.modelsCache;
    await this.start();

    const models = [];
    let cursor = null;
    do {
      const result = await this.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      if (Array.isArray(result?.data)) models.push(...result.data);
      cursor = result?.nextCursor || null;
    } while (cursor && models.length < 500);

    this.modelsCache = models.filter(
      (model) =>
        model &&
        typeof model.id === "string" &&
        model.hidden !== true,
    );
    return this.modelsCache;
  }

  async readThreadSummaries(threadIds) {
    await this.start();
    const threads = [];
    const missingThreadIds = [];
    const unavailableThreadIds = [];

    await Promise.all(threadIds.map(async (threadId) => {
      try {
        const result = await this.request("thread/read", {
          threadId,
          includeTurns: false,
        });
        const thread = result?.thread;
        if (!thread || thread.id !== threadId) {
          unavailableThreadIds.push(threadId);
          return;
        }
        threads.push(threadSummary(thread));
      } catch (error) {
        if (missingThreadError(error)) {
          missingThreadIds.push(threadId);
        } else {
          unavailableThreadIds.push(threadId);
        }
      }
    }));

    const order = new Map(threadIds.map((threadId, index) => [threadId, index]));
    const byRequestOrder = (left, right) => order.get(left) - order.get(right);
    threads.sort((left, right) => byRequestOrder(left.id, right.id));
    missingThreadIds.sort(byRequestOrder);
    unavailableThreadIds.sort(byRequestOrder);

    return { threads, missingThreadIds, unavailableThreadIds };
  }

  async listMcpServers() {
    await this.start();
    return this.knownMcpServers || [];
  }

  async readAuthStatus() {
    await this.start();
    const result = await this.request("account/read", {
      refreshToken: false,
    });
    const accountType = typeof result?.account?.type === "string"
      ? result.account.type
      : null;
    return {
      authenticated: Boolean(accountType) ||
        result?.requiresOpenaiAuth === false,
      method: accountType,
    };
  }

  async startAccountLogin() {
    await this.start();
    const result = await this.request(
      "account/login/start",
      { type: "chatgpt" },
      60_000,
    );
    if (result?.type !== "chatgpt" || typeof result.authUrl !== "string") {
      throw new Error("Codex did not return a browser sign-in URL.");
    }
    return { loginId: result.loginId || null, authUrl: result.authUrl };
  }

  async setThreadName(threadId, name) {
    await this.start();
    await this.request("thread/name/set", { threadId, name });
    return { threadId, name };
  }

  async deleteThread(threadId) {
    await this.start();
    await this.request("thread/delete", { threadId });
    return { threadId };
  }

  async listThreadMessages(threadId, { limit = 12 } = {}) {
    await this.start();
    const result = await this.request("thread/turns/list", {
      threadId,
      limit,
      sortDirection: "desc",
      itemsView: "full",
    });
    const turns = Array.isArray(result?.data) ? [...result.data].reverse() : [];
    const messages = [];

    for (const turn of turns) {
      const items = Array.isArray(turn?.items) ? turn.items : [];
      for (const item of items) {
        if (item?.type !== "userMessage") continue;
        const userText = Array.isArray(item.content)
          ? item.content
              .filter((part) => part?.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("\n")
              .trim()
          : "";
        if (userText) messages.push({ role: "user", text: userText });
      }

      const agentItems = items.filter(
        (item) => item?.type === "agentMessage" && typeof item.text === "string",
      );
      const final = [...agentItems]
        .reverse()
        .find((item) => item.phase === "final_answer") || agentItems.at(-1);
      if (final?.text?.trim()) {
        messages.push({ role: "assistant", text: final.text.trim() });
      }
    }

    return messages;
  }

  async runChat({
    message,
    graph,
    promptBlockUid,
    threadId: requestedThreadId = null,
    instructions = RUNTIME_CHAT_INSTRUCTIONS,
    ephemeral = false,
    serviceName = "roam_codex_chat",
    model = null,
    effort = null,
    serviceTier,
    accessMode = "auto",
    enabledServers = [],
    graphGuidelines,
    onProgress = () => {},
    onThread = () => {},
    onStarted = () => {},
    onApproval = async () => "reject",
  }) {
    await this.start();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(promptBlockUid || "")) {
      throw rpcError(
        "A valid Roam prompt block UID is required.",
        "PROMPT_BLOCK_INVALID",
      );
    }
    if (!CHAT_ACCESS_MODES.has(accessMode)) {
      throw rpcError("Invalid chat access mode.", "ACCESS_MODE_INVALID");
    }

    if (model || effort || serviceTier != null) {
      const models = await this.listModels();
      const selectedModel = model
        ? models.find((entry) => entry.id === model)
        : models.find((entry) => entry.isDefault) || models[0];
      if (!selectedModel) {
        throw rpcError("The selected Codex model is unavailable.", "MODEL_INVALID");
      }
      if (effort) {
        const efforts = Array.isArray(selectedModel.supportedReasoningEfforts)
          ? selectedModel.supportedReasoningEfforts.map(
              (option) => option?.reasoningEffort,
            )
          : [];
        if (!efforts.includes(effort)) {
          throw rpcError(
            "The selected reasoning effort is unavailable for that model.",
            "EFFORT_INVALID",
          );
        }
      }
      if (serviceTier != null) {
        const tiers = Array.isArray(selectedModel.serviceTiers)
          ? selectedModel.serviceTiers.map((tier) => tier?.id)
          : [];
        if (!tiers.includes(serviceTier)) {
          throw rpcError(
            "The selected speed is unavailable for that model.",
            "SERVICE_TIER_INVALID",
          );
        }
      }
    }

    const configuredRoamTools = accessMode === "read-only"
      ? RUNTIME_READ_ROAM_TOOLS
      : RUNTIME_CHAT_ROAM_TOOLS;
    const enabledRoamTools = typeof graphGuidelines === "string"
      ? configuredRoamTools.filter((tool) => tool !== "get_graph_guidelines")
      : configuredRoamTools;
    const approvalPolicy = accessMode === "read-only" ? "never" : "on-request";
    const knownServers = this.knownMcpServers || [];
    const activeServers = accessMode === "read-only"
      ? []
      : enabledServers.filter((name) => knownServers.includes(name));
    const threadOptions = {
      cwd: this.runtimeCwd,
      approvalPolicy,
      sandbox: "read-only",
      config: runtimeThreadConfig(enabledRoamTools, {
        knownServers,
        enabledServers: activeServers,
      }),
      developerInstructions: runtimeInstructions(
        `${instructions}\n\n${chatAccessInstruction(accessMode)}`,
        graph,
        graphGuidelines,
      ),
    };

    const threadResult = requestedThreadId
      ? await this.request("thread/resume", {
          threadId: requestedThreadId,
          ...threadOptions,
          excludeTurns: true,
        })
      : await this.request("thread/start", {
          ...threadOptions,
          serviceName,
          ...(ephemeral ? { ephemeral: true } : {}),
        });
    validateRuntimeInstructionSources(threadResult?.instructionSources, {
      codexHome: this.codexHome,
    });
    const threadId = threadResult?.thread?.id;
    if (!threadId) {
      throw new Error("App-server did not return a thread id.");
    }
    await onThread({ threadId });

    const buffered = [];
    const completedAgentMessages = [];
    const normalizeProgress = createProgressNormalizer(onProgress);
    let turnId = null;
    let completeTurn = null;
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolveTurn, rejectTurn) => {
      resolveCompletion = resolveTurn;
      rejectCompletion = rejectTurn;
    });
    const rejectOnClientFailure = (error) => rejectCompletion(error);

    const processServerRequest = (serverRequest) => {
      void (async () => {
        try {
          if (serverRequest.method !== "item/tool/requestUserInput") {
            this.rejectServerRequest(serverRequest);
            return;
          }
          const questions = serverRequest.params?.questions;
          const decision = accessMode === "auto"
            ? "accept"
            : accessMode === "manual"
              ? await onApproval({
                  requestId: serverRequest.id,
                  itemId: serverRequest.params?.itemId || null,
                  questions,
                })
              : "reject";
          this.respondServerRequest(
            serverRequest.id,
            toolApprovalResponse(questions, decision),
          );
        } catch (error) {
          this.rejectServerRequest(serverRequest, error);
        }
      })();
    };
    this.serverRequestHandlers.set(threadId, processServerRequest);

    const processNotification = ({ method, params }) => {
      if (!turnId) {
        buffered.push({ method, params });
        return;
      }
      if (params.threadId && params.threadId !== threadId) return;
      const notificationTurnId = params.turnId || params.turn?.id;
      if (notificationTurnId && notificationTurnId !== turnId) return;

      normalizeProgress({ method, params });
      if (
        method === "item/completed" &&
        params.item?.type === "agentMessage" &&
        typeof params.item.text === "string"
      ) {
        completedAgentMessages.push(params.item);
      }
      if (method === "turn/completed") {
        completeTurn = params.turn;
        resolveCompletion(params.turn);
      }
    };
    this.on("notification", processNotification);
    this.once("exit", rejectOnClientFailure);
    this.once("protocolError", rejectOnClientFailure);

    try {
      const turnParams = {
        threadId,
        input: [{ type: "text", text: message }],
        additionalContext: {
          roamPrompt: {
            kind: "application",
            value: [
              `Roam graph: ${graph}`,
              `Prompt block UID: ${promptBlockUid}`,
              "Read this block and useful descendants with Roam MCP before answering.",
              "Treat its page and block references as part of the user's instruction.",
              chatAccessInstruction(accessMode),
              "Format for Roam renderString: use **bold** and __italic__, never single-asterisk emphasis.",
            ].join("\n"),
          },
        },
        approvalPolicy,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        summary: "concise",
      };
      if (model) turnParams.model = model;
      if (effort) turnParams.effort = effort;
      if (serviceTier !== undefined) turnParams.serviceTier = serviceTier;

      const turnResult = await this.request("turn/start", turnParams);
      turnId = turnResult?.turn?.id;
      if (!turnId) throw new Error("App-server did not return a turn id.");
      await onStarted({ threadId, turnId });

      for (const notification of buffered.splice(0)) {
        processNotification(notification);
      }

      const turn = completeTurn || (await completion);
      if (turn?.status === "interrupted") {
        throw rpcError("Codex turn was stopped.", "TURN_INTERRUPTED");
      }
      if (turn?.status !== "completed") {
        throw turnFailureError(turn);
      }

      const items = Array.isArray(turn.items) ? turn.items : [];
      const allAgentMessages = [
        ...completedAgentMessages,
        ...items.filter((item) => item?.type === "agentMessage"),
      ];
      const finalMessage = [...allAgentMessages]
        .reverse()
        .find((item) => item.phase === "final_answer") ||
        allAgentMessages.at(-1);
      if (!finalMessage?.text?.trim()) {
        throw new Error("Codex completed without a final reply.");
      }

      return {
        threadId,
        turnId,
        reply: finalMessage.text.trim(),
      };
    } finally {
      this.off("notification", processNotification);
      this.off("exit", rejectOnClientFailure);
      this.off("protocolError", rejectOnClientFailure);
      if (this.serverRequestHandlers.get(threadId) === processServerRequest) {
        this.serverRequestHandlers.delete(threadId);
      }
      try {
        await this.request("thread/unsubscribe", { threadId }, 5_000);
      } catch {
        // The turn result is authoritative; teardown is best-effort.
      }
    }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.modelsCache = null;
    this.knownMcpServers = null;
    if (!child) return;
    child.stdin.end();
    child.kill("SIGTERM");
  }

  async runWork({
    graph,
    blockUid,
    accessMode = "auto",
    enabledServers = [],
    serviceTier,
    ...rest
  }) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(blockUid || "")) {
      throw rpcError("A valid Roam block UID is required.", "BLOCK_UID_INVALID");
    }
    let effectiveServiceTier = serviceTier;
    if (serviceTier === undefined) {
      const models = await this.listModels();
      const selectedModel = rest.model
        ? models.find((entry) => entry.id === rest.model)
        : models.find((entry) => entry.isDefault) || models[0];
      const tierIds = Array.isArray(selectedModel?.serviceTiers)
        ? selectedModel.serviceTiers.map((tier) => tier?.id)
        : [];
      effectiveServiceTier = tierIds.includes("priority")
        ? "priority"
        : undefined;
    }
    return this.runChat({
      ...rest,
      message: buildWorkPrompt({ graph, blockUid }),
      graph,
      promptBlockUid: blockUid,
      threadId: null,
      accessMode,
      enabledServers,
      serviceTier: effectiveServiceTier,
      instructions: RUNTIME_WORK_INSTRUCTIONS,
      ephemeral: true,
      serviceName: "roam_codex_work",
    });
  }
}

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === "https://roamresearch.com") return true;
  if (/^https:\/\/[a-z0-9-]+\.roamresearch\.com$/i.test(origin)) return true;
  return /^roam:\/\//i.test(origin);
}

function isPairingOrigin(origin) {
  return Boolean(origin) && isAllowedOrigin(origin);
}

function secureStringMatches(received, expected) {
  const receivedBytes = Buffer.from(String(received));
  const expectedBytes = Buffer.from(String(expected));
  return receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes);
}

export function createPairingSession({
  code = `${randomBytes(3).toString("hex")}-${randomBytes(3).toString("hex")}`
    .toUpperCase(),
  now = Date.now,
  ttlMs = PAIRING_CODE_TTL_MS,
  maxAttempts = PAIRING_CODE_MAX_ATTEMPTS,
} = {}) {
  const pairingCode = String(code).trim().toUpperCase();
  const expiresAt = now() + ttlMs;
  let attemptsRemaining = maxAttempts;
  let consumed = false;
  return {
    code: pairingCode,
    expiresAt,
    verify(value) {
      if (consumed || attemptsRemaining <= 0 || now() >= expiresAt) return false;
      const matches = secureStringMatches(
        String(value || "").trim().toUpperCase(),
        pairingCode,
      );
      attemptsRemaining -= 1;
      if (matches) consumed = true;
      return matches;
    },
  };
}

function bearerMatches(header, token) {
  if (!header?.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw rpcError("Request body is too large.", "BODY_TOO_LARGE");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw rpcError("Request body must be valid JSON.", "INVALID_JSON");
  }
}

function sendJson(response, status, body, origin) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": origin || "https://roamresearch.com",
    vary: "Origin",
  });
  response.end(JSON.stringify(body));
}

function startNdjson(response, origin) {
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": origin || "https://roamresearch.com",
    vary: "Origin",
  });
}

function writeNdjson(response, event) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`${JSON.stringify(event)}\n`);
}

export function createTraceWriter(
  tracePath = resolve(ROOT, ".dev", "last-run.jsonl"),
) {
  let writes = Promise.resolve();
  return (entry) => {
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      ...entry,
    })}\n`;
    writes = writes
      .then(async () => {
        await mkdir(dirname(tracePath), { recursive: true, mode: 0o700 });
        await appendFile(tracePath, line, { mode: 0o600 });
      })
      .catch((error) => {
        process.stderr.write(`[trace] ${error.message}\n`);
      });
    return writes;
  };
}

export function createBridgeServer({
  token,
  graph: initialGraph = null,
  client: initialClient = null,
  createClient = (boundGraph) =>
    new AppServerClient({ runtimeCwd: runtimeCwdForGraph(boundGraph) }),
  onBind = async () => {},
  requestConsent = requestPairingConsent,
  ensureGraphAccess = ensureRuntimeGraphAccess,
  pairingCodePath = PAIRING_CODE_PATH,
  trace = createTraceWriter(),
} = {}) {
  if (!token) throw new Error("A bridge bearer token is required.");
  let graph = typeof initialGraph === "string" && initialGraph.trim()
    ? initialGraph.trim()
    : null;
  let client = initialClient || (graph ? createClient(graph) : null);
  let pairingSession = null;
  let consentInFlight = false;

  const bindGraph = async (nextGraph) => {
    if (graph === nextGraph && client) return;
    const previousClient = client;
    graph = nextGraph;
    client = createClient(nextGraph);
    if (previousClient) {
      void Promise.resolve(previousClient.stop()).catch(() => {});
    }
    await onBind(nextGraph);
    void Promise.resolve(ensureGraphAccess({ graph: nextGraph }))
      .then((result) => trace({
        event: result.connected
          ? "graph.access.ready"
          : "graph.access.unavailable",
        graph: nextGraph,
        ...(result.alreadyConnected ? { alreadyConnected: true } : {}),
      }))
      .catch(() => {});
  };
  const activeRunsByBlockUid = new Map();
  const activeRunsByThreadId = new Map();
  const activeRunsById = new Map();

  const interruptRun = async (run) => {
    if (!run.threadId || !run.turnId) return false;
    if (!run.interruptPromise) {
      run.interruptPromise = client.interruptTurn({
        threadId: run.threadId,
        turnId: run.turnId,
      });
    }
    await run.interruptPromise;
    return true;
  };

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (!isAllowedOrigin(origin)) {
      sendJson(response, 403, { error: "Origin is not allowed." }, null);
      return;
    }

    if (request.method === "OPTIONS") {
      const headers = {
        "access-control-allow-origin": origin || "https://roamresearch.com",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers":
          "authorization, content-type, x-roam-graph",
        "access-control-max-age": "600",
        vary: "Origin",
      };
      if (
        request.headers["access-control-request-private-network"] === "true"
      ) {
        headers["access-control-allow-private-network"] = "true";
      }
      response.writeHead(204, headers);
      response.end();
      return;
    }

    let requestedGraph = null;
    try {
      requestedGraph = request.headers["x-roam-graph"]
        ? decodeURIComponent(request.headers["x-roam-graph"])
        : null;
    } catch {
      sendJson(response, 400, { error: "Invalid Roam graph header." }, origin);
      return;
    }
    if (graph && requestedGraph && requestedGraph !== graph) {
      sendJson(
        response,
        409,
        {
          error:
            `This bridge is paired to graph "${graph}". ` +
            "Pair this graph from the Roam panel to switch.",
          code: "GRAPH_MISMATCH",
        },
        origin,
      );
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      sendJson(
        response,
        200,
        {
          ok: true,
          graph,
          version: BRIDGE_VERSION,
          appServer: client?.ready ? "ready" : "idle",
        },
        origin,
      );
      return;
    }

    if (request.method === "POST" && request.url === "/pair") {
      if (!isPairingOrigin(origin)) {
        sendJson(
          response,
          403,
          { error: "Pairing requires an allowed Roam origin." },
          null,
        );
        return;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
        sendJson(response, status, { error: error.message }, origin);
        return;
      }
      if (!validPairingGraphName(body?.graph)) {
        sendJson(response, 400, { error: "A valid graph name is required." }, origin);
        return;
      }
      const pairingGraph = body.graph.trim();

      if (typeof body.code === "string" && body.code.trim()) {
        if (!pairingSession?.verify(body.code)) {
          sendJson(
            response,
            403,
            {
              error:
                "That pairing code is invalid or expired. Click Pair again " +
                "for a fresh one.",
            },
            origin,
          );
          return;
        }
        pairingSession = null;
        await bindGraph(pairingGraph);
        await trace({ event: "pair.bound", graph: pairingGraph, via: "code" });
        sendJson(response, 200, { graph: pairingGraph, token }, origin);
        return;
      }

      if (consentInFlight) {
        sendJson(
          response,
          409,
          { error: "A pairing request is already waiting for consent." },
          origin,
        );
        return;
      }
      consentInFlight = true;
      let consent;
      try {
        consent = await requestConsent({ graph: pairingGraph });
      } finally {
        consentInFlight = false;
      }
      if (!consent.supported) {
        pairingSession = createPairingSession();
        try {
          await mkdir(dirname(pairingCodePath), {
            recursive: true,
            mode: 0o700,
          });
          await writeFile(pairingCodePath, `${pairingSession.code}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
        } catch {
          // The code is still verifiable; only the on-disk copy failed.
        }
        sendJson(response, 200, { codeRequired: true }, origin);
        return;
      }
      if (!consent.allowed) {
        sendJson(
          response,
          403,
          { error: "Pairing was declined on this computer." },
          origin,
        );
        return;
      }
      pairingSession = null;
      await bindGraph(pairingGraph);
      await trace({ event: "pair.bound", graph: pairingGraph, via: "dialog" });
      sendJson(response, 200, { graph: pairingGraph, token }, origin);
      return;
    }

    if (!client) {
      sendJson(
        response,
        409,
        {
          error:
            "The bridge isn't paired to a graph yet. Pair from the Roam panel.",
          code: "NOT_BOUND",
        },
        origin,
      );
      return;
    }

    if (request.method === "GET" && request.url === "/auth") {
      if (!bearerMatches(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Invalid bridge token." }, origin);
        return;
      }
      try {
        const status = await client.readAuthStatus();
        sendJson(
          response,
          200,
          {
            auth: status.authenticated ? "authenticated" : "signed-out",
            method: status.method,
          },
          origin,
        );
      } catch (error) {
        sendJson(
          response,
          502,
          { error: error.message || "Could not read the Codex sign-in state." },
          origin,
        );
      }
      return;
    }

    if (request.method === "POST" && request.url === "/auth/login") {
      if (!bearerMatches(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Invalid bridge token." }, origin);
        return;
      }
      try {
        const login = await client.startAccountLogin();
        await trace({ event: "auth.login.started", graph });
        sendJson(response, 200, { ok: true, ...login }, origin);
      } catch (error) {
        sendJson(
          response,
          502,
          { error: error.message || "Could not start the Codex sign-in." },
          origin,
        );
      }
      return;
    }

    if (request.method === "GET" && request.url === "/models") {
      if (!bearerMatches(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Invalid bridge token." }, origin);
        return;
      }
      try {
        const models = (await client.listModels()).map((model) => ({
          id: model.id,
          displayName: model.displayName || model.id,
          isDefault: model.isDefault === true,
          defaultReasoningEffort: model.defaultReasoningEffort || null,
          supportedReasoningEfforts: Array.isArray(
            model.supportedReasoningEfforts,
          )
            ? model.supportedReasoningEfforts.map((option) => ({
                reasoningEffort: option.reasoningEffort,
                description: option.description || "",
              }))
            : [],
          defaultServiceTier: model.defaultServiceTier || null,
          serviceTiers: Array.isArray(model.serviceTiers)
            ? model.serviceTiers.map((tier) => ({
                id: tier.id,
                name: tier.name || tier.id,
                description: tier.description || "",
              }))
            : [],
        }));
        sendJson(response, 200, { models }, origin);
      } catch (error) {
        sendJson(
          response,
          502,
          { error: error.message || "Could not load Codex models." },
          origin,
        );
      }
      return;
    }

    if (request.method === "GET" && request.url === "/mcp-servers") {
      if (!bearerMatches(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Invalid bridge token." }, origin);
        return;
      }
      try {
        const servers = await client.listMcpServers();
        sendJson(response, 200, { servers }, origin);
      } catch (error) {
        sendJson(
          response,
          502,
          { error: error.message || "Could not list Codex MCP servers." },
          origin,
        );
      }
      return;
    }

    if (request.method === "POST" && request.url === "/threads/summaries") {
      if (!bearerMatches(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Invalid bridge token." }, origin);
        return;
      }

      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
        sendJson(response, status, { error: error.message }, origin);
        return;
      }
      if (body?.graph !== graph) {
        sendJson(
          response,
          400,
          { error: `This bridge is restricted to graph "${graph}".` },
          origin,
        );
        return;
      }
      const threadIds = body?.threadIds;
      if (
        !Array.isArray(threadIds) ||
        threadIds.length > MAX_THREAD_SUMMARY_IDS ||
        threadIds.some((threadId) =>
          typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)
        ) ||
        new Set(threadIds).size !== threadIds.length
      ) {
        sendJson(
          response,
          400,
          {
            error:
              `threadIds must contain at most ${MAX_THREAD_SUMMARY_IDS} ` +
              "unique Codex thread IDs.",
          },
          origin,
        );
        return;
      }

      try {
        const result = await client.readThreadSummaries(threadIds);
        sendJson(response, 200, result, origin);
      } catch (error) {
        sendJson(
          response,
          502,
          { error: error.message || "Could not load conversation history." },
          origin,
        );
      }
      return;
    }

    const messagesMatch = request.url?.match(
      /^\/threads\/([A-Za-z0-9_-]{8,128})\/messages$/,
    );
    if (request.method === "GET" && messagesMatch) {
      if (!bearerMatches(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Invalid bridge token." }, origin);
        return;
      }
      try {
        const messages = await client.listThreadMessages(messagesMatch[1]);
        sendJson(response, 200, { messages }, origin);
      } catch (error) {
        const missing = missingThreadError(error);
        sendJson(
          response,
          missing ? 404 : 502,
          { error: error.message || "Could not load that conversation." },
          origin,
        );
      }
      return;
    }

    const threadNameMatch = request.url?.match(
      /^\/threads\/([A-Za-z0-9_-]{8,128})\/name$/,
    );
    if (request.method === "POST" && threadNameMatch) {
      if (!bearerMatches(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Invalid bridge token." }, origin);
        return;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
        sendJson(response, status, { error: error.message }, origin);
        return;
      }
      if (body?.graph !== graph) {
        sendJson(
          response,
          400,
          { error: `This bridge is restricted to graph "${graph}".` },
          origin,
        );
        return;
      }
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 100 || /[\r\n]/.test(name)) {
        sendJson(
          response,
          400,
          { error: "name must be a single line of at most 100 characters." },
          origin,
        );
        return;
      }
      try {
        const result = await client.setThreadName(threadNameMatch[1], name);
        sendJson(response, 200, result, origin);
      } catch (error) {
        const missing = missingThreadError(error);
        sendJson(
          response,
          missing ? 404 : 502,
          { error: error.message || "Could not name that conversation." },
          origin,
        );
      }
      return;
    }

    const threadDeleteMatch = request.url?.match(
      /^\/threads\/([A-Za-z0-9_-]{8,128})$/,
    );
    if (request.method === "DELETE" && threadDeleteMatch) {
      if (!bearerMatches(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Invalid bridge token." }, origin);
        return;
      }
      const threadId = threadDeleteMatch[1];
      try {
        const result = await client.deleteThread(threadId);
        await trace({ event: "thread.deleted", graph, threadId });
        sendJson(response, 200, { ok: true, ...result }, origin);
      } catch (error) {
        sendJson(
          response,
          502,
          { error: error.message || "Could not delete that conversation." },
          origin,
        );
      }
      return;
    }

    if (request.method === "POST" && request.url === "/chat") {
      if (!bearerMatches(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Invalid bridge token." }, origin);
        return;
      }

      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
        sendJson(response, status, { error: error.message }, origin);
        return;
      }

      if (body?.graph !== graph) {
        sendJson(
          response,
          400,
          { error: `This bridge is restricted to graph "${graph}".` },
          origin,
        );
        return;
      }
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message || message.length > MAX_CHAT_MESSAGE_LENGTH) {
        sendJson(
          response,
          400,
          { error: `A chat message must be 1-${MAX_CHAT_MESSAGE_LENGTH} characters.` },
          origin,
        );
        return;
      }
      const graphGuidelines = body.graphGuidelines;
      if (
        graphGuidelines !== undefined &&
        (typeof graphGuidelines !== "string" ||
          graphGuidelines.length > MAX_GRAPH_GUIDELINES_LENGTH)
      ) {
        sendJson(
          response,
          400,
          { error: `Graph guidelines must be at most ${MAX_GRAPH_GUIDELINES_LENGTH} characters.` },
          origin,
        );
        return;
      }
      const promptBlockUid = body.promptBlockUid;
      if (
        typeof promptBlockUid !== "string" ||
        !/^[A-Za-z0-9_-]{6,64}$/.test(promptBlockUid)
      ) {
        sendJson(response, 400, { error: "Invalid Roam prompt block UID." }, origin);
        return;
      }
      const requestedThreadId = body.threadId || null;
      if (
        requestedThreadId !== null &&
        (typeof requestedThreadId !== "string" ||
          !THREAD_ID_PATTERN.test(requestedThreadId))
      ) {
        sendJson(response, 400, { error: "Invalid Codex thread ID." }, origin);
        return;
      }
      for (const field of ["model", "effort", "serviceTier"]) {
        if (
          body[field] !== undefined &&
          body[field] !== null &&
          (typeof body[field] !== "string" || body[field].length > 100)
        ) {
          sendJson(response, 400, { error: `Invalid ${field}.` }, origin);
          return;
        }
      }
      const accessMode = body.accessMode || "auto";
      if (!CHAT_ACCESS_MODES.has(accessMode)) {
        sendJson(response, 400, { error: "Invalid accessMode." }, origin);
        return;
      }
      const requestedServers = body.enabledServers === undefined
        ? []
        : body.enabledServers;
      if (
        !Array.isArray(requestedServers) ||
        requestedServers.length > 32 ||
        requestedServers.some((name) =>
          typeof name !== "string" ||
          !name.trim() ||
          name.length > 64 ||
          /[\u0000-\u001f]/.test(name)
        )
      ) {
        sendJson(response, 400, { error: "Invalid enabledServers." }, origin);
        return;
      }
      const enabledServers = [...new Set(requestedServers)];
      if (
        requestedThreadId &&
        activeRunsByThreadId.has(requestedThreadId)
      ) {
        sendJson(
          response,
          409,
          { error: "That Codex conversation already has an active turn." },
          origin,
        );
        return;
      }

      const runId = randomUUID();
      const startedAt = Date.now();
      const activeRun = {
        kind: "chat",
        runId,
        blockUid: null,
        threadId: requestedThreadId,
        turnId: null,
        cancelRequested: false,
        interruptPromise: null,
        pendingApprovals: new Map(),
      };
      activeRunsById.set(runId, activeRun);
      if (requestedThreadId) {
        activeRunsByThreadId.set(requestedThreadId, activeRun);
      }
      await trace({
        runId,
        event: "chat.started",
        graph,
        threadId: requestedThreadId,
        promptBlockUid,
        messageLength: message.length,
        ...(enabledServers.length ? { enabledServers } : {}),
      });
      startNdjson(response, origin);
      writeNdjson(response, { type: "started", runId });

      try {
        const result = await client.runChat({
          message,
          graph,
          ...(graphGuidelines !== undefined ? { graphGuidelines } : {}),
          promptBlockUid,
          threadId: requestedThreadId,
          model: body.model || null,
          effort: body.effort || null,
          serviceTier: Object.hasOwn(body, "serviceTier")
            ? body.serviceTier
            : undefined,
          accessMode,
          enabledServers,
          onProgress: (progress) => {
            writeNdjson(response, { type: "progress", ...progress });
          },
          onThread: ({ threadId }) => {
            activeRun.threadId = threadId;
            activeRunsByThreadId.set(threadId, activeRun);
            writeNdjson(response, { type: "conversation", threadId });
          },
          onStarted: async ({ threadId, turnId }) => {
            activeRun.threadId = threadId;
            activeRun.turnId = turnId;
            if (activeRun.cancelRequested) await interruptRun(activeRun);
          },
          onApproval: ({ itemId, questions }) => new Promise((resolveDecision) => {
            if (response.destroyed || response.writableEnded) {
              resolveDecision("reject");
              return;
            }
            const approvalId = randomUUID();
            activeRun.pendingApprovals.set(approvalId, {
              resolve: resolveDecision,
              itemId,
            });
            writeNdjson(response, {
              type: "approval",
              approvalId,
              questions: Array.isArray(questions)
                ? questions.map((question) => ({
                    header: typeof question?.header === "string"
                      ? question.header
                      : "Roam change",
                    question: typeof question?.question === "string"
                      ? question.question
                      : "Allow this Roam change?",
                  }))
                : [],
            });
          }),
        });
        const payload = {
          runId,
          graph,
          durationMs: Date.now() - startedAt,
          ...result,
        };
        await trace({
          runId,
          event: "chat.completed",
          graph,
          threadId: result.threadId,
          turnId: result.turnId,
          durationMs: payload.durationMs,
        });
        writeNdjson(response, { type: "completed", result: payload });
      } catch (error) {
        await trace({
          runId,
          event: error.code === "TURN_INTERRUPTED"
            ? "chat.interrupted"
            : "chat.failed",
          graph,
          threadId: activeRun.threadId,
          durationMs: Date.now() - startedAt,
          error: error.message,
          code: error.code,
          codexErrorInfo: error.codexErrorInfo || null,
          httpStatusCode: Number.isFinite(error.httpStatusCode)
            ? error.httpStatusCode
            : null,
          additionalDetails: error.additionalDetails || null,
        });
        writeNdjson(response, {
          type: "error",
          runId,
          error: error.message || "Chat failed.",
          code: error.code,
          ...(error.codexErrorInfo
            ? { codexErrorInfo: error.codexErrorInfo }
            : {}),
          ...(Number.isFinite(error.httpStatusCode)
            ? { httpStatusCode: error.httpStatusCode }
            : {}),
          ...(error.additionalDetails
            ? { additionalDetails: error.additionalDetails }
            : {}),
        });
      } finally {
        for (const pendingApproval of activeRun.pendingApprovals.values()) {
          pendingApproval.resolve("reject");
        }
        activeRun.pendingApprovals.clear();
        if (activeRun.threadId) {
          activeRunsByThreadId.delete(activeRun.threadId);
        }
        activeRunsById.delete(runId);
        response.end();
      }
      return;
    }

    const approvalMatch = request.url?.match(
      /^\/runs\/([0-9a-f-]{36})\/approvals\/([0-9a-f-]{36})$/i,
    );
    if (request.method === "POST" && approvalMatch) {
      if (!bearerMatches(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Invalid bridge token." }, origin);
        return;
      }
      const run = activeRunsById.get(approvalMatch[1]);
      const pendingApproval = run?.pendingApprovals?.get(approvalMatch[2]);
      if (!run || !pendingApproval) {
        sendJson(response, 404, { error: "That approval is no longer pending." }, origin);
        return;
      }
      let approvalBody;
      try {
        approvalBody = await readJsonBody(request);
      } catch (error) {
        const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
        sendJson(response, status, { error: error.message }, origin);
        return;
      }
      if (!["accept", "reject"].includes(approvalBody?.decision)) {
        sendJson(response, 400, { error: "Invalid approval decision." }, origin);
        return;
      }
      run.pendingApprovals.delete(approvalMatch[2]);
      pendingApproval.resolve(approvalBody.decision);
      await trace({
        runId: run.runId,
        event: `chat.approval.${approvalBody.decision}ed`,
        graph,
        threadId: run.threadId,
        itemId: pendingApproval.itemId,
      });
      sendJson(response, 200, { ok: true }, origin);
      return;
    }

    const steerMatch = request.url?.match(
      /^\/runs\/([0-9a-f-]{36})\/steer$/i,
    );
    if (request.method === "POST" && steerMatch) {
      if (!bearerMatches(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Invalid bridge token." }, origin);
        return;
      }
      const run = activeRunsById.get(steerMatch[1]);
      if (!run || run.kind !== "chat") {
        sendJson(
          response,
          404,
          { error: "That Codex chat run is not active." },
          origin,
        );
        return;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
        sendJson(response, status, { error: error.message }, origin);
        return;
      }
      if (body?.graph !== graph) {
        sendJson(
          response,
          400,
          { error: `This bridge is restricted to graph "${graph}".` },
          origin,
        );
        return;
      }
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message || message.length > MAX_CHAT_MESSAGE_LENGTH) {
        sendJson(
          response,
          400,
          { error: `A steer message must be 1-${MAX_CHAT_MESSAGE_LENGTH} characters.` },
          origin,
        );
        return;
      }
      if (run.cancelRequested) {
        sendJson(
          response,
          409,
          {
            error: "That Codex run is being stopped.",
            code: "TURN_NOT_STEERABLE",
          },
          origin,
        );
        return;
      }
      if (!run.threadId || !run.turnId) {
        sendJson(
          response,
          409,
          {
            error: "That Codex turn is still starting. Try again in a moment.",
            code: "TURN_NOT_STARTED",
          },
          origin,
        );
        return;
      }
      try {
        await client.steerTurn({
          threadId: run.threadId,
          turnId: run.turnId,
          message,
        });
        await trace({
          runId: run.runId,
          event: "chat.steered",
          graph,
          threadId: run.threadId,
          turnId: run.turnId,
          messageLength: message.length,
        });
        sendJson(response, 200, { ok: true, turnId: run.turnId }, origin);
      } catch (error) {
        await trace({
          runId: run.runId,
          event: "chat.steer.failed",
          graph,
          threadId: run.threadId,
          turnId: run.turnId,
          error: error.message,
        });
        sendJson(
          response,
          409,
          {
            error: error.message || "The active turn could not be steered.",
            code: "TURN_NOT_STEERABLE",
          },
          origin,
        );
      }
      return;
    }

    const cancelMatch = request.url?.match(
      /^\/runs\/([0-9a-f-]{36})\/cancel$/i,
    );
    if (request.method === "POST" && cancelMatch) {
      if (!bearerMatches(request.headers.authorization, token)) {
        sendJson(response, 401, { error: "Invalid bridge token." }, origin);
        return;
      }

      const run = activeRunsById.get(cancelMatch[1]);
      if (!run) {
        sendJson(response, 404, { error: "That Codex run is not active." }, origin);
        return;
      }

      run.cancelRequested = true;
      await trace({
        runId: run.runId,
        event: `${run.kind}.cancel.requested`,
        graph,
        blockUid: run.blockUid,
        threadId: run.threadId,
      });
      try {
        const sent = await interruptRun(run);
        sendJson(
          response,
          202,
          { ok: true, status: sent ? "interrupting" : "starting" },
          origin,
        );
      } catch (error) {
        sendJson(
          response,
          502,
          { error: error.message || "Could not stop the Codex run." },
          origin,
        );
      }
      return;
    }

    if (request.method !== "POST" || request.url !== "/probe") {
      sendJson(response, 404, { error: "Not found." }, origin);
      return;
    }

    if (!bearerMatches(request.headers.authorization, token)) {
      sendJson(response, 401, { error: "Invalid bridge token." }, origin);
      return;
    }

    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
      sendJson(response, status, { error: error.message }, origin);
      return;
    }

    const blockUid = body.blockUid;
    if (
      typeof blockUid !== "string" ||
      !/^[A-Za-z0-9_-]{6,64}$/.test(blockUid)
    ) {
      sendJson(response, 400, { error: "Invalid Roam block UID." }, origin);
      return;
    }
    const graphGuidelines = body.graphGuidelines;
    if (
      graphGuidelines !== undefined &&
      (typeof graphGuidelines !== "string" ||
        graphGuidelines.length > MAX_GRAPH_GUIDELINES_LENGTH)
    ) {
      sendJson(
        response,
        400,
        { error: `Graph guidelines must be at most ${MAX_GRAPH_GUIDELINES_LENGTH} characters.` },
        origin,
      );
      return;
    }
    if (body?.graph !== graph) {
      sendJson(
        response,
        400,
        { error: `This bridge is restricted to graph "${graph}".` },
        origin,
      );
      return;
    }
    const workAccessMode = body.accessMode || "auto";
    if (!CHAT_ACCESS_MODES.has(workAccessMode)) {
      sendJson(response, 400, { error: "Invalid accessMode." }, origin);
      return;
    }
    if (activeRunsByBlockUid.has(blockUid)) {
      sendJson(
        response,
        409,
        { error: "Codex is already working on this block." },
        origin,
      );
      return;
    }

    const runId = randomUUID();
    const startedAt = Date.now();
    const activeRun = {
      kind: "work",
      runId,
      blockUid,
      threadId: null,
      turnId: null,
      cancelRequested: false,
      interruptPromise: null,
      pendingApprovals: new Map(),
    };
    activeRunsByBlockUid.set(blockUid, activeRun);
    activeRunsById.set(runId, activeRun);
    await trace({ runId, event: "work.started", graph, blockUid });
    startNdjson(response, origin);
    writeNdjson(response, { type: "started", runId });

    try {
      const result = await client.runWork({
        graph,
        ...(graphGuidelines !== undefined ? { graphGuidelines } : {}),
        blockUid,
        accessMode: workAccessMode,
        onProgress: (progress) => {
          writeNdjson(response, { type: "progress", ...progress });
        },
        onStarted: async ({ threadId, turnId }) => {
          activeRun.threadId = threadId;
          activeRun.turnId = turnId;
          if (activeRun.cancelRequested) await interruptRun(activeRun);
        },
        onApproval: ({ itemId, questions }) => new Promise((resolveDecision) => {
          if (response.destroyed || response.writableEnded) {
            resolveDecision("reject");
            return;
          }
          const approvalId = randomUUID();
          activeRun.pendingApprovals.set(approvalId, {
            resolve: resolveDecision,
            itemId,
          });
          writeNdjson(response, {
            type: "approval",
            approvalId,
            questions: Array.isArray(questions)
              ? questions.map((question) => ({
                  header: typeof question?.header === "string"
                    ? question.header
                    : "Roam change",
                  question: typeof question?.question === "string"
                    ? question.question
                    : "Allow this Roam change?",
                }))
              : [],
          });
        }),
      });
      const payload = {
        runId,
        graph,
        blockUid,
        durationMs: Date.now() - startedAt,
        ...result,
      };
      await trace({
        runId,
        event: "work.completed",
        graph,
        blockUid,
        durationMs: payload.durationMs,
        threadId: result.threadId,
        turnId: result.turnId,
      });
      writeNdjson(response, { type: "completed", result: payload });
    } catch (error) {
      await trace({
        runId,
        event:
          error.code === "TURN_INTERRUPTED"
            ? "work.interrupted"
            : "work.failed",
        graph,
        blockUid,
        durationMs: Date.now() - startedAt,
        error: error.message,
        code: error.code,
        codexErrorInfo: error.codexErrorInfo || null,
        httpStatusCode: Number.isFinite(error.httpStatusCode)
          ? error.httpStatusCode
          : null,
        additionalDetails: error.additionalDetails || null,
      });
      writeNdjson(response, {
        type: "error",
        runId,
        error: error.message || "The task could not be completed.",
        code: error.code,
        ...(error.codexErrorInfo
          ? { codexErrorInfo: error.codexErrorInfo }
          : {}),
        ...(Number.isFinite(error.httpStatusCode)
          ? { httpStatusCode: error.httpStatusCode }
          : {}),
        ...(error.additionalDetails
          ? { additionalDetails: error.additionalDetails }
          : {}),
      });
    } finally {
      for (const pendingApproval of activeRun.pendingApprovals.values()) {
        pendingApproval.resolve("reject");
      }
      activeRun.pendingApprovals.clear();
      activeRunsByBlockUid.delete(blockUid);
      activeRunsById.delete(runId);
      response.end();
    }
  });
  server.stopClient = () => Promise.resolve(client?.stop()).catch(() => {});
  return server;
}

export const BRIDGE_TOKEN_PATH = resolve(RUNTIME_HOME, "bridge-token");
export const LEGACY_BRIDGE_TOKEN_PATH = resolve(ROOT, ".dev", "bridge-token");

export async function legacyBridgeTokenPaths({
  root = ROOT,
  runtimeHome = RUNTIME_HOME,
} = {}) {
  const candidates = [resolve(root, ".dev", "bridge-token")];
  try {
    const appRoot = resolve(runtimeHome, "app");
    const versions = await readdir(appRoot);
    // Newest install first, so the most recently paired token wins.
    for (const version of versions.sort().reverse()) {
      candidates.push(resolve(appRoot, version, ".dev", "bridge-token"));
    }
  } catch {
    // No packaged installs to migrate from.
  }
  return candidates;
}

async function readTokenFile(tokenPath) {
  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    return existing || null;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

export async function ensureBridgeToken(
  tokenPath = BRIDGE_TOKEN_PATH,
  { legacyTokenPaths = null } = {},
) {
  if (process.env.ROAM_CODEX_BRIDGE_TOKEN) {
    return process.env.ROAM_CODEX_BRIDGE_TOKEN;
  }

  const existing = await readTokenFile(tokenPath);
  if (existing) {
    await chmod(tokenPath, 0o600);
    return existing;
  }

  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });

  // Installs before 0.9.2 kept the token beside the running copy of the
  // bridge, so every upgrade minted a new one and forced the user to pair
  // again. Adopt that token once so upgrades stay silent.
  const candidates = legacyTokenPaths || (await legacyBridgeTokenPaths());
  for (const candidate of candidates) {
    if (candidate === tokenPath) continue;
    const legacy = await readTokenFile(candidate);
    if (!legacy) continue;
    await writeFile(tokenPath, `${legacy}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return legacy;
  }

  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return token;
}

export async function startBridge({
  host = process.env.ROAM_CODEX_HOST || DEFAULT_HOST,
  port = Number(process.env.ROAM_CODEX_PORT || DEFAULT_PORT),
} = {}) {
  const token = await ensureBridgeToken();
  const config = await readBridgeConfig();
  const graph = typeof config.graph === "string" && config.graph.trim()
    ? config.graph.trim()
    : null;
  const server = createBridgeServer({
    token,
    graph,
    createClient: (boundGraph) => new AppServerClient({
      runtimeCwd: runtimeCwdForGraph(boundGraph),
      command: config.codexBin || process.env.CODEX_BIN || "codex",
    }),
    onBind: async (boundGraph) => {
      const current = await readBridgeConfig();
      await writeBridgeConfig({ ...current, graph: boundGraph });
    },
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });

  process.stdout.write(
    [
      `Roam Codex bridge listening on http://${host}:${port}`,
      graph
        ? `Graph: ${graph}`
        : "Graph: not paired yet — open the Codex panel in Roam and click Pair.",
      "",
    ].join("\n"),
  );

  const shutdown = async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await server.stopClient();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  return server;
}

async function main() {
  await startBridge();
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
