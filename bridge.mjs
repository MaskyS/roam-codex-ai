import { spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 47321;
const DEFAULT_GRAPH = "maskys";
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PROGRESS_TEXT_LENGTH = 240;
const RUNTIME_ROAM_TOOLS = [
  "get_graph_guidelines",
  "get_block",
  "get_page",
  "get_backlinks",
  "search",
  "get_comments",
];
const RUNTIME_DISABLED_MCP_SERVERS = [
  "Railway",
  "computer-use",
  "node_repl",
  "paper_access_mock",
  "railway",
  "felt",
  "paper",
  "supabase",
];

export function runtimeAppServerArgs({
  roamHome = resolve(ROOT, ".dev", "roam-home"),
} = {}) {
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
    `mcp_servers.roam.env={HOME=${JSON.stringify(roamHome)}}`,
    "-c",
    `mcp_servers.roam.enabled_tools=${JSON.stringify(RUNTIME_ROAM_TOOLS)}`,
    ...RUNTIME_DISABLED_MCP_SERVERS.flatMap((server) => [
      "-c",
      `mcp_servers.${server}.enabled=false`,
    ]),
  ];
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
    cwd = ROOT,
    command = process.env.CODEX_BIN || "codex",
    spawnProcess = spawn,
    stderr = process.stderr,
  } = {}) {
    super();
    this.cwd = cwd;
    this.command = command;
    this.spawnProcess = spawnProcess;
    this.stderr = stderr;
    this.child = null;
    this.startPromise = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
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
    const child = this.spawnProcess(
      this.command,
      runtimeAppServerArgs(),
      {
        cwd: this.cwd,
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
      },
      30_000,
    );
    this.notify("initialized", {});
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
      this.#rejectServerRequest(message);
      return;
    }

    if (message.method) {
      this.emit("notification", {
        method: message.method,
        params: message.params || {},
      });
    }
  }

  #rejectServerRequest(message) {
    this.#send({
      id: message.id,
      error: {
        code: -32601,
        message:
          `Interactive app-server request "${message.method}" is not ` +
          "supported by this read-only prototype.",
      },
    });
  }

  #handleExit(error) {
    if (!this.child) return;
    this.child = null;
    this.ready = false;
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

  async stop() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (!child) return;
    child.stdin.end();
    child.kill("SIGTERM");
  }

  async runProbe({
    graph = DEFAULT_GRAPH,
    blockUid,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onProgress = () => {},
    onStarted = () => {},
  }) {
    await this.start();

    const threadResult = await this.request("thread/start", {
      cwd: this.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "roam_codex_lab",
      ephemeral: true,
      developerInstructions: [
        "You are the research and planning runtime for a Roam editing command.",
        `Operate only on the Roam graph nickname "${graph}".`,
        "Use only the allowlisted Roam MCP read tools.",
        "Do not use the shell, filesystem tools, or any write tool.",
        "Use built-in web search for current or external information.",
        "The Roam extension—not you—will apply your bounded edit plan.",
        "Do not ask the user for interactive input.",
        "Return the requested JSON object and no Markdown outside its fields.",
      ].join(" "),
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

    const timer = setTimeout(() => {
      rejectCompletion(
        rpcError("Timed out waiting for the Codex turn.", "TURN_TIMEOUT"),
      );
    }, timeoutMs);

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
      clearTimeout(timer);
      this.off("notification", processNotification);
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
      response.writeHead(204, {
        "access-control-allow-origin": origin || "https://roamresearch.com",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "600",
        vary: "Origin",
      });
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
        event: "probe.cancel.requested",
        graph,
        blockUid: run.blockUid,
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
  const client = new AppServerClient();
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
