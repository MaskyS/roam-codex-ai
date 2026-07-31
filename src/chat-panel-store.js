import {
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
  readChatState,
  writeChatState,
  buildConversationHistory,
  requestPanelChat,
  requestPanelModels,
  requestPanelMessages,
  requestPanelThreadSummaries,
  requestPanelThreadName,
  readGraphThreadIndex,
  ensureGraphThreadRecord,
  updateGraphThreadActivity,
  copyRoamText,
  readFocusedPromptBlock,
  clearScratchPromptBlock,
  restoreClearedChatPromptBlock,
  requestRunCancellation,
  findSidebarBlockWindow,
  shouldClearChatPrompt,
  CHAT_TRANSCRIPT_HEIGHT_KEY,
  CHAT_TRANSCRIPT_MIN_HEIGHT,
  CHAT_TRANSCRIPT_MAX_HEIGHT,
} from "./core.js";

// All chat-panel behavior lives here, framework-free. React components read
// getSnapshot() and call the action methods; every mutation bumps version and
// notifies subscribers. The store never touches panel DOM.
export function createChatPanelStore({
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
  updateGraphActivityImpl = (record, timestamp) =>
    updateGraphThreadActivity(record, timestamp, { api }),
  copyTextImpl = copyRoamText,
  navigatorImpl = globalThis.navigator,
  readPromptImpl,
  clearScratchPromptImpl,
  restorePromptImpl,
  cancelRequest = requestRunCancellation,
  protectedPromptUids = null,
  scratchPrompt = false,
  now = Date.now,
  onClose = () => {},
} = {}) {
  if (!validBlockUid(rootBlockUid)) {
    throw new Error("The Codex chat panel requires a Roam block.");
  }
  const readPrompt = readPromptImpl ||
    (() => readFocusedPromptBlock(rootBlockUid, { api }));
  const clearScratchPrompt = clearScratchPromptImpl ||
    ((prompt) => clearScratchPromptBlock(prompt, {
      api,
      protectedPromptUids,
      rootBlockUid,
      scratchPrompt,
    }));
  const restorePrompt = restorePromptImpl ||
    ((prompt) => restoreClearedChatPromptBlock(prompt, {
      api,
      rootBlockUid,
      scratchPrompt,
    }));
  const ensureGraphThread = ensureGraphThreadImpl ||
    ((input) => ensureGraphThreadRecord({ ...input, api, storage }));

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
  const resetPromptUids = new Set();
  const threadSummaries = new Map();
  const graphThreadRecords = new Map();
  const threadIndexPromises = new Map();
  const mirroredThreadNames = new Set();
  let historyOpen = false;
  let historyLoadVersion = 0;
  let selectionLoadVersion = 0;
  let historyError = "";
  let progressTextValue = "";
  let progressKind = "";
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
  let pickerOpen = false;
  let pickerLevel = null;

  const clampTranscriptHeight = (value) => Math.min(
    CHAT_TRANSCRIPT_MAX_HEIGHT,
    Math.max(CHAT_TRANSCRIPT_MIN_HEIGHT, Math.round(value)),
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
  let transcriptHeight = readStoredTranscriptHeight() ??
    CHAT_TRANSCRIPT_MAX_HEIGHT;

  const listeners = new Set();
  let version = 0;
  let snapshot = null;
  const emit = () => {
    version += 1;
    snapshot = null;
    for (const listener of [...listeners]) listener();
  };

  const persist = () => writeChatState(state, { storage });
  const currentRecord = () => state.activeThreadId
    ? state.conversations[state.activeThreadId]
    : null;
  const currentPreferences = () =>
    currentRecord() || state.newConversationPreferences;

  const sendShortcutIsMac = /Mac|iP(?:hone|ad|od)/i.test(
    navigatorImpl?.platform || navigatorImpl?.userAgent || "",
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
      lastSeenUpdatedAt: completed
        ? Math.max(previous?.lastSeenUpdatedAt || 0, timestamp)
        : previous?.lastSeenUpdatedAt || 0,
      availability: "available",
      pendingGraphIndex: previous?.pendingGraphIndex || false,
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
        graphRecord.createdAt || 0,
      ),
      model: previous.model || null,
      effort: previous.effort || null,
      speed: previous.speed || null,
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
            graphRecord = await ensureGraphThread({
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
  };

  const pickerLabel = () => {
    if (!modelsReady) return modelsError ? "Models unavailable" : "Loading models…";
    if (!models.length) return "No models available";
    const selected = currentModelEntry();
    const parts = [selected?.displayName || selected?.id || "Model"];
    if (pickerEffort) parts.push(effortLabel(pickerEffort));
    const tier = modelTierChoices(selected).find(
      (entry) => entry.id === pickerSpeed,
    );
    if (tier && tier.id !== defaultTierIdFor(selected)) {
      parts.push(tier.name || tier.id);
    }
    return parts.join(" · ");
  };

  const historyItems = () => buildConversationHistory(
    state,
    [...threadSummaries.values()],
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
      progressTextValue =
        "Unavailable on this device. The graph thread record was kept.";
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
      progressTextValue = "";
      progressKind = "";
      emit();
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
          "error",
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
        composerCleared = await clearScratchPrompt(prompt);
      } catch (error) {
        try {
          await restorePrompt(prompt);
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
          void ensureThreadIndexed(threadId, prompt.text).catch(() => {});
          modelChanged = false;
          effortChanged = false;
          speedChanged = false;
        },
        onProgress: ({ kind, text }) => {
          setProgress(text, kind);
        },
      });

      const completedAt = now();
      rememberThread(result.threadId, { completed: true });
      await ensureThreadIndexed(result.threadId, prompt.text, {
        completedAt,
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
        preview: startingNewConversation
          ? prompt.text
          : existingSummary.preview || "",
        createdAt: existingSummary.createdAt || completedAt,
        updatedAt: completedAt,
        status: "idle",
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
      runId = null;
      setRunning(false);
    }
  };

  const stop = () => {
    if (!runId) return Promise.resolve();
    setProgress("Stopping", "activity");
    return cancelRequest(runId).catch((error) => {
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
      resetPromptUids,
    }));
    return closePromise;
  };

  const maybeSendFromShortcut = () => {
    const focused = api.ui?.getFocusedBlock?.();
    const sidebarWindow = findSidebarBlockWindow(rootBlockUid, { api });
    if (
      !focused?.["window-id"] ||
      focused["window-id"] !== sidebarWindow?.["window-id"]
    ) {
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
        "window-id": sidebarWindow["window-id"],
      },
    });
  };

  const getSnapshot = () => {
    if (snapshot) return snapshot;
    const selected = currentModelEntry();
    const tiers = modelTierChoices(selected);
    const currentTier = tiers.find((tier) => tier.id === pickerSpeed);
    snapshot = {
      version,
      closed,
      messages,
      running,
      runStartedAt,
      modelsReady,
      models,
      progress: { text: progressTextValue, kind: progressKind },
      picker: {
        open: pickerOpen,
        level: pickerLevel,
        label: pickerLabel(),
        modelId: pickerModel,
        effortId: pickerEffort,
        speedId: pickerSpeed,
        selectedModel: selected,
        efforts: modelEfforts(selected),
        defaultEffort: modelEfforts(selected).includes(
          selected?.defaultReasoningEffort,
        )
          ? selected.defaultReasoningEffort
          : null,
        tiers,
        defaultTierId: defaultTierIdFor(selected),
        currentTier: currentTier || null,
      },
      history: {
        open: historyOpen,
        error: historyError,
        items: historyItems(),
        activeThreadId: state.activeThreadId,
      },
      conversationLabel: conversationLabel(),
      transcriptHeight,
      sendShortcutIsMac,
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
    conversationDateLabel,
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
    pickModel(modelId) {
      if (modelId !== pickerModel) {
        pickerModel = modelId;
        modelChanged = true;
        effortChanged = true;
        speedChanged = true;
        const next = currentModelEntry();
        const efforts = modelEfforts(next);
        if (!efforts.includes(pickerEffort)) {
          const defaultEffort = efforts.includes(next?.defaultReasoningEffort)
            ? next.defaultReasoningEffort
            : null;
          pickerEffort = defaultEffort || efforts[0] || "";
        }
        if (!modelTierChoices(next).some((tier) => tier.id === pickerSpeed)) {
          pickerSpeed = defaultTierIdFor(next);
        }
        savePreferences();
      }
      closePicker();
    },
    pickEffort(effort) {
      if (effort !== pickerEffort) {
        pickerEffort = effort;
        effortChanged = true;
        savePreferences();
      }
      closePicker();
    },
    pickSpeed(tierId) {
      if (tierId !== pickerSpeed) {
        pickerSpeed = tierId;
        speedChanged = true;
        savePreferences();
      }
      closePicker();
    },
    setTranscriptHeight(height) {
      transcriptHeight = clampTranscriptHeight(height);
      emit();
    },
    persistTranscriptHeight() {
      try {
        storage.setItem(CHAT_TRANSCRIPT_HEIGHT_KEY, String(transcriptHeight));
      } catch {
        // A device that cannot persist the height still keeps this session's.
      }
    },
    loadModels() {
      return requestModelsImpl()
        .then((availableModels) => {
          if (closed) return;
          models = Array.isArray(availableModels) ? availableModels : [];
          modelsReady = true;
          initPicker();
          emit();
        })
        .catch((error) => {
          if (closed) return;
          modelsError = error.message || "Could not load Codex models.";
          setProgress(error.message, "error");
        });
    },
    loadInitialConversation() {
      const initialThreadId = state.activeThreadId;
      return loadHistory().then(() => {
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
    },
  };
}
