import {
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
  formatRunningElapsed,
  renderRoamMarkdown,
  unmountRoamMarkdown,
  findSidebarBlockWindow,
  shouldClearChatPrompt,
  CHAT_PANEL_ID,
  CHAT_CONTROLS_ID,
  CHAT_PANEL_CLASS,
  CHAT_TRANSCRIPT_HEIGHT_KEY,
  CHAT_TRANSCRIPT_MIN_HEIGHT,
  CHAT_TRANSCRIPT_MAX_HEIGHT,
  CHAT_SCROLL_BOTTOM_THRESHOLD,
} from "./core.js";

export function createChatPanel({
  doc = globalThis.document,
  storage = window.localStorage,
  api = getRoamApi(),
  rootBlockUid,
  requestChatImpl = requestPanelChat,
  requestModelsImpl = requestPanelModels,
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
  let pickerOpen = false;
  let pickerLevel = null;
  let messageRenderVersion = 0;
  const renderedMessageNodes = new Set();
  const copyFeedbackTimers = new Map();

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
  transcriptHandle.hidden = true;
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
  transcript.appendChild(progress);

  const syncTranscriptStatus = ({ scroll = false } = {}) => {
    if (progress.parentNode !== transcript) transcript.appendChild(progress);
    transcript.hidden = !messages.length && progress.hidden;
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
    "Choose the model, reasoning effort, and speed",
  );
  pickerButton.setAttribute("aria-label", "Model, effort, and speed");
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
  pickerMenu.setAttribute("aria-label", "Model, effort, and speed options");
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
    sendShortcutIsMac ? "⌥⏎" : "Alt ⏎",
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
    transcriptHandle.hidden = !messages.length;
    if (!messages.length) {
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

  const renderPickerButton = () => {
    if (!modelsReady) return;
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
    selectionLoadVersion += 1;
    state.activeThreadId = null;
    state.newConversationPreferences = { model, effort, speed };
    messages = [];
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
