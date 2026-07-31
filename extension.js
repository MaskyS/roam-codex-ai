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

export const RUNNING_BLOCK_TEXT = "[[Codex/running]]";

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
  { onProgress = () => {}, onStarted = () => {} } = {},
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

    for (const label of [
      "Codex: Work on this block",
      "Codex: Probe selected block",
    ]) {
      extensionAPI.ui.slashCommand.addCommand({
        label,
        callback: workFromSlashCommand,
      });
    }

    for (const label of [
      "Codex: Work on focused block",
      "Codex: Probe focused block",
    ]) {
      extensionAPI.ui.commandPalette.addCommand({
        label,
        callback: workFromCommandPalette,
      });
    }

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
  onunload: () => stopAllRunningPresentations(),
};
