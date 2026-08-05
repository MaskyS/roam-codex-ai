import {
  ChatControls,
  ChatHistory,
  ChatTranscript,
  ConnectionCard,
  chatMessageOutlineRows,
} from "./chat-components.jsx";

export { chatMessageOutlineRows };

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:47321";
const TOKEN_KEY_PREFIX = "roam-codex-lab.bridge-token";
const RUNNING_STATUS_KEY_PREFIX = "roam-codex-lab.running-status-uids";
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
const CHAT_STATE_VERSION = 3;
const CHAT_STATE_KEY_PREFIX = `roam-codex-lab.chat-state.v${CHAT_STATE_VERSION}`;
const LEGACY_CHAT_STATE_KEY_PREFIX = "roam-codex-lab.chat-state.v2";
const INSTALLATION_ID_KEY_PREFIX = "roam-codex-lab.installation-id";
const THREAD_PAGE_PREFIX = "Codex/thread/";
const THREAD_ID_FIELD = "Codex thread::";
const THREAD_ORIGIN_FIELD = "Origin installation::";
const THREAD_CREATED_FIELD = "Created at::";
const THREAD_ACTIVE_FIELD = "Last active at::";
const AGENT_GUIDELINES_PAGE_TITLE = "roam/agent guidelines";
const MAX_GRAPH_GUIDELINES_LENGTH = 20_000;
const CHAT_TRANSCRIPT_HEIGHT_KEY_PREFIX = "roam-codex-lab.chat-transcript-height";
const CHAT_TRANSCRIPT_MIN_HEIGHT = 140;
const CHAT_TRANSCRIPT_DEFAULT_HEIGHT = 320;
const CHAT_TRANSCRIPT_MAX_HEIGHT = 640;
const CHAT_SCROLL_BOTTOM_THRESHOLD = 24;
const CHAT_ACCESS_MODES = new Set(["auto", "read-only", "manual"]);
const CONNECTION_RETRY_MS = 4_000;
const ENABLED_MCP_SERVERS_SETTING = "enabled-mcp-servers";
const BRIDGE_URL_SETTING = "bridge-url";
const DEFAULT_ACCESS_SETTING = "default-access";
const DEFAULT_MODEL_SETTING = "default-model";
const NATIVE_WINDOW_HEADER_CLASS = "roam-codex-native-window-header";
const NATIVE_COMPOSER_CLASS = "roam-codex-native-composer";
let ACTIVE_CHAT_PANEL = null;
let SIDEBAR_CHAT_LAUNCHER = null;
let CHAT_PANEL_OPEN_PROMISE = null;
let CHAT_PANEL_CLOSE_PROMISE = null;
let CHAT_TOGGLE_HOTKEY_DISPOSE = null;
let EXTENSION_SETTINGS = null;
let EXTENSION_CONFIG = {
  graph: null,
  bridgeUrl: DEFAULT_BRIDGE_URL,
  defaultAccess: "auto",
  defaultModel: null,
};
const CHAT_TOGGLE_HOTKEY_KEY = "__roamCodexToggleHotkeyDispose";

export const RUNNING_BLOCK_TEXT = "[[Codex/running]]";
// Roam sometimes records a zero-width-only block as an open sidebar window
// without rendering a corresponding React host. A non-breaking space remains
// visually empty while ensuring the temporary composer block is renderable.
export const CHAT_COMPOSER_PLACEHOLDER = "\u00A0";

export function normalizeBridgeUrl(value) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_BRIDGE_URL));
  } catch {
    throw new Error("Bridge URL must be a valid loopback URL.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Bridge URL must use http://127.0.0.1 with an explicit port.",
    );
  }
  return url.origin;
}

function activeGraphName(api = globalThis.window?.roamAlphaAPI) {
  const graph = typeof api?.graph?.name === "string" ? api.graph.name.trim() : "";
  if (!graph || graph.length > 200 || /[\u0000-\u001f]/.test(graph)) {
    throw new Error("Roam's active graph name is unavailable.");
  }
  return graph;
}

function currentGraphName() {
  return EXTENSION_CONFIG.graph || activeGraphName();
}

function currentBridgeUrl() {
  return EXTENSION_CONFIG.bridgeUrl;
}

function graphHeaderValue(graph) {
  return encodeURIComponent(graph);
}

function graphStorageKey(prefix, graph = currentGraphName()) {
  return `${prefix}.${encodeURIComponent(graph)}`;
}

export function chatStateKey(graph) {
  return graphStorageKey(CHAT_STATE_KEY_PREFIX, graph);
}

export function legacyChatStateKey(graph) {
  return graphStorageKey(LEGACY_CHAT_STATE_KEY_PREFIX, graph);
}

function tokenKey(graph) {
  return graphStorageKey(TOKEN_KEY_PREFIX, graph);
}

function runningStatusKey(graph) {
  return graphStorageKey(RUNNING_STATUS_KEY_PREFIX, graph);
}

function installationIdKey(graph) {
  return graphStorageKey(INSTALLATION_ID_KEY_PREFIX, graph);
}

function transcriptHeightKey(graph) {
  return graphStorageKey(CHAT_TRANSCRIPT_HEIGHT_KEY_PREFIX, graph);
}

function emptyChatState({
  defaultAccess = EXTENSION_CONFIG.defaultAccess,
  defaultModel = EXTENSION_CONFIG.defaultModel,
} = {}) {
  return {
    version: CHAT_STATE_VERSION,
    activeThreadId: null,
    newConversationPreferences: {
      model: defaultModel,
      effort: null,
      speed: null,
      access: defaultAccess,
    },
    threadPreferences: {},
    lastSeenUpdatedAt: {},
    pendingThreads: {},
    // Conversation membership is an in-memory view assembled from Roam plus
    // pending page-creation retries. writeChatState deliberately omits it.
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

function sanitizeConversationPreferences(value, fallbackAccess = "auto") {
  return {
    model: typeof value?.model === "string" ? value.model : null,
    effort: typeof value?.effort === "string" ? value.effort : null,
    speed: typeof value?.speed === "string" ? value.speed : null,
    access: CHAT_ACCESS_MODES.has(value?.access)
      ? value.access
      : fallbackAccess,
  };
}

function sanitizeThreadPreferences(value) {
  const preferences = {};
  for (const [threadId, record] of Object.entries(value || {}).slice(0, 500)) {
    if (!validThreadId(threadId)) continue;
    preferences[threadId] = sanitizeConversationPreferences(record);
  }
  return preferences;
}

function sanitizeLastSeenUpdatedAt(value) {
  const markers = {};
  for (const [threadId, timestamp] of Object.entries(value || {}).slice(0, 500)) {
    if (!validThreadId(threadId) || !Number.isFinite(timestamp) || timestamp < 0) {
      continue;
    }
    markers[threadId] = timestamp;
  }
  return markers;
}

function sanitizePendingThreads(value) {
  const pending = {};
  for (const [threadId, record] of Object.entries(value || {}).slice(0, 100)) {
    if (!validThreadId(threadId) || record?.threadId !== threadId) continue;
    const createdAt = Number.isFinite(record.createdAt) && record.createdAt > 0
      ? record.createdAt
      : Date.now();
    pending[threadId] = {
      threadId,
      createdAt,
      titleHint: typeof record.titleHint === "string"
        ? singleLine(record.titleHint).slice(0, 80)
        : "",
    };
  }
  return pending;
}

export function discardLegacyChatState({
  storage = window.localStorage,
  key = legacyChatStateKey(),
} = {}) {
  try {
    storage.removeItem?.(key);
  } catch {
    // A device that cannot remove obsolete cache can still use v3 state.
  }
}

export function readChatState({
  storage = window.localStorage,
  key = chatStateKey(),
  defaultAccess = EXTENSION_CONFIG.defaultAccess,
  defaultModel = EXTENSION_CONFIG.defaultModel,
} = {}) {
  let value;
  try {
    value = JSON.parse(storage.getItem(key) || "null");
  } catch {
    return emptyChatState({ defaultAccess, defaultModel });
  }

  if (!value || value.version !== CHAT_STATE_VERSION) {
    return emptyChatState({ defaultAccess, defaultModel });
  }

  const threadPreferences = sanitizeThreadPreferences(value.threadPreferences);
  const lastSeenUpdatedAt = sanitizeLastSeenUpdatedAt(value.lastSeenUpdatedAt);
  const pendingThreads = sanitizePendingThreads(value.pendingThreads);
  const conversations = Object.fromEntries(
    Object.values(pendingThreads).map((record) => {
      const preferences = threadPreferences[record.threadId] ||
        sanitizeConversationPreferences(null);
      return [record.threadId, {
        threadId: record.threadId,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        ...preferences,
        threadPageUid: null,
        threadPageTitle: null,
        originInstallationId: null,
        lastSeenUpdatedAt: lastSeenUpdatedAt[record.threadId] || 0,
        availability: "pending",
        pendingGraphIndex: true,
      }];
    }),
  );

  return {
    version: CHAT_STATE_VERSION,
    activeThreadId: validThreadId(value.activeThreadId)
      ? value.activeThreadId
      : null,
    newConversationPreferences: sanitizeConversationPreferences(
      value.newConversationPreferences,
      defaultAccess,
    ),
    threadPreferences,
    lastSeenUpdatedAt,
    pendingThreads,
    conversations,
  };
}

export function writeChatState(
  state,
  { storage = window.localStorage, key = chatStateKey() } = {},
) {
  storage.setItem(key, JSON.stringify({
    version: CHAT_STATE_VERSION,
    activeThreadId: validThreadId(state?.activeThreadId)
      ? state.activeThreadId
      : null,
    newConversationPreferences: sanitizeConversationPreferences(
      state?.newConversationPreferences,
      EXTENSION_CONFIG.defaultAccess,
    ),
    threadPreferences: sanitizeThreadPreferences(state?.threadPreferences),
    lastSeenUpdatedAt: sanitizeLastSeenUpdatedAt(state?.lastSeenUpdatedAt),
    pendingThreads: sanitizePendingThreads(state?.pendingThreads),
  }));
}

function getRoamApi() {
  if (!window.roamAlphaAPI) {
    throw new Error("Roam Alpha API is unavailable.");
  }
  return window.roamAlphaAPI;
}

function getToken({
  storage = window.localStorage,
  graph = currentGraphName(),
} = {}) {
  return storage.getItem(tokenKey(graph))?.trim() || "";
}

async function bridgeFetch(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init);
  } catch (cause) {
    const error = new Error("The local Codex bridge isn't responding.");
    error.code = "BRIDGE_UNREACHABLE";
    error.cause = cause;
    throw error;
  }
}

function missingTokenError() {
  const error = new Error(
    "Pair this device with the local Codex bridge to continue.",
  );
  error.code = "NOT_PAIRED";
  return error;
}

function bridgeResponseError(response, body = {}) {
  if (response.status === 401) {
    const error = missingTokenError();
    error.status = response.status;
    return error;
  }
  const error = new Error(
    body.error || `Bridge returned HTTP ${response.status}.`,
  );
  error.status = response.status;
  if (typeof body.code === "string") error.code = body.code;
  return error;
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
  graph = currentGraphName(),
  bridgeUrl = currentBridgeUrl(),
  token = getToken({ graph }),
  graphGuidelines,
  onProgress = () => {},
  onStarted = () => {},
} = {}) {
  if (!token) {
    throw missingTokenError();
  }

  const body = { graph, blockUid };
  if (graphGuidelines !== undefined) body.graphGuidelines = graphGuidelines;

  const response = await bridgeFetch(fetchImpl, `${bridgeUrl}/probe`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-roam-graph": graphHeaderValue(graph),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let body = {};
    try {
      body = await response.json();
    } catch {
      // A useful status error is emitted below.
    }
    throw bridgeResponseError(response, body);
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
      if (typeof event.codexErrorInfo === "string") {
        error.codexErrorInfo = event.codexErrorInfo;
      }
      if (Number.isFinite(event.httpStatusCode)) {
        error.httpStatusCode = event.httpStatusCode;
      }
      if (typeof event.additionalDetails === "string") {
        error.additionalDetails = event.additionalDetails;
      }
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
  graph = currentGraphName(),
  bridgeUrl = currentBridgeUrl(),
  token = getToken({ graph }),
} = {}) {
  if (!token) {
    throw missingTokenError();
  }

  const response = await bridgeFetch(fetchImpl, `${bridgeUrl}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-roam-graph": graphHeaderValue(graph),
    },
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    // A useful status error is emitted below.
  }
  if (!response.ok) {
    throw bridgeResponseError(response, body);
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

export async function requestPanelAuth(options = {}) {
  const result = await bridgeJson("/auth", options);
  return {
    auth: result.auth === "authenticated" ? "authenticated" : "signed-out",
    method: typeof result.method === "string" ? result.method : null,
  };
}

export async function requestPanelLogin({
  fetchImpl = window.fetch.bind(window),
  graph = currentGraphName(),
  bridgeUrl = currentBridgeUrl(),
  token = getToken({ graph }),
} = {}) {
  if (!token) {
    throw missingTokenError();
  }
  const response = await bridgeFetch(fetchImpl, `${bridgeUrl}/auth/login`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-roam-graph": graphHeaderValue(graph),
    },
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    // A useful status error is emitted below.
  }
  if (!response.ok || typeof result.authUrl !== "string") {
    throw bridgeResponseError(response, result);
  }
  return { loginId: result.loginId || null, authUrl: result.authUrl };
}

export async function probeBridgeConnection({
  fetchImpl = window.fetch.bind(window),
  storage = window.localStorage,
  graph = currentGraphName(),
  bridgeUrl = currentBridgeUrl(),
} = {}) {
  let response;
  try {
    response = await fetchImpl(`${bridgeUrl}/health`, {
      headers: { "x-roam-graph": graphHeaderValue(graph) },
    });
  } catch (error) {
    return { state: "no-bridge", graph, bridgeUrl, detail: error.message };
  }

  let result = {};
  try {
    result = await response.json();
  } catch {
    // A non-JSON reply is treated through the status checks below.
  }
  if (response.ok && result.ok === true && result.graph === null) {
    return { state: "unpaired", graph, bridgeUrl };
  }
  if (
    response.status === 409 ||
    (typeof result.graph === "string" && result.graph !== graph)
  ) {
    return {
      state: "wrong-graph",
      graph,
      bridgeUrl,
      serverGraph: typeof result.graph === "string" ? result.graph : null,
      detail: typeof result.error === "string" ? result.error : "",
    };
  }
  if (!response.ok || result.ok !== true) {
    return {
      state: "no-bridge",
      graph,
      bridgeUrl,
      detail: typeof result.error === "string" ? result.error : "",
    };
  }
  if (!getToken({ storage, graph })) {
    return { state: "unpaired", graph, bridgeUrl };
  }
  return { state: "connected", graph, bridgeUrl };
}

export async function requestPanelThreadSummaries(threadIds, {
  fetchImpl = window.fetch.bind(window),
  graph = currentGraphName(),
  bridgeUrl = currentBridgeUrl(),
  token = getToken({ graph }),
} = {}) {
  if (!token) {
    throw missingTokenError();
  }
  if (
    !Array.isArray(threadIds) ||
    threadIds.length > 100 ||
    threadIds.some((threadId) => !validThreadId(threadId)) ||
    new Set(threadIds).size !== threadIds.length
  ) {
    throw new Error("Conversation history requires at most 100 unique thread IDs.");
  }

  const response = await bridgeFetch(fetchImpl, `${bridgeUrl}/threads/summaries`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-roam-graph": graphHeaderValue(graph),
    },
    body: JSON.stringify({ graph, threadIds }),
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    // A useful status error is emitted below.
  }
  if (!response.ok) {
    throw bridgeResponseError(response, result);
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
  graph = currentGraphName(),
  bridgeUrl = currentBridgeUrl(),
  token = getToken({ graph }),
} = {}) {
  if (!token) {
    throw missingTokenError();
  }
  const cleanName = singleLine(name);
  if (!validThreadId(threadId) || !cleanName || cleanName.length > 100) {
    throw new Error("A valid conversation and name are required.");
  }
  const response = await bridgeFetch(
    fetchImpl,
    `${bridgeUrl}/threads/${encodeURIComponent(threadId)}/name`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-roam-graph": graphHeaderValue(graph),
      },
      body: JSON.stringify({ graph, name: cleanName }),
    },
  );
  let result = {};
  try {
    result = await response.json();
  } catch {
    // A useful status error is emitted below.
  }
  if (!response.ok) {
    throw bridgeResponseError(response, result);
  }
  return result;
}

export async function requestPanelThreadDelete(threadId, {
  fetchImpl = window.fetch.bind(window),
  graph = currentGraphName(),
  bridgeUrl = currentBridgeUrl(),
  token = getToken({ graph }),
} = {}) {
  if (!token) {
    throw missingTokenError();
  }
  if (!validThreadId(threadId)) {
    throw new Error("Cannot delete a conversation without a valid thread ID.");
  }
  const response = await bridgeFetch(
    fetchImpl,
    `${bridgeUrl}/threads/${encodeURIComponent(threadId)}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        "x-roam-graph": graphHeaderValue(graph),
      },
    },
  );
  let result = {};
  try {
    result = await response.json();
  } catch {
    // A useful status error is emitted below.
  }
  if (!response.ok) {
    throw bridgeResponseError(response, result);
  }
  return result;
}

export async function requestPanelChat(message, {
  fetchImpl = window.fetch.bind(window),
  graph = currentGraphName(),
  bridgeUrl = currentBridgeUrl(),
  token = getToken({ graph }),
  promptBlockUid,
  graphGuidelines,
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
    throw missingTokenError();
  }
  if (!validBlockUid(promptBlockUid)) {
    throw new Error("Cannot chat without a valid Roam prompt block UID.");
  }

  const body = {
    graph,
    message: String(message),
    promptBlockUid,
  };
  if (graphGuidelines !== undefined) body.graphGuidelines = graphGuidelines;
  if (threadId) body.threadId = threadId;
  if (model) body.model = model;
  if (effort) body.effort = effort;
  if (serviceTier !== undefined) body.serviceTier = serviceTier;
  body.accessMode = CHAT_ACCESS_MODES.has(accessMode) ? accessMode : "auto";
  const sanitizedServers = sanitizeEnabledMcpServers(enabledServers);
  if (sanitizedServers.length) body.enabledServers = sanitizedServers;

  const response = await bridgeFetch(fetchImpl, `${bridgeUrl}/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-roam-graph": graphHeaderValue(graph),
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
    throw bridgeResponseError(response, result);
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
  graph = currentGraphName(),
  bridgeUrl = currentBridgeUrl(),
  token = getToken({ graph }),
} = {}) {
  if (!token) {
    throw missingTokenError();
  }
  if (!/^[0-9a-f-]{36}$/i.test(runId) || !/^[0-9a-f-]{36}$/i.test(approvalId)) {
    throw new Error("A valid active approval is required.");
  }
  if (!["accept", "reject"].includes(decision)) {
    throw new Error("A valid approval decision is required.");
  }
  const response = await bridgeFetch(
    fetchImpl,
    `${bridgeUrl}/runs/${runId}/approvals/${approvalId}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-roam-graph": graphHeaderValue(graph),
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
    throw bridgeResponseError(response, result);
  }
  return result;
}

export async function requestRunCancellation(runId, {
  fetchImpl = window.fetch.bind(window),
  graph = currentGraphName(),
  bridgeUrl = currentBridgeUrl(),
  token = getToken({ graph }),
} = {}) {
  if (!token) {
    throw missingTokenError();
  }
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    throw new Error("Cannot stop a run without a valid run ID.");
  }

  const response = await bridgeFetch(
    fetchImpl,
    `${bridgeUrl}/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-roam-graph": graphHeaderValue(graph),
      },
    },
  );
  let result = {};
  try {
    result = await response.json();
  } catch {
    // A useful status error is emitted below.
  }
  if (!response.ok) {
    throw bridgeResponseError(response, result);
  }
  return result;
}

export async function requestRunSteer(runId, message, {
  fetchImpl = window.fetch.bind(window),
  graph = currentGraphName(),
  bridgeUrl = currentBridgeUrl(),
  token = getToken({ graph }),
} = {}) {
  if (!token) {
    throw missingTokenError();
  }
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    throw new Error("Cannot steer a run without a valid run ID.");
  }

  const response = await bridgeFetch(
    fetchImpl,
    `${bridgeUrl}/runs/${encodeURIComponent(runId)}/steer`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-roam-graph": graphHeaderValue(graph),
      },
      body: JSON.stringify({ graph, message: String(message) }),
    },
  );
  let result = {};
  try {
    result = await response.json();
  } catch {
    // A useful status error is emitted below.
  }
  if (!response.ok) {
    throw bridgeResponseError(response, result);
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
  key = installationIdKey(),
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

function orderedOutlineChildren(block) {
  return [...(block?.[":block/children"] || [])].sort((left, right) => {
    const leftOrder = Number.isFinite(left?.[":block/order"])
      ? left[":block/order"]
      : Number.MAX_SAFE_INTEGER;
    const rightOrder = Number.isFinite(right?.[":block/order"])
      ? right[":block/order"]
      : Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}

function appendGuidelineOutline(lines, block, depth) {
  const value = typeof block?.[":block/string"] === "string"
    ? block[":block/string"].trim()
    : "";
  if (value) {
    const indent = "  ".repeat(depth);
    const continuation = `\n${"  ".repeat(depth + 1)}`;
    lines.push(`${indent}- ${value.replace(/\r?\n/g, continuation)}`);
  }
  for (const child of orderedOutlineChildren(block)) {
    appendGuidelineOutline(lines, child, value ? depth + 1 : depth);
  }
}

export async function readGraphAgentGuidelines({
  api = getRoamApi(),
  maxLength = MAX_GRAPH_GUIDELINES_LENGTH,
} = {}) {
  const pageUid = await Promise.resolve(
    exactPageUid(api, AGENT_GUIDELINES_PAGE_TITLE),
  );
  if (!pageUid) return "";

  const pattern = [
    "[:block/uid :node/title :block/string :block/order",
    "{:block/children ...}]",
  ].join(" ");
  const page = api.data?.async?.pull
    ? await api.data.async.pull(pattern, [":block/uid", pageUid])
    : api.data?.pull?.(pattern, [":block/uid", pageUid]);
  if (!page) return "";

  const lines = [];
  for (const child of orderedOutlineChildren(page)) {
    appendGuidelineOutline(lines, child, 0);
  }
  const text = lines.join("\n").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
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

export async function deleteGraphThreadRecord(
  record,
  { api = getRoamApi() } = {},
) {
  if (
    !validThreadId(record?.threadId) ||
    !validBlockUid(record?.threadPageUid) ||
    typeof record?.threadPageTitle !== "string" ||
    !record.threadPageTitle.startsWith(THREAD_PAGE_PREFIX)
  ) {
    throw new Error("Refusing to delete an invalid Codex thread page.");
  }
  if (!api.data?.page?.delete) {
    throw new Error("Roam page deletion is unavailable.");
  }
  await api.data.page.delete({
    page: { uid: record.threadPageUid },
  });
  return {
    threadId: record.threadId,
    threadPageUid: record.threadPageUid,
  };
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

export function conversationAgeLabel(value, currentTime = Date.now()) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const elapsed = Math.max(0, currentTime - value);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return "now";
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m ago`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h ago`;
  if (elapsed < 30 * day) return `${Math.floor(elapsed / day)}d ago`;
  if (elapsed < 365 * day) return `${Math.floor(elapsed / (30 * day))}mo ago`;
  return `${Math.floor(elapsed / (365 * day))}y ago`;
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

function readRunningStatusUids(storage, key = runningStatusKey()) {
  try {
    const value = JSON.parse(storage.getItem(key) || "[]");
    return Array.isArray(value)
      ? value.filter((uid) => typeof uid === "string")
      : [];
  } catch {
    return [];
  }
}

function writeRunningStatusUids(storage, uids, key = runningStatusKey()) {
  if (uids.length) {
    storage.setItem(key, JSON.stringify([...new Set(uids)]));
  } else {
    storage.removeItem(key);
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

export async function workOnBlock(
  blockUid,
  {
    api = getRoamApi(),
    storage = window.localStorage,
    request = requestProbe,
    cancelRequest = requestRunCancellation,
    notifyImpl = notify,
    startPresentation = startRunningPresentation,
    openChatImpl = () => openChatPanel(),
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
  let result;
  let failure;

  try {
    let graphGuidelines;
    try {
      graphGuidelines = await readGraphAgentGuidelines({ api });
    } catch {
      // The runtime can fall back to the MCP guideline tool when the live
      // page could not be read through Roam's local API.
    }
    statusUid = await createRunningStatus(blockUid, { api, storage });
    stopPresentation = startPresentation(statusUid);
    result = await request(blockUid, {
      graphGuidelines,
      onProgress: (progress) => stopPresentation?.update?.(progress),
      onStarted: ({ runId }) => {
        stopPresentation?.setCancelHandler?.(() => cancelRequest(runId));
      },
    });
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
      return { outcome: "stopped", reply: "" };
    }
    if (failure.code === "NOT_PAIRED") {
      notifyImpl(
        "Pair this device with the local Codex bridge to continue — opening the chat panel.",
        "warning",
      );
      void openChatImpl().catch(() => {});
      throw failure;
    }
    if (failure.code === "BRIDGE_UNREACHABLE") {
      notifyImpl(
        "The local Codex bridge isn't running. Start it with npx roam-codex-bridge.",
        "warning",
      );
      throw failure;
    }
    notifyImpl(`Codex could not finish: ${failure.message}`, "danger");
    throw failure;
  }

  const reply = typeof result?.reply === "string" ? result.reply.trim() : "";
  notifyImpl(reply || "Codex finished this block.", "success");
  return { outcome: "completed", reply };
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
  // Minimal test documents do not provide this native DOM back-reference.
  if (!element.ownerDocument) element.ownerDocument = doc;
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

export function placeChatHeader(
  controller,
  { doc = globalThis.document, host = null } = {},
) {
  const chatHeader = controller?.headerElement;
  if (!chatHeader) return false;
  const placement = findSidebarChatLauncherPlacement(doc);
  const launcher = doc?.getElementById?.(SIDEBAR_CHAT_LAUNCHER_ID);
  if (
    placement?.header &&
    launcher?.parentNode === placement.header
  ) {
    if (
      chatHeader.parentNode !== placement.header ||
      launcher.nextSibling !== chatHeader
    ) {
      placement.header.insertBefore(
        chatHeader,
        launcher.nextSibling || placement.nativeToggle || null,
      );
    }
    return true;
  }
  if (host && controller?.element) {
    if (
      chatHeader.parentNode !== host ||
      chatHeader.nextSibling !== controller.element
    ) {
      host.insertBefore(chatHeader, controller.element);
    }
  }
  return false;
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
      placeChatHeader(ACTIVE_CHAT_PANEL, { doc });
      return mountedButton;
    }
    mountedButton = mountSidebarChatLauncher({ doc, ...mountOptions });
    placeChatHeader(ACTIVE_CHAT_PANEL, { doc });
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
  const addWindowResult = api.ui.rightSidebar.addWindow({
    window: { type: "block", "block-uid": blockUid, order: 0 },
  });
  let sidebarWindow = findSidebarBlockWindow(blockUid, { api });
  if (!sidebarWindow) {
    const addWindowFailure = new Promise((_, reject) => {
      Promise.resolve(addWindowResult).catch(reject);
    });
    sidebarWindow = await Promise.race([
      waitForSidebarBlockWindow(blockUid, api, waitOptions),
      addWindowFailure,
    ]);
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
    children: orderedOutlineChildren(block).map(snapshotChatPromptOutline),
  };
}

function appendChatPromptOutline(lines, block, depth, root = false) {
  const value = normalizeChatPromptText(block?.[":block/string"]);
  let childDepth = depth;
  if (value) {
    if (root) {
      lines.push(value);
    } else {
      const indent = "  ".repeat(depth);
      const continuation = `\n${"  ".repeat(depth + 1)}`;
      lines.push(`${indent}- ${value.replace(/\r?\n/g, continuation)}`);
      childDepth += 1;
    }
  }
  for (const child of orderedOutlineChildren(block)) {
    appendChatPromptOutline(lines, child, childDepth);
  }
}

export function serializeChatPromptOutline(block) {
  const lines = [];
  appendChatPromptOutline(lines, block, 0, true);
  return lines.join("\n").trim();
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
  {
    api = getRoamApi(),
    preferredBlockUid = null,
  } = {},
) {
  const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
  const focused = api.ui?.getFocusedBlock?.();
  if (!sidebarWindow?.["window-id"]) {
    throw new Error("The chat composer is no longer available.");
  }

  const pattern =
    "[:block/uid :block/string :block/order {:block/children ...}]";
  const rootPull = api.data?.async?.pull
    ? await api.data.async.pull(pattern, [":block/uid", rootBlockUid])
    : api.data?.pull?.(pattern, [":block/uid", rootBlockUid]);
  if (!rootPull) {
    throw new Error("The chat composer is no longer available.");
  }

  const focusedBlockUid =
    focused?.["window-id"] === sidebarWindow["window-id"] &&
      validBlockUid(focused?.["block-uid"])
      ? focused["block-uid"]
      : null;
  const focusUid = [...new Set([
    focusedBlockUid,
    validBlockUid(preferredBlockUid) ? preferredBlockUid : null,
    rootBlockUid,
  ].filter(Boolean))].find((uid) => findChatPromptPath(rootPull, uid)) ||
    rootBlockUid;
  const text = serializeChatPromptOutline(rootPull);
  if (text) {
    const outline = snapshotChatPromptOutline(rootPull);
    return {
      uid: rootBlockUid,
      focusUid,
      text,
      outline,
      rootOutline: outline,
    };
  }

  throw new Error("Write a message in the chat composer before sending.");
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

export async function resolveChatPromptBlock({
  api = getRoamApi(),
  date = new Date(),
} = {}) {
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
  defaultAccess = EXTENSION_CONFIG.defaultAccess,
  defaultModel = EXTENSION_CONFIG.defaultModel,
  requestChatImpl = requestPanelChat,
  requestModelsImpl = requestPanelModels,
  requestMcpServersImpl = requestPanelMcpServers,
  probeConnectionImpl = probeBridgeConnection,
  authRequest = requestPanelAuth,
  loginRequest = requestPanelLogin,
  pairRequest = pairBridge,
  openUrlImpl = (url) => doc.defaultView?.open?.(url, "_blank", "noopener"),
  readEnabledMcpServersImpl = () =>
    EXTENSION_SETTINGS?.get?.(ENABLED_MCP_SERVERS_SETTING),
  writeEnabledMcpServersImpl = (servers) =>
    EXTENSION_SETTINGS?.set?.(ENABLED_MCP_SERVERS_SETTING, servers),
  requestMessagesImpl = requestPanelMessages,
  requestHistoryImpl = requestPanelThreadSummaries,
  requestThreadNameImpl = requestPanelThreadName,
  requestDeleteThreadImpl = requestPanelThreadDelete,
  requestGraphIndexImpl = () => readGraphThreadIndex({ api }),
  ensureGraphThreadImpl = (input) => ensureGraphThreadRecord({
    ...input,
    api,
    storage,
  }),
  deleteGraphThreadImpl = (record) => deleteGraphThreadRecord(record, { api }),
  updateGraphActivityImpl = (record, timestamp) =>
    updateGraphThreadActivity(record, timestamp, { api }),
  copyTextImpl = copyRoamText,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  settleComposerResetImpl = () =>
    new Promise((resolve) => globalThis.setTimeout(resolve, 0)),
  findComposerEditorImpl = () => {
    const shell = doc.querySelector?.(".roam-codex-chat-composer-shell");
    if (shell) {
      return shell.querySelector?.(
        '[contenteditable="true"], .block-editor, .rm-block-editor, .rm-block__self',
      ) || null;
    }
    return doc.querySelector?.(
      ".roam-codex-chat-window > .roam-codex-native-composer " +
        '[contenteditable="true"]',
    ) || null;
  },
  composerSettleTimeoutMs = 800,
  setIntervalImpl = globalThis.setInterval?.bind(globalThis),
  clearIntervalImpl = globalThis.clearInterval?.bind(globalThis),
  matchMediaImpl = globalThis.matchMedia?.bind(globalThis),
  navigatorImpl = globalThis.navigator,
  readPromptImpl = ({ preferredBlockUid = null } = {}) =>
    readFocusedPromptBlock(rootBlockUid, { api, preferredBlockUid }),
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
  steerRequest = requestRunSteer,
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

  discardLegacyChatState({ storage });
  let state = readChatState({ storage, defaultAccess, defaultModel });
  let messages = [];
  let models = [];
  let modelsReady = false;
  let modelsError = "";
  let mcpServers = [];
  let connection = { state: "checking" };
  let connectionRetryTimer = null;
  let connectionProbeVersion = 0;
  let connectionNote = "";
  let connectionCardVisible = false;
  let pairingCodeRequired = false;
  let enabledMcpServers = sanitizeEnabledMcpServers(
    readEnabledMcpServersImpl(),
  );
  let runId = null;
  let running = false;
  let steerPending = false;
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
  let historyMenuThreadId = null;
  let deletingThreadId = null;
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
  let pickerAccess = defaultAccess;
  let pickerOpen = false;
  let pickerLevel = null;
  let stopDisabled = false;
  let lastComposerBlockUid = rootBlockUid;
  const copyFeedbackTimers = new Map();
  const copyStates = new Map();
  const approvalCards = new Map();
  let progressState = { text: "", kind: "", running: false, elapsed: "" };

  const rememberComposerFocus = () => {
    const focused = api.ui?.getFocusedBlock?.();
    const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
    if (
      validBlockUid(focused?.["block-uid"]) &&
      focused?.["window-id"] === sidebarWindow?.["window-id"]
    ) {
      lastComposerBlockUid = focused["block-uid"];
    }
  };

  const prepareComposerEditorForSubmit = async () => {
    const editor = findComposerEditorImpl();
    if (!editor) return;
    // The native block editor keeps a local draft for a mounted block.
    // Blur it before the prompt is read so Roam commits the draft to the
    // graph; otherwise the editor can overwrite the later reset with its
    // own state. Both the mouse and Alt+Enter paths call send(), so this
    // runs identically for both.
    editor.blur?.();
    await settleComposerResetImpl();
    await settleComposerResetImpl();
  };

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

  const connectionMount = createPanelElement(doc, "div");
  body.appendChild(connectionMount);

  const transcriptWrap = createPanelElement(
    doc,
    "div",
    "roam-codex-chat-transcript-wrap",
  );
  transcriptWrap.hidden = true;
  let transcript = null;
  const transcriptMount = createPanelElement(doc, "div");
  transcriptWrap.appendChild(transcriptMount);
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
    if (!transcript) {
      scrollLatestButton.hidden = true;
      return;
    }
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
    if (!transcript) return;
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
  scrollLatestButton.addEventListener("click", scrollToLatest);

  const transcriptHandle = createPanelElement(
    doc,
    "div",
    "roam-codex-chat-resize",
  );
  transcriptHandle.setAttribute("role", "separator");
  transcriptHandle.setAttribute("aria-orientation", "horizontal");
  transcriptHandle.setAttribute("aria-label", "Resize the conversation area");
  transcriptHandle.hidden = true;
  body.appendChild(transcriptHandle);

  const createRoot = window.ReactDOMClient?.createRoot;
  if (!window.React?.createElement || !createRoot)
    throw new Error("Codex chat requires Roam's React 18 globals.");
  const connectionRoot = createRoot(connectionMount);
  const transcriptRoot = createRoot(transcriptMount);
  const historyRoot = createRoot(historyPopover);

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
      value = Number.parseInt(storage.getItem(transcriptHeightKey()), 10);
    } catch {
      return null;
    }
    return Number.isFinite(value) ? clampTranscriptHeight(value) : null;
  };
  const applyTranscriptHeight = (height) => {
    setElementStyle(transcriptWrap, "height", `${height}px`);
    setElementStyle(transcriptWrap, "maxHeight", `${height}px`);
    if (transcript) {
      setElementStyle(transcript, "height", `${height}px`);
      setElementStyle(transcript, "maxHeight", `${height}px`);
    }
  };
  let transcriptHeight = readStoredTranscriptHeight() ??
    CHAT_TRANSCRIPT_DEFAULT_HEIGHT;
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
      storage.setItem(transcriptHeightKey(), String(transcriptHeight));
    } catch {
      // A device that cannot persist the height still keeps this session's.
    }
  };
  transcriptHandle.addEventListener("pointerdown", (event) => {
    if (!Number.isFinite(event?.clientY)) return;
    const measured = transcriptWrap?.getBoundingClientRect?.()?.height;
    const styled = Number.parseFloat(transcriptWrap.style?.height);
    transcriptResize = {
      startY: event.clientY,
      startHeight: Number.isFinite(measured) && measured > 0
        ? measured
        : Number.isFinite(styled) && styled > 0
          ? styled
          : transcriptHeight,
    };
    doc.addEventListener?.("pointermove", handleTranscriptResizeMove, true);
    doc.addEventListener?.("pointerup", stopTranscriptResize, true);
    event.preventDefault?.();
  });

  const sendShortcutIsMac = /Mac|iP(?:hone|ad|od)/i.test(
    navigatorImpl?.platform || navigatorImpl?.userAgent || "",
  );
  panel.appendChild(body);

  const controls = createPanelElement(
    doc,
    "footer",
    "roam-codex-chat-controls",
  );
  controls.id = CHAT_CONTROLS_ID;
  const controlsRoot = createRoot(controls);

  const persist = () => writeChatState(state, { storage });
  const currentRecord = () => state.activeThreadId
    ? state.conversations[state.activeThreadId]
    : null;
  const currentPreferences = () => {
    if (!state.activeThreadId) return state.newConversationPreferences;
    return state.threadPreferences[state.activeThreadId] ||
      currentRecord() ||
      state.newConversationPreferences;
  };

  const savePreferences = () => {
    const model = pickerModel || null;
    const effort = pickerEffort || null;
    const speed = pickerSpeed || null;
    const access = CHAT_ACCESS_MODES.has(pickerAccess) ? pickerAccess : "auto";
    const preferences = { model, effort, speed, access };
    const record = currentRecord();
    if (state.activeThreadId) {
      state.threadPreferences[state.activeThreadId] = preferences;
    }
    if (record) {
      record.model = model;
      record.effort = effort;
      record.speed = speed;
      record.access = access;
    } else if (!state.activeThreadId) {
      state.newConversationPreferences = preferences;
    }
    persist();
  };

  const rememberThread = (threadId, { completed = false } = {}) => {
    if (!validThreadId(threadId)) return;
    const timestamp = now();
    const previous = state.conversations[threadId];
    const previousPreferences = state.threadPreferences[threadId] || previous;
    const preferences = {
      model: pickerModel || previousPreferences?.model || null,
      effort: pickerEffort || previousPreferences?.effort || null,
      speed: pickerSpeed || previousPreferences?.speed || null,
      access: CHAT_ACCESS_MODES.has(pickerAccess)
        ? pickerAccess
        : previousPreferences?.access || "auto",
    };
    state.threadPreferences[threadId] = preferences;
    if (!previous?.threadPageUid && !graphThreadRecords.has(threadId)) {
      state.pendingThreads[threadId] = {
        threadId,
        createdAt: state.pendingThreads[threadId]?.createdAt ||
          previous?.createdAt ||
          timestamp,
        titleHint: state.pendingThreads[threadId]?.titleHint || "",
      };
    }
    if (completed) {
      state.lastSeenUpdatedAt[threadId] = Math.max(
        state.lastSeenUpdatedAt[threadId] || 0,
        timestamp,
      );
    }
    state.conversations[threadId] = {
      threadId,
      createdAt: previous?.createdAt || timestamp,
      updatedAt: completed ? timestamp : previous?.updatedAt || timestamp,
      ...preferences,
      threadPageUid: previous?.threadPageUid || null,
      threadPageTitle: previous?.threadPageTitle || null,
      originInstallationId: previous?.originInstallationId || null,
      lastSeenUpdatedAt: state.lastSeenUpdatedAt[threadId] || 0,
      availability: "available",
      pendingGraphIndex: Boolean(state.pendingThreads[threadId]),
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
    const preferences = state.threadPreferences[graphRecord.threadId] ||
      sanitizeConversationPreferences(previous);
    const record = {
      threadId: graphRecord.threadId,
      createdAt: graphRecord.createdAt || previous.createdAt || now(),
      updatedAt: Math.max(
        graphRecord.lastActiveAt || 0,
        previous.updatedAt || 0,
        graphRecord.createdAt || 0,
      ),
      ...preferences,
      threadPageUid: graphRecord.threadPageUid,
      threadPageTitle: graphRecord.threadPageTitle,
      originInstallationId: graphRecord.originInstallationId || null,
      lastSeenUpdatedAt: state.lastSeenUpdatedAt[graphRecord.threadId] || 0,
      availability: ["available", "missing", "unavailable"].includes(
          previous.availability,
        )
        ? previous.availability
        : "pending",
      pendingGraphIndex: false,
    };
    state.conversations[graphRecord.threadId] = record;
    graphThreadRecords.set(graphRecord.threadId, graphRecord);
    delete state.pendingThreads[graphRecord.threadId];
    return record;
  };

  const rebuildConversationMembership = (graphRecords) => {
    const previousConversations = state.conversations;
    const pendingThreads = Object.values(state.pendingThreads);
    state.conversations = {};
    graphThreadRecords.clear();

    for (const pendingThread of pendingThreads) {
      const previous = previousConversations[pendingThread.threadId] || {};
      const preferences = state.threadPreferences[pendingThread.threadId] ||
        sanitizeConversationPreferences(previous);
      state.conversations[pendingThread.threadId] = {
        threadId: pendingThread.threadId,
        createdAt: pendingThread.createdAt,
        updatedAt: previous.updatedAt || pendingThread.createdAt,
        ...preferences,
        threadPageUid: null,
        threadPageTitle: null,
        originInstallationId: null,
        lastSeenUpdatedAt:
          state.lastSeenUpdatedAt[pendingThread.threadId] || 0,
        availability: previous.availability || "pending",
        pendingGraphIndex: true,
      };
    }
    for (const graphRecord of graphRecords || []) applyGraphRecord(graphRecord);

    const memberThreadIds = new Set(Object.keys(state.conversations));
    for (const threadId of Object.keys(state.threadPreferences)) {
      if (!memberThreadIds.has(threadId)) delete state.threadPreferences[threadId];
    }
    for (const threadId of Object.keys(state.lastSeenUpdatedAt)) {
      if (!memberThreadIds.has(threadId)) delete state.lastSeenUpdatedAt[threadId];
    }
    for (const threadId of threadSummaries.keys()) {
      if (!memberThreadIds.has(threadId)) threadSummaries.delete(threadId);
    }
    if (
      state.activeThreadId &&
      !memberThreadIds.has(state.activeThreadId)
    ) {
      state.activeThreadId = null;
    }
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
    const record = state.conversations[threadId];
    if (!record?.threadPageUid && !graphThreadRecords.has(threadId)) {
      state.pendingThreads[threadId] = {
        threadId,
        createdAt: state.pendingThreads[threadId]?.createdAt ||
          record?.createdAt ||
          now(),
        titleHint: singleLine(title || "").slice(0, 80),
      };
      if (record) record.pendingGraphIndex = true;
      persist();
    }
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
          }
          persist();
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

  const handleCopy = async (message, button, roleLabel) => {
    const previousTimer = copyFeedbackTimers.get(message);
    if (previousTimer !== undefined) clearTimeoutImpl(previousTimer);
    copyFeedbackTimers.delete(message);
    copyStates.set(message, "copying");
    renderMessages();
    try {
      await copyTextImpl(message.text);
      if (closed) return;
      copyStates.set(message, "copied");
    } catch {
      if (closed) return;
      copyStates.set(message, "error");
    }
    renderMessages();
    const timer = setTimeoutImpl(() => {
      copyFeedbackTimers.delete(message);
      if (closed) return;
      copyStates.set(message, "idle");
      renderMessages();
    }, 1_400);
    copyFeedbackTimers.set(message, timer);
  };

  const renderMessages = ({ scroll = true } = {}) => {
    if (closed) return;
    const conversationAreaAvailable = connection.state === "connected";
    transcriptWrap.hidden = !conversationAreaAvailable;
    transcriptHandle.hidden = !conversationAreaAvailable;
    transcriptRoot.render(window.React.createElement(ChatTranscript, {
      messages,
      approvals: [...approvalCards.values()],
      progress: progressState,
      copyStates,
      BlockString: api.ui?.react?.BlockString || getRoamApi().ui.react.BlockString,
      onCopy: handleCopy,
      onDecide: decideApproval,
      transcriptRef: (node) => {
        transcript = node;
        if (!node) return;
        if (scroll) node.scrollTop = node.scrollHeight;
        updateScrollLatestButton();
      },
      onScroll: updateScrollLatestButton,
      height: transcriptHeight,
    }));
  };

  const setProgress = (text = "", kind = "") => {
    progressState = { ...progressState, text: singleLine(text), kind };
    renderMessages({ scroll: Boolean(progressState.text || progressState.running) });
  };

  const removeApprovalCard = (approvalId) => {
    if (!approvalCards.has(approvalId)) return;
    approvalCards.delete(approvalId);
    renderApprovalCards();
  };
  const clearApprovalCards = () => {
    approvalCards.clear();
    renderApprovalCards();
  };
  const decideApproval = (approvalId, decision) => {
    const approval = approvalCards.get(approvalId);
    if (!runId || !approval || approval.state === "submitting") return;
    approval.state = "submitting";
    renderApprovalCards();
    void approvalRequest(runId, approvalId, decision)
      .then(() => {
        removeApprovalCard(approvalId);
        setProgress("Continuing", "activity");
      })
      .catch((error) => {
        approval.state = "error";
        renderApprovalCards();
        setProgress(error.message || "Could not answer the approval.", "error");
      });
  };
  const renderApprovalCards = () => {
    if (closed) return;
    renderMessages();
  };
  const renderApproval = ({ approvalId, questions }) => {
    if (approvalCards.has(approvalId)) return;
    approvalCards.set(approvalId, { approvalId, questions, state: "" });
    renderApprovalCards();
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
    const catalogDefault = models.find((model) => model.isDefault) || models[0];
    const preferredModelAvailable = models.some(
      (model) => model.id === preferred.model,
    );
    pickerModel = preferredModelAvailable
      ? preferred.model
      : catalogDefault?.id || "";
    if (!state.activeThreadId && preferred.model && !preferredModelAvailable) {
      modelChanged = false;
    }
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

  const closePicker = ({ restoreFocus = false } = {}) => {
    pickerOpen = false;
    pickerLevel = null;
    renderControls();
    if (restoreFocus) {
      controls.querySelector?.(".roam-codex-chat-picker-button")?.focus?.();
    }
  };

  const pickerOptions = () => {
    const selected = currentModelEntry();
    if (pickerLevel === "model") {
      return models.filter((model) => model?.id).map((model) => ({
        id: model.id,
        label: `${model.displayName || model.id}${model.isDefault ? " (Default)" : ""}`,
        active: model.id === pickerModel,
        description: model.description || "",
      }));
    }
    if (pickerLevel === "effort") {
      const efforts = modelEfforts(selected);
      const defaultEffort = efforts.includes(selected?.defaultReasoningEffort)
        ? selected.defaultReasoningEffort
        : null;
      return efforts.map((effort) => ({
        id: effort,
        label: `${effortLabel(effort)}${effort === defaultEffort ? " (Default)" : ""}`,
        active: effort === pickerEffort,
        description: selected?.supportedReasoningEfforts?.find(
          (entry) => entry?.reasoningEffort === effort,
        )?.description || "",
      }));
    }
    if (pickerLevel === "speed") {
      const defaultTier = defaultTierIdFor(selected);
      return modelTierChoices(selected).map((tier) => ({
        id: tier.id,
        label: `${tier.name || tier.id}${tier.id === defaultTier ? " (Default)" : ""}`,
        active: tier.id === pickerSpeed,
        description: tier.description || "",
      }));
    }
    if (pickerLevel === "access") {
      return [
        ["auto", "Auto", "Allow requested Roam changes without asking"],
        ["read-only", "Read only", "Do not expose Roam write tools"],
        ["manual", "Manual", "Ask before each Roam write"],
      ].map(([id, label, description]) => ({
        id, label, description, active: id === pickerAccess,
      }));
    }
    if (pickerLevel === "tools") {
      return [{
        id: "Roam", label: "Roam", active: true, toggle: true,
        disabled: true, description: "Graph tools are always available",
      }, ...mcpServers.map((name) => ({
        id: name, label: name, active: enabledMcpServers.includes(name), toggle: true,
      }))];
    }
    return [];
  };

  const pickerRows = () => {
    const selected = currentModelEntry();
    const tiers = modelTierChoices(selected);
    const currentTier = tiers.find((tier) => tier.id === pickerSpeed);
    const rows = [
      { label: "Model", value: selected?.displayName || selected?.id || "—", level: "model" },
      { label: "Effort", value: pickerEffort ? effortLabel(pickerEffort) : "—", level: "effort" },
    ];
    if (tiers.length) {
      rows.push({ label: "Speed", value: currentTier?.name || currentTier?.id || "—", level: "speed" });
    }
    rows.push({ label: "Access", value: effortLabel(pickerAccess), level: "access" });
    if (mcpServers.length) {
      const enabledCount = enabledMcpServers
        .filter((name) => mcpServers.includes(name))
        .length;
      rows.push({ label: "Tools", value: enabledCount ? `Roam + ${enabledCount}` : "Roam only", level: "tools" });
    }
    return rows;
  };

  const pickPickerOption = (id) => {
    if (pickerLevel === "tools") {
      const previous = enabledMcpServers;
      const next = new Set(enabledMcpServers);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      enabledMcpServers = sanitizeEnabledMcpServers([...next]);
      renderControls();
      void Promise.resolve(writeEnabledMcpServersImpl(enabledMcpServers))
        .catch(() => {
          enabledMcpServers = previous;
          renderControls();
        });
      return;
    }
    if (pickerLevel === "model" && id !== pickerModel) {
      pickerModel = id;
      modelChanged = true;
      effortChanged = true;
      speedChanged = true;
      const selected = currentModelEntry();
      const efforts = modelEfforts(selected);
      if (!efforts.includes(pickerEffort)) {
        pickerEffort = efforts.includes(selected?.defaultReasoningEffort)
          ? selected.defaultReasoningEffort
          : efforts[0] || "";
      }
      if (!modelTierChoices(selected).some((tier) => tier.id === pickerSpeed)) {
        pickerSpeed = defaultTierIdFor(selected);
      }
      savePreferences();
    } else if (pickerLevel === "effort" && id !== pickerEffort) {
      pickerEffort = id;
      effortChanged = true;
      savePreferences();
    } else if (pickerLevel === "speed" && id !== pickerSpeed) {
      pickerSpeed = id;
      speedChanged = true;
      savePreferences();
    } else if (pickerLevel === "access" && id !== pickerAccess) {
      pickerAccess = id;
      savePreferences();
    }
    closePicker({ restoreFocus: true });
  };

  const stopTurn = () => {
    if (!runId) return;
    stopDisabled = true;
    setProgress("Stopping", "activity");
    renderControls();
    void cancelRequest(runId).catch((error) => {
      stopDisabled = false;
      setProgress(error.message || "Could not stop the turn.", "error");
      renderControls();
    });
  };

  const renderControls = () => {
    if (closed) return;
    const tier = modelTierChoices(currentModelEntry()).find(
      (entry) => entry.id === pickerSpeed,
    );
    controlsRoot.render(window.React.createElement(ChatControls, {
      picker: {
        label: modelsError || (modelsReady ? pickerLabel() : "Loading models…"),
        disabled: running || !modelsReady,
        open: pickerOpen,
        level: pickerLevel,
        speed: tier?.id === "priority" ? "fast" : "standard",
        rows: pickerRows(),
        options: pickerOptions(),
      },
      running,
      steering: running && Boolean(runId),
      sendDisabled: !modelsReady || (running && (!runId || steerPending)),
      stopDisabled,
      shortcutIsMac: sendShortcutIsMac,
      levelLabel: effortLabel,
      actions: {
        togglePicker: (nextOpen) => {
          if (running || !modelsReady) return;
          pickerOpen = typeof nextOpen === "boolean" ? nextOpen : !pickerOpen;
          if (!pickerOpen) pickerLevel = null;
          renderControls();
        },
        openPickerLevel: (level) => {
          pickerLevel = level;
          renderControls();
        },
        pick: pickPickerOption,
        rememberComposerFocus,
        send: () => void send(),
        stop: stopTurn,
      },
    }));
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
    historyMenuThreadId = null;
    historyPopover.hidden = true;
    conversationButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) conversationButton.focus?.();
  };

  const beginNewConversation = () => {
    if (running) return;
    const model = defaultModel;
    const effort = null;
    const speed = null;
    const access = defaultAccess;
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
      renderControls();
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
      renderControls();
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
        state.lastSeenUpdatedAt[threadId] = record.lastSeenUpdatedAt;
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
      if (["NOT_PAIRED", "BRIDGE_UNREACHABLE"].includes(error.code)) {
        setProgress("", "");
        void refreshConnection();
        return;
      }
      setProgress(error.message || "Could not load that conversation.", "error");
    }
  };

  const deleteConversation = async (threadId) => {
    if (
      running ||
      deletingThreadId ||
      !state.conversations[threadId]
    ) {
      return;
    }
    const localRecord = state.conversations[threadId];
    const graphRecord = graphThreadRecords.get(threadId) || localRecord;
    deletingThreadId = threadId;
    historyError = "";
    renderHistory();

    try {
      await requestDeleteThreadImpl(threadId);
      if (graphRecord?.threadPageUid) {
        await deleteGraphThreadImpl(graphRecord);
      }

      historyLoadVersion += 1;
      const deletedActiveConversation = state.activeThreadId === threadId;
      if (deletedActiveConversation) {
        selectionLoadVersion += 1;
        state.activeThreadId = null;
        state.newConversationPreferences = {
          model: defaultModel,
          effort: null,
          speed: null,
          access: defaultAccess,
        };
        messages = [];
        clearApprovalCards();
        modelChanged = Boolean(defaultModel);
        effortChanged = false;
        speedChanged = false;
      }

      delete state.conversations[threadId];
      delete state.threadPreferences[threadId];
      delete state.lastSeenUpdatedAt[threadId];
      delete state.pendingThreads[threadId];
      graphThreadRecords.delete(threadId);
      threadSummaries.delete(threadId);
      threadIndexPromises.delete(threadId);
      for (const mirroredName of [...mirroredThreadNames]) {
        if (mirroredName.startsWith(`${threadId}\n`)) {
          mirroredThreadNames.delete(mirroredName);
        }
      }

      historyMenuThreadId = null;
      deletingThreadId = null;
      persist();
      if (deletedActiveConversation) {
        renderMessages();
        setProgress();
        if (modelsReady) {
          initPicker();
          renderControls();
        }
      }
      renderConversationButton();
      if (historyOpen) renderHistory();
    } catch (error) {
      deletingThreadId = null;
      const connectionFailure = ["NOT_PAIRED", "BRIDGE_UNREACHABLE"].includes(
        error.code,
      );
      historyError = connectionFailure
        ? ""
        : error.message || "Could not delete that conversation.";
      if (connectionFailure) void refreshConnection();
      if (historyOpen) renderHistory();
    }
  };

  const renderHistory = () => {
    if (closed) return;
    const items = historyItems();
    historyRoot.render(window.React.createElement(ChatHistory, {
      items,
      activeThreadId: state.activeThreadId,
      error: historyError,
      running,
      menuThreadId: historyMenuThreadId,
      deletingThreadId,
      dateLabel: (value) => conversationAgeLabel(value, now()),
      onNew: beginNewConversation,
      onSelect: (threadId) => void selectConversation(threadId),
      onToggleMenu: (threadId) => {
        if (running || deletingThreadId) return;
        historyMenuThreadId = historyMenuThreadId === threadId
          ? null
          : threadId;
        renderHistory();
      },
      onDelete: (threadId) => void deleteConversation(threadId),
    }));
  };

  const loadHistory = async ({ reconcileActive = false } = {}) => {
    const loadVersion = ++historyLoadVersion;
    historyError = "";
    try {
      const graphIndex = await requestGraphIndexImpl();
      if (closed || loadVersion !== historyLoadVersion) return;
      rebuildConversationMembership(graphIndex?.records || []);
      if (graphIndex?.errors?.length) {
        historyError = `${graphIndex.errors.length} thread page${
          graphIndex.errors.length === 1 ? " has" : "s have"
        } invalid or duplicate metadata.`;
      }
      persist();
    } catch (error) {
      historyError = ["NOT_PAIRED", "BRIDGE_UNREACHABLE"].includes(error.code)
        ? ""
        : error.message || "The graph thread index is unavailable.";
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
      progressState = { ...progressState, running: true, elapsed: formatRunningElapsed(0) };
      if (setIntervalImpl && clearIntervalImpl && elapsedIntervalId === null) {
        elapsedIntervalId = setIntervalImpl(() => {
          progressState = {
            ...progressState,
            elapsed: formatRunningElapsed(now() - runStartedAt),
          };
          renderMessages({ scroll: false });
        }, 1000);
      }
    } else if (!value && running) {
      resolveIdle?.();
      resolveIdle = null;
    }
    if (!value) {
      progressState = { ...progressState, running: false };
      if (clearIntervalImpl && elapsedIntervalId !== null) {
        clearIntervalImpl(elapsedIntervalId);
      }
      elapsedIntervalId = null;
    }
    renderMessages({ scroll: value });
    running = value;
    if (value && pickerOpen) closePicker();
    conversationButton.disabled = value;
    stopDisabled = false;
    renderControls();
    if (historyOpen) renderHistory();
  };

  const clearComposerForSubmit = async (prompt) => {
    const shouldClearPrompt = shouldClearChatPrompt(prompt.uid, {
      scratchPrompt,
      protectedPromptUids,
    });
    if (!shouldClearPrompt) return { ok: true, composerCleared: false };
    const resetBlockUid = scratchPrompt ? rootBlockUid : prompt.uid;
    let composerCleared = false;
    try {
      composerCleared = await clearScratchPromptImpl(prompt);
    } catch (error) {
      try {
        await restorePromptImpl(prompt);
      } catch {
        // The original reset error is more useful than a secondary recovery
        // error. The composer remains visible for manual recovery.
      }
      return {
        ok: false,
        error: error.message || "The composer could not be cleared safely.",
      };
    }
    if (!composerCleared) {
      return {
        ok: false,
        error: "The composer changed before it could be sent. Review it and try again.",
      };
    }
    lastComposerBlockUid = resetBlockUid;
    resetPromptUids.add(resetBlockUid);
    let refocus = true;
    try {
      // Roam applies the outline reset asynchronously and its editor only
      // re-renders the placeholder while the block stays blurred. Wait for
      // the visible editor to show the reset before refocusing; focusing too
      // early resurrects the just-submitted text on the first message of a
      // New Chat.
      await settleComposerResetImpl();
      const settled = await settleComposerEditorAfterReset(prompt.text);
      if (settled.editorReady) {
        const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
        if (sidebarWindow?.["window-id"]) {
          await api.ui.setBlockFocusAndSelection({
            location: {
              "block-uid": resetBlockUid,
              "window-id": sidebarWindow["window-id"],
            },
          });
        }
      } else {
        // Never edit the native editor DOM directly: that can crash Roam.
        // Heal a late blur-commit that may have rewritten the placeholder,
        // and leave the stale editor alone; the next click re-syncs it.
        refocus = false;
        await healResetPromptPlaceholder(resetBlockUid);
      }
    } catch {
      // The outline has already reset successfully. A focus failure should
      // not turn a valid send into a failed one.
    }
    return { ok: true, composerCleared: true, refocus };
  };

  const composerEditorText = (element) =>
    typeof element?.textContent === "string" ? element.textContent : "";

  const composerEditorShowsSubmitted = (element, submittedText) => {
    const visible = composerEditorText(element).replace(/\u00A0/g, " ").trim();
    const submitted = String(submittedText || "").replace(/\u00A0/g, " ").trim();
    return Boolean(submitted) && visible.includes(submitted);
  };

  const settleComposerEditorAfterReset = async (submittedText) => {
    let editor = findComposerEditorImpl();
    if (!editor || !composerEditorShowsSubmitted(editor, submittedText)) {
      return { editorReady: true };
    }
    const deadline = now() + composerSettleTimeoutMs;
    while (now() < deadline) {
      await settleComposerResetImpl();
      editor = findComposerEditorImpl();
      if (!composerEditorShowsSubmitted(editor, submittedText)) {
        return { editorReady: true };
      }
    }
    return { editorReady: false };
  };

  const healResetPromptPlaceholder = async (blockUid) => {
    try {
      const pull = api.data?.async?.pull
        ? await api.data.async.pull("[:block/string]", [":block/uid", blockUid])
        : api.data?.pull?.("[:block/string]", [":block/uid", blockUid]);
      if (pull?.[":block/string"] !== CHAT_COMPOSER_PLACEHOLDER) {
        await api.data.block.update({
          block: { uid: blockUid, string: CHAT_COMPOSER_PLACEHOLDER },
        });
      }
    } catch {
      // The outline is already usable; healing is best-effort.
    }
  };

  const refocusClearedComposer = async (prompt) => {
    const blockUid = scratchPrompt ? rootBlockUid : prompt.uid;
    try {
      const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
      if (sidebarWindow?.["window-id"]) {
        await api.ui.setBlockFocusAndSelection({
          location: {
            "block-uid": blockUid,
            "window-id": sidebarWindow["window-id"],
          },
        });
      }
    } catch {
      // The outline is already empty. A focus failure should not turn a
      // valid send into a failed one.
    }
  };

  const restoreSubmittedPrompt = async (prompt) => {
    try {
      const restored = await restorePromptImpl(prompt);
      if (restored) {
        const focusUid = prompt.focusUid || prompt.uid;
        lastComposerBlockUid = focusUid;
        const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
        if (sidebarWindow?.["window-id"]) {
          await api.ui.setBlockFocusAndSelection({
            location: {
              "block-uid": focusUid,
              "window-id": sidebarWindow["window-id"],
            },
          });
        }
      }
      return { restored, restoreFailed: false };
    } catch {
      return { restored: false, restoreFailed: true };
    }
  };

  const steerActiveTurn = async (steerRunId) => {
    let prompt;
    try {
      await prepareComposerEditorForSubmit();
      prompt = await readPromptImpl({
        preferredBlockUid: lastComposerBlockUid,
      });
      lastComposerBlockUid = prompt.focusUid || prompt.uid;
    } catch (error) {
      setProgress(error.message || "Write a message in the chat composer.", "error");
      return null;
    }
    const cleared = await clearComposerForSubmit(prompt);
    if (!cleared.ok) {
      setProgress(cleared.error, "error");
      return null;
    }
    const bubble = {
      role: "user",
      text: prompt.text,
      outline: prompt.outline,
    };
    messages.push(bubble);
    renderMessages();
    if (cleared.composerCleared && cleared.refocus !== false) {
      await refocusClearedComposer(prompt);
    }
    setProgress("Adding to the current turn", "activity");
    try {
      await steerRequest(steerRunId, prompt.text);
      return null;
    } catch (error) {
      const bubbleIndex = messages.indexOf(bubble);
      if (bubbleIndex >= 0) {
        messages.splice(bubbleIndex, 1);
        renderMessages();
      }
      let restored = false;
      let restoreFailed = false;
      if (cleared.composerCleared) {
        ({ restored, restoreFailed } = await restoreSubmittedPrompt(prompt));
      }
      if (["NOT_PAIRED", "BRIDGE_UNREACHABLE"].includes(error.code)) {
        setProgress("", "");
        void refreshConnection();
        return null;
      }
      const draftIntact = !cleared.composerCleared || restored;
      if ([404, 409].includes(error.status) && draftIntact) {
        await idlePromise;
        if (!closed && !running) return send();
      }
      const failureText = error.message || "The turn could not be steered.";
      setProgress(
        restoreFailed
          ? `${failureText} The submitted outline could not be restored.`
          : restored
            ? `${failureText} · Draft restored.`
            : failureText,
        "error",
      );
      return null;
    }
  };

  const send = async () => {
    if (running) {
      if (runId && !steerPending) {
        steerPending = true;
        renderControls();
        try {
          return await steerActiveTurn(runId);
        } finally {
          steerPending = false;
          renderControls();
        }
      }
      return null;
    }
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
      await prepareComposerEditorForSubmit();
      prompt = await readPromptImpl({
        preferredBlockUid: lastComposerBlockUid,
      });
      lastComposerBlockUid = prompt.focusUid || prompt.uid;
    } catch (error) {
      setProgress(error.message || "Write a message in the chat composer.", "error");
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
    let graphGuidelines;
    try {
      graphGuidelines = await readGraphAgentGuidelines({ api });
    } catch {
      // Omit the injected value so the runtime can load guidelines through
      // the official MCP fallback instead of blocking the user's turn.
    }

    const cleared = await clearComposerForSubmit(prompt);
    if (!cleared.ok) {
      setProgress(cleared.error, "error");
      setRunning(false);
      return null;
    }
    const composerCleared = cleared.composerCleared;

    messages.push({
      role: "user",
      text: prompt.text,
      outline: prompt.outline,
    });
    renderMessages();
    if (composerCleared && cleared.refocus !== false) {
      await refocusClearedComposer(prompt);
    }
    runId = null;
    setProgress("Starting", "activity");

    try {
      const result = await requestChatImpl(prompt.text, {
        promptBlockUid: prompt.uid,
        graphGuidelines,
        threadId: state.activeThreadId,
        model: modelOverride,
        effort: effortOverride,
        serviceTier: speedOverride,
        accessMode: pickerAccess,
        enabledServers: enabledMcpServers,
        onStarted: ({ runId: startedRunId }) => {
          runId = startedRunId;
          renderControls();
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
        ({ restored, restoreFailed } = await restoreSubmittedPrompt(prompt));
      }
      if (["NOT_PAIRED", "BRIDGE_UNREACHABLE"].includes(error.code)) {
        setProgress("", "");
        void refreshConnection();
        return null;
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
      const failureText = [
        error.message || "Codex could not finish.",
        error.additionalDetails,
      ].filter(Boolean).join(" · ");
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
      void refreshConnection();
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
        rememberComposerFocus();
        void send();
      }
    }
  };

  const handleDocumentClick = (event) => {
    if (historyOpen && !header.contains?.(event.target)) closeHistory();
    const inPickerPortal = event.target?.closest?.(
      ".roam-codex-chat-picker-portal",
    );
    if (
      pickerOpen &&
      !controls.contains?.(event.target) &&
      !inPickerPortal
    ) closePicker();
  };

  const close = () => {
    if (closed) return closePromise || Promise.resolve();
    closed = true;
    connectionProbeVersion += 1;
    if (connectionRetryTimer !== null) {
      clearTimeoutImpl?.(connectionRetryTimer);
      connectionRetryTimer = null;
    }
    stopTranscriptResize();
    if (clearIntervalImpl && elapsedIntervalId !== null) {
      clearIntervalImpl(elapsedIntervalId);
    }
    elapsedIntervalId = null;
    doc.removeEventListener?.("keydown", handleSendShortcut, true);
    doc.removeEventListener?.("focusin", rememberComposerFocus, true);
    doc.removeEventListener?.("selectionchange", rememberComposerFocus, true);
    doc.removeEventListener?.("click", handleDocumentClick, true);
    doc.removeEventListener?.("visibilitychange", handleVisibilityChange);
    doc.defaultView?.removeEventListener?.("focus", handleWindowFocus);
    for (const timer of copyFeedbackTimers.values()) clearTimeoutImpl(timer);
    copyFeedbackTimers.clear();
    connectionRoot.unmount();
    transcriptRoot.unmount();
    historyRoot.unmount();
    controlsRoot.unmount();
    header.remove();
    panel.remove();
    controls.remove();
    closePromise = Promise.resolve(onClose({
      whenIdle: () => idlePromise,
      resetPromptUids,
    }));
    return closePromise;
  };

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
  doc.addEventListener?.("focusin", rememberComposerFocus, true);
  doc.addEventListener?.("selectionchange", rememberComposerFocus, true);
  doc.addEventListener?.("click", handleDocumentClick, true);
  doc.addEventListener?.("visibilitychange", handleVisibilityChange);
  doc.defaultView?.addEventListener?.("focus", handleWindowFocus);
  rememberComposerFocus();
  renderMessages();
  setProgress();
  renderConversationButton();
  setRunning(false);

  let catalogsLoading = false;
  const loadCatalogs = () => {
    if (closed || modelsReady || catalogsLoading) return;
    catalogsLoading = true;
    void requestModelsImpl()
      .then((availableModels) => {
        if (closed) return;
        models = Array.isArray(availableModels) ? availableModels : [];
        modelsReady = true;
        modelsError = "";
        initPicker();
        renderControls();
        setRunning(running);
      })
      .catch((error) => {
        if (closed) return;
        const connectionSetupFailure =
          ["NOT_PAIRED", "BRIDGE_UNREACHABLE"].includes(error.code) ||
          [401, 409].includes(error.status);
        if (!connectionSetupFailure) {
          modelsError = "Models unavailable";
          renderControls();
          setProgress(error.message, "error");
        }
        scheduleConnectionRetry();
      })
      .finally(() => {
        catalogsLoading = false;
      });

    void requestMcpServersImpl()
      .then((servers) => {
        if (closed) return;
        mcpServers = Array.isArray(servers) ? servers : [];
        renderControls();
      })
      .catch(() => {
        // Without a server list the picker simply omits the Tools row.
      });
  };

  const renderConnectionCard = ({ focusInput = false } = {}) => {
    if (closed) return;
    const visible = connection.state !== "connected";
    const reveal = visible && !connectionCardVisible;
    connectionCardVisible = visible;
    connectionRoot.render(window.React.createElement(ConnectionCard, {
      connection,
      note: connectionNote,
      pairingCodeRequired,
      focusInput,
      reveal,
      reduceMotion: Boolean(
        matchMediaImpl?.("(prefers-reduced-motion: reduce)")?.matches,
      ),
      actions: {
        pair: startPairing,
        login: startLogin,
        retry: refreshConnection,
      },
    }));
  };

  const scheduleConnectionRetry = () => {
    if (closed || !setTimeoutImpl) return;
    if (connectionRetryTimer !== null) clearTimeoutImpl?.(connectionRetryTimer);
    connectionRetryTimer = setTimeoutImpl(() => {
      connectionRetryTimer = null;
      void refreshConnection();
    }, CONNECTION_RETRY_MS);
  };

  const refreshConnection = async () => {
    if (closed) return;
    const probeVersion = ++connectionProbeVersion;
    let next;
    try {
      next = await probeConnectionImpl();
    } catch (error) {
      next = { state: "no-bridge", detail: error.message };
    }
    if (closed || probeVersion !== connectionProbeVersion) return;
    if (next.state === "connected") {
      try {
        const authState = await authRequest();
        if (closed || probeVersion !== connectionProbeVersion) return;
        if (authState.auth !== "authenticated") {
          next = { ...next, state: "signed-out" };
        }
      } catch (error) {
        if (closed || probeVersion !== connectionProbeVersion) return;
        next = error.status === 401
          ? { state: "unpaired", graph: next.graph }
          : { state: "no-bridge", graph: next.graph, detail: error.message };
      }
    }
    const reconnected = next.state === "connected" &&
      connection.state !== "connected" &&
      connection.state !== "checking";
    const stateChanged = next.state !== connection.state;
    if (stateChanged) connectionNote = "";
    connection = next;
    renderConnectionCard({ focusInput: stateChanged });
    renderMessages({ scroll: false });
    if (connection.state === "connected") {
      if (connectionRetryTimer !== null) {
        clearTimeoutImpl?.(connectionRetryTimer);
        connectionRetryTimer = null;
      }
      loadCatalogs();
      if (reconnected) void loadHistory({ reconcileActive: false });
    } else {
      scheduleConnectionRetry();
    }
  };

  const startPairing = async (code) => {
    try {
      await pairRequest(code === undefined ? {} : { code });
      pairingCodeRequired = false;
      connectionNote = "";
      await refreshConnection();
    } catch (error) {
      if (error.code === "CODE_REQUIRED") {
        pairingCodeRequired = true;
        connectionNote =
          "Run npx roam-codex-bridge code in a terminal, then enter the code here.";
        renderConnectionCard({ focusInput: true });
        return;
      }
      connectionNote = error.code === "BRIDGE_UNREACHABLE"
        ? ""
        : error.message || "Pairing failed.";
      if (error.code === "BRIDGE_UNREACHABLE") {
        void refreshConnection();
        return;
      }
      renderConnectionCard({ focusInput: pairingCodeRequired });
    }
  };

  const startLogin = async () => {
    try {
      const login = await loginRequest();
      connectionNote =
        "Finish signing in from the browser tab that just opened; " +
        "this panel reconnects by itself.";
      renderConnectionCard();
      openUrlImpl?.(login.authUrl);
    } catch (error) {
      connectionNote = error.code === "BRIDGE_UNREACHABLE"
        ? ""
        : error.message || "Sign-in could not start.";
      if (error.code === "BRIDGE_UNREACHABLE") {
        void refreshConnection();
        return;
      }
      renderConnectionCard();
    }
  };

  loadCatalogs();
  void refreshConnection();

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
      lastComposerBlockUid = rootBlockUid;
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
  waitOptions,
  resolvePromptBlock = resolveChatPromptBlock,
  openPromptBlock = openPromptBlockInSidebar,
  createPanel = createChatPanel,
  removeScratchPrompt = removeScratchPromptBlock,
  removeResetPrompts = removeResetChatPromptBlocks,
  readOutlineUids = readPromptOutlineUids,
} = {}) {
  const prompt = await resolvePromptBlock({ api });
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
    placeChatHeader(controller, { doc, host });
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
    placeChatHeader(controller, { doc, host });

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
  graph = currentGraphName(),
  bridgeUrl = currentBridgeUrl(),
  code = null,
} = {}) {
  const body = { graph };
  if (code !== null && code !== undefined) {
    const pairingCode = String(code).trim();
    if (!pairingCode || pairingCode.length > 64 || /[\u0000-\u001f]/.test(pairingCode)) {
      throw new Error("Enter the one-time pairing code from the bridge.");
    }
    body.code = pairingCode;
  }
  const response = await bridgeFetch(fetchImpl, `${bridgeUrl}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  let result = {};
  try {
    result = await response.json();
  } catch {
    // A useful status error is emitted below.
  }

  if (response.ok && result.codeRequired === true) {
    const error = new Error(
      "This computer asks for a pairing code instead of a dialog.",
    );
    error.code = "CODE_REQUIRED";
    throw error;
  }
  if (!response.ok || typeof result.token !== "string") {
    throw new Error(
      result.error || `Bridge pairing returned HTTP ${response.status}.`,
    );
  }
  if (result.graph !== graph) {
    throw new Error(`The bridge paired to graph "${result.graph}" instead.`);
  }

  storage.setItem(tokenKey(graph), result.token);
  notify("Local bridge paired on this device.", "success");
  return result;
}

function configuredDefaultAccess(value) {
  return CHAT_ACCESS_MODES.has(value) ? value : "auto";
}

function configuredDefaultModel(value) {
  const model = typeof value === "string" ? singleLine(value) : "";
  return model && model.length <= 100 ? model : null;
}

export function configureExtension({ api, settings }) {
  const graph = activeGraphName(api);
  let bridgeUrl = DEFAULT_BRIDGE_URL;
  const savedBridgeUrl = settings?.get?.(BRIDGE_URL_SETTING);
  if (savedBridgeUrl) {
    try {
      bridgeUrl = normalizeBridgeUrl(savedBridgeUrl);
    } catch (error) {
      notify(`${error.message} Using ${DEFAULT_BRIDGE_URL}.`, "warning");
    }
  }
  EXTENSION_CONFIG = {
    graph,
    bridgeUrl,
    defaultAccess: configuredDefaultAccess(
      settings?.get?.(DEFAULT_ACCESS_SETTING),
    ),
    defaultModel: configuredDefaultModel(
      settings?.get?.(DEFAULT_MODEL_SETTING),
    ),
  };
}

export function installSettingsPanel(extensionAPI) {
  const settings = extensionAPI.settings;
  const writable = settings.canSet !== false;
  const readOnlyNote = writable
    ? ""
    : " This graph's extension settings can only be changed by an admin.";
  return settings.panel.create({
    tabTitle: "Roam Codex",
    settings: [
      {
        id: BRIDGE_URL_SETTING,
        name: "Local bridge URL",
        description:
          "Loopback endpoint including its port. Only 127.0.0.1 is allowed." +
          readOnlyNote,
        action: {
          type: "input",
          placeholder: DEFAULT_BRIDGE_URL,
          onChange: (event) => {
            if (!writable) return;
            try {
              EXTENSION_CONFIG.bridgeUrl = normalizeBridgeUrl(event.target.value);
              event.target.setCustomValidity?.("");
            } catch (error) {
              event.target.setCustomValidity?.(error.message);
            }
          },
        },
      },
      {
        id: DEFAULT_ACCESS_SETTING,
        name: "Default graph access",
        description:
          "Seeds new conversations; existing conversations keep their access." +
          readOnlyNote,
        action: {
          type: "select",
          items: ["auto", "read-only", "manual"],
          onChange: (value) => {
            if (writable) EXTENSION_CONFIG.defaultAccess = configuredDefaultAccess(value);
          },
        },
      },
      {
        id: DEFAULT_MODEL_SETTING,
        name: "Default Codex model",
        description:
          "Optional model ID for new conversations. Unavailable models fall " +
          "back to the bridge default." + readOnlyNote,
        action: {
          type: "input",
          placeholder: "Server default",
          onChange: (event) => {
            if (writable) {
              EXTENSION_CONFIG.defaultModel = configuredDefaultModel(
                event.target.value,
              );
            }
          },
        },
      },
    ],
  });
}

export default {
  onload: ({ extensionAPI }) => {
    EXTENSION_SETTINGS = extensionAPI.settings;
    configureExtension({ api: getRoamApi(), settings: EXTENSION_SETTINGS });
    void installSettingsPanel(extensionAPI).catch((error) => {
      notify(`Codex settings could not load: ${error.message}`, "warning");
    });
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

  },
  onunload: () => {
    EXTENSION_SETTINGS = null;
    EXTENSION_CONFIG = {
      graph: null,
      bridgeUrl: DEFAULT_BRIDGE_URL,
      defaultAccess: "auto",
      defaultModel: null,
    };
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
