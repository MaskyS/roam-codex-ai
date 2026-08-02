const BRIDGE_URL = "http://127.0.0.1:47321";
const GRAPH = "maskys";
const TOKEN_KEY = "roam-codex-lab.bridge-token";
const RUNNING_STATUS_KEY = "roam-codex-lab.running-status-uids";
const ACTIVE_BLOCK_UIDS = new Set();
const ACTIVE_PRESENTATIONS = new Map();
const RUNNING_BLOCK_CLASS = "roam-codex-running-block";
const RUNNING_BADGE_CLASS = "roam-codex-running-status";
const RUNNING_META_CLASS = "roam-codex-running-meta";
const RUNNING_TIMER_CLASS = "roam-codex-running-timer";
const RUNNING_CANCEL_CLASS = "roam-codex-running-cancel";
const RUNNING_SUMMARY_CLASS = "roam-codex-running-summary";
const CHAT_PANEL_ID = "roam-codex-chat-panel";
const CHAT_CONTROLS_ID = "roam-codex-chat-controls";
const CHAT_PANEL_CLASS = "roam-codex-chat-panel";
const SIDEBAR_CHAT_LAUNCHER_ID = "roam-codex-sidebar-chat-launcher";
const CHAT_STATE_VERSION = 2;
const CHAT_STATE_KEY = `roam-codex-lab.chat-state.v${CHAT_STATE_VERSION}.${GRAPH}`;
const INSTALLATION_ID_KEY = `roam-codex-lab.installation-id.${GRAPH}`;
const THREAD_PAGE_PREFIX = "Codex/thread/";
const THREAD_ID_FIELD = "Codex thread::";
const THREAD_ORIGIN_FIELD = "Origin installation::";
const THREAD_CREATED_FIELD = "Created at::";
const THREAD_ACTIVE_FIELD = "Last active at::";
const CHAT_TRANSCRIPT_HEIGHT_KEY = `roam-codex-lab.chat-transcript-height.${GRAPH}`;
const CHAT_TRANSCRIPT_MIN_HEIGHT = 140;
const CHAT_TRANSCRIPT_MAX_HEIGHT = 640;
const CHAT_SCROLL_BOTTOM_THRESHOLD = 24;
const CHAT_ACCESS_MODES = new Set(["auto", "read-only", "manual"]);
const ENABLED_MCP_SERVERS_SETTING = "enabled-mcp-servers";
const NATIVE_WINDOW_HEADER_CLASS = "roam-codex-native-window-header";
const NATIVE_COMPOSER_CLASS = "roam-codex-native-composer";
let ACTIVE_CHAT_PANEL = null;
let SIDEBAR_CHAT_LAUNCHER = null;
let CHAT_PANEL_OPEN_PROMISE = null;
let CHAT_PANEL_CLOSE_PROMISE = null;
let CHAT_TOGGLE_HOTKEY_DISPOSE = null;
let EXTENSION_SETTINGS = null;
const CHAT_TOGGLE_HOTKEY_KEY = "__roamCodexToggleHotkeyDispose";

export const RUNNING_BLOCK_TEXT = "[[Codex/running]]";
// Roam sometimes records a zero-width-only block as an open sidebar window
// without rendering a corresponding React host. A non-breaking space remains
// visually empty while ensuring the temporary composer block is renderable.
export const CHAT_COMPOSER_PLACEHOLDER = "\u00A0";

function emptyChatState() {
  return {
    version: CHAT_STATE_VERSION,
    activeThreadId: null,
    newConversationPreferences: {
      model: null,
      effort: null,
      speed: null,
      access: "auto",
    },
    conversations: {},
  };
}

function sanitizeEnabledMcpServers(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.filter((name) =>
      typeof name === "string" &&
      name.trim() &&
      name.length <= 64 &&
      !/[\u0000-\u001f]/.test(name)
    ),
  )].slice(0, 32);
}

function validThreadId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function validBlockUid(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(value);
}

export function readChatState({
  storage = window.localStorage,
  key = CHAT_STATE_KEY,
} = {}) {
  let value;
  try {
    value = JSON.parse(storage.getItem(key) || "null");
  } catch {
    return emptyChatState();
  }

  if (!value || value.version !== CHAT_STATE_VERSION) {
    return emptyChatState();
  }

  const conversations = {};
  for (const [threadId, record] of Object.entries(value.conversations || {})) {
    if (!validThreadId(threadId) || record?.threadId !== threadId) continue;
    conversations[threadId] = {
      threadId,
      createdAt: Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
      model: typeof record.model === "string" ? record.model : null,
      effort: typeof record.effort === "string" ? record.effort : null,
      speed: typeof record.speed === "string" ? record.speed : null,
      access: CHAT_ACCESS_MODES.has(record.access) ? record.access : "auto",
      threadPageUid: typeof record.threadPageUid === "string"
        ? record.threadPageUid
        : null,
      threadPageTitle: typeof record.threadPageTitle === "string" &&
          record.threadPageTitle.startsWith(THREAD_PAGE_PREFIX)
        ? record.threadPageTitle
        : null,
      originInstallationId: typeof record.originInstallationId === "string"
        ? record.originInstallationId
        : null,
      lastSeenUpdatedAt: Number.isFinite(record.lastSeenUpdatedAt)
        ? record.lastSeenUpdatedAt
        : 0,
      availability: ["available", "missing", "unavailable", "pending"].includes(
          record.availability,
        )
        ? record.availability
        : "pending",
      pendingGraphIndex: record.pendingGraphIndex === true,
    };
  }

  const activeThreadId = validThreadId(value.activeThreadId) &&
      conversations[value.activeThreadId]
    ? value.activeThreadId
    : null;

  return {
    version: CHAT_STATE_VERSION,
    activeThreadId,
    newConversationPreferences: {
      model: typeof value.newConversationPreferences?.model === "string"
        ? value.newConversationPreferences.model
        : null,
      effort: typeof value.newConversationPreferences?.effort === "string"
        ? value.newConversationPreferences.effort
        : null,
      speed: typeof value.newConversationPreferences?.speed === "string"
        ? value.newConversationPreferences.speed
        : null,
      access: CHAT_ACCESS_MODES.has(value.newConversationPreferences?.access)
        ? value.newConversationPreferences.access
        : "auto",
    },
    conversations,
  };
}

export function writeChatState(
  state,
  { storage = window.localStorage, key = CHAT_STATE_KEY } = {},
) {
  storage.setItem(key, JSON.stringify({ ...state, version: CHAT_STATE_VERSION }));
}

function getRoamApi() {
  if (!window.roamAlphaAPI) {
    throw new Error("Roam Alpha API is unavailable.");
  }
  return window.roamAlphaAPI;
}

function getToken() {
  return window.localStorage.getItem(TOKEN_KEY)?.trim() || "";
}

function notify(message, intent = "primary") {
  const api = getRoamApi();
  if (api.ui?.toaster?.show) {
    api.ui.toaster.show({
      id: `roam-codex-${Date.now()}`,
      intent,
      message,
      timeout: 5000,
    });
    return;
  }
  console.log(`[Roam Codex] ${message}`);
}

export async function requestProbe(blockUid, {
  fetchImpl = window.fetch.bind(window),
  token = getToken(),
  onProgress = () => {},
  onStarted = () => {},
} = {}) {
  if (!token) {
    throw new Error(
      'No bridge token. Run "Codex: Pair local bridge" first.',
    );
  }

  const response = await fetchImpl(`${BRIDGE_URL}/probe`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: GRAPH, blockUid }),
  });

  if (!response.ok) {
    let body = {};
    try {
      body = await response.json();
    } catch {
      // A useful status error is emitted below.
    }
    throw new Error(body.error || `Bridge returned HTTP ${response.status}.`);
  }

  if (
    response.headers.get("content-type")?.includes("application/x-ndjson")
  ) {
    return readProbeStream(response, { onProgress, onStarted });
  }

  return response.json();
}

export async function readProbeStream(
  response,
  {
    onProgress = () => {},
    onStarted = () => {},
    onThread = () => {},
    onApproval = () => {},
  } = {},
) {
  if (!response.body?.getReader) {
    throw new Error("This browser cannot read streamed Codex progress.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let result;

  const processLine = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("The bridge emitted an invalid progress event.");
    }

    if (event.type === "started" && typeof event.runId === "string") {
      try {
        onStarted({ runId: event.runId });
      } catch {
        // A presentation problem must not cancel the underlying Codex turn.
      }
    } else if (
      event.type === "conversation" &&
      typeof event.threadId === "string"
    ) {
      try {
        onThread({ threadId: event.threadId });
      } catch {
        // Local conversation persistence must not cancel the Codex turn.
      }
    } else if (event.type === "progress" && typeof event.text === "string") {
      try {
        onProgress({ kind: event.kind || "activity", text: event.text });
      } catch {
        // A presentation problem must not cancel the underlying Codex turn.
      }
    } else if (
      event.type === "approval" &&
      typeof event.approvalId === "string" &&
      Array.isArray(event.questions)
    ) {
      try {
        onApproval({
          approvalId: event.approvalId,
          questions: event.questions,
        });
      } catch {
        // The bridge keeps the approval pending so the turn can still be stopped.
      }
    } else if (event.type === "completed") {
      result = event.result;
    } else if (event.type === "error") {
      const error = new Error(event.error || "Codex could not finish the run.");
      error.code = event.code;
      throw error;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) processLine(line);
    if (done) break;
  }
  processLine(pending);

  if (!result) {
    throw new Error("The bridge stream ended before Codex returned a result.");
  }
  return result;
}

async function bridgeJson(path, {
  fetchImpl = window.fetch.bind(window),
  token = getToken(),
} = {}) {
  if (!token) {
    throw new Error(
      'No bridge token. Run "Codex: Pair local bridge" first.',
    );
  }

  const response = await fetchImpl(`${BRIDGE_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    // A useful status error is emitted below.
  }
  if (!response.ok) {
    const error = new Error(
      body.error || `Bridge returned HTTP ${response.status}.`,
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function requestPanelModels(options = {}) {
  const result = await bridgeJson("/models", options);
  return Array.isArray(result.models) ? result.models : [];
}

export async function requestPanelMcpServers(options = {}) {
  const result = await bridgeJson("/mcp-servers", options);
  return sanitizeEnabledMcpServers(result.servers);
}

export async function requestPanelThreadSummaries(threadIds, {
  fetchImpl = window.fetch.bind(window),
  token = getToken(),
} = {}) {
  if (!token) {
    throw new Error(
      'No bridge token. Run "Codex: Pair local bridge" first.',
    );
  }
  if (
    !Array.isArray(threadIds) ||
    threadIds.length > 100 ||
    threadIds.some((threadId) => !validThreadId(threadId)) ||
    new Set(threadIds).size !== threadIds.length
  ) {
    throw new Error("Conversation history requires at most 100 unique thread IDs.");
  }

  const response = await fetchImpl(`${BRIDGE_URL}/threads/summaries`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: GRAPH, threadIds }),
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    // A useful status error is emitted below.
  }
  if (!response.ok) {
    throw new Error(
      result.error || `Bridge returned HTTP ${response.status}.`,
    );
  }
  return {
    threads: Array.isArray(result.threads) ? result.threads : [],
    missingThreadIds: Array.isArray(result.missingThreadIds)
      ? result.missingThreadIds
      : [],
    unavailableThreadIds: Array.isArray(result.unavailableThreadIds)
      ? result.unavailableThreadIds
      : [],
  };
}

export async function requestPanelMessages(threadId, options = {}) {
  if (!validThreadId(threadId)) {
    throw new Error("Cannot load a conversation without a valid thread ID.");
  }
  const result = await bridgeJson(
    `/threads/${encodeURIComponent(threadId)}/messages`,
    options,
  );
  return Array.isArray(result.messages) ? result.messages : [];
}

export async function requestPanelThreadName(threadId, name, {
  fetchImpl = window.fetch.bind(window),
  token = getToken(),
} = {}) {
  if (!token) {
    throw new Error('No bridge token. Run "Codex: Pair local bridge" first.');
  }
  const cleanName = singleLine(name);
  if (!validThreadId(threadId) || !cleanName || cleanName.length > 100) {
    throw new Error("A valid conversation and name are required.");
  }
  const response = await fetchImpl(
    `${BRIDGE_URL}/threads/${encodeURIComponent(threadId)}/name`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ graph: GRAPH, name: cleanName }),
    },
  );
  let result = {};
  try {
    result = await response.json();
  } catch {
    // A useful status error is emitted below.
  }
  if (!response.ok) {
    throw new Error(result.error || `Bridge returned HTTP ${response.status}.`);
  }
  return result;
}

export async function requestPanelChat(message, {
  fetchImpl = window.fetch.bind(window),
  token = getToken(),
  promptBlockUid,
  threadId = null,
  model = null,
  effort = null,
  serviceTier,
  accessMode = "auto",
  enabledServers = [],
  onProgress = () => {},
  onStarted = () => {},
  onThread = () => {},
  onApproval = () => {},
} = {}) {
  if (!token) {
    throw new Error(
      'No bridge token. Run "Codex: Pair local bridge" first.',
    );
  }
  if (!validBlockUid(promptBlockUid)) {
    throw new Error("Cannot chat without a valid Roam prompt block UID.");
  }

  const body = {
    graph: GRAPH,
    message: String(message),
    promptBlockUid,
  };
  if (threadId) body.threadId = threadId;
  if (model) body.model = model;
  if (effort) body.effort = effort;
  if (serviceTier !== undefined) body.serviceTier = serviceTier;
  body.accessMode = CHAT_ACCESS_MODES.has(accessMode) ? accessMode : "auto";
  const sanitizedServers = sanitizeEnabledMcpServers(enabledServers);
  if (sanitizedServers.length) body.enabledServers = sanitizedServers;

  const response = await fetchImpl(`${BRIDGE_URL}/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let result = {};
    try {
      result = await response.json();
    } catch {
      // A useful status error is emitted below.
    }
    throw new Error(
      result.error || `Bridge returned HTTP ${response.status}.`,
    );
  }

  return readProbeStream(response, {
    onProgress,
    onStarted,
    onThread,
    onApproval,
  });
}

export async function requestRunApproval(runId, approvalId, decision, {
  fetchImpl = window.fetch.bind(window),
  token = getToken(),
} = {}) {
  if (!token) {
    throw new Error(
      'No bridge token. Run "Codex: Pair local bridge" first.',
    );
  }
  if (!/^[0-9a-f-]{36}$/i.test(runId) || !/^[0-9a-f-]{36}$/i.test(approvalId)) {
    throw new Error("A valid active approval is required.");
  }
  if (!["accept", "reject"].includes(decision)) {
    throw new Error("A valid approval decision is required.");
  }
  const response = await fetchImpl(
    `${BRIDGE_URL}/runs/${runId}/approvals/${approvalId}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision }),
    },
  );
  let result = {};
  try {
    result = await response.json();
  } catch {
    // A useful status error is emitted below.
  }
  if (!response.ok) {
    throw new Error(result.error || `Bridge returned HTTP ${response.status}.`);
  }
  return result;
}

export async function requestRunCancellation(runId, {
  fetchImpl = window.fetch.bind(window),
  token = getToken(),
} = {}) {
  if (!token) {
    throw new Error(
      'No bridge token. Run "Codex: Pair local bridge" first.',
    );
  }
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    throw new Error("Cannot stop a run without a valid run ID.");
  }

  const response = await fetchImpl(
    `${BRIDGE_URL}/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    },
  );
  let result = {};
  try {
    result = await response.json();
  } catch {
    // A useful status error is emitted below.
  }
  if (!response.ok) {
    throw new Error(result.error || `Bridge returned HTTP ${response.status}.`);
  }
  return result;
}

function singleLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function threadPageLabel(title) {
  return typeof title === "string" && title.startsWith(THREAD_PAGE_PREFIX)
    ? singleLine(title.slice(THREAD_PAGE_PREFIX.length))
    : "";
}

function readableThreadLabel(value, timestamp = Date.now()) {
  const cleaned = singleLine(value)
    .replace(/\[\[|\]\]/g, "")
    .replace(/[\r\n/#]+/g, " · ")
    .replace(/\s*·\s*/g, " · ")
    .slice(0, 80)
    .trim();
  return cleaned || `Untitled · ${conversationDateLabel(timestamp)}`;
}

function storageInstallationId({
  storage = window.localStorage,
  key = INSTALLATION_ID_KEY,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const existing = storage.getItem(key)?.trim();
  if (/^[A-Za-z0-9_-]{8,128}$/.test(existing || "")) return existing;
  const random = cryptoImpl?.randomUUID?.() || [
    Date.now().toString(36),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ].join("-");
  const installationId = `install_${random}`.replace(/[^A-Za-z0-9_-]/g, "_");
  storage.setItem(key, installationId);
  return installationId;
}

function fieldChildren(page, label) {
  return (page?.[":block/children"] || page?.children || [])
    .filter((child) => typeof (child?.[":block/string"] ?? child?.string) === "string")
    .filter((child) =>
      (child[":block/string"] ?? child.string).startsWith(`${label} `)
    )
    .map((child) => ({
      uid: child[":block/uid"] ?? child.uid,
      value: singleLine(
        (child[":block/string"] ?? child.string).slice(label.length),
      ),
    }));
}

async function pullThreadPage(api, pageUid) {
  const pattern = [
    "[:block/uid :node/title",
    "{:block/children [:block/uid :block/string :block/order]}]",
  ].join(" ");
  if (api.data?.async?.pull) {
    return api.data.async.pull(pattern, [":block/uid", pageUid]);
  }
  return api.data?.pull?.(pattern, [":block/uid", pageUid]) || null;
}

async function threadPageRows(api) {
  if (typeof api.q !== "function") return [];
  try {
    return api.q(
      "[:find ?uid ?title :in $ ?prefix :where " +
        "[?page :block/uid ?uid] [?page :node/title ?title] " +
        "[(clojure.string/starts-with? ?title ?prefix)]]",
      THREAD_PAGE_PREFIX,
    ) || [];
  } catch {
    const rows = api.q(
      "[:find ?uid ?title :where " +
        "[?page :block/uid ?uid] [?page :node/title ?title]]",
    ) || [];
    return rows.filter((row) =>
      Array.isArray(row) && String(row[1] || "").startsWith(THREAD_PAGE_PREFIX)
    );
  }
}

export async function readGraphThreadIndex({ api = getRoamApi() } = {}) {
  const rows = await Promise.resolve(threadPageRows(api));
  const uniqueRows = [...new Map(
    rows
      .filter((row) =>
        Array.isArray(row) &&
        typeof row[0] === "string" &&
        typeof row[1] === "string" &&
        row[1].startsWith(THREAD_PAGE_PREFIX)
      )
      .map((row) => [row[0], row]),
  ).values()].slice(0, 500);
  const pages = (await Promise.all(
    uniqueRows.map(async ([pageUid, title]) => {
      const page = await pullThreadPage(api, pageUid);
      if (!page) return null;
      return { page, pageUid, title };
    }),
  )).filter(Boolean);

  const records = [];
  const errors = [];
  for (const entry of pages) {
    const ids = fieldChildren(entry.page, THREAD_ID_FIELD);
    if (ids.length !== 1 || !validThreadId(ids[0]?.value)) {
      errors.push({
        pageUid: entry.pageUid,
        title: entry.title,
        error: ids.length > 1
          ? "Thread page contains multiple Codex thread IDs."
          : "Thread page does not contain one valid Codex thread ID.",
      });
      continue;
    }
    const origins = fieldChildren(entry.page, THREAD_ORIGIN_FIELD);
    const created = fieldChildren(entry.page, THREAD_CREATED_FIELD);
    const active = fieldChildren(entry.page, THREAD_ACTIVE_FIELD);
    if (origins.length > 1 || created.length > 1 || active.length > 1) {
      errors.push({
        pageUid: entry.pageUid,
        title: entry.title,
        threadId: ids[0].value,
        error: "Thread page contains duplicate metadata fields.",
      });
      continue;
    }
    records.push({
      threadId: ids[0].value,
      threadPageUid: entry.pageUid,
      threadPageTitle: entry.title,
      originInstallationId: origins[0]?.value || null,
      createdAt: Date.parse(created[0]?.value || "") || 0,
      lastActiveAt: Date.parse(active[0]?.value || "") || 0,
      metadataUids: {
        threadId: ids[0].uid,
        origin: origins[0]?.uid || null,
        createdAt: created[0]?.uid || null,
        lastActiveAt: active[0]?.uid || null,
      },
    });
  }

  const byThreadId = new Map();
  for (const record of records) {
    const group = byThreadId.get(record.threadId) || [];
    group.push(record);
    byThreadId.set(record.threadId, group);
  }
  const duplicateIds = new Set();
  for (const [threadId, group] of byThreadId) {
    if (group.length < 2) continue;
    duplicateIds.add(threadId);
    for (const record of group) {
      errors.push({
        pageUid: record.threadPageUid,
        title: record.threadPageTitle,
        threadId,
        error: "Codex thread ID is indexed by more than one thread page.",
      });
    }
  }
  return {
    records: records.filter((record) => !duplicateIds.has(record.threadId)),
    errors,
  };
}

async function exactPageUid(api, title) {
  if (typeof api.q !== "function") return null;
  return api.q(
    "[:find ?uid . :in $ ?title :where " +
      "[?page :node/title ?title] [?page :block/uid ?uid]]",
    title,
  ) || null;
}

function generatedRoamUid(api) {
  return api.util?.generateUID?.() || Math.random().toString(36).slice(2, 11);
}

async function createMetadataBlock(api, pageUid, order, string) {
  const uid = generatedRoamUid(api);
  await api.data.block.create({
    location: { "parent-uid": pageUid, order },
    block: { uid, string },
  });
  return uid;
}

export async function ensureGraphThreadRecord({
  api = getRoamApi(),
  storage = window.localStorage,
  threadId,
  title,
  timestamp = Date.now(),
} = {}) {
  if (!validThreadId(threadId)) {
    throw new Error("Cannot index a conversation without a valid thread ID.");
  }
  if (!api.data?.page?.create || !api.data?.block?.create) {
    throw new Error("Roam graph writes are unavailable for the thread index.");
  }

  const index = await readGraphThreadIndex({ api });
  const existing = index.records.find((record) => record.threadId === threadId);
  if (existing) {
    const installationId = existing.originInstallationId ||
      storageInstallationId({ storage });
    const createdAt = existing.createdAt || timestamp;
    const lastActiveAt = existing.lastActiveAt || createdAt;
    const metadataUids = { ...existing.metadataUids };
    if (!metadataUids.origin) {
      metadataUids.origin = await createMetadataBlock(
        api,
        existing.threadPageUid,
        1,
        `${THREAD_ORIGIN_FIELD} ${installationId}`,
      );
    }
    if (!metadataUids.createdAt) {
      metadataUids.createdAt = await createMetadataBlock(
        api,
        existing.threadPageUid,
        2,
        `${THREAD_CREATED_FIELD} ${new Date(createdAt).toISOString()}`,
      );
    }
    if (!metadataUids.lastActiveAt) {
      metadataUids.lastActiveAt = await createMetadataBlock(
        api,
        existing.threadPageUid,
        3,
        `${THREAD_ACTIVE_FIELD} ${new Date(lastActiveAt).toISOString()}`,
      );
    }
    return {
      ...existing,
      originInstallationId: installationId,
      createdAt,
      lastActiveAt,
      metadataUids,
    };
  }
  if (index.errors.some((error) => error.threadId === threadId)) {
    throw new Error("The graph contains an ambiguous record for this Codex thread.");
  }

  const installationId = storageInstallationId({ storage });
  const iso = new Date(timestamp).toISOString();
  const baseTitle = `${THREAD_PAGE_PREFIX}${readableThreadLabel(title, timestamp)}`;
  let pageTitle = baseTitle;
  let suffix = 2;
  while (await Promise.resolve(exactPageUid(api, pageTitle))) {
    pageTitle = `${baseTitle} · ${suffix}`;
    suffix += 1;
  }
  const pageUid = generatedRoamUid(api);
  await api.data.page.create({ page: { uid: pageUid, title: pageTitle } });
  const metadataUids = {
    threadId: await createMetadataBlock(
      api,
      pageUid,
      0,
      `${THREAD_ID_FIELD} ${threadId}`,
    ),
    origin: await createMetadataBlock(
      api,
      pageUid,
      1,
      `${THREAD_ORIGIN_FIELD} ${installationId}`,
    ),
    createdAt: await createMetadataBlock(
      api,
      pageUid,
      2,
      `${THREAD_CREATED_FIELD} ${iso}`,
    ),
    lastActiveAt: await createMetadataBlock(
      api,
      pageUid,
      3,
      `${THREAD_ACTIVE_FIELD} ${iso}`,
    ),
  };
  return {
    threadId,
    threadPageUid: pageUid,
    threadPageTitle: pageTitle,
    originInstallationId: installationId,
    createdAt: timestamp,
    lastActiveAt: timestamp,
    metadataUids,
  };
}

export async function updateGraphThreadActivity(
  record,
  timestamp,
  { api = getRoamApi() } = {},
) {
  if (!record?.metadataUids?.lastActiveAt || !api.data?.block?.update) {
    return record;
  }
  if (Number.isFinite(record.lastActiveAt) && record.lastActiveAt >= timestamp) {
    return record;
  }
  await api.data.block.update({
    block: {
      uid: record.metadataUids.lastActiveAt,
      string: `${THREAD_ACTIVE_FIELD} ${new Date(timestamp).toISOString()}`,
    },
  });
  return { ...record, lastActiveAt: timestamp };
}

function serverTimestampMs(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function conversationDateLabel(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function buildConversationHistory(state, summaries = []) {
  const summaryByThreadId = new Map(
    summaries
      .filter((summary) => validThreadId(summary?.id))
      .map((summary) => [summary.id, summary]),
  );
  return Object.values(state?.conversations || {})
    .filter((record) => validThreadId(record?.threadId))
    .map((record) => {
      const summary = summaryByThreadId.get(record.threadId) || null;
      const graphTitle = threadPageLabel(record.threadPageTitle);
      const name = singleLine(summary?.name || "");
      const preview = singleLine(summary?.preview || "");
      const createdAt = serverTimestampMs(summary?.createdAt) ||
        record.createdAt;
      const updatedAt = Math.max(
        serverTimestampMs(summary?.updatedAt),
        Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
      );
      return {
        threadId: record.threadId,
        title: graphTitle || name || preview ||
          `Untitled${createdAt ? ` · ${conversationDateLabel(createdAt)}` : ""}`,
        createdAt,
        updatedAt,
        active: state.activeThreadId === record.threadId,
        availability: record.availability || "pending",
      };
    })
    .sort((left, right) =>
      right.updatedAt - left.updatedAt ||
      right.createdAt - left.createdAt ||
      left.threadId.localeCompare(right.threadId)
    );
}

function readRunningStatusUids(storage) {
  try {
    const value = JSON.parse(storage.getItem(RUNNING_STATUS_KEY) || "[]");
    return Array.isArray(value)
      ? value.filter((uid) => typeof uid === "string")
      : [];
  } catch {
    return [];
  }
}

function writeRunningStatusUids(storage, uids) {
  if (uids.length) {
    storage.setItem(RUNNING_STATUS_KEY, JSON.stringify([...new Set(uids)]));
  } else {
    storage.removeItem(RUNNING_STATUS_KEY);
  }
}

function rememberRunningStatus(storage, statusUid) {
  writeRunningStatusUids(storage, [
    ...readRunningStatusUids(storage),
    statusUid,
  ]);
}

function forgetRunningStatus(storage, statusUid) {
  writeRunningStatusUids(
    storage,
    readRunningStatusUids(storage).filter((uid) => uid !== statusUid),
  );
}

export async function createRunningStatus(
  blockUid,
  {
    api = getRoamApi(),
    storage = window.localStorage,
  } = {},
) {
  const statusUid = api.util.generateUID();
  rememberRunningStatus(storage, statusUid);
  try {
    await api.data.block.create({
      location: { "parent-uid": blockUid, order: "last" },
      block: {
        uid: statusUid,
        string: RUNNING_BLOCK_TEXT,
      },
    });
  } catch (error) {
    forgetRunningStatus(storage, statusUid);
    throw error;
  }
  return statusUid;
}

export async function removeRunningStatus(
  statusUid,
  {
    api = getRoamApi(),
    storage = window.localStorage,
  } = {},
) {
  await api.data.block.delete({ block: { uid: statusUid } });
  forgetRunningStatus(storage, statusUid);
}

export async function cleanupStaleRunningStatuses({
  api = getRoamApi(),
  storage = window.localStorage,
} = {}) {
  const remaining = [];
  let removed = 0;

  for (const statusUid of readRunningStatusUids(storage)) {
    try {
      await api.data.block.delete({ block: { uid: statusUid } });
      removed += 1;
    } catch {
      remaining.push(statusUid);
    }
  }

  writeRunningStatusUids(storage, remaining);
  return removed;
}

export function formatRunningElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function runningPresentationText(elapsedMs, progressText = "") {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const state = singleLine(progressText) ||
    (totalSeconds < 5
      ? "Starting"
      : totalSeconds < 45
        ? "Working"
        : "Still working");
  return `${state} · ${formatRunningElapsed(elapsedMs)}`;
}

function runningStateText(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 5) return "Starting";
  if (totalSeconds < 45) return "Working";
  return "Still working";
}

function findRunningBlockContainers(doc, statusUid) {
  if (!doc?.querySelectorAll || !/^[A-Za-z0-9_-]+$/.test(statusUid)) {
    return [];
  }

  const containers = new Set();
  const nodes = [
    ...(doc.getElementById
      ? [doc.getElementById(`block-input-${statusUid}`)].filter(Boolean)
      : []),
    ...doc.querySelectorAll(`[data-uid="${statusUid}"]`),
    ...doc.querySelectorAll(`[data-block-uid="${statusUid}"]`),
  ];

  for (const node of nodes) {
    const container = node.matches?.(".roam-block-container")
      ? node
      : node.closest?.(".roam-block-container");
    if (container) containers.add(container);
  }
  return [...containers];
}

export function startRunningPresentation(
  statusUid,
  {
    doc = globalThis.document,
    now = Date.now,
    setIntervalImpl = globalThis.setInterval?.bind(globalThis),
    clearIntervalImpl = globalThis.clearInterval?.bind(globalThis),
  } = {},
) {
  ACTIVE_PRESENTATIONS.get(statusUid)?.();

  if (
    !doc?.createElement ||
    !doc?.querySelectorAll ||
    !setIntervalImpl ||
    !clearIntervalImpl
  ) {
    return () => {};
  }

  const startedAt = now();
  const decorated = new Map();
  let progressText = "";
  let cancelHandler = null;
  let cancelling = false;
  let stopped = false;

  const cancel = async () => {
    if (stopped || cancelling || !cancelHandler) return;
    cancelling = true;
    progressText = "Stopping";
    sync();
    try {
      await cancelHandler();
    } catch {
      cancelling = false;
      progressText = "Could not stop the run";
      sync();
    }
  };

  const sync = () => {
    if (stopped) return;
    const elapsedMs = now() - startedAt;
    const elapsedText = formatRunningElapsed(elapsedMs);
    const summaryText = progressText || runningStateText(elapsedMs);

    for (const container of findRunningBlockContainers(doc, statusUid)) {
      let badge = container.querySelector?.(`.${RUNNING_BADGE_CLASS}`);
      if (!badge) {
        badge = doc.createElement("span");
        badge.className = RUNNING_BADGE_CLASS;
        badge.setAttribute("aria-live", "off");

        const meta = doc.createElement("span");
        meta.className = RUNNING_META_CLASS;

        const timer = doc.createElement("span");
        timer.className = RUNNING_TIMER_CLASS;
        meta.appendChild(timer);

        const cancelButton = doc.createElement("button");
        cancelButton.className = RUNNING_CANCEL_CLASS;
        cancelButton.type = "button";
        cancelButton.textContent = "Stop";
        cancelButton.title = "Stop this Codex run";
        cancelButton.addEventListener("click", cancel);
        meta.appendChild(cancelButton);

        badge.appendChild(meta);

        const summary = doc.createElement("span");
        summary.className = RUNNING_SUMMARY_CLASS;
        badge.appendChild(summary);

        const host = container.querySelector?.(".rm-block-main") || container;
        host.appendChild(badge);
      }

      const meta = badge.querySelector?.(`.${RUNNING_META_CLASS}`);
      const timer = meta?.querySelector?.(`.${RUNNING_TIMER_CLASS}`);
      const cancelButton = meta?.querySelector?.(`.${RUNNING_CANCEL_CLASS}`);
      const summary = badge.querySelector?.(`.${RUNNING_SUMMARY_CLASS}`);
      if (timer) timer.textContent = elapsedText;
      if (cancelButton) {
        cancelButton.hidden = !cancelHandler;
        cancelButton.disabled = cancelling;
        cancelButton.textContent = cancelling ? "Stopping…" : "Stop";
      }
      if (summary) summary.textContent = summaryText;
      badge.title = progressText
        ? `${progressText}\nLocal progress; the Roam block is not being updated.`
        : "Local elapsed timer; the Roam block is not being updated.";
      badge.setAttribute(
        "aria-label",
        `Codex ${summaryText.toLowerCase()}, elapsed ${elapsedText}`,
      );
      container.classList?.add(RUNNING_BLOCK_CLASS);
      decorated.set(container, badge);
    }
  };

  const update = (progress) => {
    if (stopped) return;
    const value = typeof progress === "string" ? progress : progress?.text;
    if (typeof value !== "string") return;
    const nextText = singleLine(value);
    if (!nextText || nextText === progressText) return;
    progressText = nextText;
    sync();
  };

  sync();
  const intervalId = setIntervalImpl(sync, 1000);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearIntervalImpl(intervalId);
    for (const [container, badge] of decorated) {
      badge.remove?.();
      container.classList?.remove(RUNNING_BLOCK_CLASS);
    }
    decorated.clear();
    if (ACTIVE_PRESENTATIONS.get(statusUid) === stop) {
      ACTIVE_PRESENTATIONS.delete(statusUid);
    }
  };

  stop.update = update;
  stop.setCancelHandler = (handler) => {
    cancelHandler = typeof handler === "function" ? handler : null;
    sync();
  };

  ACTIVE_PRESENTATIONS.set(statusUid, stop);
  return stop;
}

export function stopAllRunningPresentations() {
  for (const stop of [...ACTIVE_PRESENTATIONS.values()]) stop();
}

function formatComment(comment) {
  return `**Codex** — ${singleLine(comment.text)}`;
}

function escapeMarkdownLinkText(value) {
  return singleLine(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("]", "\\]");
}

function formatSource(source) {
  const title = escapeMarkdownLinkText(source.title);
  const url = String(source.url).replaceAll("(", "%28").replaceAll(")", "%29");
  return `[${title}](${url}) — ${singleLine(source.supports)}`;
}

function formatSourcesComment(sources) {
  return [
    "- **Codex** — Sources",
    ...sources.map((source) => `  - ${formatSource(source)}`),
  ].join("\n");
}

function commentToOpenIndex(comments) {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    if (
      comments[index].kind === "question" ||
      comments[index].kind === "warning"
    ) {
      return index;
    }
  }
  return comments.length - 1;
}

export async function applyRunPlan(
  sourceBlockUid,
  plan,
  {
    api = getRoamApi(),
  } = {},
) {
  if (
    !plan ||
    !Array.isArray(plan.edits) ||
    !Array.isArray(plan.comments) ||
    !Array.isArray(plan.sources)
  ) {
    throw new Error("Bridge returned an invalid edit plan.");
  }

  const targetUids = new Map([["source", sourceBlockUid]]);
  const createdUids = [];

  for (const edit of plan.edits) {
    const parentUid = targetUids.get(edit.parent);
    if (!parentUid) {
      throw new Error(`Edit "${edit.id}" has an unknown parent.`);
    }

    const uid = api.util.generateUID();
    await api.data.block.create({
      location: { "parent-uid": parentUid, order: "last" },
      block: {
        uid,
        string: singleLine(edit.text),
      },
    });
    targetUids.set(edit.id, uid);
    createdUids.push(uid);
  }

  const sourcesByTarget = new Map();
  for (const source of plan.sources) {
    if (!targetUids.has(source.target)) {
      throw new Error("A Codex source has an unknown target.");
    }
    const group = sourcesByTarget.get(source.target) || [];
    group.push(source);
    sourcesByTarget.set(source.target, group);
  }

  const commentUids = [];
  const sourceCommentUids = [];
  const openFirstSourceComment = plan.comments.length === 0;
  let sourceCommentIndex = 0;
  for (const [target, sources] of sourcesByTarget) {
    const result = await api.data.block.addComment({
      "block-uid": targetUids.get(target),
      "reply-markdown": formatSourcesComment(sources),
      "open-comment": openFirstSourceComment && sourceCommentIndex === 0,
    });
    const uids = result?.uids || [];
    sourceCommentUids.push(...uids);
    commentUids.push(...uids);
    sourceCommentIndex += 1;
  }

  const openedCommentIndex = commentToOpenIndex(plan.comments);
  for (const [index, comment] of plan.comments.entries()) {
    const targetUid = targetUids.get(comment.target);
    if (!targetUid) {
      throw new Error("A Codex comment has an unknown target.");
    }

    const result = await api.data.block.addComment({
      "block-uid": targetUid,
      "reply-string": formatComment(comment),
      "open-comment": index === openedCommentIndex,
    });
    commentUids.push(...(result?.uids || []));
  }

  return {
    outcome: plan.outcome,
    research: plan.research,
    createdUids,
    sourceCommentUids,
    commentUids,
  };
}

export async function workOnBlock(
  blockUid,
  {
    api = getRoamApi(),
    storage = window.localStorage,
    request = requestProbe,
    cancelRequest = requestRunCancellation,
    notifyImpl = notify,
    startPresentation = startRunningPresentation,
  } = {},
) {
  if (!blockUid) {
    notifyImpl("Focus the block you want Codex to work on.", "warning");
    return null;
  }
  if (ACTIVE_BLOCK_UIDS.has(blockUid)) {
    notifyImpl("Codex is already running on this block.", "warning");
    return null;
  }

  ACTIVE_BLOCK_UIDS.add(blockUid);
  let statusUid;
  let stopPresentation;
  let applied;
  let failure;

  try {
    statusUid = await createRunningStatus(blockUid, { api, storage });
    stopPresentation = startPresentation(statusUid);
    const run = await request(blockUid, {
      onProgress: (progress) => stopPresentation?.update?.(progress),
      onStarted: ({ runId }) => {
        stopPresentation?.setCancelHandler?.(() => cancelRequest(runId));
      },
    });
    applied = await applyRunPlan(blockUid, run.plan, { api });
  } catch (error) {
    failure = error;
  } finally {
    stopPresentation?.();
    if (statusUid) {
      try {
        await removeRunningStatus(statusUid, { api, storage });
      } catch (error) {
        failure ||= new Error(
          `Run finished, but its running indicator could not be removed: ${error.message}`,
        );
      }
    }
    ACTIVE_BLOCK_UIDS.delete(blockUid);
  }

  if (failure) {
    if (failure.code === "TURN_INTERRUPTED") {
      notifyImpl("Codex stopped.", "primary");
      return {
        outcome: "stopped",
        research: "not_needed",
        createdUids: [],
        sourceCommentUids: [],
        commentUids: [],
      };
    }
    notifyImpl(`Codex could not finish: ${failure.message}`, "danger");
    throw failure;
  }

  if (applied.outcome === "applied") {
    const commentSuffix = applied.commentUids.length
      ? " Comments are open in the sidebar."
      : "";
    const action = applied.sourceCommentUids.length
      ? "researched and updated"
      : "updated";
    notifyImpl(`Codex ${action} the outline.${commentSuffix}`, "success");
  } else if (applied.outcome === "needs_input") {
    notifyImpl("Codex needs input in the comments sidebar.", "warning");
  } else {
    notifyImpl("Codex left a comment without changing the outline.", "primary");
  }

  return applied;
}

export function findChatPanelHost(
  doc = globalThis.document,
  sidebarWindow,
) {
  const windowId = sidebarWindow?.["window-id"];
  if (typeof windowId !== "string" || !windowId) return null;
  return doc?.getElementById?.(`sidebar-window-${windowId}`) || null;
}

async function waitForChatPanelHost(
  doc,
  sidebarWindow,
  {
    attempts = 80,
    waitImpl = (resolveWait) => setTimeout(resolveWait, 50),
  } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const host = findChatPanelHost(doc, sidebarWindow);
    if (host) return host;
    await new Promise(waitImpl);
  }
  throw new Error("Roam's native prompt window did not become available.");
}

function createPanelElement(doc, tag, className, text = "") {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

export function renderRoamMarkdown(
  element,
  string,
  { api = getRoamApi() } = {},
) {
  const value = typeof string === "string" ? string : "";
  const renderString = api.ui?.components?.renderString;
  if (typeof renderString !== "function") {
    element.textContent = value;
    return Promise.resolve(false);
  }
  return Promise.resolve(renderString({ el: element, string: value }))
    .then(() => true)
    .catch(() => {
      element.textContent = value;
      return false;
    });
}

export function unmountRoamMarkdown(
  element,
  { api = getRoamApi() } = {},
) {
  const unmountNode = api.ui?.components?.unmountNode;
  if (typeof unmountNode !== "function") return Promise.resolve(false);
  return Promise.resolve(unmountNode({ el: element }))
    .then(() => true)
    .catch(() => false);
}

export function copyRoamText(
  string,
  { navigatorImpl = globalThis.navigator } = {},
) {
  const value = typeof string === "string" ? string : "";
  const writeText = navigatorImpl?.clipboard?.writeText;
  if (typeof writeText !== "function") {
    return Promise.reject(new Error("Clipboard access is unavailable."));
  }
  return Promise.resolve(writeText.call(navigatorImpl.clipboard, value));
}

function panelButton(doc, className, label, title) {
  const button = createPanelElement(doc, "button", className, label);
  button.type = "button";
  if (title) button.title = title;
  return button;
}

function directChildWithClass(element, className) {
  return Array.from(element?.children || []).find((child) =>
    String(child.className || "").split(/\s+/).includes(className)
  ) || null;
}

function rightSidebarVisible(sidebar, doc) {
  if (!sidebar || sidebar.hidden) return false;
  const style = doc.defaultView?.getComputedStyle?.(sidebar);
  if (style?.display === "none" || style?.visibility === "hidden") return false;
  const rect = sidebar.getBoundingClientRect?.();
  if (rect && Number.isFinite(rect.width) && rect.width <= 1) return false;
  return true;
}

export function findSidebarChatLauncherPlacement(doc = globalThis.document) {
  const sidebar = doc?.getElementById?.("right-sidebar");
  const content = doc?.getElementById?.("roam-right-sidebar-content");
  if (!sidebar || !content || !rightSidebarVisible(sidebar, doc)) return null;
  const header = directChildWithClass(sidebar, "flex-h-box") ||
    sidebar.querySelector?.(":scope > .flex-h-box") || null;
  if (!header) return null;
  const nativeToggle = Array.from(header.children || []).find((child) =>
    child?.tagName?.toLowerCase?.() === "button" &&
    child.id !== SIDEBAR_CHAT_LAUNCHER_ID
  ) || null;
  if (!nativeToggle) return null;
  return { sidebar, content, header, nativeToggle };
}

function activeChatPanelIsOpen() {
  return Boolean(ACTIVE_CHAT_PANEL?.element?.isConnected);
}

export function cleanupStaleChatUi(doc = globalThis.document) {
  doc?.getElementById?.(CHAT_PANEL_ID)?.remove?.();
  doc?.getElementById?.(CHAT_CONTROLS_ID)?.remove?.();
  for (const element of doc?.querySelectorAll?.(".roam-codex-chat-header") || []) {
    element.remove?.();
  }
  for (const element of doc?.querySelectorAll?.(".roam-codex-chat-toolbar") || []) {
    element.classList?.remove?.("roam-codex-chat-toolbar");
  }
  for (const element of doc?.querySelectorAll?.(".roam-codex-chat-window") || []) {
    element.classList?.remove?.("roam-codex-chat-window");
  }
  for (const element of doc?.querySelectorAll?.(`.${NATIVE_WINDOW_HEADER_CLASS}`) || []) {
    element.classList?.remove?.(NATIVE_WINDOW_HEADER_CLASS);
  }
  for (const shell of doc?.querySelectorAll?.(".roam-codex-chat-composer-shell") || []) {
    const nativeComposer = shell.querySelector?.(".roam-codex-native-composer");
    if (nativeComposer && shell.parentNode) {
      shell.parentNode.insertBefore?.(nativeComposer, shell);
    }
    shell.remove?.();
  }
  for (const element of doc?.querySelectorAll?.(`.${NATIVE_COMPOSER_CLASS}`) || []) {
    element.classList?.remove?.(NATIVE_COMPOSER_CLASS);
  }
}

function updateSidebarChatLauncherState(button, chatOpen) {
  const open = Boolean(chatOpen);
  button.dataset.chatOpen = open ? "true" : "false";
  button.setAttribute("aria-pressed", open ? "true" : "false");
  if (button.dataset.state === "idle") {
    button.title = open ? "Close Codex chat" : "Open Codex chat";
    button.setAttribute(
      "aria-label",
      open ? "Close Codex chat" : "Open Codex chat",
    );
  }
}

export function mountSidebarChatLauncher({
  doc = globalThis.document,
  openChatImpl = openChatPanel,
  closeChatImpl = closeChatPanel,
  isChatOpenImpl = activeChatPanelIsOpen,
  notifyImpl = notify,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  const existing = doc?.getElementById?.(SIDEBAR_CHAT_LAUNCHER_ID);
  const placement = findSidebarChatLauncherPlacement(doc);
  if (!placement) {
    existing?.roamCodexDispose?.();
    existing?.remove?.();
    return null;
  }
  // A developer-extension reload evaluates a new module while the old DOM
  // node can remain in Roam. Replace it so no stale listener, disabled flag,
  // or in-flight visual state survives the reload.
  existing?.roamCodexDispose?.();
  existing?.remove?.();

  const button = panelButton(
    doc,
    "bp3-button bp3-minimal roam-codex-sidebar-chat-launcher",
    "",
    "Open Codex chat",
  );
  button.id = SIDEBAR_CHAT_LAUNCHER_ID;
  button.dataset.state = "idle";
  updateSidebarChatLauncherState(button, isChatOpenImpl());
  const icon = createPanelElement(
    doc,
    "span",
    "roam-codex-sidebar-chat-launcher-icon",
  );
  icon.setAttribute("aria-hidden", "true");
  button.appendChild(icon);

  let feedbackTimer = null;
  button.roamCodexDispose = () => {
    if (feedbackTimer !== null) clearTimeoutImpl(feedbackTimer);
    feedbackTimer = null;
  };
  button.addEventListener("click", async () => {
    if (["opening", "closing"].includes(button.dataset.state)) return;
    button.roamCodexDispose();
    const closing = isChatOpenImpl();
    button.dataset.state = closing ? "closing" : "opening";
    button.disabled = true;
    button.title = closing ? "Closing Codex chat" : "Opening Codex chat";
    try {
      await (closing ? closeChatImpl() : openChatImpl());
      if (!button.isConnected) return;
      button.dataset.state = "idle";
      updateSidebarChatLauncherState(button, isChatOpenImpl());
    } catch (error) {
      if (!button.isConnected) return;
      button.dataset.state = "error";
      button.title = closing
        ? "Codex chat could not close"
        : "Codex chat could not open";
      const action = closing ? "close" : "open";
      notifyImpl(`Codex chat could not ${action}: ${error.message}`, "danger");
      feedbackTimer = setTimeoutImpl(() => {
        feedbackTimer = null;
        if (!button.isConnected) return;
        button.dataset.state = "idle";
        updateSidebarChatLauncherState(button, isChatOpenImpl());
      }, 1_400);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });

  placement.header.insertBefore(
    button,
    placement.header.firstChild || placement.nativeToggle,
  );
  placement.header.classList?.add?.("roam-codex-chat-toolbar");
  return button;
}

export function installSidebarChatLauncher({
  doc = globalThis.document,
  MutationObserverImpl = doc?.defaultView?.MutationObserver ||
    globalThis.MutationObserver,
  requestAnimationFrameImpl = doc?.defaultView?.requestAnimationFrame?.bind(
    doc.defaultView,
  ) || ((callback) => globalThis.setTimeout(callback, 0)),
  cancelAnimationFrameImpl = doc?.defaultView?.cancelAnimationFrame?.bind(
    doc.defaultView,
  ) || globalThis.clearTimeout,
  ...mountOptions
} = {}) {
  let disposed = false;
  let scheduled = null;
  let mountedButton = null;
  const sync = () => {
    scheduled = null;
    if (disposed) return null;
    const placement = findSidebarChatLauncherPlacement(doc);
    if (
      mountedButton?.isConnected &&
      placement?.header === mountedButton.parentNode
    ) {
      placement.header.classList?.add?.("roam-codex-chat-toolbar");
      const isOpen = typeof mountOptions.isChatOpenImpl === "function"
        ? mountOptions.isChatOpenImpl()
        : activeChatPanelIsOpen();
      updateSidebarChatLauncherState(mountedButton, isOpen);
      return mountedButton;
    }
    mountedButton = mountSidebarChatLauncher({ doc, ...mountOptions });
    return mountedButton;
  };
  const schedule = () => {
    if (disposed || scheduled !== null) return;
    scheduled = requestAnimationFrameImpl(sync);
  };
  const observer = typeof MutationObserverImpl === "function"
    ? new MutationObserverImpl((mutations) => {
      const sidebar = doc?.getElementById?.("right-sidebar");
      if (!sidebar || mutations.some((mutation) =>
        mutation.target === sidebar || sidebar.contains?.(mutation.target)
      )) {
        schedule();
      }
    })
    : null;
  const observationRoot = doc?.body || doc?.documentElement;
  if (observer && observationRoot) {
    observer.observe(observationRoot, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
      childList: true,
      subtree: true,
    });
  }
  sync();
  return {
    sync,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      observer?.disconnect?.();
      if (scheduled !== null) cancelAnimationFrameImpl(scheduled);
      scheduled = null;
      const button = mountedButton?.isConnected
        ? mountedButton
        : doc?.getElementById?.(SIDEBAR_CHAT_LAUNCHER_ID);
      button?.roamCodexDispose?.();
      button?.parentNode?.classList?.remove?.("roam-codex-chat-toolbar");
      button?.remove?.();
      mountedButton = null;
    },
  };
}

function modelEfforts(model) {
  return Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
        .map((option) => option?.reasoningEffort)
        .filter((effort) => typeof effort === "string")
    : [];
}

function modelTiers(model) {
  return Array.isArray(model?.serviceTiers)
    ? model.serviceTiers.filter((tier) => typeof tier?.id === "string")
    : [];
}

function modelTierChoices(model) {
  const tiers = modelTiers(model);
  if (!tiers.length) return [];
  if (tiers.some((tier) => tier.id === "standard")) return tiers;
  return [{
    id: "",
    name: "Standard",
    description: "Default speed",
    synthetic: true,
  }, ...tiers];
}

function effortLabel(effort) {
  const value = String(effort).replaceAll(/[-_]+/g, " ");
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

export function findSidebarBlockWindow(
  blockUid,
  { api = getRoamApi() } = {},
) {
  const windows = api.ui?.rightSidebar?.getWindows?.() || [];
  return windows.find(
    (sidebarWindow) =>
      sidebarWindow?.type === "block" &&
      sidebarWindow["block-uid"] === blockUid,
  ) || null;
}

async function waitForSidebarBlockWindow(
  blockUid,
  api,
  {
    attempts = 80,
    waitImpl = (resolveWait) => setTimeout(resolveWait, 50),
  } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const sidebarWindow = findSidebarBlockWindow(blockUid, { api });
    if (sidebarWindow) return sidebarWindow;
    await new Promise(waitImpl);
  }
  throw new Error("Roam did not open the prompt block in the right sidebar.");
}

export async function openPromptBlockInSidebar(
  blockUid,
  {
    api = getRoamApi(),
    waitOptions,
  } = {},
) {
  if (!validBlockUid(blockUid)) {
    throw new Error("Focus an ordinary Roam block before opening Codex chat.");
  }

  // A window can remain in getWindows() while the sidebar is hidden at zero
  // width. addWindow identifies windows by type + target UID, so repeating it
  // is the supported way to ensure the existing prompt window is visible too.
  await api.ui.rightSidebar.addWindow({
    window: { type: "block", "block-uid": blockUid, order: 0 },
  });
  let sidebarWindow = findSidebarBlockWindow(blockUid, { api });
  if (!sidebarWindow) {
    sidebarWindow = await waitForSidebarBlockWindow(
      blockUid,
      api,
      waitOptions,
    );
  }
  if (sidebarWindow["collapsed?"]) {
    await api.ui.rightSidebar.expandWindow({
      window: { type: "block", "block-uid": blockUid },
    });
  }
  return sidebarWindow;
}

export function normalizeChatPromptText(value) {
  return typeof value === "string"
    ? value.split(CHAT_COMPOSER_PLACEHOLDER).join("").trim()
    : "";
}

function snapshotChatPromptOutline(block) {
  return {
    uid: block?.[":block/uid"] || null,
    string: typeof block?.[":block/string"] === "string"
      ? block[":block/string"]
      : "",
    children: (block?.[":block/children"] || []).map(snapshotChatPromptOutline),
  };
}

function findChatPromptPath(block, targetUid, path = []) {
  if (!block || !validBlockUid(targetUid)) return null;
  const nextPath = [...path, block];
  if (block[":block/uid"] === targetUid) return nextPath;
  for (const child of block[":block/children"] || []) {
    const childPath = findChatPromptPath(child, targetUid, nextPath);
    if (childPath) return childPath;
  }
  return null;
}

function sameChatPromptOutline(left, right) {
  if (!left || !right) return false;
  if (left.uid !== right.uid || left.string !== right.string) return false;
  if (left.children.length !== right.children.length) return false;
  return left.children.every(
    (child, index) => sameChatPromptOutline(child, right.children[index]),
  );
}

function outlineContainsProtectedUid(outline, protectedPromptUids) {
  if (!(protectedPromptUids instanceof Set)) return false;
  if (protectedPromptUids.has(outline?.uid)) return true;
  return (outline?.children || []).some(
    (child) => outlineContainsProtectedUid(child, protectedPromptUids),
  );
}

function resetChatPromptSnapshot(
  prompt,
  { rootBlockUid = null, scratchPrompt = false } = {},
) {
  return scratchPrompt
    ? {
      uid: rootBlockUid,
      text: prompt?.rootOutline?.string,
      outline: prompt?.rootOutline,
    }
    : prompt;
}

export async function readFocusedPromptBlock(
  rootBlockUid,
  { api = getRoamApi() } = {},
) {
  const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
  const focused = api.ui?.getFocusedBlock?.();
  if (
    !sidebarWindow?.["window-id"] ||
    !validBlockUid(focused?.["block-uid"]) ||
    focused["window-id"] !== sidebarWindow["window-id"]
  ) {
    throw new Error("Focus the Roam block you want to send in the Block Outline.");
  }

  const uid = focused["block-uid"];
  const pattern = "[:block/uid :block/string {:block/children ...}]";
  const pull = api.data?.async?.pull
    ? await api.data.async.pull(pattern, [":block/uid", uid])
    : api.data?.pull?.(pattern, [":block/uid", uid]);
  let rootPull = pull;
  if (uid !== rootBlockUid) {
    rootPull = api.data?.async?.pull
      ? await api.data.async.pull(pattern, [":block/uid", rootBlockUid])
      : api.data?.pull?.(pattern, [":block/uid", rootBlockUid]);
  }
  let promptPull = pull;
  let text = normalizeChatPromptText(promptPull?.[":block/string"]);
  if (!text && rootPull) {
    const focusedPath = findChatPromptPath(rootPull, uid) || [];
    promptPull = focusedPath
      .slice(0, -1)
      .reverse()
      .find((block) => normalizeChatPromptText(block?.[":block/string"])) ||
      promptPull;
    text = normalizeChatPromptText(promptPull?.[":block/string"]);
  }
  if (!text) {
    throw new Error("Write a message in this Roam outline before sending.");
  }
  return {
    uid: promptPull[":block/uid"],
    text,
    outline: snapshotChatPromptOutline(promptPull),
    rootOutline: snapshotChatPromptOutline(rootPull),
  };
}

async function pullUid(uid, api) {
  if (api.data?.async?.pull) {
    return api.data.async.pull("[:block/uid]", [":block/uid", uid]);
  }
  return api.data?.pull?.("[:block/uid]", [":block/uid", uid]) || null;
}

async function ensureDailyNotePage(date, api) {
  const uid = api.util?.dateToPageUid?.(date);
  const title = api.util?.dateToPageTitle?.(date);
  if (!validBlockUid(uid) || typeof title !== "string" || !title) {
    throw new Error("Roam could not resolve today's Daily Note.");
  }
  if (await pullUid(uid, api)) return uid;

  try {
    await api.data.page.create({ page: { title } });
  } catch (error) {
    // Another Roam event may have created today's page between the read and
    // write. Only suppress that race when the expected page now exists.
    if (!await pullUid(uid, api)) throw error;
  }
  return uid;
}

export async function resolveChatPromptBlock(
  blockUid,
  {
    api = getRoamApi(),
    date = new Date(),
  } = {},
) {
  if (blockUid !== undefined && blockUid !== null) {
    if (!validBlockUid(blockUid)) {
      throw new Error("Codex chat received an invalid Roam block UID.");
    }
    return { uid: blockUid, scratch: false };
  }

  const focusedBlockUid = api.ui?.getFocusedBlock?.()?.["block-uid"];
  if (
    validBlockUid(focusedBlockUid) &&
    await pullUid(focusedBlockUid, api)
  ) {
    return { uid: focusedBlockUid, scratch: false };
  }

  let parentUid = await api.ui?.mainWindow?.getOpenPageOrBlockUid?.();
  if (!validBlockUid(parentUid)) {
    parentUid = await ensureDailyNotePage(date, api);
  }

  const uid = api.util?.generateUID?.();
  if (!validBlockUid(uid)) {
    throw new Error("Roam could not create a prompt block UID.");
  }
  await api.data.block.create({
    location: { "parent-uid": parentUid, order: "last" },
    block: { uid, string: CHAT_COMPOSER_PLACEHOLDER },
  });
  return { uid, scratch: true, parentUid };
}

export async function removeScratchPromptBlock(
  blockUid,
  { api = getRoamApi() } = {},
) {
  if (!validBlockUid(blockUid)) return;
  if (findSidebarBlockWindow(blockUid, { api })) {
    await api.ui.rightSidebar.removeWindow({
      window: { type: "block", "block-uid": blockUid },
    });
  }
  await api.data.block.delete({ block: { uid: blockUid } });
}

export async function clearScratchPromptBlock(
  prompt,
  {
    api = getRoamApi(),
    protectedPromptUids = null,
    rootBlockUid = null,
    scratchPrompt = false,
  } = {},
) {
  const resetPrompt = resetChatPromptSnapshot(prompt, {
    rootBlockUid,
    scratchPrompt,
  });
  if (
    !validBlockUid(resetPrompt?.uid) ||
    typeof resetPrompt?.text !== "string"
  ) {
    return false;
  }
  const pattern = "[:block/uid :block/string {:block/children ...}]";
  const pull = api.data?.async?.pull
    ? await api.data.async.pull(pattern, [":block/uid", resetPrompt.uid])
    : api.data?.pull?.(pattern, [":block/uid", resetPrompt.uid]);
  const currentText = pull?.[":block/string"];
  if (
    typeof currentText !== "string" ||
    normalizeChatPromptText(currentText) !==
      normalizeChatPromptText(resetPrompt.text)
  ) {
    return false;
  }

  const currentOutline = snapshotChatPromptOutline(pull);
  if (
    resetPrompt.outline &&
    !sameChatPromptOutline(currentOutline, resetPrompt.outline)
  ) {
    return false;
  }

  // Mark the root as the empty composer before removing its submitted
  // descendants. If a later delete fails, restoration can distinguish this
  // reset-in-progress state from a user's newer draft.
  await api.data.block.update({
    block: { uid: resetPrompt.uid, string: CHAT_COMPOSER_PLACEHOLDER },
  });
  for (const child of currentOutline.children) {
    if (outlineContainsProtectedUid(child, protectedPromptUids)) continue;
    await api.data.block.delete({ block: { uid: child.uid } });
  }
  return true;
}

function outlineIsOrderedSubset(currentChildren, submittedChildren) {
  let submittedIndex = 0;
  for (const currentChild of currentChildren) {
    while (
      submittedIndex < submittedChildren.length &&
      submittedChildren[submittedIndex].uid !== currentChild.uid
    ) {
      submittedIndex += 1;
    }
    if (
      submittedIndex >= submittedChildren.length ||
      !sameChatPromptOutline(
        currentChild,
        submittedChildren[submittedIndex],
      )
    ) {
      return false;
    }
    submittedIndex += 1;
  }
  return true;
}

async function createChatPromptOutline(outline, parentUid, order, api) {
  await api.data.block.create({
    location: { "parent-uid": parentUid, order },
    block: { uid: outline.uid, string: outline.string },
  });
  for (const [childOrder, child] of outline.children.entries()) {
    await createChatPromptOutline(child, outline.uid, childOrder, api);
  }
}

export async function restoreClearedChatPromptBlock(
  prompt,
  {
    api = getRoamApi(),
    rootBlockUid = null,
    scratchPrompt = false,
  } = {},
) {
  const resetPrompt = resetChatPromptSnapshot(prompt, {
    rootBlockUid,
    scratchPrompt,
  });
  if (
    !validBlockUid(resetPrompt?.uid) ||
    !resetPrompt?.outline ||
    resetPrompt.outline.uid !== resetPrompt.uid
  ) {
    return false;
  }

  const pattern = "[:block/uid :block/string {:block/children ...}]";
  const pull = api.data?.async?.pull
    ? await api.data.async.pull(pattern, [":block/uid", resetPrompt.uid])
    : api.data?.pull?.(pattern, [":block/uid", resetPrompt.uid]);
  if (
    !pull ||
    normalizeChatPromptText(pull[":block/string"]) ||
    pull[":block/uid"] !== resetPrompt.uid
  ) {
    return false;
  }

  const currentOutline = snapshotChatPromptOutline(pull);
  if (!outlineIsOrderedSubset(
    currentOutline.children,
    resetPrompt.outline.children,
  )) {
    return false;
  }

  const currentChildUids = new Set(
    currentOutline.children.map((child) => child.uid),
  );
  for (const [order, child] of resetPrompt.outline.children.entries()) {
    if (currentChildUids.has(child.uid)) continue;
    await createChatPromptOutline(child, resetPrompt.uid, order, api);
  }
  await api.data.block.update({
    block: {
      uid: resetPrompt.uid,
      string: resetPrompt.outline.string,
    },
  });
  return true;
}

export async function removeResetChatPromptBlocks(
  blockUids,
  { api = getRoamApi() } = {},
) {
  const removed = [];
  if (!(blockUids instanceof Set)) return removed;

  for (const uid of blockUids) {
    if (!validBlockUid(uid)) continue;
    const pull = api.data?.async?.pull
      ? await api.data.async.pull(
        "[:block/uid :block/string]",
        [":block/uid", uid],
      )
      : api.data?.pull?.(
        "[:block/uid :block/string]",
        [":block/uid", uid],
      );
    if (pull?.[":block/string"] !== CHAT_COMPOSER_PLACEHOLDER) continue;
    await api.data.block.delete({ block: { uid } });
    removed.push(uid);
  }
  return removed;
}

function collectOutlineUids(block, uids) {
  const uid = block?.[":block/uid"];
  if (validBlockUid(uid)) uids.add(uid);
  for (const child of block?.[":block/children"] || []) {
    collectOutlineUids(child, uids);
  }
}

export async function readPromptOutlineUids(
  rootBlockUid,
  { api = getRoamApi() } = {},
) {
  if (!validBlockUid(rootBlockUid)) return new Set();
  const pattern = "[:block/uid {:block/children ...}]";
  const outline = api.data?.async?.pull
    ? await api.data.async.pull(pattern, [":block/uid", rootBlockUid])
    : api.data?.pull?.(pattern, [":block/uid", rootBlockUid]);
  const uids = new Set();
  collectOutlineUids(outline, uids);
  return uids;
}

export function shouldClearChatPrompt(
  promptUid,
  { scratchPrompt = false, protectedPromptUids = null } = {},
) {
  return scratchPrompt ||
    (protectedPromptUids instanceof Set &&
      !protectedPromptUids.has(promptUid));
}

export function createChatPanel({
  doc = globalThis.document,
  storage = window.localStorage,
  api = getRoamApi(),
  rootBlockUid,
  requestChatImpl = requestPanelChat,
  requestModelsImpl = requestPanelModels,
  requestMcpServersImpl = requestPanelMcpServers,
  readEnabledMcpServersImpl = () =>
    EXTENSION_SETTINGS?.get?.(ENABLED_MCP_SERVERS_SETTING),
  writeEnabledMcpServersImpl = (servers) =>
    EXTENSION_SETTINGS?.set?.(ENABLED_MCP_SERVERS_SETTING, servers),
  requestMessagesImpl = requestPanelMessages,
  requestHistoryImpl = requestPanelThreadSummaries,
  requestThreadNameImpl = requestPanelThreadName,
  requestGraphIndexImpl = () => readGraphThreadIndex({ api }),
  ensureGraphThreadImpl = (input) => ensureGraphThreadRecord({
    ...input,
    api,
    storage,
  }),
  updateGraphActivityImpl = (record, timestamp) =>
    updateGraphThreadActivity(record, timestamp, { api }),
  copyTextImpl = copyRoamText,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  setIntervalImpl = globalThis.setInterval?.bind(globalThis),
  clearIntervalImpl = globalThis.clearInterval?.bind(globalThis),
  matchMediaImpl = globalThis.matchMedia?.bind(globalThis),
  navigatorImpl = globalThis.navigator,
  readPromptImpl = () => readFocusedPromptBlock(rootBlockUid, { api }),
  clearScratchPromptImpl = (prompt) =>
    clearScratchPromptBlock(prompt, {
      api,
      protectedPromptUids,
      rootBlockUid,
      scratchPrompt,
    }),
  restorePromptImpl = (prompt) =>
    restoreClearedChatPromptBlock(prompt, {
      api,
      rootBlockUid,
      scratchPrompt,
    }),
  cancelRequest = requestRunCancellation,
  approvalRequest = requestRunApproval,
  protectedPromptUids = null,
  scratchPrompt = false,
  now = Date.now,
  onClose = () => {},
} = {}) {
  if (!doc?.createElement) {
    throw new Error("A document is required to create the Codex chat panel.");
  }
  if (!validBlockUid(rootBlockUid)) {
    throw new Error("The Codex chat panel requires a Roam block.");
  }

  let state = readChatState({ storage });
  let messages = [];
  let models = [];
  let modelsReady = false;
  let mcpServers = [];
  let enabledMcpServers = sanitizeEnabledMcpServers(
    readEnabledMcpServersImpl(),
  );
  let runId = null;
  let running = false;
  let runStartedAt = 0;
  let elapsedIntervalId = null;
  let closed = false;
  let idlePromise = Promise.resolve();
  let resolveIdle = null;
  let closePromise = null;
  const resetPromptUids = new Set();
  const threadSummaries = new Map();
  const graphThreadRecords = new Map();
  const threadIndexPromises = new Map();
  const mirroredThreadNames = new Set();
  let historyOpen = false;
  let historyLoadVersion = 0;
  let selectionLoadVersion = 0;
  let historyError = "";
  let modelChanged = !state.activeThreadId && Boolean(
    state.newConversationPreferences.model,
  );
  let effortChanged = !state.activeThreadId && Boolean(
    state.newConversationPreferences.effort,
  );
  let speedChanged = !state.activeThreadId && Boolean(
    state.newConversationPreferences.speed,
  );
  let pickerModel = "";
  let pickerEffort = "";
  let pickerSpeed = "";
  let pickerAccess = "auto";
  let pickerOpen = false;
  let pickerLevel = null;
  let messageRenderVersion = 0;
  const renderedMessageNodes = new Set();
  const copyFeedbackTimers = new Map();
  const approvalCards = new Map();

  const panel = createPanelElement(doc, "section", CHAT_PANEL_CLASS);
  panel.id = CHAT_PANEL_ID;
  panel.setAttribute("aria-label", "Codex chat");

  const header = createPanelElement(doc, "header", "roam-codex-chat-header");
  const heading = createPanelElement(doc, "div", "roam-codex-chat-heading");
  const conversationButton = panelButton(
    doc,
    "roam-codex-chat-conversation",
    "New chat",
    "Open conversation history",
  );
  conversationButton.setAttribute("aria-haspopup", "menu");
  conversationButton.setAttribute("aria-expanded", "false");
  heading.appendChild(conversationButton);
  header.appendChild(heading);
  const historyPopover = createPanelElement(
    doc,
    "div",
    "roam-codex-chat-history",
  );
  historyPopover.setAttribute("role", "menu");
  historyPopover.setAttribute("aria-label", "Conversation history");
  historyPopover.hidden = true;
  header.appendChild(historyPopover);
  const closeButton = panelButton(
    doc,
    "roam-codex-chat-close",
    "✕",
    "Close Codex chat",
  );
  closeButton.setAttribute("aria-label", "Close Codex chat");
  header.appendChild(closeButton);

  const body = createPanelElement(doc, "div", "roam-codex-chat-body");

  const transcriptWrap = createPanelElement(
    doc,
    "div",
    "roam-codex-chat-transcript-wrap",
  );
  const transcript = createPanelElement(doc, "div", "roam-codex-chat-transcript");
  transcript.setAttribute("role", "log");
  transcript.setAttribute("aria-live", "polite");
  transcriptWrap.appendChild(transcript);
  const scrollLatestButton = panelButton(
    doc,
    "roam-codex-chat-scroll-latest",
    "",
    "Scroll to latest message",
  );
  scrollLatestButton.setAttribute("aria-label", "Scroll to latest message");
  const scrollLatestIcon = createPanelElement(
    doc,
    "span",
    "roam-codex-chat-scroll-latest-icon",
    "↓",
  );
  scrollLatestIcon.setAttribute("aria-hidden", "true");
  scrollLatestButton.appendChild(scrollLatestIcon);
  scrollLatestButton.hidden = true;
  transcriptWrap.appendChild(scrollLatestButton);
  body.appendChild(transcriptWrap);

  const updateScrollLatestButton = () => {
    const scrollHeight = Number(transcript.scrollHeight) || 0;
    const clientHeight = Number(transcript.clientHeight) || 0;
    const scrollTop = Number(transcript.scrollTop) || 0;
    const overflowing = clientHeight > 0 && scrollHeight > clientHeight + 1;
    const distanceFromBottom = Math.max(
      0,
      scrollHeight - clientHeight - scrollTop,
    );
    scrollLatestButton.hidden =
      !messages.length ||
      !overflowing ||
      distanceFromBottom <= CHAT_SCROLL_BOTTOM_THRESHOLD;
  };
  const scrollToLatest = () => {
    const reduceMotion = Boolean(
      matchMediaImpl?.("(prefers-reduced-motion: reduce)")?.matches,
    );
    const top = Number(transcript.scrollHeight) || 0;
    if (typeof transcript.scrollTo === "function") {
      transcript.scrollTo({
        top,
        behavior: reduceMotion ? "auto" : "smooth",
      });
    } else {
      transcript.scrollTop = top;
    }
    scrollLatestButton.hidden = true;
  };
  transcript.addEventListener("scroll", updateScrollLatestButton);
  scrollLatestButton.addEventListener("click", scrollToLatest);

  const transcriptHandle = createPanelElement(
    doc,
    "div",
    "roam-codex-chat-resize",
  );
  transcriptHandle.setAttribute("role", "separator");
  transcriptHandle.setAttribute("aria-orientation", "horizontal");
  transcriptHandle.setAttribute("aria-label", "Resize the conversation area");
  transcriptHandle.hidden = false;
  body.appendChild(transcriptHandle);

  const progress = createPanelElement(doc, "div", "roam-codex-chat-progress");
  progress.setAttribute("aria-live", "polite");
  progress.hidden = true;
  const progressMeta = createPanelElement(
    doc,
    "span",
    "roam-codex-chat-progress-meta",
  );
  progressMeta.hidden = true;
  const progressTimer = createPanelElement(
    doc,
    "span",
    "roam-codex-chat-progress-timer",
  );
  progressMeta.appendChild(progressTimer);
  progress.appendChild(progressMeta);
  const progressText = createPanelElement(
    doc,
    "span",
    "roam-codex-chat-progress-text",
  );
  progress.appendChild(progressText);
  const approvalContainer = createPanelElement(
    doc,
    "div",
    "roam-codex-chat-approvals",
  );
  approvalContainer.hidden = true;
  transcript.appendChild(approvalContainer);
  transcript.appendChild(progress);

  const syncTranscriptStatus = ({ scroll = false } = {}) => {
    if (progress.parentNode !== transcript) transcript.appendChild(progress);
    transcript.hidden = !messages.length && progress.hidden &&
      approvalCards.size === 0;
    if (scroll && !progress.hidden) {
      transcript.scrollTop = transcript.scrollHeight;
      updateScrollLatestButton();
    }
  };

  const clampTranscriptHeight = (value) => Math.min(
    CHAT_TRANSCRIPT_MAX_HEIGHT,
    Math.max(CHAT_TRANSCRIPT_MIN_HEIGHT, Math.round(value)),
  );
  const setElementStyle = (element, property, value) => {
    if (element.style) element.style[property] = value;
  };
  const readStoredTranscriptHeight = () => {
    let value;
    try {
      value = Number.parseInt(storage.getItem(CHAT_TRANSCRIPT_HEIGHT_KEY), 10);
    } catch {
      return null;
    }
    return Number.isFinite(value) ? clampTranscriptHeight(value) : null;
  };
  const applyTranscriptHeight = (height) => {
    setElementStyle(transcriptWrap, "height", `${height}px`);
    setElementStyle(transcriptWrap, "maxHeight", `${height}px`);
    setElementStyle(transcript, "height", `${height}px`);
    setElementStyle(transcript, "maxHeight", `${height}px`);
  };
  let transcriptHeight = readStoredTranscriptHeight() ??
    CHAT_TRANSCRIPT_MAX_HEIGHT;
  applyTranscriptHeight(transcriptHeight);

  let transcriptResize = null;
  const handleTranscriptResizeMove = (event) => {
    if (!transcriptResize || !Number.isFinite(event?.clientY)) return;
    transcriptHeight = clampTranscriptHeight(
      transcriptResize.startHeight + (event.clientY - transcriptResize.startY),
    );
    applyTranscriptHeight(transcriptHeight);
    updateScrollLatestButton();
    event.preventDefault?.();
  };
  const stopTranscriptResize = () => {
    if (!transcriptResize) return;
    transcriptResize = null;
    doc.removeEventListener?.("pointermove", handleTranscriptResizeMove, true);
    doc.removeEventListener?.("pointerup", stopTranscriptResize, true);
    if (transcriptHeight === null) return;
    try {
      storage.setItem(CHAT_TRANSCRIPT_HEIGHT_KEY, String(transcriptHeight));
    } catch {
      // A device that cannot persist the height still keeps this session's.
    }
  };
  transcriptHandle.addEventListener("pointerdown", (event) => {
    if (!Number.isFinite(event?.clientY)) return;
    const measured = transcript.getBoundingClientRect?.()?.height;
    transcriptResize = {
      startY: event.clientY,
      startHeight: Number.isFinite(measured) && measured > 0
        ? measured
        : transcriptHeight ?? 300,
    };
    doc.addEventListener?.("pointermove", handleTranscriptResizeMove, true);
    doc.addEventListener?.("pointerup", stopTranscriptResize, true);
    event.preventDefault?.();
  });

  const modelRow = createPanelElement(doc, "div", "roam-codex-chat-model-row");
  const pickerWrap = createPanelElement(doc, "div", "roam-codex-chat-picker");
  const pickerButton = panelButton(
    doc,
    "roam-codex-chat-picker-button",
    "Loading models…",
    "Choose the model, reasoning effort, speed, and access",
  );
  pickerButton.setAttribute("aria-label", "Model, effort, speed, and access");
  pickerButton.setAttribute("aria-haspopup", "menu");
  pickerButton.setAttribute("aria-expanded", "false");
  pickerButton.disabled = true;
  pickerWrap.appendChild(pickerButton);
  const pickerMenu = createPanelElement(
    doc,
    "div",
    "roam-codex-chat-picker-menu",
  );
  pickerMenu.setAttribute("role", "menu");
  pickerMenu.setAttribute("aria-label", "Model, effort, speed, and access options");
  pickerMenu.hidden = true;
  pickerWrap.appendChild(pickerMenu);
  const pickerSubmenu = createPanelElement(
    doc,
    "div",
    "roam-codex-chat-picker-submenu",
  );
  pickerSubmenu.setAttribute("role", "menu");
  pickerSubmenu.hidden = true;
  pickerWrap.appendChild(pickerSubmenu);
  modelRow.appendChild(pickerWrap);
  const actions = createPanelElement(doc, "div", "roam-codex-chat-actions");
  const stopButton = panelButton(
    doc,
    "roam-codex-chat-stop",
    "Stop",
    "Stop the current Codex turn",
  );
  stopButton.hidden = true;
  actions.appendChild(stopButton);
  const sendShortcutIsMac = /Mac|iP(?:hone|ad|od)/i.test(
    navigatorImpl?.platform || navigatorImpl?.userAgent || "",
  );
  const sendButton = panelButton(
    doc,
    "roam-codex-chat-send",
    "Send",
    `Send the focused block in this chat's Block Outline (${
      sendShortcutIsMac ? "Option" : "Alt"
    }+Enter, rebindable in Settings → Hotkeys)`,
  );
  const sendShortcut = createPanelElement(
    doc,
    "kbd",
    "roam-codex-chat-send-kbd",
    sendShortcutIsMac ? "⌥↵" : "Alt ↵",
  );
  sendShortcut.setAttribute("aria-hidden", "true");
  sendButton.appendChild(sendShortcut);
  actions.appendChild(sendButton);
  modelRow.appendChild(actions);
  panel.appendChild(body);

  const controls = createPanelElement(
    doc,
    "footer",
    "roam-codex-chat-controls",
  );
  controls.id = CHAT_CONTROLS_ID;
  controls.appendChild(modelRow);

  const persist = () => writeChatState(state, { storage });
  const currentRecord = () => state.activeThreadId
    ? state.conversations[state.activeThreadId]
    : null;
  const currentPreferences = () =>
    currentRecord() || state.newConversationPreferences;

  const savePreferences = () => {
    const model = pickerModel || null;
    const effort = pickerEffort || null;
    const speed = pickerSpeed || null;
    const access = CHAT_ACCESS_MODES.has(pickerAccess) ? pickerAccess : "auto";
    const record = currentRecord();
    if (record) {
      record.model = model;
      record.effort = effort;
      record.speed = speed;
      record.access = access;
      record.updatedAt = now();
    } else {
      state.newConversationPreferences = { model, effort, speed, access };
    }
    persist();
  };

  const rememberThread = (threadId, { completed = false } = {}) => {
    if (!validThreadId(threadId)) return;
    const timestamp = now();
    const previous = state.conversations[threadId];
    state.conversations[threadId] = {
      threadId,
      createdAt: previous?.createdAt || timestamp,
      updatedAt: completed ? timestamp : previous?.updatedAt || timestamp,
      model: pickerModel || previous?.model || null,
      effort: pickerEffort || previous?.effort || null,
      speed: pickerSpeed || previous?.speed || null,
      access: CHAT_ACCESS_MODES.has(pickerAccess)
        ? pickerAccess
        : previous?.access || "auto",
      threadPageUid: previous?.threadPageUid || null,
      threadPageTitle: previous?.threadPageTitle || null,
      originInstallationId: previous?.originInstallationId || null,
      lastSeenUpdatedAt: completed
        ? Math.max(previous?.lastSeenUpdatedAt || 0, timestamp)
        : previous?.lastSeenUpdatedAt || 0,
      availability: "available",
      pendingGraphIndex: previous?.pendingGraphIndex || false,
    };
    state.activeThreadId = threadId;
    state.newConversationPreferences = {
      model: null,
      effort: null,
      speed: null,
      access: "auto",
    };
    persist();
  };

  const applyGraphRecord = (graphRecord) => {
    if (!validThreadId(graphRecord?.threadId)) return null;
    const previous = state.conversations[graphRecord.threadId] || {};
    const record = {
      threadId: graphRecord.threadId,
      createdAt: graphRecord.createdAt || previous.createdAt || now(),
      updatedAt: Math.max(
        graphRecord.lastActiveAt || 0,
        previous.updatedAt || 0,
        graphRecord.createdAt || 0,
      ),
      model: previous.model || null,
      effort: previous.effort || null,
      speed: previous.speed || null,
      access: CHAT_ACCESS_MODES.has(previous.access) ? previous.access : "auto",
      threadPageUid: graphRecord.threadPageUid,
      threadPageTitle: graphRecord.threadPageTitle,
      originInstallationId: graphRecord.originInstallationId || null,
      lastSeenUpdatedAt: previous.lastSeenUpdatedAt || 0,
      availability: previous.availability === "available"
        ? "available"
        : "pending",
      pendingGraphIndex: false,
    };
    state.conversations[graphRecord.threadId] = record;
    graphThreadRecords.set(graphRecord.threadId, graphRecord);
    return record;
  };

  const mirrorThreadName = async (graphRecord) => {
    const name = threadPageLabel(graphRecord?.threadPageTitle);
    if (!name || mirroredThreadNames.has(`${graphRecord.threadId}\n${name}`)) {
      return;
    }
    await requestThreadNameImpl(graphRecord.threadId, name);
    mirroredThreadNames.add(`${graphRecord.threadId}\n${name}`);
    const summary = threadSummaries.get(graphRecord.threadId);
    if (summary) threadSummaries.set(graphRecord.threadId, { ...summary, name });
  };

  const ensureThreadIndexed = async (
    threadId,
    title,
    { completedAt = null } = {},
  ) => {
    if (!validThreadId(threadId) || !api.data?.page?.create) return null;
    let pending = threadIndexPromises.get(threadId);
    if (!pending) {
      pending = (async () => {
        try {
          let graphRecord = graphThreadRecords.get(threadId);
          if (
            !graphRecord ||
            !graphRecord.metadataUids?.origin ||
            !graphRecord.metadataUids?.createdAt ||
            !graphRecord.metadataUids?.lastActiveAt
          ) {
            graphRecord = await ensureGraphThreadImpl({
              threadId,
              title,
              timestamp: now(),
            });
          }
          applyGraphRecord(graphRecord);
          if (completedAt) {
            graphRecord = await updateGraphActivityImpl(
              graphRecord,
              completedAt,
            );
            graphThreadRecords.set(threadId, graphRecord);
            applyGraphRecord(graphRecord);
          }
          persist();
          try {
            await mirrorThreadName(graphRecord);
          } catch {
            // The graph page remains authoritative and the next refresh retries.
          }
          return graphRecord;
        } catch (error) {
          const record = state.conversations[threadId];
          if (record) {
            record.pendingGraphIndex = true;
            record.availability = "pending";
            persist();
          }
          throw error;
        } finally {
          threadIndexPromises.delete(threadId);
        }
      })();
      threadIndexPromises.set(threadId, pending);
    }
    const graphRecord = await pending;
    if (completedAt && graphRecord?.lastActiveAt < completedAt) {
      const updated = await updateGraphActivityImpl(graphRecord, completedAt);
      graphThreadRecords.set(threadId, updated);
      applyGraphRecord(updated);
      persist();
      return updated;
    }
    return graphRecord;
  };

  const disposeRenderedMessages = () => {
    messageRenderVersion += 1;
    for (const element of renderedMessageNodes) {
      void unmountRoamMarkdown(element, { api });
    }
    renderedMessageNodes.clear();
  };

  const renderMessages = () => {
    disposeRenderedMessages();
    const renderVersion = messageRenderVersion;
    transcript.replaceChildren();
    transcriptHandle.hidden = false;
    if (!messages.length) {
      transcript.appendChild(approvalContainer);
      transcript.appendChild(progress);
      syncTranscriptStatus();
      scrollLatestButton.hidden = true;
      return;
    }

    for (const message of messages) {
      if (!message || !["user", "assistant"].includes(message.role)) continue;
      const article = createPanelElement(
        doc,
        "article",
        `roam-codex-chat-message roam-codex-chat-message-${message.role}`,
      );
      const roleLabel = message.role === "user" ? "You" : "Codex";
      const copyButton = panelButton(
        doc,
        "roam-codex-chat-copy",
        "",
        "Copy Roam text",
      );
      copyButton.setAttribute(
        "aria-label",
        `Copy ${roleLabel} message as Roam text`,
      );
      copyButton.dataset.state = "idle";
      copyButton.addEventListener("click", async (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const previousTimer = copyFeedbackTimers.get(copyButton);
        if (previousTimer !== undefined) clearTimeoutImpl(previousTimer);
        copyFeedbackTimers.delete(copyButton);
        copyButton.dataset.state = "copying";
        try {
          await copyTextImpl(message.text);
          if (closed) return;
          copyButton.dataset.state = "copied";
          copyButton.title = "Copied";
          copyButton.setAttribute("aria-label", "Copied Roam text");
        } catch {
          if (closed) return;
          copyButton.dataset.state = "error";
          copyButton.title = "Could not copy Roam text";
          copyButton.setAttribute("aria-label", "Could not copy Roam text");
        }
        const timer = setTimeoutImpl(() => {
          copyFeedbackTimers.delete(copyButton);
          if (closed) return;
          copyButton.dataset.state = "idle";
          copyButton.title = "Copy Roam text";
          copyButton.setAttribute(
            "aria-label",
            `Copy ${roleLabel} message as Roam text`,
          );
        }, 1_400);
        copyFeedbackTimers.set(copyButton, timer);
      });
      article.appendChild(copyButton);
      const messageText = createPanelElement(
        doc,
        "div",
        "roam-codex-chat-message-text",
      );
      renderedMessageNodes.add(messageText);
      void renderRoamMarkdown(messageText, message.text, { api })
        .then((rendered) => {
          if (
            rendered &&
            (closed || renderVersion !== messageRenderVersion ||
              !renderedMessageNodes.has(messageText))
          ) {
            void unmountRoamMarkdown(messageText, { api });
          }
        });
      article.appendChild(messageText);
      transcript.appendChild(article);
    }
    transcript.appendChild(approvalContainer);
    transcript.appendChild(progress);
    syncTranscriptStatus();
    transcript.scrollTop = transcript.scrollHeight;
    updateScrollLatestButton();
  };

  const setProgress = (text = "", kind = "") => {
    progressText.textContent = singleLine(text);
    progress.dataset.kind = kind;
    progress.hidden = !progressText.textContent && progressMeta.hidden;
    syncTranscriptStatus({ scroll: !progress.hidden });
  };

  const removeApprovalCard = (approvalId) => {
    if (!approvalCards.has(approvalId)) return;
    approvalCards.delete(approvalId);
    approvalContainer.replaceChildren(...approvalCards.values());
    approvalContainer.hidden = approvalCards.size === 0;
  };

  const clearApprovalCards = () => {
    approvalCards.clear();
    approvalContainer.replaceChildren();
    approvalContainer.hidden = true;
  };

  const renderApproval = ({ approvalId, questions }) => {
    if (approvalCards.has(approvalId)) return;
    const card = createPanelElement(doc, "section", "roam-codex-chat-approval");
    card.setAttribute("aria-label", "Roam change approval");
    const title = createPanelElement(
      doc,
      "div",
      "roam-codex-chat-approval-title",
      questions.find((question) => question?.header)?.header || "Allow Roam change?",
    );
    card.appendChild(title);
    for (const question of questions) {
      if (!question?.question) continue;
      card.appendChild(createPanelElement(
        doc,
        "div",
        "roam-codex-chat-approval-question",
        question.question,
      ));
    }
    const approvalActions = createPanelElement(
      doc,
      "div",
      "roam-codex-chat-approval-actions",
    );
    const rejectButton = panelButton(
      doc,
      "roam-codex-chat-approval-reject",
      "Reject",
      "Reject this Roam change",
    );
    const acceptButton = panelButton(
      doc,
      "roam-codex-chat-approval-accept",
      "Allow",
      "Allow this Roam change",
    );
    const decide = (decision) => {
      if (!runId) return;
      rejectButton.disabled = true;
      acceptButton.disabled = true;
      card.dataset.state = "submitting";
      void approvalRequest(runId, approvalId, decision)
        .then(() => {
          removeApprovalCard(approvalId);
          setProgress("Continuing", "activity");
        })
        .catch((error) => {
          card.dataset.state = "error";
          rejectButton.disabled = false;
          acceptButton.disabled = false;
          setProgress(error.message || "Could not answer the approval.", "error");
        });
    };
    rejectButton.addEventListener("click", () => decide("reject"));
    acceptButton.addEventListener("click", () => decide("accept"));
    approvalActions.appendChild(rejectButton);
    approvalActions.appendChild(acceptButton);
    card.appendChild(approvalActions);
    approvalCards.set(approvalId, card);
    approvalContainer.appendChild(card);
    approvalContainer.hidden = false;
    transcript.hidden = false;
    transcript.scrollTop = transcript.scrollHeight;
  };

  const currentModelEntry = () =>
    models.find((model) => model.id === pickerModel) ||
    models.find((model) => model.isDefault) ||
    models[0] || null;

  const defaultTierIdFor = (model) => {
    const tiers = modelTierChoices(model);
    return tiers.some((tier) => tier.id === model?.defaultServiceTier)
      ? model.defaultServiceTier
      : "";
  };

  const initPicker = () => {
    const preferred = currentPreferences();
    const defaultModel = models.find((model) => model.isDefault) || models[0];
    pickerModel = models.some((model) => model.id === preferred.model)
      ? preferred.model
      : defaultModel?.id || "";
    const selected = currentModelEntry();
    const efforts = modelEfforts(selected);
    const defaultEffort = efforts.includes(selected?.defaultReasoningEffort)
      ? selected.defaultReasoningEffort
      : null;
    pickerEffort = efforts.includes(preferred.effort)
      ? preferred.effort
      : defaultEffort || efforts[0] || "";
    const tiers = modelTierChoices(selected);
    pickerSpeed = tiers.some((tier) => tier.id === preferred.speed)
      ? preferred.speed
      : defaultTierIdFor(selected);
    pickerAccess = CHAT_ACCESS_MODES.has(preferred.access)
      ? preferred.access
      : "auto";
  };

  const pickerLabel = () => {
    if (!models.length) return "No models available";
    const selected = currentModelEntry();
    const parts = [selected?.displayName || selected?.id || "Model"];
    if (pickerEffort) parts.push(effortLabel(pickerEffort));
    return parts.join(" · ");
  };

  const renderPickerButton = () => {
    if (!modelsReady) return;
    const tier = modelTierChoices(currentModelEntry()).find(
      (entry) => entry.id === pickerSpeed,
    );
    pickerButton.dataset.speed = tier?.id === "priority"
      ? "fast"
      : "standard";
    pickerButton.textContent = pickerLabel();
    pickerButton.setAttribute("aria-expanded", String(pickerOpen));
  };

  const closePicker = ({ restoreFocus = false } = {}) => {
    pickerOpen = false;
    pickerLevel = null;
    pickerMenu.hidden = true;
    pickerSubmenu.hidden = true;
    pickerSubmenu.replaceChildren();
    pickerButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) pickerButton.focus?.();
  };

  const syncPickerRows = () => {
    for (const row of pickerMenu.children || []) {
      const open = row.dataset?.level === pickerLevel;
      row.className = row.className.replace(/\s+is-open/g, "") +
        (open ? " is-open" : "");
      row.setAttribute?.("aria-expanded", String(open));
    }
  };

  const renderPickerSubmenu = () => {
    pickerSubmenu.replaceChildren();
    if (!pickerLevel) {
      pickerSubmenu.hidden = true;
      return;
    }
    const selected = currentModelEntry();
    pickerSubmenu.hidden = false;
    pickerSubmenu.setAttribute(
      "aria-label",
      `${effortLabel(pickerLevel)} options`,
    );

    const addOption = (label, active, onPick, description = "") => {
      const option = panelButton(
        doc,
        `roam-codex-chat-picker-option${active ? " is-active" : ""}`,
        "",
        description,
      );
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", String(active));
      option.appendChild(createPanelElement(
        doc,
        "span",
        "roam-codex-chat-picker-option-label",
        label,
      ));
      if (description) {
        option.appendChild(createPanelElement(
          doc,
          "span",
          "roam-codex-chat-picker-option-description",
          description,
        ));
      }
      option.addEventListener("click", () => {
        onPick();
        closePicker({ restoreFocus: true });
        renderPickerButton();
      });
      pickerSubmenu.appendChild(option);
    };

    if (pickerLevel === "model") {
      for (const model of models) {
        if (!model || typeof model.id !== "string") continue;
        const displayName = model.displayName || model.id;
        addOption(
          model.isDefault ? `${displayName} (Default)` : displayName,
          model.id === pickerModel,
          () => {
            if (model.id === pickerModel) return;
            pickerModel = model.id;
            modelChanged = true;
            effortChanged = true;
            speedChanged = true;
            const next = currentModelEntry();
            const efforts = modelEfforts(next);
            if (!efforts.includes(pickerEffort)) {
              const defaultEffort = efforts.includes(
                next?.defaultReasoningEffort,
              )
                ? next.defaultReasoningEffort
                : null;
              pickerEffort = defaultEffort || efforts[0] || "";
            }
            if (!modelTierChoices(next).some(
              (tier) => tier.id === pickerSpeed,
            )) {
              pickerSpeed = defaultTierIdFor(next);
            }
            savePreferences();
          },
          model.description || "",
        );
      }
      return;
    }

    if (pickerLevel === "effort") {
      const efforts = modelEfforts(selected);
      const defaultEffort = efforts.includes(selected?.defaultReasoningEffort)
        ? selected.defaultReasoningEffort
        : null;
      for (const effort of efforts) {
        addOption(
          effort === defaultEffort
            ? `${effortLabel(effort)} (Default)`
            : effortLabel(effort),
          effort === pickerEffort,
          () => {
            if (effort === pickerEffort) return;
            pickerEffort = effort;
            effortChanged = true;
            savePreferences();
          },
          selected?.supportedReasoningEfforts?.find(
            (entry) => entry?.reasoningEffort === effort,
          )?.description || "",
        );
      }
      return;
    }

    if (pickerLevel === "speed") {
      const defaultTier = defaultTierIdFor(selected);
      for (const tier of modelTierChoices(selected)) {
        const name = tier.name || tier.id;
        addOption(
          tier.id === defaultTier ? `${name} (Default)` : name,
          tier.id === pickerSpeed,
          () => {
            if (tier.id === pickerSpeed) return;
            pickerSpeed = tier.id;
            speedChanged = true;
            savePreferences();
          },
          tier.description || "",
        );
      }
      return;
    }

    if (pickerLevel === "access") {
      const choices = [
        ["auto", "Auto", "Allow requested Roam changes without asking"],
        ["read-only", "Read only", "Do not expose Roam write tools"],
        ["manual", "Manual", "Ask before each Roam write"],
      ];
      for (const [id, label, description] of choices) {
        addOption(
          label,
          id === pickerAccess,
          () => {
            if (id === pickerAccess) return;
            pickerAccess = id;
            savePreferences();
          },
          description,
        );
      }
      return;
    }

    if (pickerLevel === "tools") {
      const addToggle = (label, active, onToggle, description = "") => {
        const option = panelButton(
          doc,
          `roam-codex-chat-picker-option${active ? " is-active" : ""}`,
          "",
          description,
        );
        option.setAttribute("role", "menuitemcheckbox");
        option.setAttribute("aria-checked", String(active));
        option.appendChild(createPanelElement(
          doc,
          "span",
          "roam-codex-chat-picker-option-label",
          label,
        ));
        if (description) {
          option.appendChild(createPanelElement(
            doc,
            "span",
            "roam-codex-chat-picker-option-description",
            description,
          ));
        }
        if (onToggle) {
          option.addEventListener("click", () => {
            onToggle();
            renderPickerMenu();
          });
        } else {
          option.disabled = true;
        }
        pickerSubmenu.appendChild(option);
        return option;
      };

      addToggle("Roam", true, null, "Graph tools are always available");
      for (const name of mcpServers) {
        const active = enabledMcpServers.includes(name);
        addToggle(name, active, () => {
          const previous = enabledMcpServers;
          const next = new Set(enabledMcpServers);
          if (active) next.delete(name);
          else next.add(name);
          enabledMcpServers = sanitizeEnabledMcpServers([...next]);
          void Promise.resolve(writeEnabledMcpServersImpl(enabledMcpServers))
            .catch(() => {
              enabledMcpServers = previous;
              if (pickerOpen) renderPickerMenu();
            });
        });
      }
    }
  };

  const openPickerLevel = (level) => {
    pickerLevel = level;
    syncPickerRows();
    renderPickerSubmenu();
  };

  const renderPickerMenu = () => {
    pickerMenu.replaceChildren();
    const selected = currentModelEntry();

    const tiers = modelTierChoices(selected);
    const currentTier = tiers.find((tier) => tier.id === pickerSpeed);
    const rows = [
      ["Model", selected?.displayName || selected?.id || "—", "model"],
      ["Effort", pickerEffort ? effortLabel(pickerEffort) : "—", "effort"],
    ];
    if (tiers.length) {
      rows.push(["Speed", currentTier?.name || currentTier?.id || "—", "speed"]);
    }
    rows.push(["Access", effortLabel(pickerAccess), "access"]);
    if (mcpServers.length) {
      const enabledCount = enabledMcpServers
        .filter((name) => mcpServers.includes(name))
        .length;
      rows.push([
        "Tools",
        enabledCount ? `Roam + ${enabledCount}` : "Roam only",
        "tools",
      ]);
    }
    for (const [label, value, level] of rows) {
      const row = panelButton(
        doc,
        "roam-codex-chat-picker-item",
        "",
        `Choose ${label.toLowerCase()}`,
      );
      row.setAttribute("role", "menuitem");
      row.setAttribute("aria-haspopup", "menu");
      row.dataset.level = level;
      row.appendChild(createPanelElement(
        doc,
        "span",
        "roam-codex-chat-picker-item-label",
        label,
      ));
      row.appendChild(createPanelElement(
        doc,
        "span",
        "roam-codex-chat-picker-item-value",
        value,
      ));
      const chevron = createPanelElement(
        doc,
        "span",
        "roam-codex-chat-picker-item-chevron",
        "›",
      );
      chevron.setAttribute("aria-hidden", "true");
      row.appendChild(chevron);
      const open = () => openPickerLevel(level);
      row.addEventListener("mouseenter", open);
      row.addEventListener("focus", open);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => {
        if (!["ArrowRight", "Enter", " "].includes(event.key)) return;
        event.preventDefault?.();
        open();
      });
      pickerMenu.appendChild(row);
    }
    syncPickerRows();
    renderPickerSubmenu();
  };

  const historyItems = () => buildConversationHistory(
    state,
    [...threadSummaries.values()],
  );

  const renderConversationButton = () => {
    const active = historyItems().find((item) => item.active);
    const label = state.activeThreadId && active ? active.title : "New chat";
    conversationButton.textContent = label;
    conversationButton.title = state.activeThreadId
      ? `Current conversation: ${label}`
      : "Start a new conversation or open history";
    conversationButton.setAttribute("aria-expanded", String(historyOpen));
  };

  const closeHistory = ({ restoreFocus = false } = {}) => {
    historyOpen = false;
    historyPopover.hidden = true;
    conversationButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) conversationButton.focus?.();
  };

  const beginNewConversation = () => {
    if (running) return;
    const preferences = currentPreferences();
    const model = pickerModel || preferences.model || null;
    const effort = pickerEffort || preferences.effort || null;
    const speed = pickerSpeed || preferences.speed || null;
    const access = CHAT_ACCESS_MODES.has(pickerAccess)
      ? pickerAccess
      : preferences.access || "auto";
    selectionLoadVersion += 1;
    state.activeThreadId = null;
    state.newConversationPreferences = { model, effort, speed, access };
    messages = [];
    clearApprovalCards();
    modelChanged = Boolean(model);
    effortChanged = Boolean(effort);
    speedChanged = Boolean(speed);
    persist();
    renderMessages();
    if (modelsReady) {
      initPicker();
      renderPickerButton();
    }
    renderConversationButton();
    closeHistory();
    setProgress();
  };

  const markMissingConversation = (threadId) => {
    const missingRecord = state.conversations[threadId];
    if (!missingRecord) return;
    missingRecord.availability = "missing";
    threadSummaries.delete(threadId);
    if (state.activeThreadId === threadId) {
      messages = [];
      renderMessages();
      setProgress(
        "Unavailable on this device. The graph thread record was kept.",
        "error",
      );
    }
    persist();
  };

  const selectConversation = async (threadId, { reload = false } = {}) => {
    if (running || !state.conversations[threadId]) return;
    if (state.activeThreadId === threadId && !reload) {
      closeHistory();
      return;
    }
    const loadVersion = ++selectionLoadVersion;
    state.activeThreadId = threadId;
    messages = [];
    modelChanged = false;
    effortChanged = false;
    speedChanged = false;
    persist();
    renderMessages();
    if (modelsReady) {
      initPicker();
      renderPickerButton();
    }
    renderConversationButton();
    closeHistory();
    setProgress("Loading conversation", "activity");

    try {
      const loadedMessages = await requestMessagesImpl(threadId);
      if (
        closed ||
        loadVersion !== selectionLoadVersion ||
        state.activeThreadId !== threadId
      ) {
        return;
      }
      messages = loadedMessages.filter(
        (message) =>
          ["user", "assistant"].includes(message?.role) &&
          typeof message.text === "string",
      );
      const record = state.conversations[threadId];
      const summary = threadSummaries.get(threadId);
      if (record) {
        record.availability = "available";
        record.lastSeenUpdatedAt = Math.max(
          record.lastSeenUpdatedAt || 0,
          serverTimestampMs(summary?.updatedAt),
        );
        persist();
      }
      renderMessages();
      setProgress();
    } catch (error) {
      if (
        closed ||
        loadVersion !== selectionLoadVersion ||
        state.activeThreadId !== threadId
      ) {
        return;
      }
      if (error.status === 404) {
        markMissingConversation(threadId);
        renderConversationButton();
        return;
      }
      setProgress(error.message || "Could not load that conversation.", "error");
    }
  };

  const renderHistory = () => {
    historyPopover.replaceChildren();
    const newButton = panelButton(
      doc,
      "roam-codex-chat-history-item roam-codex-chat-history-new",
      "+ New chat",
      "Start a new conversation",
    );
    newButton.setAttribute("role", "menuitem");
    newButton.disabled = running;
    if (!state.activeThreadId) {
      newButton.className += " is-active";
      newButton.setAttribute("aria-current", "true");
    }
    newButton.addEventListener("click", beginNewConversation);
    historyPopover.appendChild(newButton);

    const items = historyItems();
    if (!items.length) {
      historyPopover.appendChild(createPanelElement(
        doc,
        "div",
        "roam-codex-chat-history-empty",
        historyError || "No previous chats yet.",
      ));
      return;
    }

    for (const item of items) {
      const button = panelButton(
        doc,
        "roam-codex-chat-history-item",
        "",
        `Resume ${item.title}`,
      );
      button.setAttribute("role", "menuitem");
      button.dataset.threadId = item.threadId;
      button.dataset.availability = item.availability;
      button.disabled = running;
      if (item.active) {
        button.className += " is-active";
        button.setAttribute("aria-current", "true");
      }
      button.appendChild(createPanelElement(
        doc,
        "span",
        "roam-codex-chat-history-title",
        item.title,
      ));
      button.appendChild(createPanelElement(
        doc,
        "span",
        "roam-codex-chat-history-date",
        ["missing", "unavailable"].includes(item.availability)
          ? "Unavailable"
          : conversationDateLabel(item.updatedAt),
      ));
      button.addEventListener("click", () => void selectConversation(item.threadId));
      historyPopover.appendChild(button);
    }
    if (historyError) {
      historyPopover.appendChild(createPanelElement(
        doc,
        "div",
        "roam-codex-chat-history-error",
        historyError,
      ));
    }
  };

  const loadHistory = async ({ reconcileActive = false } = {}) => {
    const loadVersion = ++historyLoadVersion;
    historyError = "";
    try {
      const graphIndex = await requestGraphIndexImpl();
      if (closed || loadVersion !== historyLoadVersion) return;
      for (const graphRecord of graphIndex?.records || []) {
        applyGraphRecord(graphRecord);
      }
      if (graphIndex?.errors?.length) {
        historyError = `${graphIndex.errors.length} thread page${
          graphIndex.errors.length === 1 ? " has" : "s have"
        } invalid or duplicate metadata.`;
      }
      persist();
    } catch (error) {
      historyError = error.message || "The graph thread index is unavailable.";
    }
    const threadIds = historyItems().map((item) => item.threadId);
    if (!threadIds.length) {
      renderConversationButton();
      if (historyOpen) renderHistory();
      return;
    }

    try {
      const batches = [];
      for (let index = 0; index < threadIds.length; index += 100) {
        batches.push(requestHistoryImpl(threadIds.slice(index, index + 100)));
      }
      const results = await Promise.all(batches);
      if (closed || loadVersion !== historyLoadVersion) return;
      let reloadActive = false;
      for (const result of results) {
        for (const summary of result.threads || []) {
          if (
            validThreadId(summary?.id) &&
            state.conversations[summary.id]
          ) {
            threadSummaries.set(summary.id, summary);
            const record = state.conversations[summary.id];
            const serverUpdatedAt = serverTimestampMs(summary.updatedAt);
            reloadActive ||= Boolean(
              reconcileActive &&
              summary.id === state.activeThreadId &&
              !running &&
              serverUpdatedAt > (record.lastSeenUpdatedAt || 0)
            );
            record.updatedAt = Math.max(record.updatedAt || 0, serverUpdatedAt);
            record.availability = "available";
          }
        }
        for (const threadId of result.missingThreadIds || []) {
          if (state.conversations[threadId]) markMissingConversation(threadId);
        }
        for (const threadId of result.unavailableThreadIds || []) {
          if (state.conversations[threadId]) {
            state.conversations[threadId].availability = "unavailable";
          }
        }
      }
      const backfills = [];
      for (const threadId of threadIds) {
        const record = state.conversations[threadId];
        if (!record?.threadPageUid && api.data?.page?.create) {
          const summary = threadSummaries.get(threadId);
          backfills.push(
            ensureThreadIndexed(
              threadId,
              summary?.name || summary?.preview || "",
            ).catch(() => null),
          );
        } else if (record?.threadPageUid) {
          const graphRecord = graphThreadRecords.get(threadId);
          if (
            graphRecord &&
            (!graphRecord.metadataUids?.origin ||
              !graphRecord.metadataUids?.createdAt ||
              !graphRecord.metadataUids?.lastActiveAt)
          ) {
            backfills.push(
              ensureThreadIndexed(threadId, record.threadPageTitle || "")
                .catch(() => null),
            );
          } else if (graphRecord) {
            void mirrorThreadName(graphRecord).catch(() => {});
          }
        }
      }
      await Promise.all(backfills);
      persist();
      if (reloadActive && state.activeThreadId) {
        await selectConversation(state.activeThreadId, { reload: true });
      }
    } catch (error) {
      if (closed || loadVersion !== historyLoadVersion) return;
      historyError ||= error.message || "Conversation history is unavailable.";
    }
    renderConversationButton();
    if (historyOpen) renderHistory();
  };

  const setRunning = (value) => {
    if (value && !running) {
      idlePromise = new Promise((resolve) => {
        resolveIdle = resolve;
      });
      runStartedAt = now();
      progressTimer.textContent = formatRunningElapsed(0);
      progressMeta.hidden = false;
      if (setIntervalImpl && clearIntervalImpl && elapsedIntervalId === null) {
        elapsedIntervalId = setIntervalImpl(() => {
          progressTimer.textContent = formatRunningElapsed(now() - runStartedAt);
        }, 1000);
      }
    } else if (!value && running) {
      resolveIdle?.();
      resolveIdle = null;
    }
    if (!value) {
      progressMeta.hidden = true;
      if (clearIntervalImpl && elapsedIntervalId !== null) {
        clearIntervalImpl(elapsedIntervalId);
      }
      elapsedIntervalId = null;
    }
    progress.hidden = !progressText.textContent && progressMeta.hidden;
    syncTranscriptStatus({ scroll: value });
    running = value;
    if (value && pickerOpen) closePicker();
    pickerButton.disabled = value || !modelsReady;
    sendButton.disabled = value || !modelsReady;
    sendButton.hidden = value;
    conversationButton.disabled = value;
    stopButton.hidden = !value;
    stopButton.disabled = false;
    if (historyOpen) renderHistory();
  };

  const send = async () => {
    if (running) return null;
    setRunning(true);
    if (state.activeThreadId) {
      await loadHistory({ reconcileActive: true });
      const activeSummary = threadSummaries.get(state.activeThreadId);
      if (activeSummary?.status === "active") {
        setProgress(
          "This conversation is active in Codex. Wait for it to finish, then try again.",
          "error",
        );
        setRunning(false);
        return null;
      }
    }
    let prompt;
    try {
      prompt = await readPromptImpl();
    } catch (error) {
      setProgress(error.message || "Focus a Roam block before sending.", "error");
      setRunning(false);
      return null;
    }
    const startingNewConversation = !state.activeThreadId;
    const catalogDefaultModel = models.find((model) => model.isDefault) ||
      models[0];
    const modelOverride = modelChanged
      ? pickerModel || catalogDefaultModel?.id || null
      : null;
    const effortOverride = effortChanged ? pickerEffort || null : null;
    const speedOverride = speedChanged ? pickerSpeed || null : undefined;

    const shouldClearPrompt = shouldClearChatPrompt(prompt.uid, {
      scratchPrompt,
      protectedPromptUids,
    });
    const resetBlockUid = scratchPrompt ? rootBlockUid : prompt.uid;
    let composerCleared = false;
    if (shouldClearPrompt) {
      try {
        composerCleared = await clearScratchPromptImpl(prompt);
      } catch (error) {
        try {
          await restorePromptImpl(prompt);
        } catch {
          // The original reset error is more useful than a secondary recovery
          // error. The composer remains visible for manual recovery.
        }
        setProgress(
          error.message || "The composer could not be cleared safely.",
          "error",
        );
        setRunning(false);
        return null;
      }
      if (!composerCleared) {
        setProgress(
          "The composer changed before it could be sent. Review it and try again.",
          "error",
        );
        setRunning(false);
        return null;
      }
      resetPromptUids.add(resetBlockUid);
      try {
        const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
        if (sidebarWindow?.["window-id"]) {
          await api.ui.setBlockFocusAndSelection({
            location: {
              "block-uid": resetBlockUid,
              "window-id": sidebarWindow["window-id"],
            },
          });
        }
      } catch {
        // The outline has already reset successfully. A focus failure should
        // not turn a valid send into a failed one.
      }
    }

    messages.push({ role: "user", text: prompt.text });
    renderMessages();
    runId = null;
    setProgress("Starting", "activity");

    try {
      const result = await requestChatImpl(prompt.text, {
        promptBlockUid: prompt.uid,
        threadId: state.activeThreadId,
        model: modelOverride,
        effort: effortOverride,
        serviceTier: speedOverride,
        accessMode: pickerAccess,
        enabledServers: enabledMcpServers,
        onStarted: ({ runId: startedRunId }) => {
          runId = startedRunId;
        },
        onThread: ({ threadId }) => {
          rememberThread(threadId);
          void ensureThreadIndexed(threadId, prompt.text).catch(() => {});
          modelChanged = false;
          effortChanged = false;
          speedChanged = false;
        },
        onProgress: ({ kind, text: progressText }) => {
          setProgress(progressText, kind);
        },
        onApproval: renderApproval,
      });

      const completedAt = now();
      rememberThread(result.threadId, { completed: true });
      await ensureThreadIndexed(result.threadId, prompt.text, {
        completedAt,
      }).catch(() => null);
      if (typeof result.reply !== "string" || !result.reply.trim()) {
        throw new Error("Codex completed without a reply.");
      }
      messages.push({ role: "assistant", text: result.reply.trim() });
      renderMessages();
      const existingSummary = threadSummaries.get(result.threadId) || {};
      threadSummaries.set(result.threadId, {
        ...existingSummary,
        id: result.threadId,
        name: existingSummary.name || null,
        preview: startingNewConversation
          ? prompt.text
          : existingSummary.preview || "",
        createdAt: existingSummary.createdAt || completedAt,
        updatedAt: completedAt,
        status: "idle",
      });
      renderConversationButton();
      if (historyOpen) renderHistory();
      void loadHistory({ reconcileActive: false });
      setProgress("", "");
      return result;
    } catch (error) {
      let restored = false;
      let restoreFailed = false;
      if (composerCleared) {
        try {
          restored = await restorePromptImpl(prompt);
          if (restored) {
            const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
            if (sidebarWindow?.["window-id"]) {
              await api.ui.setBlockFocusAndSelection({
                location: {
                  "block-uid": prompt.uid,
                  "window-id": sidebarWindow["window-id"],
                },
              });
            }
          }
        } catch {
          restoreFailed = true;
        }
      }
      if (error.code === "TURN_INTERRUPTED") {
        setProgress(
          restoreFailed
            ? "Stopped · submitted outline could not be restored"
            : restored
              ? "Stopped · draft restored"
              : composerCleared
                ? "Stopped · current draft preserved"
                : "Stopped",
          restoreFailed ? "error" : "stopped",
        );
        return null;
      }
      const failureText = error.message || "Codex could not finish.";
      setProgress(
        restoreFailed
          ? `${failureText} The submitted outline could not be restored.`
          : restored
            ? `${failureText} · Draft restored.`
            : composerCleared
              ? `${failureText} · The current draft was preserved.`
              : failureText,
        "error",
      );
      return null;
    } finally {
      clearApprovalCards();
      runId = null;
      setRunning(false);
    }
  };

  const handleSendShortcut = (event) => {
    if (
      !event.defaultPrevented &&
      event.key === "Escape" &&
      (historyOpen || pickerOpen)
    ) {
      event.preventDefault();
      event.stopPropagation?.();
      if (historyOpen) closeHistory({ restoreFocus: true });
      if (pickerOpen) closePicker({ restoreFocus: true });
      return;
    }
    if (
      !event.defaultPrevented &&
      event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      event.key === "Enter"
    ) {
      const focused = api.ui?.getFocusedBlock?.();
      const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
      if (
        focused?.["window-id"] &&
        focused["window-id"] === sidebarWindow?.["window-id"]
      ) {
        event.preventDefault();
        event.stopPropagation?.();
        void send();
      }
    }
  };

  const handleDocumentClick = (event) => {
    if (historyOpen && !header.contains?.(event.target)) closeHistory();
    if (pickerOpen && !pickerWrap.contains?.(event.target)) closePicker();
  };

  const close = () => {
    if (closed) return closePromise || Promise.resolve();
    closed = true;
    stopTranscriptResize();
    if (clearIntervalImpl && elapsedIntervalId !== null) {
      clearIntervalImpl(elapsedIntervalId);
    }
    elapsedIntervalId = null;
    doc.removeEventListener?.("keydown", handleSendShortcut, true);
    doc.removeEventListener?.("click", handleDocumentClick, true);
    doc.removeEventListener?.("visibilitychange", handleVisibilityChange);
    doc.defaultView?.removeEventListener?.("focus", handleWindowFocus);
    transcript.removeEventListener?.("scroll", updateScrollLatestButton);
    for (const timer of copyFeedbackTimers.values()) clearTimeoutImpl(timer);
    copyFeedbackTimers.clear();
    disposeRenderedMessages();
    header.remove();
    panel.remove();
    controls.remove();
    closePromise = Promise.resolve(onClose({
      whenIdle: () => idlePromise,
      resetPromptUids,
    }));
    return closePromise;
  };

  // Keep Roam's native block editor focused until send() snapshots it. A
  // normal button mouse-down otherwise moves focus into the controls before
  // readFocusedPromptBlock() can identify the composer window.
  sendButton.addEventListener("mousedown", (event) => {
    event.preventDefault?.();
  });
  sendButton.addEventListener("click", () => void send());
  closeButton.addEventListener("click", () => {
    const removeWindow = api.ui?.rightSidebar?.removeWindow;
    const removal = typeof removeWindow === "function"
      ? Promise.resolve(removeWindow({
        window: { type: "block", "block-uid": rootBlockUid },
      })).catch(() => {})
      : Promise.resolve();
    void removal.then(() => close());
  });
  conversationButton.addEventListener("click", () => {
    if (running) return;
    if (historyOpen) {
      closeHistory();
      return;
    }
    historyOpen = true;
    historyPopover.hidden = false;
    renderConversationButton();
    renderHistory();
    void loadHistory({ reconcileActive: true });
  });
  const handleWindowFocus = () => {
    if (!closed && !running) void loadHistory({ reconcileActive: true });
  };
  const handleVisibilityChange = () => {
    if (doc.visibilityState === "visible") handleWindowFocus();
  };
  doc.addEventListener?.("keydown", handleSendShortcut, true);
  doc.addEventListener?.("click", handleDocumentClick, true);
  doc.addEventListener?.("visibilitychange", handleVisibilityChange);
  doc.defaultView?.addEventListener?.("focus", handleWindowFocus);
  pickerButton.addEventListener("click", () => {
    if (running || !modelsReady) return;
    if (pickerOpen) {
      closePicker();
      return;
    }
    pickerOpen = true;
    pickerLevel = null;
    pickerMenu.hidden = false;
    pickerButton.setAttribute("aria-expanded", "true");
    renderPickerMenu();
  });
  stopButton.addEventListener("click", () => {
    if (!runId) return;
    stopButton.disabled = true;
    setProgress("Stopping", "activity");
    void cancelRequest(runId).catch((error) => {
      stopButton.disabled = false;
      setProgress(error.message || "Could not stop the turn.", "error");
    });
  });

  renderMessages();
  setProgress();
  renderConversationButton();
  setRunning(false);

  void requestModelsImpl()
    .then((availableModels) => {
      if (closed) return;
      models = Array.isArray(availableModels) ? availableModels : [];
      modelsReady = true;
      initPicker();
      renderPickerButton();
      setRunning(false);
    })
    .catch((error) => {
      if (closed) return;
      pickerButton.textContent = "Models unavailable";
      setProgress(error.message, "error");
    });

  void requestMcpServersImpl()
    .then((servers) => {
      if (closed) return;
      mcpServers = Array.isArray(servers) ? servers : [];
      if (pickerOpen) renderPickerMenu();
    })
    .catch(() => {
      // Without a server list the picker simply omits the Tools row.
    });

  const initialThreadId = state.activeThreadId;
  void loadHistory().then(() => {
    if (
      !closed &&
      initialThreadId &&
      state.activeThreadId === initialThreadId &&
      !["missing", "unavailable"].includes(
        state.conversations[initialThreadId]?.availability,
      )
    ) {
      return selectConversation(initialThreadId, { reload: true });
    }
  });

  return {
    element: panel,
    headerElement: header,
    controlsElement: controls,
    rootBlockUid,
    close,
    focus: () => {
      const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
      if (!sidebarWindow?.["window-id"]) return Promise.resolve();
      return api.ui.setBlockFocusAndSelection({
        location: {
          "block-uid": rootBlockUid,
          "window-id": sidebarWindow["window-id"],
        },
      });
    },
    send,
  };
}

async function openChatPanelInternal({
  api = getRoamApi(),
  doc = globalThis.document,
  storage = window.localStorage,
  blockUid,
  waitOptions,
  resolvePromptBlock = resolveChatPromptBlock,
  openPromptBlock = openPromptBlockInSidebar,
  createPanel = createChatPanel,
  removeScratchPrompt = removeScratchPromptBlock,
  removeResetPrompts = removeResetChatPromptBlocks,
  readOutlineUids = readPromptOutlineUids,
} = {}) {
  const prompt = await resolvePromptBlock(blockUid, { api });
  const promptBlockUid = prompt.uid;
  let protectedPromptUids = new Set();
  if (!prompt.scratch) {
    try {
      protectedPromptUids = await readOutlineUids(promptBlockUid, { api });
    } catch {
      // If the initial outline cannot be read, preserve every user-owned
      // prompt rather than risk clearing material that predated the chat.
      protectedPromptUids = null;
    }
  }

  if (ACTIVE_CHAT_PANEL) {
    if (
      ACTIVE_CHAT_PANEL.element?.isConnected &&
      ACTIVE_CHAT_PANEL.rootBlockUid === promptBlockUid
    ) {
      await ACTIVE_CHAT_PANEL.focus();
      return ACTIVE_CHAT_PANEL;
    }
    await ACTIVE_CHAT_PANEL.close();
    if (ACTIVE_CHAT_PANEL?.element?.isConnected === false) {
      ACTIVE_CHAT_PANEL = null;
    }
  }

  let controller;
  let nativeWindowObserver = null;
  let disconnectedHostTimer = null;
  let host = null;
  let nativeHeader = null;
  let nativeComposer = null;
  let composerShell = null;
  const releaseMountedHost = () => {
    nativeHeader?.classList?.remove?.(NATIVE_WINDOW_HEADER_CLASS);
    nativeComposer?.classList?.remove?.(NATIVE_COMPOSER_CLASS);
    if (composerShell?.parentNode && nativeComposer) {
      composerShell.parentNode.insertBefore?.(nativeComposer, composerShell);
    }
    composerShell?.remove?.();
    host?.classList?.remove?.("roam-codex-chat-window");
    nativeHeader = null;
    nativeComposer = null;
    composerShell = null;
  };
  const mountControllerInHost = (nextHost) => {
    if (!nextHost || !controller) return false;
    releaseMountedHost();
    host = nextHost;
    host.classList?.add?.("roam-codex-chat-window");
    nativeHeader = host.firstElementChild || null;
    host.insertBefore(
      controller.element,
      nativeHeader?.nextSibling || null,
    );
    nativeHeader?.classList?.add?.(NATIVE_WINDOW_HEADER_CLASS);
    nativeComposer = controller.element.nextElementSibling || null;
    nativeComposer?.classList?.add?.(NATIVE_COMPOSER_CLASS);
    if (nativeComposer && typeof doc.createElement === "function") {
      composerShell = doc.createElement("div");
      composerShell.className = "roam-codex-chat-composer-shell";
      host.insertBefore(composerShell, nativeComposer);
      composerShell.appendChild(nativeComposer);
      composerShell.appendChild(controller.controlsElement);
    } else {
      host.appendChild(controller.controlsElement);
    }
    if (controller.headerElement) {
      const launcherPlacement = findSidebarChatLauncherPlacement(doc);
      const launcher = doc.getElementById?.(SIDEBAR_CHAT_LAUNCHER_ID);
      if (
        launcherPlacement?.header &&
        launcher?.parentNode === launcherPlacement.header
      ) {
        launcherPlacement.header.insertBefore(
          controller.headerElement,
          launcher.nextSibling || null,
        );
      } else {
        host.insertBefore(controller.headerElement, controller.element);
      }
    }
    return true;
  };
  try {
    const sidebarWindow = await openPromptBlock(
      promptBlockUid,
      { api, waitOptions },
    );
    host = await waitForChatPanelHost(doc, sidebarWindow, waitOptions);
    doc.getElementById?.(CHAT_PANEL_ID)?.remove?.();
    doc.getElementById?.(CHAT_CONTROLS_ID)?.remove?.();

    controller = createPanel({
      doc,
      storage,
      api,
      rootBlockUid: promptBlockUid,
      protectedPromptUids,
      scratchPrompt: prompt.scratch,
      onClose: ({ whenIdle, resetPromptUids }) => {
        nativeWindowObserver?.disconnect?.();
        if (disconnectedHostTimer !== null) {
          globalThis.clearTimeout(disconnectedHostTimer);
          disconnectedHostTimer = null;
        }
        releaseMountedHost();
        if (ACTIVE_CHAT_PANEL === controller) ACTIVE_CHAT_PANEL = null;
        return whenIdle()
          .then(() => prompt.scratch
            ? removeScratchPrompt(promptBlockUid, { api })
            : removeResetPrompts(resetPromptUids, { api }))
          .catch((error) => {
            notify(
              `The temporary Codex composer could not be removed: ${error.message}`,
              "warning",
            );
        });
      },
    });
    mountControllerInHost(host);
    ACTIVE_CHAT_PANEL = controller;

    const MutationObserverImpl = doc.defaultView?.MutationObserver ||
      globalThis.MutationObserver;
    const observationRoot = doc.body || doc.documentElement || host.parentNode;
    if (MutationObserverImpl && observationRoot) {
      nativeWindowObserver = new MutationObserverImpl(() => {
        if (
          host?.isConnected &&
          controller.element?.isConnected
        ) return;
        if (disconnectedHostTimer !== null) return;
        disconnectedHostTimer = globalThis.setTimeout(() => {
          disconnectedHostTimer = null;
          if (host?.isConnected && controller.element?.isConnected) return;
          const liveWindow = findSidebarBlockWindow(promptBlockUid, { api });
          if (!liveWindow) {
            void controller.close();
            return;
          }
          const nextHost = findChatPanelHost(doc, liveWindow);
          if (nextHost) mountControllerInHost(nextHost);
        }, 100);
      });
      nativeWindowObserver.observe(observationRoot, {
        childList: true,
        subtree: true,
      });
    }

    // Roam may leave this promise pending even after the sidebar window has
    // rendered. Focusing is a convenience, so it must not hold the panel-open
    // lifecycle (and the launcher/keyboard toggle) in an "opening" state.
    try {
      void Promise.resolve(controller.focus()).catch(() => {});
    } catch {
      // The panel is already usable; a synchronous focus failure is harmless.
    }
    return controller;
  } catch (error) {
    if (controller) {
      await controller.close();
    } else if (prompt.scratch) {
      try {
        await removeScratchPrompt(promptBlockUid, { api });
      } catch {
        // Preserve the original opening failure; normal cleanup reports its
        // own failure once a panel has taken ownership of the scratch block.
      }
    }
    throw error;
  }
}

export function openChatPanel(options = {}) {
  if (CHAT_PANEL_OPEN_PROMISE) return CHAT_PANEL_OPEN_PROMISE;
  const opening = openChatPanelInternal(options);
  const tracked = opening.finally(() => {
    if (CHAT_PANEL_OPEN_PROMISE === tracked) CHAT_PANEL_OPEN_PROMISE = null;
  });
  CHAT_PANEL_OPEN_PROMISE = tracked;
  return tracked;
}

export function closeChatPanel() {
  if (CHAT_PANEL_CLOSE_PROMISE) return CHAT_PANEL_CLOSE_PROMISE;
  const panel = ACTIVE_CHAT_PANEL;
  if (!panel) return Promise.resolve();
  ACTIVE_CHAT_PANEL = null;
  const closing = Promise.resolve(panel.close());
  const tracked = closing.finally(() => {
    if (CHAT_PANEL_CLOSE_PROMISE === tracked) CHAT_PANEL_CLOSE_PROMISE = null;
  });
  CHAT_PANEL_CLOSE_PROMISE = tracked;
  return tracked;
}

export function toggleChatPanel() {
  if (CHAT_PANEL_OPEN_PROMISE) return CHAT_PANEL_OPEN_PROMISE;
  if (CHAT_PANEL_CLOSE_PROMISE) return CHAT_PANEL_CLOSE_PROMISE;
  return activeChatPanelIsOpen() ? closeChatPanel() : openChatPanel();
}

export function installChatToggleHotkey({
  doc = globalThis.document,
  toggleImpl = toggleChatPanel,
  notifyImpl = notify,
} = {}) {
  if (!doc?.addEventListener) return () => {};
  const runtime = doc.defaultView || globalThis;
  runtime[CHAT_TOGGLE_HOTKEY_KEY]?.();
  let disposed = false;
  const handleKeydown = (event) => {
    if (
      disposed ||
      event.defaultPrevented ||
      event.altKey ||
      event.shiftKey ||
      !(event.metaKey || event.ctrlKey) ||
      String(event.key).toLowerCase() !== "j"
    ) {
      return;
    }
    event.preventDefault?.();
    event.stopPropagation?.();
    void Promise.resolve(toggleImpl()).catch((error) => {
      notifyImpl(`Codex chat could not toggle: ${error.message}`, "danger");
    });
  };
  doc.addEventListener("keydown", handleKeydown, true);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    doc.removeEventListener?.("keydown", handleKeydown, true);
    if (runtime[CHAT_TOGGLE_HOTKEY_KEY] === dispose) {
      delete runtime[CHAT_TOGGLE_HOTKEY_KEY];
    }
  };
  runtime[CHAT_TOGGLE_HOTKEY_KEY] = dispose;
  return dispose;
}

export function sendActiveChatMessage({
  api = getRoamApi(),
  panel = ACTIVE_CHAT_PANEL,
} = {}) {
  if (!panel?.element?.isConnected) return null;
  const focused = api.ui?.getFocusedBlock?.();
  const sidebarWindow = findSidebarBlockWindow(panel.rootBlockUid, { api });
  if (
    !focused?.["window-id"] ||
    focused["window-id"] !== sidebarWindow?.["window-id"]
  ) {
    return null;
  }
  return panel.send();
}

export async function pairBridge({
  fetchImpl = window.fetch.bind(window),
  storage = window.localStorage,
} = {}) {
  const response = await fetchImpl(`${BRIDGE_URL}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ graph: GRAPH }),
  });

  let result = {};
  try {
    result = await response.json();
  } catch {
    // A useful status error is emitted below.
  }

  if (!response.ok || typeof result.token !== "string") {
    throw new Error(
      result.error || `Bridge pairing returned HTTP ${response.status}.`,
    );
  }
  if (result.graph !== GRAPH) {
    throw new Error(`Bridge is connected to graph "${result.graph}".`);
  }

  storage.setItem(TOKEN_KEY, result.token);
  notify("Local bridge paired on this device.", "success");
  return result;
}

export async function checkBridge({
  fetchImpl = window.fetch.bind(window),
} = {}) {
  try {
    const response = await fetchImpl(`${BRIDGE_URL}/health`);
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    notify(
      `Bridge is ${result.appServer}; graph is ${result.graph}.`,
      "success",
    );
    return result;
  } catch (error) {
    notify(`Bridge unavailable: ${error.message}`, "danger");
    throw error;
  }
}

export default {
  onload: ({ extensionAPI }) => {
    EXTENSION_SETTINGS = extensionAPI.settings;
    cleanupStaleChatUi();
    ACTIVE_CHAT_PANEL = null;
    CHAT_PANEL_OPEN_PROMISE = null;
    CHAT_PANEL_CLOSE_PROMISE = null;
    void cleanupStaleRunningStatuses().catch((error) => {
      notify(
        `A stale Codex running indicator could not be removed: ${error.message}`,
        "warning",
      );
    });

    const workFromSlashCommand = (context) => {
      void workOnBlock(context["block-uid"]).catch(() => {});
      return "";
    };
    const workFromCommandPalette = () => {
      const focused = getRoamApi().ui.getFocusedBlock();
      void workOnBlock(focused?.["block-uid"]).catch(() => {});
    };
    const openChat = () => openChatPanel();

    SIDEBAR_CHAT_LAUNCHER?.dispose?.();
    SIDEBAR_CHAT_LAUNCHER = installSidebarChatLauncher({
      openChatImpl: openChat,
    });
    CHAT_TOGGLE_HOTKEY_DISPOSE?.();
    CHAT_TOGGLE_HOTKEY_DISPOSE = installChatToggleHotkey();

    extensionAPI.ui.commandPalette.addCommand({
      label: "Codex: Send chat message",
      "default-hotkey": "alt-enter",
      callback: () => {
        void sendActiveChatMessage();
      },
    });

    extensionAPI.ui.commandPalette.addCommand({
      label: "Codex: Toggle chat",
      "disable-hotkey": true,
      callback: () => {
        void toggleChatPanel().catch((error) => {
          notify(`Codex chat could not toggle: ${error.message}`, "danger");
        });
      },
    });

    extensionAPI.ui.commandPalette.addCommand({
      label: "Codex: Open chat",
      callback: () => {
        void openChat().catch((error) => {
          notify(`Codex chat could not open: ${error.message}`, "danger");
        });
      },
    });

    extensionAPI.ui.slashCommand.addCommand({
      label: "Codex: Do this block",
      callback: workFromSlashCommand,
    });

    extensionAPI.ui.commandPalette.addCommand({
      label: "Codex: Do this block",
      callback: workFromCommandPalette,
    });

    extensionAPI.ui.commandPalette.addCommand({
      label: "Codex: Pair local bridge",
      "disable-hotkey": true,
      callback: () => {
        void pairBridge().catch((error) => {
          notify(`Bridge pairing failed: ${error.message}`, "danger");
        });
      },
    });

    extensionAPI.ui.commandPalette.addCommand({
      label: "Codex: Check local bridge",
      "disable-hotkey": true,
      callback: () => void checkBridge(),
    });
  },
  onunload: () => {
    EXTENSION_SETTINGS = null;
    CHAT_TOGGLE_HOTKEY_DISPOSE?.();
    CHAT_TOGGLE_HOTKEY_DISPOSE = null;
    SIDEBAR_CHAT_LAUNCHER?.dispose?.();
    SIDEBAR_CHAT_LAUNCHER?.remove?.();
    SIDEBAR_CHAT_LAUNCHER = null;
    void closeChatPanel();
    cleanupStaleChatUi();
    stopAllRunningPresentations();
  },
};
