import { createChatPanel } from "./chat-panel.jsx";

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
const NATIVE_WINDOW_HEADER_CLASS = "roam-codex-native-window-header";
const NATIVE_COMPOSER_CLASS = "roam-codex-native-composer";
let ACTIVE_CHAT_PANEL = null;
let SIDEBAR_CHAT_LAUNCHER = null;
let CHAT_PANEL_OPEN_PROMISE = null;
let CHAT_PANEL_CLOSE_PROMISE = null;
let CHAT_TOGGLE_HOTKEY_DISPOSE = null;
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
    newConversationPreferences: { model: null, effort: null, speed: null },
    conversations: {},
  };
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
  onProgress = () => {},
  onStarted = () => {},
  onThread = () => {},
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
  });
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

// Internal helpers shared with the chat panel module.
export {
  createPanelElement,
  panelButton,
  getRoamApi,
  validBlockUid,
  validThreadId,
  singleLine,
  threadPageLabel,
  serverTimestampMs,
  conversationDateLabel,
  modelEfforts,
  modelTierChoices,
  effortLabel,
  CHAT_PANEL_ID,
  CHAT_CONTROLS_ID,
  CHAT_PANEL_CLASS,
  CHAT_TRANSCRIPT_HEIGHT_KEY,
  CHAT_TRANSCRIPT_MIN_HEIGHT,
  CHAT_TRANSCRIPT_MAX_HEIGHT,
  CHAT_SCROLL_BOTTOM_THRESHOLD,
};
