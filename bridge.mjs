import { spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_HOME = resolve(homedir(), ".roam-better-ai");
const DEFAULT_GRAPH = "maskys";

export function runtimeCwdForGraph(graph) {
  const encoded = encodeURIComponent(String(graph || "graph"));
  const safe = encoded === "." || encoded === ".." ? `_${encoded}` : encoded;
  return resolve(RUNTIME_HOME, "graphs", safe);
}

export const DEFAULT_RUNTIME_CWD = runtimeCwdForGraph(DEFAULT_GRAPH);
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
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 47321;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PROGRESS_TEXT_LENGTH = 240;
const MAX_CHAT_MESSAGE_LENGTH = 8_000;
const MAX_THREAD_SUMMARY_IDS = 100;
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

export function runtimeAppServerArgs({
  roamHome = resolve(ROOT, ".dev", "roam-home"),
  disableServers = [],
} = {}) {
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
    "-c",
    'mcp_servers.roam.command="npx"',
    "-c",
    'mcp_servers.roam.args=["--yes","@roam-research/roam-mcp"]',
    "-c",
    "mcp_servers.roam.enabled=true",
    "-c",
    `mcp_servers.roam.env={HOME=${JSON.stringify(roamHome)}}`,
    "-c",
    `mcp_servers.roam.enabled_tools=${JSON.stringify(RUNTIME_CHAT_ROAM_TOOLS)}`,
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
  servers.roam = { enabled: true, enabled_tools: enabledTools };
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

function runtimeInstructions(source, graph) {
  return [
    source,
    "",
    `Active Roam graph nickname: ${JSON.stringify(graph)}.`,
  ].join("\n");
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

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["applied", "needs_input", "no_change"],
    },
    research: {
      type: "string",
      enum: ["completed", "not_needed", "unavailable"],
    },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            pattern: "^b[1-9][0-9]*$",
          },
          parent: {
            type: "string",
            minLength: 1,
            maxLength: 20,
          },
          text: {
            type: "string",
            minLength: 1,
            maxLength: 500,
          },
        },
        required: ["id", "parent", "text"],
        additionalProperties: false,
      },
      maxItems: 12,
    },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target: {
            type: "string",
            minLength: 1,
            maxLength: 20,
          },
          kind: {
            type: "string",
            enum: ["question", "note", "warning"],
          },
          text: {
            type: "string",
            minLength: 1,
            maxLength: 500,
          },
        },
        required: ["target", "kind", "text"],
        additionalProperties: false,
      },
      maxItems: 4,
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target: {
            type: "string",
            minLength: 1,
            maxLength: 20,
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: 200,
          },
          url: {
            type: "string",
            minLength: 1,
            maxLength: 2048,
          },
          supports: {
            type: "string",
            minLength: 1,
            maxLength: 300,
          },
        },
        required: ["target", "title", "url", "supports"],
        additionalProperties: false,
      },
      maxItems: 10,
    },
  },
  required: ["outcome", "research", "edits", "comments", "sources"],
  additionalProperties: false,
};

export function buildProbePrompt({ graph, blockUid }) {
  return [
    `Work on Roam block UID "${blockUid}" in graph "${graph}".`,
    `First call get_graph_guidelines for graph "${graph}", then call`,
    "get_block for the target UID with one level of child context.",
    "Call get_comments for the same target block and use its replies as",
    "conversation context. Replies beginning with **Codex** — are earlier",
    "assistant messages; other comments may be user follow-ups.",
    "Use breadcrumb or parent context returned by the read tools when useful.",
    "Silently ignore the temporary child [[Codex/running]].",
    "The user invoked an editing command, so return useful new outline blocks",
    "rather than a proposal or a chat response. The extension may only append",
    "new descendants beneath the invoked source block; it will not rewrite,",
    "move, or delete existing blocks.",
    'Use edit id "b1", "b2", and so on. Set each edit parent to "source"',
    "or to the id of an earlier edit, producing a topologically ordered flat",
    "list. Put only durable user content in edits: no run state, IDs,",
    "interpretation labels, proposal wrappers, or Codex metadata.",
    "Write concise, natural Roam content that is immediately useful. Treat",
    "the main outline as the user's working surface and comments as its",
    "supporting layer. Include contextual links where they genuinely improve",
    "understanding or actionability. The outline should remain useful with",
    "comments closed, but do not repeat supporting material merely to make it",
    "self-contained.",
    "Determine whether the requested work depends on current or external",
    "facts. Real-world procedures, locations, requirements, prices, hours,",
    "schedules, availability, laws, products, and public people require web",
    "research. For those tasks, use live web search before planning edits,",
    'set research to "completed", and provide direct source URLs.',
    "Prefer official and primary sources. Cross-check material claims when",
    "more than one authoritative source exists. Do not cite a search-results",
    "page, an AI summary, or a source you did not actually inspect.",
    'Set research to "not_needed" only for work fully answerable from the',
    'graph context. If required research cannot be completed, set research',
    'to "unavailable", outcome to "no_change", return no edits or sources,',
    "and add a warning comment explaining what prevented verification.",
    "Keep provenance, source lists, verification details, uncertainty, and",
    "discussion in comments. Return source metadata through the sources array;",
    "do not create Sources, Citations, or References blocks in edits.",
    "Each source must target the most specific edit it supports, or source",
    "when it supports the invoked block generally. Give it a descriptive",
    "title, its direct http(s) URL, and a concise explanation of what it",
    "supports. The extension renders each targeted source group as a native",
    "Roam comment. Research marked completed requires at least one source.",
    "Use comments for questions, caveats, explanations, or anything that",
    "should not interrupt the user's outline. A comment target is either",
    '"source" or any edit id. Attach it to the most specific relevant block.',
    'If essential information is missing, return outcome "needs_input", no',
    "edits, and at least one question comment. If useful edits can be made,",
    'return outcome "applied"; optional non-blocking comments may accompany',
    'them. If no edit is appropriate, return outcome "no_change", no edits,',
    "and a concise explanatory comment.",
    "Do not repeat earlier content. Do not perform writes.",
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
    const child = this.spawnProcess(
      this.command,
      runtimeAppServerArgs({ disableServers: scannedServers }),
      {
        cwd: this.runtimeCwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
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
          version: "0.8.0",
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

  async setThreadName(threadId, name) {
    await this.start();
    await this.request("thread/name/set", { threadId, name });
    return { threadId, name };
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
    graph = DEFAULT_GRAPH,
    promptBlockUid,
    threadId: requestedThreadId = null,
    model = null,
    effort = null,
    serviceTier,
    accessMode = "auto",
    enabledServers = [],
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

    const enabledRoamTools = accessMode === "read-only"
      ? RUNTIME_READ_ROAM_TOOLS
      : RUNTIME_CHAT_ROAM_TOOLS;
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
        `${RUNTIME_CHAT_INSTRUCTIONS}\n\n${chatAccessInstruction(accessMode)}`,
        graph,
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
          serviceName: "roam_codex_chat",
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
        const detail = turn?.error?.message ||
          `status ${turn?.status || "unknown"}`;
        throw new Error(`Codex turn did not complete: ${detail}`);
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

  async runProbe({
    graph = DEFAULT_GRAPH,
    blockUid,
    onProgress = () => {},
    onStarted = () => {},
  }) {
    await this.start();

    const threadResult = await this.request("thread/start", {
      cwd: this.runtimeCwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: runtimeThreadConfig(RUNTIME_READ_ROAM_TOOLS, {
        knownServers: this.knownMcpServers || [],
      }),
      serviceName: "roam_codex_lab",
      ephemeral: true,
      developerInstructions: runtimeInstructions(
        RUNTIME_WORK_INSTRUCTIONS,
        graph,
      ),
    });

    validateRuntimeInstructionSources(threadResult?.instructionSources, {
      codexHome: this.codexHome,
    });

    const threadId = threadResult?.thread?.id;
    if (!threadId) {
      throw new Error("App-server did not return a thread id.");
    }

    const prompt = buildProbePrompt({ graph, blockUid });

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
      const turnResult = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        summary: "concise",
        outputSchema: PLAN_SCHEMA,
      });
      turnId = turnResult?.turn?.id;
      if (!turnId) {
        throw new Error("App-server did not return a turn id.");
      }
      await onStarted({ threadId, turnId });

      const earlyNotifications = buffered.splice(0);
      for (const notification of earlyNotifications) {
        processNotification(notification);
      }

      const turn = completeTurn || (await completion);
      if (turn?.status === "interrupted") {
        throw rpcError("Codex turn was stopped.", "TURN_INTERRUPTED");
      }
      if (turn?.status !== "completed") {
        const detail = turn?.error?.message || `status ${turn?.status || "unknown"}`;
        throw new Error(`Codex turn did not complete: ${detail}`);
      }

      const items = Array.isArray(turn.items) ? turn.items : [];
      const allAgentMessages = [
        ...completedAgentMessages,
        ...items.filter((item) => item?.type === "agentMessage"),
      ];
      const finalMessage =
        [...allAgentMessages]
          .reverse()
          .find((item) => item.phase === "final_answer") ||
        allAgentMessages.at(-1);

      if (!finalMessage?.text) {
        throw new Error("Codex completed without a final agent message.");
      }

      return {
        threadId,
        turnId,
        plan: parseAndValidatePlan(finalMessage.text),
      };
    } finally {
      this.off("notification", processNotification);
      this.off("exit", rejectOnClientFailure);
      this.off("protocolError", rejectOnClientFailure);
      try {
        await this.request("thread/unsubscribe", { threadId }, 5_000);
      } catch {
        // The turn result is authoritative; teardown is best-effort.
      }
    }
  }
}

export function parseAndValidatePlan(text) {
  const normalized = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let value;
  try {
    value = JSON.parse(normalized);
  } catch {
    throw new Error("Codex returned invalid edit-plan JSON.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex edit plan must be a JSON object.");
  }

  assertExactKeys(
    value,
    ["outcome", "research", "edits", "comments", "sources"],
    "edit plan",
  );
  if (!["applied", "needs_input", "no_change"].includes(value.outcome)) {
    throw new Error("Codex edit-plan outcome is invalid.");
  }
  if (
    !["completed", "not_needed", "unavailable"].includes(value.research)
  ) {
    throw new Error("Codex edit-plan research state is invalid.");
  }
  if (!Array.isArray(value.edits) || value.edits.length > 12) {
    throw new Error("Codex edit plan must contain at most 12 edits.");
  }
  if (!Array.isArray(value.comments) || value.comments.length > 4) {
    throw new Error("Codex edit plan must contain at most 4 comments.");
  }
  if (!Array.isArray(value.sources) || value.sources.length > 10) {
    throw new Error("Codex edit plan must contain at most 10 sources.");
  }

  const knownTargets = new Set(["source"]);
  const edits = value.edits.map((edit, index) => {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) {
      throw new Error(`Codex edit ${index + 1} must be an object.`);
    }
    assertExactKeys(edit, ["id", "parent", "text"], `edit ${index + 1}`);

    const id = validateText(edit.id, `edits[${index}].id`, 20);
    if (!/^b[1-9][0-9]*$/.test(id)) {
      throw new Error(`Codex edit id "${id}" is invalid.`);
    }
    if (knownTargets.has(id)) {
      throw new Error(`Codex edit id "${id}" is duplicated.`);
    }

    const parent = validateText(
      edit.parent,
      `edits[${index}].parent`,
      20,
    );
    if (!knownTargets.has(parent)) {
      throw new Error(
        `Codex edit "${id}" must refer to "source" or an earlier edit.`,
      );
    }

    const validated = {
      id,
      parent,
      text: validateText(edit.text, `edits[${index}].text`, 500),
    };
    knownTargets.add(id);
    return validated;
  });

  const comments = value.comments.map((comment, index) => {
    if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
      throw new Error(`Codex comment ${index + 1} must be an object.`);
    }
    assertExactKeys(
      comment,
      ["target", "kind", "text"],
      `comment ${index + 1}`,
    );

    const target = validateText(
      comment.target,
      `comments[${index}].target`,
      20,
    );
    if (!knownTargets.has(target)) {
      throw new Error(`Codex comment target "${target}" is invalid.`);
    }
    if (!["question", "note", "warning"].includes(comment.kind)) {
      throw new Error(`Codex comment kind "${comment.kind}" is invalid.`);
    }
    return {
      target,
      kind: comment.kind,
      text: validateText(comment.text, `comments[${index}].text`, 500),
    };
  });

  const sources = value.sources.map((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new Error(`Codex source ${index + 1} must be an object.`);
    }
    assertExactKeys(
      source,
      ["target", "title", "url", "supports"],
      `source ${index + 1}`,
    );

    const target = validateText(
      source.target,
      `sources[${index}].target`,
      20,
    );
    if (!knownTargets.has(target)) {
      throw new Error(`Codex source target "${target}" is invalid.`);
    }
    return {
      target,
      title: validateText(source.title, `sources[${index}].title`, 200),
      url: validateHttpUrl(source.url, `sources[${index}].url`),
      supports: validateText(
        source.supports,
        `sources[${index}].supports`,
        300,
      ),
    };
  });

  if (value.outcome === "applied" && edits.length === 0) {
    throw new Error('An "applied" Codex plan must contain an edit.');
  }
  if (value.outcome !== "applied" && edits.length > 0) {
    throw new Error(
      `A "${value.outcome}" Codex plan cannot contain edits.`,
    );
  }
  if (
    value.outcome === "needs_input" &&
    !comments.some((comment) => comment.kind === "question")
  ) {
    throw new Error(
      'A "needs_input" Codex plan must contain a question comment.',
    );
  }
  if (value.outcome === "no_change" && comments.length === 0) {
    throw new Error(
      'A "no_change" Codex plan must contain an explanatory comment.',
    );
  }
  if (value.research === "completed" && sources.length === 0) {
    throw new Error(
      'A Codex plan with completed research must contain a source.',
    );
  }
  if (value.research !== "completed" && sources.length > 0) {
    throw new Error(
      `A Codex plan with research "${value.research}" cannot contain sources.`,
    );
  }
  if (
    value.research === "unavailable" &&
    (value.outcome !== "no_change" ||
      edits.length > 0 ||
      !comments.some((comment) => comment.kind === "warning"))
  ) {
    throw new Error(
      "Unavailable research requires no changes and a warning comment.",
    );
  }

  return {
    outcome: value.outcome,
    research: value.research,
    edits,
    comments,
    sources,
  };
}

function validateText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Codex field "${field}" must be non-empty text.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`Codex field "${field}" is too long.`);
  }
  return trimmed;
}

function validateHttpUrl(value, field) {
  const text = validateText(value, field, 2048);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Codex field "${field}" must be a valid URL.`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(`Codex field "${field}" must be a public http(s) URL.`);
  }
  return url.href;
}

function assertExactKeys(value, keys, label) {
  const expected = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length || missing.length) {
    throw new Error(
      `Codex ${label} has missing or unexpected fields.`,
    );
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
  graph = DEFAULT_GRAPH,
  client = new AppServerClient(),
  trace = createTraceWriter(),
} = {}) {
  if (!token) throw new Error("A bridge bearer token is required.");
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

  return createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (!isAllowedOrigin(origin)) {
      sendJson(response, 403, { error: "Origin is not allowed." }, null);
      return;
    }

    if (request.method === "OPTIONS") {
      const headers = {
        "access-control-allow-origin": origin || "https://roamresearch.com",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
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

    if (request.method === "GET" && request.url === "/health") {
      sendJson(
        response,
        200,
        {
          ok: true,
          graph,
          appServer: client.ready ? "ready" : "idle",
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
      sendJson(response, 200, { graph, token }, origin);
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

      if (body.graph && body.graph !== graph) {
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
        });
        writeNdjson(response, {
          type: "error",
          runId,
          error: error.message || "Chat failed.",
          code: error.code,
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
      if (!run || run.kind !== "chat" || !pendingApproval) {
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
      if (body.graph && body.graph !== graph) {
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
    if (body.graph && body.graph !== graph) {
      sendJson(
        response,
        400,
        { error: `This bridge is restricted to graph "${graph}".` },
        origin,
      );
      return;
    }
    if (activeRunsByBlockUid.has(blockUid)) {
      sendJson(
        response,
        409,
        { error: "A probe is already running for this block." },
        origin,
      );
      return;
    }

    const runId = randomUUID();
    const startedAt = Date.now();
    const activeRun = {
      kind: "probe",
      runId,
      blockUid,
      threadId: null,
      turnId: null,
      cancelRequested: false,
      interruptPromise: null,
    };
    activeRunsByBlockUid.set(blockUid, activeRun);
    activeRunsById.set(runId, activeRun);
    await trace({ runId, event: "probe.started", graph, blockUid });
    startNdjson(response, origin);
    writeNdjson(response, { type: "started", runId });

    try {
      const result = await client.runProbe({
        graph,
        blockUid,
        onProgress: (progress) => {
          writeNdjson(response, { type: "progress", ...progress });
        },
        onStarted: async ({ threadId, turnId }) => {
          activeRun.threadId = threadId;
          activeRun.turnId = turnId;
          if (activeRun.cancelRequested) await interruptRun(activeRun);
        },
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
        event: "probe.completed",
        graph,
        blockUid,
        durationMs: payload.durationMs,
        threadId: result.threadId,
        turnId: result.turnId,
        plan: result.plan,
      });
      writeNdjson(response, { type: "completed", result: payload });
    } catch (error) {
      await trace({
        runId,
        event:
          error.code === "TURN_INTERRUPTED"
            ? "probe.interrupted"
            : "probe.failed",
        graph,
        blockUid,
        durationMs: Date.now() - startedAt,
        error: error.message,
        code: error.code,
      });
      writeNdjson(response, {
        type: "error",
        runId,
        error: error.message || "Probe failed.",
        code: error.code,
      });
    } finally {
      activeRunsByBlockUid.delete(blockUid);
      activeRunsById.delete(runId);
      response.end();
    }
  });
}

export async function ensureBridgeToken(
  tokenPath = resolve(ROOT, ".dev", "bridge-token"),
) {
  if (process.env.ROAM_CODEX_BRIDGE_TOKEN) {
    return process.env.ROAM_CODEX_BRIDGE_TOKEN;
  }

  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (existing) {
      await chmod(tokenPath, 0o600);
      return existing;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return token;
}

async function main() {
  const token = await ensureBridgeToken();
  if (process.argv.includes("--show-token")) {
    process.stdout.write(`${token}\n`);
    return;
  }

  const host = process.env.ROAM_CODEX_HOST || DEFAULT_HOST;
  const port = Number(process.env.ROAM_CODEX_PORT || DEFAULT_PORT);
  const graph = process.env.ROAM_GRAPH || DEFAULT_GRAPH;
  const client = new AppServerClient({ runtimeCwd: runtimeCwdForGraph(graph) });
  const server = createBridgeServer({ token, graph, client });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });

  process.stdout.write(
    [
      `Roam Codex bridge listening on http://${host}:${port}`,
      `Graph: ${graph}`,
      `Pairing token: npm run show-token`,
      `Trace: ${resolve(ROOT, ".dev", "last-run.jsonl")}`,
      "",
    ].join("\n"),
  );

  const shutdown = async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await client.stop();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
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
