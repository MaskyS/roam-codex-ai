// src/react-globals.js
var host = typeof window !== "undefined" ? window : globalThis;
var React = host.React;
var ReactDOM = host.ReactDOM;
function assertReactAvailable() {
  if (!React?.createElement || !ReactDOM?.render) {
    throw new Error("Roam's bundled React is unavailable.");
  }
}

// src/chat-panel-store.js
function createChatPanelStore({
  storage = window.localStorage,
  api = getRoamApi(),
  rootBlockUid,
  requestChatImpl = requestPanelChat,
  requestModelsImpl = requestPanelModels,
  requestMessagesImpl = requestPanelMessages,
  requestHistoryImpl = requestPanelThreadSummaries,
  requestThreadNameImpl = requestPanelThreadName,
  requestGraphIndexImpl = () => readGraphThreadIndex({ api }),
  ensureGraphThreadImpl,
  updateGraphActivityImpl = (record, timestamp) => updateGraphThreadActivity(record, timestamp, { api }),
  copyTextImpl = copyRoamText,
  readPromptImpl,
  clearScratchPromptImpl,
  restorePromptImpl,
  cancelRequest = requestRunCancellation,
  protectedPromptUids = null,
  scratchPrompt = false,
  now = Date.now,
  onClose = () => {
  }
} = {}) {
  if (!validBlockUid(rootBlockUid)) {
    throw new Error("The Codex chat panel requires a Roam block.");
  }
  const readPrompt = readPromptImpl || (() => readFocusedPromptBlock(rootBlockUid, { api }));
  const clearScratchPrompt = clearScratchPromptImpl || ((prompt) => clearScratchPromptBlock(prompt, {
    api,
    protectedPromptUids,
    rootBlockUid,
    scratchPrompt
  }));
  const restorePrompt = restorePromptImpl || ((prompt) => restoreClearedChatPromptBlock(prompt, {
    api,
    rootBlockUid,
    scratchPrompt
  }));
  const ensureGraphThread = ensureGraphThreadImpl || ((input) => ensureGraphThreadRecord({ ...input, api, storage }));
  let state = readChatState({ storage });
  let messages = [];
  let models = [];
  let modelsReady = false;
  let modelsError = "";
  let runId = null;
  let running = false;
  let runStartedAt = 0;
  let closed = false;
  let idlePromise = Promise.resolve();
  let resolveIdle = null;
  let closePromise = null;
  const resetPromptUids = /* @__PURE__ */ new Set();
  const threadSummaries = /* @__PURE__ */ new Map();
  const graphThreadRecords = /* @__PURE__ */ new Map();
  const threadIndexPromises = /* @__PURE__ */ new Map();
  const mirroredThreadNames = /* @__PURE__ */ new Set();
  let historyOpen = false;
  let historyLoadVersion = 0;
  let selectionLoadVersion = 0;
  let historyError = "";
  let progressTextValue = "";
  let progressKind = "";
  let modelChanged = !state.activeThreadId && Boolean(
    state.newConversationPreferences.model
  );
  let effortChanged = !state.activeThreadId && Boolean(
    state.newConversationPreferences.effort
  );
  let speedChanged = !state.activeThreadId && Boolean(
    state.newConversationPreferences.speed
  );
  let pickerModel = "";
  let pickerEffort = "";
  let pickerSpeed = "";
  let pickerOpen = false;
  let pickerLevel = null;
  let stopRequested = false;
  let modelsRequested = false;
  let initialLoadStarted = false;
  const clampTranscriptHeight = (value) => Math.min(
    CHAT_TRANSCRIPT_MAX_HEIGHT,
    Math.max(CHAT_TRANSCRIPT_MIN_HEIGHT, Math.round(value))
  );
  const readStoredTranscriptHeight = () => {
    let value;
    try {
      value = Number.parseInt(storage.getItem(CHAT_TRANSCRIPT_HEIGHT_KEY), 10);
    } catch {
      return null;
    }
    return Number.isFinite(value) ? clampTranscriptHeight(value) : null;
  };
  let transcriptHeight = readStoredTranscriptHeight() ?? CHAT_TRANSCRIPT_MAX_HEIGHT;
  const listeners = /* @__PURE__ */ new Set();
  let version = 0;
  let snapshot = null;
  const emit = () => {
    version += 1;
    snapshot = null;
    for (const listener of [...listeners]) listener();
  };
  const persist = () => writeChatState(state, { storage });
  const currentRecord = () => state.activeThreadId ? state.conversations[state.activeThreadId] : null;
  const currentPreferences = () => currentRecord() || state.newConversationPreferences;
  const sendShortcutIsMac = /Mac|iP(?:hone|ad|od)/i.test(
    globalThis.navigator?.platform || globalThis.navigator?.userAgent || ""
  );
  const setProgress = (text = "", kind = "") => {
    progressTextValue = singleLine(text);
    progressKind = kind;
    emit();
  };
  const savePreferences = () => {
    const model = pickerModel || null;
    const effort = pickerEffort || null;
    const speed = pickerSpeed || null;
    const record = currentRecord();
    if (record) {
      record.model = model;
      record.effort = effort;
      record.speed = speed;
      record.updatedAt = now();
    } else {
      state.newConversationPreferences = { model, effort, speed };
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
      threadPageUid: previous?.threadPageUid || null,
      threadPageTitle: previous?.threadPageTitle || null,
      originInstallationId: previous?.originInstallationId || null,
      lastSeenUpdatedAt: completed ? Math.max(previous?.lastSeenUpdatedAt || 0, timestamp) : previous?.lastSeenUpdatedAt || 0,
      availability: "available",
      pendingGraphIndex: previous?.pendingGraphIndex || false
    };
    state.activeThreadId = threadId;
    state.newConversationPreferences = { model: null, effort: null, speed: null };
    persist();
    emit();
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
        graphRecord.createdAt || 0
      ),
      model: previous.model || null,
      effort: previous.effort || null,
      speed: previous.speed || null,
      threadPageUid: graphRecord.threadPageUid,
      threadPageTitle: graphRecord.threadPageTitle,
      originInstallationId: graphRecord.originInstallationId || null,
      lastSeenUpdatedAt: previous.lastSeenUpdatedAt || 0,
      availability: previous.availability === "available" ? "available" : "pending",
      pendingGraphIndex: false
    };
    state.conversations[graphRecord.threadId] = record;
    graphThreadRecords.set(graphRecord.threadId, graphRecord);
    return record;
  };
  const mirrorThreadName = async (graphRecord) => {
    const name = threadPageLabel(graphRecord?.threadPageTitle);
    if (!name || mirroredThreadNames.has(`${graphRecord.threadId}
${name}`)) {
      return;
    }
    await requestThreadNameImpl(graphRecord.threadId, name);
    mirroredThreadNames.add(`${graphRecord.threadId}
${name}`);
    const summary = threadSummaries.get(graphRecord.threadId);
    if (summary) threadSummaries.set(graphRecord.threadId, { ...summary, name });
  };
  const ensureThreadIndexed = async (threadId, title, { completedAt = null } = {}) => {
    if (!validThreadId(threadId) || !api.data?.page?.create) return null;
    let pending = threadIndexPromises.get(threadId);
    if (!pending) {
      pending = (async () => {
        try {
          let graphRecord2 = graphThreadRecords.get(threadId);
          if (!graphRecord2 || !graphRecord2.metadataUids?.origin || !graphRecord2.metadataUids?.createdAt || !graphRecord2.metadataUids?.lastActiveAt) {
            graphRecord2 = await ensureGraphThread({
              threadId,
              title,
              timestamp: now()
            });
          }
          applyGraphRecord(graphRecord2);
          if (completedAt) {
            graphRecord2 = await updateGraphActivityImpl(
              graphRecord2,
              completedAt
            );
            graphThreadRecords.set(threadId, graphRecord2);
            applyGraphRecord(graphRecord2);
          }
          persist();
          try {
            await mirrorThreadName(graphRecord2);
          } catch {
          }
          return graphRecord2;
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
  const currentModelEntry = () => models.find((model) => model.id === pickerModel) || models.find((model) => model.isDefault) || models[0] || null;
  const defaultTierIdFor = (model) => {
    const tiers = modelTierChoices(model);
    return tiers.some((tier) => tier.id === model?.defaultServiceTier) ? model.defaultServiceTier : "";
  };
  const initPicker = () => {
    const preferred = currentPreferences();
    const defaultModel = models.find((model) => model.isDefault) || models[0];
    pickerModel = models.some((model) => model.id === preferred.model) ? preferred.model : defaultModel?.id || "";
    const selected = currentModelEntry();
    const efforts = modelEfforts(selected);
    const defaultEffort = efforts.includes(selected?.defaultReasoningEffort) ? selected.defaultReasoningEffort : null;
    pickerEffort = efforts.includes(preferred.effort) ? preferred.effort : defaultEffort || efforts[0] || "";
    const tiers = modelTierChoices(selected);
    pickerSpeed = tiers.some((tier) => tier.id === preferred.speed) ? preferred.speed : defaultTierIdFor(selected);
  };
  const pickerLabel = () => {
    if (!modelsReady) return modelsError ? "Models unavailable" : "Loading models\u2026";
    if (!models.length) return "No models available";
    const selected = currentModelEntry();
    const parts = [selected?.displayName || selected?.id || "Model"];
    if (pickerEffort) parts.push(effortLabel(pickerEffort));
    return parts.join(" \xB7 ");
  };
  const historyItems = () => buildConversationHistory(
    state,
    [...threadSummaries.values()]
  );
  const conversationLabel = () => {
    const active = historyItems().find((item) => item.active);
    return state.activeThreadId && active ? active.title : "New chat";
  };
  const closePicker = () => {
    if (!pickerOpen && pickerLevel === null) return;
    pickerOpen = false;
    pickerLevel = null;
    emit();
  };
  const closeHistory = () => {
    if (!historyOpen) return;
    historyOpen = false;
    emit();
  };
  const beginNewConversation = () => {
    if (running) return;
    const preferences = currentPreferences();
    const model = pickerModel || preferences.model || null;
    const effort = pickerEffort || preferences.effort || null;
    const speed = pickerSpeed || preferences.speed || null;
    selectionLoadVersion += 1;
    state.activeThreadId = null;
    state.newConversationPreferences = { model, effort, speed };
    messages = [];
    modelChanged = Boolean(model);
    effortChanged = Boolean(effort);
    speedChanged = Boolean(speed);
    persist();
    if (modelsReady) initPicker();
    historyOpen = false;
    progressTextValue = "";
    progressKind = "";
    emit();
  };
  const markMissingConversation = (threadId) => {
    const missingRecord = state.conversations[threadId];
    if (!missingRecord) return;
    missingRecord.availability = "missing";
    threadSummaries.delete(threadId);
    if (state.activeThreadId === threadId) {
      messages = [];
      progressTextValue = "Unavailable on this device. The graph thread record was kept.";
      progressKind = "error";
    }
    persist();
    emit();
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
    if (modelsReady) initPicker();
    historyOpen = false;
    progressTextValue = "Loading conversation";
    progressKind = "activity";
    emit();
    try {
      const loadedMessages = await requestMessagesImpl(threadId);
      if (closed || loadVersion !== selectionLoadVersion || state.activeThreadId !== threadId) {
        return;
      }
      messages = loadedMessages.filter(
        (message) => ["user", "assistant"].includes(message?.role) && typeof message.text === "string"
      );
      const record = state.conversations[threadId];
      const summary = threadSummaries.get(threadId);
      if (record) {
        record.availability = "available";
        record.lastSeenUpdatedAt = Math.max(
          record.lastSeenUpdatedAt || 0,
          serverTimestampMs(summary?.updatedAt)
        );
        persist();
      }
      progressTextValue = "";
      progressKind = "";
      emit();
    } catch (error) {
      if (closed || loadVersion !== selectionLoadVersion || state.activeThreadId !== threadId) {
        return;
      }
      if (error.status === 404) {
        markMissingConversation(threadId);
        return;
      }
      setProgress(error.message || "Could not load that conversation.", "error");
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
        historyError = `${graphIndex.errors.length} thread page${graphIndex.errors.length === 1 ? " has" : "s have"} invalid or duplicate metadata.`;
      }
      persist();
    } catch (error) {
      historyError = error.message || "The graph thread index is unavailable.";
    }
    const threadIds = historyItems().map((item) => item.threadId);
    if (!threadIds.length) {
      emit();
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
          if (validThreadId(summary?.id) && state.conversations[summary.id]) {
            threadSummaries.set(summary.id, summary);
            const record = state.conversations[summary.id];
            const serverUpdatedAt = serverTimestampMs(summary.updatedAt);
            reloadActive ||= Boolean(
              reconcileActive && summary.id === state.activeThreadId && !running && serverUpdatedAt > (record.lastSeenUpdatedAt || 0)
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
              summary?.name || summary?.preview || ""
            ).catch(() => null)
          );
        } else if (record?.threadPageUid) {
          const graphRecord = graphThreadRecords.get(threadId);
          if (graphRecord && (!graphRecord.metadataUids?.origin || !graphRecord.metadataUids?.createdAt || !graphRecord.metadataUids?.lastActiveAt)) {
            backfills.push(
              ensureThreadIndexed(threadId, record.threadPageTitle || "").catch(() => null)
            );
          } else if (graphRecord) {
            void mirrorThreadName(graphRecord).catch(() => {
            });
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
    emit();
  };
  const setRunning = (value) => {
    if (value && !running) {
      idlePromise = new Promise((resolve) => {
        resolveIdle = resolve;
      });
      runStartedAt = now();
    } else if (!value && running) {
      resolveIdle?.();
      resolveIdle = null;
    }
    running = value;
    stopRequested = false;
    if (value && pickerOpen) {
      pickerOpen = false;
      pickerLevel = null;
    }
    emit();
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
          "error"
        );
        setRunning(false);
        return null;
      }
    }
    let prompt;
    try {
      prompt = await readPrompt();
    } catch (error) {
      setProgress(error.message || "Focus a Roam block before sending.", "error");
      setRunning(false);
      return null;
    }
    const startingNewConversation = !state.activeThreadId;
    const catalogDefaultModel = models.find((model) => model.isDefault) || models[0];
    const modelOverride = modelChanged ? pickerModel || catalogDefaultModel?.id || null : null;
    const effortOverride = effortChanged ? pickerEffort || null : null;
    const speedOverride = speedChanged ? pickerSpeed || null : void 0;
    const shouldClearPrompt = shouldClearChatPrompt(prompt.uid, {
      scratchPrompt,
      protectedPromptUids
    });
    const resetBlockUid = scratchPrompt ? rootBlockUid : prompt.uid;
    let composerCleared = false;
    if (shouldClearPrompt) {
      try {
        composerCleared = await clearScratchPrompt(prompt);
      } catch (error) {
        try {
          await restorePrompt(prompt);
        } catch {
        }
        setProgress(
          error.message || "The composer could not be cleared safely.",
          "error"
        );
        setRunning(false);
        return null;
      }
      if (!composerCleared) {
        setProgress(
          "The composer changed before it could be sent. Review it and try again.",
          "error"
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
              "window-id": sidebarWindow["window-id"]
            }
          });
        }
      } catch {
      }
    }
    messages = [...messages, { role: "user", text: prompt.text }];
    runId = null;
    setProgress("Starting", "activity");
    try {
      const result = await requestChatImpl(prompt.text, {
        promptBlockUid: prompt.uid,
        threadId: state.activeThreadId,
        model: modelOverride,
        effort: effortOverride,
        serviceTier: speedOverride,
        onStarted: ({ runId: startedRunId }) => {
          runId = startedRunId;
        },
        onThread: ({ threadId }) => {
          rememberThread(threadId);
          void ensureThreadIndexed(threadId, prompt.text).catch(() => {
          });
          modelChanged = false;
          effortChanged = false;
          speedChanged = false;
        },
        onProgress: ({ kind, text }) => {
          setProgress(text, kind);
        }
      });
      const completedAt = now();
      rememberThread(result.threadId, { completed: true });
      await ensureThreadIndexed(result.threadId, prompt.text, {
        completedAt
      }).catch(() => null);
      if (typeof result.reply !== "string" || !result.reply.trim()) {
        throw new Error("Codex completed without a reply.");
      }
      messages = [...messages, { role: "assistant", text: result.reply.trim() }];
      const existingSummary = threadSummaries.get(result.threadId) || {};
      threadSummaries.set(result.threadId, {
        ...existingSummary,
        id: result.threadId,
        name: existingSummary.name || null,
        preview: startingNewConversation ? prompt.text : existingSummary.preview || "",
        createdAt: existingSummary.createdAt || completedAt,
        updatedAt: completedAt,
        status: "idle"
      });
      void loadHistory({ reconcileActive: false });
      setProgress("", "");
      return result;
    } catch (error) {
      let restored = false;
      let restoreFailed = false;
      if (composerCleared) {
        try {
          restored = await restorePrompt(prompt);
          if (restored) {
            const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
            if (sidebarWindow?.["window-id"]) {
              await api.ui.setBlockFocusAndSelection({
                location: {
                  "block-uid": prompt.uid,
                  "window-id": sidebarWindow["window-id"]
                }
              });
            }
          }
        } catch {
          restoreFailed = true;
        }
      }
      if (error.code === "TURN_INTERRUPTED") {
        setProgress(
          restoreFailed ? "Stopped \xB7 submitted outline could not be restored" : restored ? "Stopped \xB7 draft restored" : composerCleared ? "Stopped \xB7 current draft preserved" : "Stopped",
          restoreFailed ? "error" : "stopped"
        );
        return null;
      }
      const failureText = error.message || "Codex could not finish.";
      setProgress(
        restoreFailed ? `${failureText} The submitted outline could not be restored.` : restored ? `${failureText} \xB7 Draft restored.` : composerCleared ? `${failureText} \xB7 The current draft was preserved.` : failureText,
        "error"
      );
      return null;
    } finally {
      runId = null;
      setRunning(false);
    }
  };
  const stop = () => {
    if (!runId) return Promise.resolve();
    stopRequested = true;
    setProgress("Stopping", "activity");
    return cancelRequest(runId).catch((error) => {
      stopRequested = false;
      setProgress(error.message || "Could not stop the turn.", "error");
      throw error;
    });
  };
  const close = () => {
    if (closed) return closePromise || Promise.resolve();
    closed = true;
    emit();
    closePromise = Promise.resolve(onClose({
      whenIdle: () => idlePromise,
      resetPromptUids
    }));
    return closePromise;
  };
  const maybeSendFromShortcut = () => {
    const focused = api.ui?.getFocusedBlock?.();
    const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
    if (!focused?.["window-id"] || focused["window-id"] !== sidebarWindow?.["window-id"]) {
      return false;
    }
    void send();
    return true;
  };
  const focusRoot = () => {
    const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
    if (!sidebarWindow?.["window-id"]) return Promise.resolve();
    return api.ui.setBlockFocusAndSelection({
      location: {
        "block-uid": rootBlockUid,
        "window-id": sidebarWindow["window-id"]
      }
    });
  };
  const getSnapshot = () => {
    if (snapshot) return snapshot;
    snapshot = {
      version,
      closed,
      messages,
      running,
      runStartedAt,
      modelsReady,
      models,
      progress: { text: progressTextValue, kind: progressKind },
      stopping: stopRequested,
      pickerOpen,
      pickerLevel,
      pickerModel,
      pickerEffort,
      pickerSpeed,
      pickerLabel: pickerLabel(),
      history: {
        open: historyOpen,
        error: historyError,
        items: historyItems(),
        activeThreadId: state.activeThreadId
      },
      conversationLabel: conversationLabel(),
      transcriptHeight,
      sendShortcutIsMac
    };
    return snapshot;
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot,
    now,
    copyText: (text) => copyTextImpl(text),
    // Actions
    send,
    stop,
    close,
    focusRoot,
    maybeSendFromShortcut,
    beginNewConversation,
    selectConversation: (threadId) => void selectConversation(threadId),
    loadHistory,
    openHistory() {
      if (running || historyOpen) return;
      historyOpen = true;
      emit();
      void loadHistory({ reconcileActive: true });
    },
    closeHistory,
    togglePicker() {
      if (running || !modelsReady) return;
      if (pickerOpen) {
        closePicker();
        return;
      }
      pickerOpen = true;
      pickerLevel = null;
      emit();
    },
    closePicker,
    openPickerLevel(level) {
      if (!pickerOpen) return;
      pickerLevel = level;
      emit();
    },
    pick(level, id) {
      if (level === "model" && id !== pickerModel) {
        pickerModel = id;
        modelChanged = true;
        effortChanged = true;
        speedChanged = true;
        const next = currentModelEntry();
        const efforts = modelEfforts(next);
        if (!efforts.includes(pickerEffort)) {
          const defaultEffort = efforts.includes(next?.defaultReasoningEffort) ? next.defaultReasoningEffort : null;
          pickerEffort = defaultEffort || efforts[0] || "";
        }
        if (!modelTierChoices(next).some((tier) => tier.id === pickerSpeed)) {
          pickerSpeed = defaultTierIdFor(next);
        }
        savePreferences();
      } else if (level === "effort" && id !== pickerEffort) {
        pickerEffort = id;
        effortChanged = true;
        savePreferences();
      } else if (level === "speed" && id !== pickerSpeed) {
        pickerSpeed = id;
        speedChanged = true;
        savePreferences();
      }
      closePicker();
    },
    clampTranscriptHeight,
    setTranscriptHeight(height) {
      transcriptHeight = clampTranscriptHeight(height);
      emit();
    },
    persistTranscriptHeight() {
      try {
        storage.setItem(CHAT_TRANSCRIPT_HEIGHT_KEY, String(transcriptHeight));
      } catch {
      }
    },
    loadModels() {
      if (modelsRequested) return Promise.resolve();
      modelsRequested = true;
      return requestModelsImpl().then((availableModels) => {
        if (closed) return;
        models = Array.isArray(availableModels) ? availableModels : [];
        modelsReady = true;
        initPicker();
        emit();
      }).catch((error) => {
        if (closed) return;
        modelsError = error.message || "Could not load Codex models.";
        setProgress(error.message, "error");
      });
    },
    loadInitialConversation() {
      if (initialLoadStarted) return Promise.resolve();
      initialLoadStarted = true;
      const initialThreadId = state.activeThreadId;
      return loadHistory().then(() => {
        if (!closed && initialThreadId && state.activeThreadId === initialThreadId && !["missing", "unavailable"].includes(
          state.conversations[initialThreadId]?.availability
        )) {
          return selectConversation(initialThreadId, { reload: true });
        }
      });
    }
  };
}

// src/chat-panel.jsx
var useState = (...args) => React.useState(...args);
var useEffect = (...args) => React.useEffect(...args);
var useRef = (...args) => React.useRef(...args);
var useContext = (...args) => React.useContext(...args);
var PanelContext = React ? React.createContext(null) : null;
var usePanel = () => useContext(PanelContext);
function RoamString({ text, className }) {
  const { api } = usePanel();
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return void 0;
    let cancelled = false;
    let mounted = false;
    void renderRoamMarkdown(el, text, { api }).then((rendered) => {
      mounted = rendered;
      if (cancelled && rendered) void unmountRoamMarkdown(el, { api });
    });
    return () => {
      cancelled = true;
      if (mounted) void unmountRoamMarkdown(el, { api });
    };
  }, [api, text]);
  return /* @__PURE__ */ React.createElement("div", { className, ref });
}
function CopyButton({ roleLabel, text }) {
  const { store } = usePanel();
  const [copyState, setCopyState] = useState("idle");
  const timerRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);
  const title = copyState === "copied" ? "Copied" : copyState === "error" ? "Could not copy Roam text" : "Copy Roam text";
  const ariaLabel = copyState === "copied" ? "Copied Roam text" : copyState === "error" ? "Could not copy Roam text" : `Copy ${roleLabel} message as Roam text`;
  const onClick = async (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setCopyState("copying");
    let next;
    try {
      await store.copyText(text);
      next = "copied";
    } catch {
      next = "error";
    }
    if (!mountedRef.current) return;
    setCopyState(next);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (mountedRef.current) setCopyState("idle");
    }, 1400);
  };
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "roam-codex-chat-copy",
      "data-state": copyState,
      title,
      "aria-label": ariaLabel,
      onClick
    }
  );
}
function ProgressRow() {
  const { store, snapshot } = usePanel();
  const { running, runStartedAt, progress } = snapshot;
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!running) return void 0;
    setElapsedMs(0);
    const intervalId = setInterval(() => {
      setElapsedMs(store.now() - runStartedAt);
    }, 1e3);
    return () => clearInterval(intervalId);
  }, [running, runStartedAt, store]);
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "roam-codex-chat-progress",
      "aria-live": "polite",
      "data-kind": progress.kind,
      hidden: !progress.text && !running
    },
    /* @__PURE__ */ React.createElement("span", { className: "roam-codex-chat-progress-meta", hidden: !running }, /* @__PURE__ */ React.createElement("span", { className: "roam-codex-chat-progress-timer" }, formatRunningElapsed(running ? elapsedMs : 0))),
    /* @__PURE__ */ React.createElement("span", { className: "roam-codex-chat-progress-text" }, progress.text)
  );
}
function Transcript({ transcriptRef }) {
  const { store, snapshot } = usePanel();
  const { messages, transcriptHeight, running, progress } = snapshot;
  const [showLatest, setShowLatest] = useState(false);
  const progressVisible = Boolean(progress.text) || running;
  const measureLatest = () => {
    const el = transcriptRef.current;
    if (!el) return;
    const scrollHeight = Number(el.scrollHeight) || 0;
    const clientHeight = Number(el.clientHeight) || 0;
    const scrollTop = Number(el.scrollTop) || 0;
    const overflowing = clientHeight > 0 && scrollHeight > clientHeight + 1;
    const fromBottom = Math.max(0, scrollHeight - clientHeight - scrollTop);
    setShowLatest(
      messages.length > 0 && overflowing && fromBottom > CHAT_SCROLL_BOTTOM_THRESHOLD
    );
  };
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    measureLatest();
  }, [messages.length, progressVisible]);
  const scrollToLatest = () => {
    const el = transcriptRef.current;
    if (!el) return;
    const reduceMotion = Boolean(
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    );
    const top = Number(el.scrollHeight) || 0;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
    } else {
      el.scrollTop = top;
    }
    setShowLatest(false);
  };
  const heightStyle = {
    height: `${transcriptHeight}px`,
    maxHeight: `${transcriptHeight}px`
  };
  return /* @__PURE__ */ React.createElement("div", { className: "roam-codex-chat-transcript-wrap", style: heightStyle }, /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "roam-codex-chat-transcript",
      role: "log",
      "aria-live": "polite",
      ref: transcriptRef,
      hidden: !messages.length && !progressVisible,
      style: heightStyle,
      onScroll: measureLatest
    },
    messages.map((message, index) => {
      if (!message || !["user", "assistant"].includes(message.role)) {
        return null;
      }
      const roleLabel = message.role === "user" ? "You" : "Codex";
      return /* @__PURE__ */ React.createElement(
        "article",
        {
          key: `${index}-${message.role}`,
          className: `roam-codex-chat-message roam-codex-chat-message-${message.role}`
        },
        /* @__PURE__ */ React.createElement(CopyButton, { roleLabel, text: message.text }),
        /* @__PURE__ */ React.createElement(
          RoamString,
          {
            text: message.text,
            className: "roam-codex-chat-message-text"
          }
        )
      );
    }),
    /* @__PURE__ */ React.createElement(ProgressRow, null)
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "roam-codex-chat-scroll-latest",
      title: "Scroll to latest message",
      "aria-label": "Scroll to latest message",
      hidden: !showLatest,
      onClick: scrollToLatest
    },
    /* @__PURE__ */ React.createElement("span", { className: "roam-codex-chat-scroll-latest-icon", "aria-hidden": "true" }, "\u2193")
  ));
}
function ResizeHandle({ transcriptRef }) {
  const { store, snapshot, doc } = usePanel();
  const dragRef = useRef(null);
  useEffect(() => () => dragRef.current?.stop(), []);
  const onPointerDown = (event) => {
    if (!Number.isFinite(event?.clientY)) return;
    const transcript = transcriptRef.current;
    const measured = transcript?.getBoundingClientRect?.()?.height;
    const startHeight = Number.isFinite(measured) && measured > 0 ? measured : snapshot.transcriptHeight;
    const startY = event.clientY;
    let height = startHeight;
    const onMove = (moveEvent) => {
      if (!Number.isFinite(moveEvent?.clientY)) return;
      height = store.clampTranscriptHeight(
        startHeight + (moveEvent.clientY - startY)
      );
      for (const el of [transcript, transcript?.parentElement]) {
        if (el?.style) {
          el.style.height = `${height}px`;
          el.style.maxHeight = `${height}px`;
        }
      }
      moveEvent.preventDefault?.();
    };
    const stop = () => {
      dragRef.current = null;
      doc.removeEventListener?.("pointermove", onMove, true);
      doc.removeEventListener?.("pointerup", stop, true);
      store.setTranscriptHeight(height);
      store.persistTranscriptHeight();
    };
    dragRef.current = { stop };
    doc.addEventListener?.("pointermove", onMove, true);
    doc.addEventListener?.("pointerup", stop, true);
    event.preventDefault?.();
  };
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "roam-codex-chat-resize",
      role: "separator",
      "aria-orientation": "horizontal",
      "aria-label": "Resize the conversation area",
      onPointerDown
    }
  );
}
function PickerOption({ label, active, level, id, description }) {
  const { store } = usePanel();
  return /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: `roam-codex-chat-picker-option${active ? " is-active" : ""}`,
      role: "menuitemradio",
      "aria-checked": active,
      title: description,
      onClick: () => store.pick(level, id)
    },
    /* @__PURE__ */ React.createElement("span", { className: "roam-codex-chat-picker-option-label" }, label),
    description ? /* @__PURE__ */ React.createElement("span", { className: "roam-codex-chat-picker-option-description" }, description) : null
  );
}
function pickerModelView(snapshot) {
  const { models, pickerModel, pickerEffort, pickerSpeed } = snapshot;
  const selected = models.find((model) => model.id === pickerModel) || models.find((model) => model.isDefault) || models[0] || null;
  const efforts = modelEfforts(selected);
  const tiers = modelTierChoices(selected);
  const defaultTierId = tiers.some(
    (tier) => tier.id === selected?.defaultServiceTier
  ) ? selected.defaultServiceTier : "";
  return {
    selected,
    efforts,
    defaultEffort: efforts.includes(selected?.defaultReasoningEffort) ? selected.defaultReasoningEffort : null,
    tiers,
    defaultTierId,
    currentTier: tiers.find((tier) => tier.id === pickerSpeed) || null,
    effortId: pickerEffort,
    speedId: pickerSpeed,
    modelId: pickerModel
  };
}
function PickerMenu({ view }) {
  const { store, snapshot } = usePanel();
  const { pickerOpen, pickerLevel, models } = snapshot;
  const rows = [
    ["Model", view.selected?.displayName || view.selected?.id || "\u2014", "model"],
    ["Effort", view.effortId ? effortLabel(view.effortId) : "\u2014", "effort"]
  ];
  if (view.tiers.length) {
    rows.push([
      "Speed",
      view.currentTier?.name || view.currentTier?.id || "\u2014",
      "speed"
    ]);
  }
  let options = null;
  if (pickerLevel === "model") {
    options = models.filter((model) => model && typeof model.id === "string").map((model) => {
      const displayName = model.displayName || model.id;
      return /* @__PURE__ */ React.createElement(
        PickerOption,
        {
          key: model.id,
          label: model.isDefault ? `${displayName} (Default)` : displayName,
          active: model.id === view.modelId,
          level: "model",
          id: model.id,
          description: model.description || ""
        }
      );
    });
  } else if (pickerLevel === "effort") {
    options = view.efforts.map((effort) => /* @__PURE__ */ React.createElement(
      PickerOption,
      {
        key: effort,
        label: effort === view.defaultEffort ? `${effortLabel(effort)} (Default)` : effortLabel(effort),
        active: effort === view.effortId,
        level: "effort",
        id: effort,
        description: view.selected?.supportedReasoningEfforts?.find(
          (entry) => entry?.reasoningEffort === effort
        )?.description || ""
      }
    ));
  } else if (pickerLevel === "speed") {
    options = view.tiers.map((tier) => /* @__PURE__ */ React.createElement(
      PickerOption,
      {
        key: tier.id,
        label: tier.id === view.defaultTierId ? `${tier.name || tier.id} (Default)` : tier.name || tier.id,
        active: tier.id === view.speedId,
        level: "speed",
        id: tier.id,
        description: tier.description || ""
      }
    ));
  }
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "roam-codex-chat-picker-menu",
      role: "menu",
      "aria-label": "Model, effort, and speed options",
      hidden: !pickerOpen
    },
    rows.map(([label, value, level]) => {
      const open = pickerLevel === level;
      const openLevel = () => store.openPickerLevel(level);
      return /* @__PURE__ */ React.createElement(
        "button",
        {
          key: level,
          type: "button",
          className: `roam-codex-chat-picker-item${open ? " is-open" : ""}`,
          role: "menuitem",
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "data-level": level,
          title: `Choose ${label.toLowerCase()}`,
          onMouseEnter: openLevel,
          onFocus: openLevel,
          onClick: openLevel,
          onKeyDown: (event) => {
            if (!["ArrowRight", "Enter", " "].includes(event.key)) return;
            event.preventDefault?.();
            openLevel();
          }
        },
        /* @__PURE__ */ React.createElement("span", { className: "roam-codex-chat-picker-item-label" }, label),
        /* @__PURE__ */ React.createElement("span", { className: "roam-codex-chat-picker-item-value" }, value),
        /* @__PURE__ */ React.createElement(
          "span",
          {
            className: "roam-codex-chat-picker-item-chevron",
            "aria-hidden": "true"
          },
          "\u203A"
        )
      );
    })
  ), /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "roam-codex-chat-picker-submenu",
      role: "menu",
      "aria-label": pickerLevel ? `${effortLabel(pickerLevel)} options` : "",
      hidden: !pickerOpen || !pickerLevel
    },
    options
  ));
}
function ControlsBar({ pickerWrapRef }) {
  const { store, snapshot } = usePanel();
  const { running, modelsReady, stopping, pickerOpen, pickerLabel } = snapshot;
  const view = pickerModelView(snapshot);
  const shortcutIsMac = snapshot.sendShortcutIsMac;
  return /* @__PURE__ */ React.createElement("div", { className: "roam-codex-chat-model-row" }, /* @__PURE__ */ React.createElement("div", { className: "roam-codex-chat-picker", ref: pickerWrapRef }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "roam-codex-chat-picker-button",
      title: "Choose the model, reasoning effort, and speed",
      "aria-label": "Model, effort, and speed",
      "aria-haspopup": "menu",
      "aria-expanded": pickerOpen,
      "data-speed": modelsReady ? view.currentTier?.id === "priority" ? "fast" : "standard" : void 0,
      disabled: running || !modelsReady,
      onClick: () => store.togglePicker()
    },
    pickerLabel
  ), /* @__PURE__ */ React.createElement(PickerMenu, { view })), /* @__PURE__ */ React.createElement("div", { className: "roam-codex-chat-actions" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "roam-codex-chat-stop",
      title: "Stop the current Codex turn",
      hidden: !running,
      disabled: stopping,
      onClick: () => {
        void store.stop().catch(() => {
        });
      }
    },
    "Stop"
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "roam-codex-chat-send",
      title: `Send the focused block in this chat's Block Outline (${shortcutIsMac ? "Option" : "Alt"}+Enter, rebindable in Settings \u2192 Hotkeys)`,
      hidden: running,
      disabled: running || !modelsReady,
      onMouseDown: (event) => {
        event.preventDefault?.();
      },
      onClick: () => void store.send()
    },
    "Send",
    /* @__PURE__ */ React.createElement("kbd", { className: "roam-codex-chat-send-kbd", "aria-hidden": "true" }, shortcutIsMac ? "\u2325\u21B5" : "Alt \u21B5")
  )));
}
function HeaderContent({ onCloseRequested }) {
  const { store, snapshot } = usePanel();
  const { running, history, conversationLabel } = snapshot;
  return /* @__PURE__ */ React.createElement("div", { className: "roam-codex-chat-heading" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "roam-codex-chat-conversation",
      "aria-haspopup": "menu",
      "aria-expanded": history.open,
      disabled: running,
      title: history.activeThreadId ? `Current conversation: ${conversationLabel}` : "Start a new conversation or open history",
      onClick: () => history.open ? store.closeHistory() : store.openHistory()
    },
    conversationLabel
  ), /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "roam-codex-chat-history",
      role: "menu",
      "aria-label": "Conversation history",
      hidden: !history.open
    },
    /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        role: "menuitem",
        className: `roam-codex-chat-history-item roam-codex-chat-history-new${history.activeThreadId ? "" : " is-active"}`,
        "aria-current": history.activeThreadId ? void 0 : "true",
        title: "Start a new conversation",
        disabled: running,
        onClick: () => store.beginNewConversation()
      },
      "+ New chat"
    ),
    history.items.length ? history.items.map((item) => /* @__PURE__ */ React.createElement(
      "button",
      {
        key: item.threadId,
        type: "button",
        role: "menuitem",
        className: `roam-codex-chat-history-item${item.active ? " is-active" : ""}`,
        "aria-current": item.active ? "true" : void 0,
        "data-thread-id": item.threadId,
        "data-availability": item.availability,
        title: `Resume ${item.title}`,
        disabled: running,
        onClick: () => store.selectConversation(item.threadId)
      },
      /* @__PURE__ */ React.createElement("span", { className: "roam-codex-chat-history-title" }, item.title),
      /* @__PURE__ */ React.createElement("span", { className: "roam-codex-chat-history-date" }, ["missing", "unavailable"].includes(item.availability) ? "Unavailable" : conversationDateLabel(item.updatedAt))
    )) : /* @__PURE__ */ React.createElement("div", { className: "roam-codex-chat-history-empty" }, history.error || "No previous chats yet."),
    history.items.length && history.error ? /* @__PURE__ */ React.createElement("div", { className: "roam-codex-chat-history-error" }, history.error) : null
  ), /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "roam-codex-chat-close",
      title: "Close Codex chat",
      "aria-label": "Close Codex chat",
      onClick: onCloseRequested
    },
    "\u2715"
  ));
}
function ChatPanelRoot({ store, doc, api, headerEl, controlsEl, onCloseRequested }) {
  const [snapshot, setSnapshot] = useState(store.getSnapshot);
  const transcriptRef = useRef(null);
  const pickerWrapRef = useRef(null);
  useEffect(() => {
    const unsubscribe = store.subscribe(() => setSnapshot(store.getSnapshot()));
    setSnapshot(store.getSnapshot());
    void store.loadModels();
    void store.loadInitialConversation();
    return unsubscribe;
  }, [store]);
  useEffect(() => {
    const handleKeydown = (event) => {
      const current = store.getSnapshot();
      if (!event.defaultPrevented && event.key === "Escape" && (current.history.open || current.pickerOpen)) {
        event.preventDefault();
        event.stopPropagation?.();
        if (current.history.open) store.closeHistory();
        if (current.pickerOpen) store.closePicker();
        return;
      }
      if (!event.defaultPrevented && event.altKey && !event.metaKey && !event.ctrlKey && event.key === "Enter") {
        if (store.maybeSendFromShortcut()) {
          event.preventDefault();
          event.stopPropagation?.();
        }
      }
    };
    const handleClick = (event) => {
      const current = store.getSnapshot();
      if (current.history.open && !headerEl.contains?.(event.target)) {
        store.closeHistory();
      }
      if (current.pickerOpen && !pickerWrapRef.current?.contains?.(event.target)) {
        store.closePicker();
      }
    };
    const handleWindowFocus = () => {
      const current = store.getSnapshot();
      if (!current.closed && !current.running) {
        void store.loadHistory({ reconcileActive: true });
      }
    };
    const handleVisibilityChange = () => {
      if (doc.visibilityState === "visible") handleWindowFocus();
    };
    doc.addEventListener?.("keydown", handleKeydown, true);
    doc.addEventListener?.("click", handleClick, true);
    doc.addEventListener?.("visibilitychange", handleVisibilityChange);
    doc.defaultView?.addEventListener?.("focus", handleWindowFocus);
    return () => {
      doc.removeEventListener?.("keydown", handleKeydown, true);
      doc.removeEventListener?.("click", handleClick, true);
      doc.removeEventListener?.("visibilitychange", handleVisibilityChange);
      doc.defaultView?.removeEventListener?.("focus", handleWindowFocus);
    };
  }, [store, doc, headerEl]);
  return /* @__PURE__ */ React.createElement(PanelContext.Provider, { value: { store, snapshot, api, doc } }, ReactDOM.createPortal(
    /* @__PURE__ */ React.createElement(HeaderContent, { onCloseRequested }),
    headerEl
  ), /* @__PURE__ */ React.createElement("div", { className: "roam-codex-chat-body" }, /* @__PURE__ */ React.createElement(Transcript, { transcriptRef }), /* @__PURE__ */ React.createElement(ResizeHandle, { transcriptRef })), ReactDOM.createPortal(
    /* @__PURE__ */ React.createElement(ControlsBar, { pickerWrapRef }),
    controlsEl
  ));
}
function createChatPanel(options = {}) {
  const {
    doc = globalThis.document,
    api = getRoamApi(),
    ...storeOptions
  } = options;
  if (!doc?.createElement) {
    throw new Error("A document is required to create the Codex chat panel.");
  }
  assertReactAvailable();
  const store = createChatPanelStore({ ...storeOptions, api });
  const panel = doc.createElement("section");
  panel.className = CHAT_PANEL_CLASS;
  panel.id = CHAT_PANEL_ID;
  panel.setAttribute("aria-label", "Codex chat");
  const header = doc.createElement("header");
  header.className = "roam-codex-chat-header";
  const controls = doc.createElement("footer");
  controls.className = "roam-codex-chat-controls";
  controls.id = CHAT_CONTROLS_ID;
  let unmounted = false;
  const close = () => {
    const result = store.close();
    if (!unmounted) {
      unmounted = true;
      ReactDOM.unmountComponentAtNode(panel);
    }
    header.remove();
    panel.remove();
    controls.remove();
    return result;
  };
  const onCloseRequested = () => {
    const removeWindow = api.ui?.rightSidebar?.removeWindow;
    const removal = typeof removeWindow === "function" ? Promise.resolve(removeWindow({
      window: { type: "block", "block-uid": storeOptions.rootBlockUid }
    })).catch(() => {
    }) : Promise.resolve();
    void removal.then(() => close());
  };
  ReactDOM.render(
    /* @__PURE__ */ React.createElement(
      ChatPanelRoot,
      {
        store,
        doc,
        api,
        headerEl: header,
        controlsEl: controls,
        onCloseRequested
      }
    ),
    panel
  );
  return {
    element: panel,
    headerElement: header,
    controlsElement: controls,
    rootBlockUid: storeOptions.rootBlockUid,
    close,
    focus: store.focusRoot,
    send: store.send
  };
}

// src/core.js
var BRIDGE_URL = "http://127.0.0.1:47321";
var GRAPH = "maskys";
var TOKEN_KEY = "roam-codex-lab.bridge-token";
var RUNNING_STATUS_KEY = "roam-codex-lab.running-status-uids";
var ACTIVE_BLOCK_UIDS = /* @__PURE__ */ new Set();
var ACTIVE_PRESENTATIONS = /* @__PURE__ */ new Map();
var RUNNING_BLOCK_CLASS = "roam-codex-running-block";
var RUNNING_BADGE_CLASS = "roam-codex-running-status";
var RUNNING_META_CLASS = "roam-codex-running-meta";
var RUNNING_TIMER_CLASS = "roam-codex-running-timer";
var RUNNING_CANCEL_CLASS = "roam-codex-running-cancel";
var RUNNING_SUMMARY_CLASS = "roam-codex-running-summary";
var CHAT_PANEL_ID = "roam-codex-chat-panel";
var CHAT_CONTROLS_ID = "roam-codex-chat-controls";
var CHAT_PANEL_CLASS = "roam-codex-chat-panel";
var SIDEBAR_CHAT_LAUNCHER_ID = "roam-codex-sidebar-chat-launcher";
var CHAT_STATE_VERSION = 2;
var CHAT_STATE_KEY = `roam-codex-lab.chat-state.v${CHAT_STATE_VERSION}.${GRAPH}`;
var INSTALLATION_ID_KEY = `roam-codex-lab.installation-id.${GRAPH}`;
var THREAD_PAGE_PREFIX = "Codex/thread/";
var THREAD_ID_FIELD = "Codex thread::";
var THREAD_ORIGIN_FIELD = "Origin installation::";
var THREAD_CREATED_FIELD = "Created at::";
var THREAD_ACTIVE_FIELD = "Last active at::";
var CHAT_TRANSCRIPT_HEIGHT_KEY = `roam-codex-lab.chat-transcript-height.${GRAPH}`;
var CHAT_TRANSCRIPT_MIN_HEIGHT = 140;
var CHAT_TRANSCRIPT_MAX_HEIGHT = 640;
var CHAT_SCROLL_BOTTOM_THRESHOLD = 24;
var NATIVE_WINDOW_HEADER_CLASS = "roam-codex-native-window-header";
var NATIVE_COMPOSER_CLASS = "roam-codex-native-composer";
var ACTIVE_CHAT_PANEL = null;
var SIDEBAR_CHAT_LAUNCHER = null;
var CHAT_PANEL_OPEN_PROMISE = null;
var CHAT_PANEL_CLOSE_PROMISE = null;
var CHAT_TOGGLE_HOTKEY_DISPOSE = null;
var CHAT_TOGGLE_HOTKEY_KEY = "__roamCodexToggleHotkeyDispose";
var RUNNING_BLOCK_TEXT = "[[Codex/running]]";
var CHAT_COMPOSER_PLACEHOLDER = "\xA0";
function emptyChatState() {
  return {
    version: CHAT_STATE_VERSION,
    activeThreadId: null,
    newConversationPreferences: { model: null, effort: null, speed: null },
    conversations: {}
  };
}
function validThreadId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}
function validBlockUid(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(value);
}
function readChatState({
  storage = window.localStorage,
  key = CHAT_STATE_KEY
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
      threadPageUid: typeof record.threadPageUid === "string" ? record.threadPageUid : null,
      threadPageTitle: typeof record.threadPageTitle === "string" && record.threadPageTitle.startsWith(THREAD_PAGE_PREFIX) ? record.threadPageTitle : null,
      originInstallationId: typeof record.originInstallationId === "string" ? record.originInstallationId : null,
      lastSeenUpdatedAt: Number.isFinite(record.lastSeenUpdatedAt) ? record.lastSeenUpdatedAt : 0,
      availability: ["available", "missing", "unavailable", "pending"].includes(
        record.availability
      ) ? record.availability : "pending",
      pendingGraphIndex: record.pendingGraphIndex === true
    };
  }
  const activeThreadId = validThreadId(value.activeThreadId) && conversations[value.activeThreadId] ? value.activeThreadId : null;
  return {
    version: CHAT_STATE_VERSION,
    activeThreadId,
    newConversationPreferences: {
      model: typeof value.newConversationPreferences?.model === "string" ? value.newConversationPreferences.model : null,
      effort: typeof value.newConversationPreferences?.effort === "string" ? value.newConversationPreferences.effort : null,
      speed: typeof value.newConversationPreferences?.speed === "string" ? value.newConversationPreferences.speed : null
    },
    conversations
  };
}
function writeChatState(state, { storage = window.localStorage, key = CHAT_STATE_KEY } = {}) {
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
      timeout: 5e3
    });
    return;
  }
  console.log(`[Roam Codex] ${message}`);
}
async function requestProbe(blockUid, {
  fetchImpl = window.fetch.bind(window),
  token = getToken(),
  onProgress = () => {
  },
  onStarted = () => {
  }
} = {}) {
  if (!token) {
    throw new Error(
      'No bridge token. Run "Codex: Pair local bridge" first.'
    );
  }
  const response = await fetchImpl(`${BRIDGE_URL}/probe`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ graph: GRAPH, blockUid })
  });
  if (!response.ok) {
    let body = {};
    try {
      body = await response.json();
    } catch {
    }
    throw new Error(body.error || `Bridge returned HTTP ${response.status}.`);
  }
  if (response.headers.get("content-type")?.includes("application/x-ndjson")) {
    return readProbeStream(response, { onProgress, onStarted });
  }
  return response.json();
}
async function readProbeStream(response, {
  onProgress = () => {
  },
  onStarted = () => {
  },
  onThread = () => {
  }
} = {}) {
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
      }
    } else if (event.type === "conversation" && typeof event.threadId === "string") {
      try {
        onThread({ threadId: event.threadId });
      } catch {
      }
    } else if (event.type === "progress" && typeof event.text === "string") {
      try {
        onProgress({ kind: event.kind || "activity", text: event.text });
      } catch {
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
  token = getToken()
} = {}) {
  if (!token) {
    throw new Error(
      'No bridge token. Run "Codex: Pair local bridge" first.'
    );
  }
  const response = await fetchImpl(`${BRIDGE_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
  }
  if (!response.ok) {
    const error = new Error(
      body.error || `Bridge returned HTTP ${response.status}.`
    );
    error.status = response.status;
    throw error;
  }
  return body;
}
async function requestPanelModels(options = {}) {
  const result = await bridgeJson("/models", options);
  return Array.isArray(result.models) ? result.models : [];
}
async function requestPanelThreadSummaries(threadIds, {
  fetchImpl = window.fetch.bind(window),
  token = getToken()
} = {}) {
  if (!token) {
    throw new Error(
      'No bridge token. Run "Codex: Pair local bridge" first.'
    );
  }
  if (!Array.isArray(threadIds) || threadIds.length > 100 || threadIds.some((threadId) => !validThreadId(threadId)) || new Set(threadIds).size !== threadIds.length) {
    throw new Error("Conversation history requires at most 100 unique thread IDs.");
  }
  const response = await fetchImpl(`${BRIDGE_URL}/threads/summaries`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ graph: GRAPH, threadIds })
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
  }
  if (!response.ok) {
    throw new Error(
      result.error || `Bridge returned HTTP ${response.status}.`
    );
  }
  return {
    threads: Array.isArray(result.threads) ? result.threads : [],
    missingThreadIds: Array.isArray(result.missingThreadIds) ? result.missingThreadIds : [],
    unavailableThreadIds: Array.isArray(result.unavailableThreadIds) ? result.unavailableThreadIds : []
  };
}
async function requestPanelMessages(threadId, options = {}) {
  if (!validThreadId(threadId)) {
    throw new Error("Cannot load a conversation without a valid thread ID.");
  }
  const result = await bridgeJson(
    `/threads/${encodeURIComponent(threadId)}/messages`,
    options
  );
  return Array.isArray(result.messages) ? result.messages : [];
}
async function requestPanelThreadName(threadId, name, {
  fetchImpl = window.fetch.bind(window),
  token = getToken()
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
        "content-type": "application/json"
      },
      body: JSON.stringify({ graph: GRAPH, name: cleanName })
    }
  );
  let result = {};
  try {
    result = await response.json();
  } catch {
  }
  if (!response.ok) {
    throw new Error(result.error || `Bridge returned HTTP ${response.status}.`);
  }
  return result;
}
async function requestPanelChat(message, {
  fetchImpl = window.fetch.bind(window),
  token = getToken(),
  promptBlockUid,
  threadId = null,
  model = null,
  effort = null,
  serviceTier,
  onProgress = () => {
  },
  onStarted = () => {
  },
  onThread = () => {
  }
} = {}) {
  if (!token) {
    throw new Error(
      'No bridge token. Run "Codex: Pair local bridge" first.'
    );
  }
  if (!validBlockUid(promptBlockUid)) {
    throw new Error("Cannot chat without a valid Roam prompt block UID.");
  }
  const body = {
    graph: GRAPH,
    message: String(message),
    promptBlockUid
  };
  if (threadId) body.threadId = threadId;
  if (model) body.model = model;
  if (effort) body.effort = effort;
  if (serviceTier !== void 0) body.serviceTier = serviceTier;
  const response = await fetchImpl(`${BRIDGE_URL}/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    let result = {};
    try {
      result = await response.json();
    } catch {
    }
    throw new Error(
      result.error || `Bridge returned HTTP ${response.status}.`
    );
  }
  return readProbeStream(response, {
    onProgress,
    onStarted,
    onThread
  });
}
async function requestRunCancellation(runId, {
  fetchImpl = window.fetch.bind(window),
  token = getToken()
} = {}) {
  if (!token) {
    throw new Error(
      'No bridge token. Run "Codex: Pair local bridge" first.'
    );
  }
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    throw new Error("Cannot stop a run without a valid run ID.");
  }
  const response = await fetchImpl(
    `${BRIDGE_URL}/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    }
  );
  let result = {};
  try {
    result = await response.json();
  } catch {
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
  return typeof title === "string" && title.startsWith(THREAD_PAGE_PREFIX) ? singleLine(title.slice(THREAD_PAGE_PREFIX.length)) : "";
}
function readableThreadLabel(value, timestamp = Date.now()) {
  const cleaned = singleLine(value).replace(/\[\[|\]\]/g, "").replace(/[\r\n/#]+/g, " \xB7 ").replace(/\s*·\s*/g, " \xB7 ").slice(0, 80).trim();
  return cleaned || `Untitled \xB7 ${conversationDateLabel(timestamp)}`;
}
function storageInstallationId({
  storage = window.localStorage,
  key = INSTALLATION_ID_KEY,
  cryptoImpl = globalThis.crypto
} = {}) {
  const existing = storage.getItem(key)?.trim();
  if (/^[A-Za-z0-9_-]{8,128}$/.test(existing || "")) return existing;
  const random = cryptoImpl?.randomUUID?.() || [
    Date.now().toString(36),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2)
  ].join("-");
  const installationId = `install_${random}`.replace(/[^A-Za-z0-9_-]/g, "_");
  storage.setItem(key, installationId);
  return installationId;
}
function fieldChildren(page, label) {
  return (page?.[":block/children"] || page?.children || []).filter((child) => typeof (child?.[":block/string"] ?? child?.string) === "string").filter(
    (child) => (child[":block/string"] ?? child.string).startsWith(`${label} `)
  ).map((child) => ({
    uid: child[":block/uid"] ?? child.uid,
    value: singleLine(
      (child[":block/string"] ?? child.string).slice(label.length)
    )
  }));
}
async function pullThreadPage(api, pageUid) {
  const pattern = [
    "[:block/uid :node/title",
    "{:block/children [:block/uid :block/string :block/order]}]"
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
      "[:find ?uid ?title :in $ ?prefix :where [?page :block/uid ?uid] [?page :node/title ?title] [(clojure.string/starts-with? ?title ?prefix)]]",
      THREAD_PAGE_PREFIX
    ) || [];
  } catch {
    const rows = api.q(
      "[:find ?uid ?title :where [?page :block/uid ?uid] [?page :node/title ?title]]"
    ) || [];
    return rows.filter(
      (row) => Array.isArray(row) && String(row[1] || "").startsWith(THREAD_PAGE_PREFIX)
    );
  }
}
async function readGraphThreadIndex({ api = getRoamApi() } = {}) {
  const rows = await Promise.resolve(threadPageRows(api));
  const uniqueRows = [...new Map(
    rows.filter(
      (row) => Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "string" && row[1].startsWith(THREAD_PAGE_PREFIX)
    ).map((row) => [row[0], row])
  ).values()].slice(0, 500);
  const pages = (await Promise.all(
    uniqueRows.map(async ([pageUid, title]) => {
      const page = await pullThreadPage(api, pageUid);
      if (!page) return null;
      return { page, pageUid, title };
    })
  )).filter(Boolean);
  const records = [];
  const errors = [];
  for (const entry of pages) {
    const ids = fieldChildren(entry.page, THREAD_ID_FIELD);
    if (ids.length !== 1 || !validThreadId(ids[0]?.value)) {
      errors.push({
        pageUid: entry.pageUid,
        title: entry.title,
        error: ids.length > 1 ? "Thread page contains multiple Codex thread IDs." : "Thread page does not contain one valid Codex thread ID."
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
        error: "Thread page contains duplicate metadata fields."
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
        lastActiveAt: active[0]?.uid || null
      }
    });
  }
  const byThreadId = /* @__PURE__ */ new Map();
  for (const record of records) {
    const group = byThreadId.get(record.threadId) || [];
    group.push(record);
    byThreadId.set(record.threadId, group);
  }
  const duplicateIds = /* @__PURE__ */ new Set();
  for (const [threadId, group] of byThreadId) {
    if (group.length < 2) continue;
    duplicateIds.add(threadId);
    for (const record of group) {
      errors.push({
        pageUid: record.threadPageUid,
        title: record.threadPageTitle,
        threadId,
        error: "Codex thread ID is indexed by more than one thread page."
      });
    }
  }
  return {
    records: records.filter((record) => !duplicateIds.has(record.threadId)),
    errors
  };
}
async function exactPageUid(api, title) {
  if (typeof api.q !== "function") return null;
  return api.q(
    "[:find ?uid . :in $ ?title :where [?page :node/title ?title] [?page :block/uid ?uid]]",
    title
  ) || null;
}
function generatedRoamUid(api) {
  return api.util?.generateUID?.() || Math.random().toString(36).slice(2, 11);
}
async function createMetadataBlock(api, pageUid, order, string) {
  const uid = generatedRoamUid(api);
  await api.data.block.create({
    location: { "parent-uid": pageUid, order },
    block: { uid, string }
  });
  return uid;
}
async function ensureGraphThreadRecord({
  api = getRoamApi(),
  storage = window.localStorage,
  threadId,
  title,
  timestamp = Date.now()
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
    const installationId2 = existing.originInstallationId || storageInstallationId({ storage });
    const createdAt = existing.createdAt || timestamp;
    const lastActiveAt = existing.lastActiveAt || createdAt;
    const metadataUids2 = { ...existing.metadataUids };
    if (!metadataUids2.origin) {
      metadataUids2.origin = await createMetadataBlock(
        api,
        existing.threadPageUid,
        1,
        `${THREAD_ORIGIN_FIELD} ${installationId2}`
      );
    }
    if (!metadataUids2.createdAt) {
      metadataUids2.createdAt = await createMetadataBlock(
        api,
        existing.threadPageUid,
        2,
        `${THREAD_CREATED_FIELD} ${new Date(createdAt).toISOString()}`
      );
    }
    if (!metadataUids2.lastActiveAt) {
      metadataUids2.lastActiveAt = await createMetadataBlock(
        api,
        existing.threadPageUid,
        3,
        `${THREAD_ACTIVE_FIELD} ${new Date(lastActiveAt).toISOString()}`
      );
    }
    return {
      ...existing,
      originInstallationId: installationId2,
      createdAt,
      lastActiveAt,
      metadataUids: metadataUids2
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
    pageTitle = `${baseTitle} \xB7 ${suffix}`;
    suffix += 1;
  }
  const pageUid = generatedRoamUid(api);
  await api.data.page.create({ page: { uid: pageUid, title: pageTitle } });
  const metadataUids = {
    threadId: await createMetadataBlock(
      api,
      pageUid,
      0,
      `${THREAD_ID_FIELD} ${threadId}`
    ),
    origin: await createMetadataBlock(
      api,
      pageUid,
      1,
      `${THREAD_ORIGIN_FIELD} ${installationId}`
    ),
    createdAt: await createMetadataBlock(
      api,
      pageUid,
      2,
      `${THREAD_CREATED_FIELD} ${iso}`
    ),
    lastActiveAt: await createMetadataBlock(
      api,
      pageUid,
      3,
      `${THREAD_ACTIVE_FIELD} ${iso}`
    )
  };
  return {
    threadId,
    threadPageUid: pageUid,
    threadPageTitle: pageTitle,
    originInstallationId: installationId,
    createdAt: timestamp,
    lastActiveAt: timestamp,
    metadataUids
  };
}
async function updateGraphThreadActivity(record, timestamp, { api = getRoamApi() } = {}) {
  if (!record?.metadataUids?.lastActiveAt || !api.data?.block?.update) {
    return record;
  }
  if (Number.isFinite(record.lastActiveAt) && record.lastActiveAt >= timestamp) {
    return record;
  }
  await api.data.block.update({
    block: {
      uid: record.metadataUids.lastActiveAt,
      string: `${THREAD_ACTIVE_FIELD} ${new Date(timestamp).toISOString()}`
    }
  });
  return { ...record, lastActiveAt: timestamp };
}
function serverTimestampMs(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 1e12 ? value * 1e3 : value;
}
function conversationDateLabel(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Intl.DateTimeFormat(void 0, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}
function buildConversationHistory(state, summaries = []) {
  const summaryByThreadId = new Map(
    summaries.filter((summary) => validThreadId(summary?.id)).map((summary) => [summary.id, summary])
  );
  return Object.values(state?.conversations || {}).filter((record) => validThreadId(record?.threadId)).map((record) => {
    const summary = summaryByThreadId.get(record.threadId) || null;
    const graphTitle = threadPageLabel(record.threadPageTitle);
    const name = singleLine(summary?.name || "");
    const preview = singleLine(summary?.preview || "");
    const createdAt = serverTimestampMs(summary?.createdAt) || record.createdAt;
    const updatedAt = Math.max(
      serverTimestampMs(summary?.updatedAt),
      Number.isFinite(record.updatedAt) ? record.updatedAt : 0
    );
    return {
      threadId: record.threadId,
      title: graphTitle || name || preview || `Untitled${createdAt ? ` \xB7 ${conversationDateLabel(createdAt)}` : ""}`,
      createdAt,
      updatedAt,
      active: state.activeThreadId === record.threadId,
      availability: record.availability || "pending"
    };
  }).sort(
    (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.threadId.localeCompare(right.threadId)
  );
}
function readRunningStatusUids(storage) {
  try {
    const value = JSON.parse(storage.getItem(RUNNING_STATUS_KEY) || "[]");
    return Array.isArray(value) ? value.filter((uid) => typeof uid === "string") : [];
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
    statusUid
  ]);
}
function forgetRunningStatus(storage, statusUid) {
  writeRunningStatusUids(
    storage,
    readRunningStatusUids(storage).filter((uid) => uid !== statusUid)
  );
}
async function createRunningStatus(blockUid, {
  api = getRoamApi(),
  storage = window.localStorage
} = {}) {
  const statusUid = api.util.generateUID();
  rememberRunningStatus(storage, statusUid);
  try {
    await api.data.block.create({
      location: { "parent-uid": blockUid, order: "last" },
      block: {
        uid: statusUid,
        string: RUNNING_BLOCK_TEXT
      }
    });
  } catch (error) {
    forgetRunningStatus(storage, statusUid);
    throw error;
  }
  return statusUid;
}
async function removeRunningStatus(statusUid, {
  api = getRoamApi(),
  storage = window.localStorage
} = {}) {
  await api.data.block.delete({ block: { uid: statusUid } });
  forgetRunningStatus(storage, statusUid);
}
async function cleanupStaleRunningStatuses({
  api = getRoamApi(),
  storage = window.localStorage
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
function formatRunningElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1e3));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
function runningPresentationText(elapsedMs, progressText = "") {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1e3));
  const state = singleLine(progressText) || (totalSeconds < 5 ? "Starting" : totalSeconds < 45 ? "Working" : "Still working");
  return `${state} \xB7 ${formatRunningElapsed(elapsedMs)}`;
}
function runningStateText(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1e3));
  if (totalSeconds < 5) return "Starting";
  if (totalSeconds < 45) return "Working";
  return "Still working";
}
function findRunningBlockContainers(doc, statusUid) {
  if (!doc?.querySelectorAll || !/^[A-Za-z0-9_-]+$/.test(statusUid)) {
    return [];
  }
  const containers = /* @__PURE__ */ new Set();
  const nodes = [
    ...doc.getElementById ? [doc.getElementById(`block-input-${statusUid}`)].filter(Boolean) : [],
    ...doc.querySelectorAll(`[data-uid="${statusUid}"]`),
    ...doc.querySelectorAll(`[data-block-uid="${statusUid}"]`)
  ];
  for (const node of nodes) {
    const container = node.matches?.(".roam-block-container") ? node : node.closest?.(".roam-block-container");
    if (container) containers.add(container);
  }
  return [...containers];
}
function startRunningPresentation(statusUid, {
  doc = globalThis.document,
  now = Date.now,
  setIntervalImpl = globalThis.setInterval?.bind(globalThis),
  clearIntervalImpl = globalThis.clearInterval?.bind(globalThis)
} = {}) {
  ACTIVE_PRESENTATIONS.get(statusUid)?.();
  if (!doc?.createElement || !doc?.querySelectorAll || !setIntervalImpl || !clearIntervalImpl) {
    return () => {
    };
  }
  const startedAt = now();
  const decorated = /* @__PURE__ */ new Map();
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
        const meta2 = doc.createElement("span");
        meta2.className = RUNNING_META_CLASS;
        const timer2 = doc.createElement("span");
        timer2.className = RUNNING_TIMER_CLASS;
        meta2.appendChild(timer2);
        const cancelButton2 = doc.createElement("button");
        cancelButton2.className = RUNNING_CANCEL_CLASS;
        cancelButton2.type = "button";
        cancelButton2.textContent = "Stop";
        cancelButton2.title = "Stop this Codex run";
        cancelButton2.addEventListener("click", cancel);
        meta2.appendChild(cancelButton2);
        badge.appendChild(meta2);
        const summary2 = doc.createElement("span");
        summary2.className = RUNNING_SUMMARY_CLASS;
        badge.appendChild(summary2);
        const host2 = container.querySelector?.(".rm-block-main") || container;
        host2.appendChild(badge);
      }
      const meta = badge.querySelector?.(`.${RUNNING_META_CLASS}`);
      const timer = meta?.querySelector?.(`.${RUNNING_TIMER_CLASS}`);
      const cancelButton = meta?.querySelector?.(`.${RUNNING_CANCEL_CLASS}`);
      const summary = badge.querySelector?.(`.${RUNNING_SUMMARY_CLASS}`);
      if (timer) timer.textContent = elapsedText;
      if (cancelButton) {
        cancelButton.hidden = !cancelHandler;
        cancelButton.disabled = cancelling;
        cancelButton.textContent = cancelling ? "Stopping\u2026" : "Stop";
      }
      if (summary) summary.textContent = summaryText;
      badge.title = progressText ? `${progressText}
Local progress; the Roam block is not being updated.` : "Local elapsed timer; the Roam block is not being updated.";
      badge.setAttribute(
        "aria-label",
        `Codex ${summaryText.toLowerCase()}, elapsed ${elapsedText}`
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
  const intervalId = setIntervalImpl(sync, 1e3);
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
function stopAllRunningPresentations() {
  for (const stop of [...ACTIVE_PRESENTATIONS.values()]) stop();
}
function formatComment(comment) {
  return `**Codex** \u2014 ${singleLine(comment.text)}`;
}
function escapeMarkdownLinkText(value) {
  return singleLine(value).replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}
function formatSource(source) {
  const title = escapeMarkdownLinkText(source.title);
  const url = String(source.url).replaceAll("(", "%28").replaceAll(")", "%29");
  return `[${title}](${url}) \u2014 ${singleLine(source.supports)}`;
}
function formatSourcesComment(sources) {
  return [
    "- **Codex** \u2014 Sources",
    ...sources.map((source) => `  - ${formatSource(source)}`)
  ].join("\n");
}
function commentToOpenIndex(comments) {
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    if (comments[index].kind === "question" || comments[index].kind === "warning") {
      return index;
    }
  }
  return comments.length - 1;
}
async function applyRunPlan(sourceBlockUid, plan, {
  api = getRoamApi()
} = {}) {
  if (!plan || !Array.isArray(plan.edits) || !Array.isArray(plan.comments) || !Array.isArray(plan.sources)) {
    throw new Error("Bridge returned an invalid edit plan.");
  }
  const targetUids = /* @__PURE__ */ new Map([["source", sourceBlockUid]]);
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
        string: singleLine(edit.text)
      }
    });
    targetUids.set(edit.id, uid);
    createdUids.push(uid);
  }
  const sourcesByTarget = /* @__PURE__ */ new Map();
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
      "open-comment": openFirstSourceComment && sourceCommentIndex === 0
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
      "open-comment": index === openedCommentIndex
    });
    commentUids.push(...result?.uids || []);
  }
  return {
    outcome: plan.outcome,
    research: plan.research,
    createdUids,
    sourceCommentUids,
    commentUids
  };
}
async function workOnBlock(blockUid, {
  api = getRoamApi(),
  storage = window.localStorage,
  request = requestProbe,
  cancelRequest = requestRunCancellation,
  notifyImpl = notify,
  startPresentation = startRunningPresentation
} = {}) {
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
      }
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
          `Run finished, but its running indicator could not be removed: ${error.message}`
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
        commentUids: []
      };
    }
    notifyImpl(`Codex could not finish: ${failure.message}`, "danger");
    throw failure;
  }
  if (applied.outcome === "applied") {
    const commentSuffix = applied.commentUids.length ? " Comments are open in the sidebar." : "";
    const action = applied.sourceCommentUids.length ? "researched and updated" : "updated";
    notifyImpl(`Codex ${action} the outline.${commentSuffix}`, "success");
  } else if (applied.outcome === "needs_input") {
    notifyImpl("Codex needs input in the comments sidebar.", "warning");
  } else {
    notifyImpl("Codex left a comment without changing the outline.", "primary");
  }
  return applied;
}
function findChatPanelHost(doc = globalThis.document, sidebarWindow) {
  const windowId = sidebarWindow?.["window-id"];
  if (typeof windowId !== "string" || !windowId) return null;
  return doc?.getElementById?.(`sidebar-window-${windowId}`) || null;
}
async function waitForChatPanelHost(doc, sidebarWindow, {
  attempts = 80,
  waitImpl = (resolveWait) => setTimeout(resolveWait, 50)
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const host2 = findChatPanelHost(doc, sidebarWindow);
    if (host2) return host2;
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
function renderRoamMarkdown(element, string, { api = getRoamApi() } = {}) {
  const value = typeof string === "string" ? string : "";
  const renderString = api.ui?.components?.renderString;
  if (typeof renderString !== "function") {
    element.textContent = value;
    return Promise.resolve(false);
  }
  return Promise.resolve(renderString({ el: element, string: value })).then(() => true).catch(() => {
    element.textContent = value;
    return false;
  });
}
function unmountRoamMarkdown(element, { api = getRoamApi() } = {}) {
  const unmountNode = api.ui?.components?.unmountNode;
  if (typeof unmountNode !== "function") return Promise.resolve(false);
  return Promise.resolve(unmountNode({ el: element })).then(() => true).catch(() => false);
}
function copyRoamText(string, { navigatorImpl = globalThis.navigator } = {}) {
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
  return Array.from(element?.children || []).find(
    (child) => String(child.className || "").split(/\s+/).includes(className)
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
function findSidebarChatLauncherPlacement(doc = globalThis.document) {
  const sidebar = doc?.getElementById?.("right-sidebar");
  const content = doc?.getElementById?.("roam-right-sidebar-content");
  if (!sidebar || !content || !rightSidebarVisible(sidebar, doc)) return null;
  const header = directChildWithClass(sidebar, "flex-h-box") || sidebar.querySelector?.(":scope > .flex-h-box") || null;
  if (!header) return null;
  const nativeToggle = Array.from(header.children || []).find(
    (child) => child?.tagName?.toLowerCase?.() === "button" && child.id !== SIDEBAR_CHAT_LAUNCHER_ID
  ) || null;
  if (!nativeToggle) return null;
  return { sidebar, content, header, nativeToggle };
}
function activeChatPanelIsOpen() {
  return Boolean(ACTIVE_CHAT_PANEL?.element?.isConnected);
}
function cleanupStaleChatUi(doc = globalThis.document) {
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
      open ? "Close Codex chat" : "Open Codex chat"
    );
  }
}
function mountSidebarChatLauncher({
  doc = globalThis.document,
  openChatImpl = openChatPanel,
  closeChatImpl = closeChatPanel,
  isChatOpenImpl = activeChatPanelIsOpen,
  notifyImpl = notify,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout
} = {}) {
  const existing = doc?.getElementById?.(SIDEBAR_CHAT_LAUNCHER_ID);
  const placement = findSidebarChatLauncherPlacement(doc);
  if (!placement) {
    existing?.roamCodexDispose?.();
    existing?.remove?.();
    return null;
  }
  existing?.roamCodexDispose?.();
  existing?.remove?.();
  const button = panelButton(
    doc,
    "bp3-button bp3-minimal roam-codex-sidebar-chat-launcher",
    "",
    "Open Codex chat"
  );
  button.id = SIDEBAR_CHAT_LAUNCHER_ID;
  button.dataset.state = "idle";
  updateSidebarChatLauncherState(button, isChatOpenImpl());
  const icon = createPanelElement(
    doc,
    "span",
    "roam-codex-sidebar-chat-launcher-icon"
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
      button.title = closing ? "Codex chat could not close" : "Codex chat could not open";
      const action = closing ? "close" : "open";
      notifyImpl(`Codex chat could not ${action}: ${error.message}`, "danger");
      feedbackTimer = setTimeoutImpl(() => {
        feedbackTimer = null;
        if (!button.isConnected) return;
        button.dataset.state = "idle";
        updateSidebarChatLauncherState(button, isChatOpenImpl());
      }, 1400);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
  placement.header.insertBefore(
    button,
    placement.header.firstChild || placement.nativeToggle
  );
  placement.header.classList?.add?.("roam-codex-chat-toolbar");
  return button;
}
function installSidebarChatLauncher({
  doc = globalThis.document,
  MutationObserverImpl = doc?.defaultView?.MutationObserver || globalThis.MutationObserver,
  requestAnimationFrameImpl = doc?.defaultView?.requestAnimationFrame?.bind(
    doc.defaultView
  ) || ((callback) => globalThis.setTimeout(callback, 0)),
  cancelAnimationFrameImpl = doc?.defaultView?.cancelAnimationFrame?.bind(
    doc.defaultView
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
    if (mountedButton?.isConnected && placement?.header === mountedButton.parentNode) {
      placement.header.classList?.add?.("roam-codex-chat-toolbar");
      const isOpen = typeof mountOptions.isChatOpenImpl === "function" ? mountOptions.isChatOpenImpl() : activeChatPanelIsOpen();
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
  const observer = typeof MutationObserverImpl === "function" ? new MutationObserverImpl((mutations) => {
    const sidebar = doc?.getElementById?.("right-sidebar");
    if (!sidebar || mutations.some(
      (mutation) => mutation.target === sidebar || sidebar.contains?.(mutation.target)
    )) {
      schedule();
    }
  }) : null;
  const observationRoot = doc?.body || doc?.documentElement;
  if (observer && observationRoot) {
    observer.observe(observationRoot, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
      childList: true,
      subtree: true
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
      const button = mountedButton?.isConnected ? mountedButton : doc?.getElementById?.(SIDEBAR_CHAT_LAUNCHER_ID);
      button?.roamCodexDispose?.();
      button?.parentNode?.classList?.remove?.("roam-codex-chat-toolbar");
      button?.remove?.();
      mountedButton = null;
    }
  };
}
function modelEfforts(model) {
  return Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map((option) => option?.reasoningEffort).filter((effort) => typeof effort === "string") : [];
}
function modelTiers(model) {
  return Array.isArray(model?.serviceTiers) ? model.serviceTiers.filter((tier) => typeof tier?.id === "string") : [];
}
function modelTierChoices(model) {
  const tiers = modelTiers(model);
  if (!tiers.length) return [];
  if (tiers.some((tier) => tier.id === "standard")) return tiers;
  return [{
    id: "",
    name: "Standard",
    description: "Default speed",
    synthetic: true
  }, ...tiers];
}
function effortLabel(effort) {
  const value = String(effort).replaceAll(/[-_]+/g, " ");
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}
function findSidebarBlockWindow(blockUid, { api = getRoamApi() } = {}) {
  const windows = api.ui?.rightSidebar?.getWindows?.() || [];
  return windows.find(
    (sidebarWindow) => sidebarWindow?.type === "block" && sidebarWindow["block-uid"] === blockUid
  ) || null;
}
async function waitForSidebarBlockWindow(blockUid, api, {
  attempts = 80,
  waitImpl = (resolveWait) => setTimeout(resolveWait, 50)
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const sidebarWindow = findSidebarBlockWindow(blockUid, { api });
    if (sidebarWindow) return sidebarWindow;
    await new Promise(waitImpl);
  }
  throw new Error("Roam did not open the prompt block in the right sidebar.");
}
async function openPromptBlockInSidebar(blockUid, {
  api = getRoamApi(),
  waitOptions
} = {}) {
  if (!validBlockUid(blockUid)) {
    throw new Error("Focus an ordinary Roam block before opening Codex chat.");
  }
  await api.ui.rightSidebar.addWindow({
    window: { type: "block", "block-uid": blockUid, order: 0 }
  });
  let sidebarWindow = findSidebarBlockWindow(blockUid, { api });
  if (!sidebarWindow) {
    sidebarWindow = await waitForSidebarBlockWindow(
      blockUid,
      api,
      waitOptions
    );
  }
  if (sidebarWindow["collapsed?"]) {
    await api.ui.rightSidebar.expandWindow({
      window: { type: "block", "block-uid": blockUid }
    });
  }
  return sidebarWindow;
}
function normalizeChatPromptText(value) {
  return typeof value === "string" ? value.split(CHAT_COMPOSER_PLACEHOLDER).join("").trim() : "";
}
function snapshotChatPromptOutline(block) {
  return {
    uid: block?.[":block/uid"] || null,
    string: typeof block?.[":block/string"] === "string" ? block[":block/string"] : "",
    children: (block?.[":block/children"] || []).map(snapshotChatPromptOutline)
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
    (child, index) => sameChatPromptOutline(child, right.children[index])
  );
}
function outlineContainsProtectedUid(outline, protectedPromptUids) {
  if (!(protectedPromptUids instanceof Set)) return false;
  if (protectedPromptUids.has(outline?.uid)) return true;
  return (outline?.children || []).some(
    (child) => outlineContainsProtectedUid(child, protectedPromptUids)
  );
}
function resetChatPromptSnapshot(prompt, { rootBlockUid = null, scratchPrompt = false } = {}) {
  return scratchPrompt ? {
    uid: rootBlockUid,
    text: prompt?.rootOutline?.string,
    outline: prompt?.rootOutline
  } : prompt;
}
async function readFocusedPromptBlock(rootBlockUid, { api = getRoamApi() } = {}) {
  const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
  const focused = api.ui?.getFocusedBlock?.();
  if (!sidebarWindow?.["window-id"] || !validBlockUid(focused?.["block-uid"]) || focused["window-id"] !== sidebarWindow["window-id"]) {
    throw new Error("Focus the Roam block you want to send in the Block Outline.");
  }
  const uid = focused["block-uid"];
  const pattern = "[:block/uid :block/string {:block/children ...}]";
  const pull = api.data?.async?.pull ? await api.data.async.pull(pattern, [":block/uid", uid]) : api.data?.pull?.(pattern, [":block/uid", uid]);
  let rootPull = pull;
  if (uid !== rootBlockUid) {
    rootPull = api.data?.async?.pull ? await api.data.async.pull(pattern, [":block/uid", rootBlockUid]) : api.data?.pull?.(pattern, [":block/uid", rootBlockUid]);
  }
  let promptPull = pull;
  let text = normalizeChatPromptText(promptPull?.[":block/string"]);
  if (!text && rootPull) {
    const focusedPath = findChatPromptPath(rootPull, uid) || [];
    promptPull = focusedPath.slice(0, -1).reverse().find((block) => normalizeChatPromptText(block?.[":block/string"])) || promptPull;
    text = normalizeChatPromptText(promptPull?.[":block/string"]);
  }
  if (!text) {
    throw new Error("Write a message in this Roam outline before sending.");
  }
  return {
    uid: promptPull[":block/uid"],
    text,
    outline: snapshotChatPromptOutline(promptPull),
    rootOutline: snapshotChatPromptOutline(rootPull)
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
    if (!await pullUid(uid, api)) throw error;
  }
  return uid;
}
async function resolveChatPromptBlock(blockUid, {
  api = getRoamApi(),
  date = /* @__PURE__ */ new Date()
} = {}) {
  if (blockUid !== void 0 && blockUid !== null) {
    if (!validBlockUid(blockUid)) {
      throw new Error("Codex chat received an invalid Roam block UID.");
    }
    return { uid: blockUid, scratch: false };
  }
  const focusedBlockUid = api.ui?.getFocusedBlock?.()?.["block-uid"];
  if (validBlockUid(focusedBlockUid) && await pullUid(focusedBlockUid, api)) {
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
    block: { uid, string: CHAT_COMPOSER_PLACEHOLDER }
  });
  return { uid, scratch: true, parentUid };
}
async function removeScratchPromptBlock(blockUid, { api = getRoamApi() } = {}) {
  if (!validBlockUid(blockUid)) return;
  if (findSidebarBlockWindow(blockUid, { api })) {
    await api.ui.rightSidebar.removeWindow({
      window: { type: "block", "block-uid": blockUid }
    });
  }
  await api.data.block.delete({ block: { uid: blockUid } });
}
async function clearScratchPromptBlock(prompt, {
  api = getRoamApi(),
  protectedPromptUids = null,
  rootBlockUid = null,
  scratchPrompt = false
} = {}) {
  const resetPrompt = resetChatPromptSnapshot(prompt, {
    rootBlockUid,
    scratchPrompt
  });
  if (!validBlockUid(resetPrompt?.uid) || typeof resetPrompt?.text !== "string") {
    return false;
  }
  const pattern = "[:block/uid :block/string {:block/children ...}]";
  const pull = api.data?.async?.pull ? await api.data.async.pull(pattern, [":block/uid", resetPrompt.uid]) : api.data?.pull?.(pattern, [":block/uid", resetPrompt.uid]);
  const currentText = pull?.[":block/string"];
  if (typeof currentText !== "string" || normalizeChatPromptText(currentText) !== normalizeChatPromptText(resetPrompt.text)) {
    return false;
  }
  const currentOutline = snapshotChatPromptOutline(pull);
  if (resetPrompt.outline && !sameChatPromptOutline(currentOutline, resetPrompt.outline)) {
    return false;
  }
  await api.data.block.update({
    block: { uid: resetPrompt.uid, string: CHAT_COMPOSER_PLACEHOLDER }
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
    while (submittedIndex < submittedChildren.length && submittedChildren[submittedIndex].uid !== currentChild.uid) {
      submittedIndex += 1;
    }
    if (submittedIndex >= submittedChildren.length || !sameChatPromptOutline(
      currentChild,
      submittedChildren[submittedIndex]
    )) {
      return false;
    }
    submittedIndex += 1;
  }
  return true;
}
async function createChatPromptOutline(outline, parentUid, order, api) {
  await api.data.block.create({
    location: { "parent-uid": parentUid, order },
    block: { uid: outline.uid, string: outline.string }
  });
  for (const [childOrder, child] of outline.children.entries()) {
    await createChatPromptOutline(child, outline.uid, childOrder, api);
  }
}
async function restoreClearedChatPromptBlock(prompt, {
  api = getRoamApi(),
  rootBlockUid = null,
  scratchPrompt = false
} = {}) {
  const resetPrompt = resetChatPromptSnapshot(prompt, {
    rootBlockUid,
    scratchPrompt
  });
  if (!validBlockUid(resetPrompt?.uid) || !resetPrompt?.outline || resetPrompt.outline.uid !== resetPrompt.uid) {
    return false;
  }
  const pattern = "[:block/uid :block/string {:block/children ...}]";
  const pull = api.data?.async?.pull ? await api.data.async.pull(pattern, [":block/uid", resetPrompt.uid]) : api.data?.pull?.(pattern, [":block/uid", resetPrompt.uid]);
  if (!pull || normalizeChatPromptText(pull[":block/string"]) || pull[":block/uid"] !== resetPrompt.uid) {
    return false;
  }
  const currentOutline = snapshotChatPromptOutline(pull);
  if (!outlineIsOrderedSubset(
    currentOutline.children,
    resetPrompt.outline.children
  )) {
    return false;
  }
  const currentChildUids = new Set(
    currentOutline.children.map((child) => child.uid)
  );
  for (const [order, child] of resetPrompt.outline.children.entries()) {
    if (currentChildUids.has(child.uid)) continue;
    await createChatPromptOutline(child, resetPrompt.uid, order, api);
  }
  await api.data.block.update({
    block: {
      uid: resetPrompt.uid,
      string: resetPrompt.outline.string
    }
  });
  return true;
}
async function removeResetChatPromptBlocks(blockUids, { api = getRoamApi() } = {}) {
  const removed = [];
  if (!(blockUids instanceof Set)) return removed;
  for (const uid of blockUids) {
    if (!validBlockUid(uid)) continue;
    const pull = api.data?.async?.pull ? await api.data.async.pull(
      "[:block/uid :block/string]",
      [":block/uid", uid]
    ) : api.data?.pull?.(
      "[:block/uid :block/string]",
      [":block/uid", uid]
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
async function readPromptOutlineUids(rootBlockUid, { api = getRoamApi() } = {}) {
  if (!validBlockUid(rootBlockUid)) return /* @__PURE__ */ new Set();
  const pattern = "[:block/uid {:block/children ...}]";
  const outline = api.data?.async?.pull ? await api.data.async.pull(pattern, [":block/uid", rootBlockUid]) : api.data?.pull?.(pattern, [":block/uid", rootBlockUid]);
  const uids = /* @__PURE__ */ new Set();
  collectOutlineUids(outline, uids);
  return uids;
}
function shouldClearChatPrompt(promptUid, { scratchPrompt = false, protectedPromptUids = null } = {}) {
  return scratchPrompt || protectedPromptUids instanceof Set && !protectedPromptUids.has(promptUid);
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
  readOutlineUids = readPromptOutlineUids
} = {}) {
  const prompt = await resolvePromptBlock(blockUid, { api });
  const promptBlockUid = prompt.uid;
  let protectedPromptUids = /* @__PURE__ */ new Set();
  if (!prompt.scratch) {
    try {
      protectedPromptUids = await readOutlineUids(promptBlockUid, { api });
    } catch {
      protectedPromptUids = null;
    }
  }
  if (ACTIVE_CHAT_PANEL) {
    if (ACTIVE_CHAT_PANEL.element?.isConnected && ACTIVE_CHAT_PANEL.rootBlockUid === promptBlockUid) {
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
  let host2 = null;
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
    host2?.classList?.remove?.("roam-codex-chat-window");
    nativeHeader = null;
    nativeComposer = null;
    composerShell = null;
  };
  const mountControllerInHost = (nextHost) => {
    if (!nextHost || !controller) return false;
    releaseMountedHost();
    host2 = nextHost;
    host2.classList?.add?.("roam-codex-chat-window");
    nativeHeader = host2.firstElementChild || null;
    host2.insertBefore(
      controller.element,
      nativeHeader?.nextSibling || null
    );
    nativeHeader?.classList?.add?.(NATIVE_WINDOW_HEADER_CLASS);
    nativeComposer = controller.element.nextElementSibling || null;
    nativeComposer?.classList?.add?.(NATIVE_COMPOSER_CLASS);
    if (nativeComposer && typeof doc.createElement === "function") {
      composerShell = doc.createElement("div");
      composerShell.className = "roam-codex-chat-composer-shell";
      host2.insertBefore(composerShell, nativeComposer);
      composerShell.appendChild(nativeComposer);
      composerShell.appendChild(controller.controlsElement);
    } else {
      host2.appendChild(controller.controlsElement);
    }
    if (controller.headerElement) {
      const launcherPlacement = findSidebarChatLauncherPlacement(doc);
      const launcher = doc.getElementById?.(SIDEBAR_CHAT_LAUNCHER_ID);
      if (launcherPlacement?.header && launcher?.parentNode === launcherPlacement.header) {
        launcherPlacement.header.insertBefore(
          controller.headerElement,
          launcher.nextSibling || null
        );
      } else {
        host2.insertBefore(controller.headerElement, controller.element);
      }
    }
    return true;
  };
  try {
    const sidebarWindow = await openPromptBlock(
      promptBlockUid,
      { api, waitOptions }
    );
    host2 = await waitForChatPanelHost(doc, sidebarWindow, waitOptions);
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
        return whenIdle().then(() => prompt.scratch ? removeScratchPrompt(promptBlockUid, { api }) : removeResetPrompts(resetPromptUids, { api })).catch((error) => {
          notify(
            `The temporary Codex composer could not be removed: ${error.message}`,
            "warning"
          );
        });
      }
    });
    mountControllerInHost(host2);
    ACTIVE_CHAT_PANEL = controller;
    const MutationObserverImpl = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
    const observationRoot = doc.body || doc.documentElement || host2.parentNode;
    if (MutationObserverImpl && observationRoot) {
      nativeWindowObserver = new MutationObserverImpl(() => {
        if (host2?.isConnected && controller.element?.isConnected) return;
        if (disconnectedHostTimer !== null) return;
        disconnectedHostTimer = globalThis.setTimeout(() => {
          disconnectedHostTimer = null;
          if (host2?.isConnected && controller.element?.isConnected) return;
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
        subtree: true
      });
    }
    try {
      void Promise.resolve(controller.focus()).catch(() => {
      });
    } catch {
    }
    return controller;
  } catch (error) {
    if (controller) {
      await controller.close();
    } else if (prompt.scratch) {
      try {
        await removeScratchPrompt(promptBlockUid, { api });
      } catch {
      }
    }
    throw error;
  }
}
function openChatPanel(options = {}) {
  if (CHAT_PANEL_OPEN_PROMISE) return CHAT_PANEL_OPEN_PROMISE;
  const opening = openChatPanelInternal(options);
  const tracked = opening.finally(() => {
    if (CHAT_PANEL_OPEN_PROMISE === tracked) CHAT_PANEL_OPEN_PROMISE = null;
  });
  CHAT_PANEL_OPEN_PROMISE = tracked;
  return tracked;
}
function closeChatPanel() {
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
function toggleChatPanel() {
  if (CHAT_PANEL_OPEN_PROMISE) return CHAT_PANEL_OPEN_PROMISE;
  if (CHAT_PANEL_CLOSE_PROMISE) return CHAT_PANEL_CLOSE_PROMISE;
  return activeChatPanelIsOpen() ? closeChatPanel() : openChatPanel();
}
function installChatToggleHotkey({
  doc = globalThis.document,
  toggleImpl = toggleChatPanel,
  notifyImpl = notify
} = {}) {
  if (!doc?.addEventListener) return () => {
  };
  const runtime = doc.defaultView || globalThis;
  runtime[CHAT_TOGGLE_HOTKEY_KEY]?.();
  let disposed = false;
  const handleKeydown = (event) => {
    if (disposed || event.defaultPrevented || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || String(event.key).toLowerCase() !== "j") {
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
function sendActiveChatMessage({
  api = getRoamApi(),
  panel = ACTIVE_CHAT_PANEL
} = {}) {
  if (!panel?.element?.isConnected) return null;
  const focused = api.ui?.getFocusedBlock?.();
  const sidebarWindow = findSidebarBlockWindow(panel.rootBlockUid, { api });
  if (!focused?.["window-id"] || focused["window-id"] !== sidebarWindow?.["window-id"]) {
    return null;
  }
  return panel.send();
}
async function pairBridge({
  fetchImpl = window.fetch.bind(window),
  storage = window.localStorage
} = {}) {
  const response = await fetchImpl(`${BRIDGE_URL}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ graph: GRAPH })
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
  }
  if (!response.ok || typeof result.token !== "string") {
    throw new Error(
      result.error || `Bridge pairing returned HTTP ${response.status}.`
    );
  }
  if (result.graph !== GRAPH) {
    throw new Error(`Bridge is connected to graph "${result.graph}".`);
  }
  storage.setItem(TOKEN_KEY, result.token);
  notify("Local bridge paired on this device.", "success");
  return result;
}
async function checkBridge({
  fetchImpl = window.fetch.bind(window)
} = {}) {
  try {
    const response = await fetchImpl(`${BRIDGE_URL}/health`);
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    notify(
      `Bridge is ${result.appServer}; graph is ${result.graph}.`,
      "success"
    );
    return result;
  } catch (error) {
    notify(`Bridge unavailable: ${error.message}`, "danger");
    throw error;
  }
}
var core_default = {
  onload: ({ extensionAPI }) => {
    cleanupStaleChatUi();
    ACTIVE_CHAT_PANEL = null;
    CHAT_PANEL_OPEN_PROMISE = null;
    CHAT_PANEL_CLOSE_PROMISE = null;
    void cleanupStaleRunningStatuses().catch((error) => {
      notify(
        `A stale Codex running indicator could not be removed: ${error.message}`,
        "warning"
      );
    });
    const workFromSlashCommand = (context) => {
      void workOnBlock(context["block-uid"]).catch(() => {
      });
      return "";
    };
    const workFromCommandPalette = () => {
      const focused = getRoamApi().ui.getFocusedBlock();
      void workOnBlock(focused?.["block-uid"]).catch(() => {
      });
    };
    const openChat = () => openChatPanel();
    SIDEBAR_CHAT_LAUNCHER?.dispose?.();
    SIDEBAR_CHAT_LAUNCHER = installSidebarChatLauncher({
      openChatImpl: openChat
    });
    CHAT_TOGGLE_HOTKEY_DISPOSE?.();
    CHAT_TOGGLE_HOTKEY_DISPOSE = installChatToggleHotkey();
    extensionAPI.ui.commandPalette.addCommand({
      label: "Codex: Send chat message",
      "default-hotkey": "alt-enter",
      callback: () => {
        void sendActiveChatMessage();
      }
    });
    extensionAPI.ui.commandPalette.addCommand({
      label: "Codex: Toggle chat",
      "disable-hotkey": true,
      callback: () => {
        void toggleChatPanel().catch((error) => {
          notify(`Codex chat could not toggle: ${error.message}`, "danger");
        });
      }
    });
    extensionAPI.ui.commandPalette.addCommand({
      label: "Codex: Open chat",
      callback: () => {
        void openChat().catch((error) => {
          notify(`Codex chat could not open: ${error.message}`, "danger");
        });
      }
    });
    extensionAPI.ui.slashCommand.addCommand({
      label: "Codex: Do this block",
      callback: workFromSlashCommand
    });
    extensionAPI.ui.commandPalette.addCommand({
      label: "Codex: Do this block",
      callback: workFromCommandPalette
    });
    extensionAPI.ui.commandPalette.addCommand({
      label: "Codex: Pair local bridge",
      "disable-hotkey": true,
      callback: () => {
        void pairBridge().catch((error) => {
          notify(`Bridge pairing failed: ${error.message}`, "danger");
        });
      }
    });
    extensionAPI.ui.commandPalette.addCommand({
      label: "Codex: Check local bridge",
      "disable-hotkey": true,
      callback: () => void checkBridge()
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
  }
};
export {
  CHAT_COMPOSER_PLACEHOLDER,
  CHAT_CONTROLS_ID,
  CHAT_PANEL_CLASS,
  CHAT_PANEL_ID,
  CHAT_SCROLL_BOTTOM_THRESHOLD,
  CHAT_TRANSCRIPT_HEIGHT_KEY,
  CHAT_TRANSCRIPT_MAX_HEIGHT,
  CHAT_TRANSCRIPT_MIN_HEIGHT,
  RUNNING_BLOCK_TEXT,
  applyRunPlan,
  buildConversationHistory,
  checkBridge,
  cleanupStaleChatUi,
  cleanupStaleRunningStatuses,
  clearScratchPromptBlock,
  closeChatPanel,
  conversationDateLabel,
  copyRoamText,
  createChatPanel,
  createPanelElement,
  createRunningStatus,
  core_default as default,
  effortLabel,
  ensureGraphThreadRecord,
  findChatPanelHost,
  findSidebarBlockWindow,
  findSidebarChatLauncherPlacement,
  formatRunningElapsed,
  getRoamApi,
  installChatToggleHotkey,
  installSidebarChatLauncher,
  modelEfforts,
  modelTierChoices,
  mountSidebarChatLauncher,
  normalizeChatPromptText,
  openChatPanel,
  openPromptBlockInSidebar,
  pairBridge,
  panelButton,
  readChatState,
  readFocusedPromptBlock,
  readGraphThreadIndex,
  readProbeStream,
  readPromptOutlineUids,
  removeResetChatPromptBlocks,
  removeRunningStatus,
  removeScratchPromptBlock,
  renderRoamMarkdown,
  requestPanelChat,
  requestPanelMessages,
  requestPanelModels,
  requestPanelThreadName,
  requestPanelThreadSummaries,
  requestProbe,
  requestRunCancellation,
  resolveChatPromptBlock,
  restoreClearedChatPromptBlock,
  runningPresentationText,
  sendActiveChatMessage,
  serverTimestampMs,
  shouldClearChatPrompt,
  singleLine,
  startRunningPresentation,
  stopAllRunningPresentations,
  threadPageLabel,
  toggleChatPanel,
  unmountRoamMarkdown,
  updateGraphThreadActivity,
  validBlockUid,
  validThreadId,
  workOnBlock,
  writeChatState
};
