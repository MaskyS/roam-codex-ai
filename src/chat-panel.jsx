import { React, ReactDOM, assertReactAvailable } from "./react-globals.js";
import { createChatPanelStore } from "./chat-panel-store.js";
import {
  getRoamApi,
  renderRoamMarkdown,
  unmountRoamMarkdown,
  formatRunningElapsed,
  conversationDateLabel,
  effortLabel,
  CHAT_PANEL_ID,
  CHAT_CONTROLS_ID,
  CHAT_PANEL_CLASS,
  CHAT_SCROLL_BOTTOM_THRESHOLD,
} from "./core.js";

// Lazy delegates so importing this module never touches window.React; the
// shell asserts availability before any component renders.
const useState = (...args) => React.useState(...args);
const useEffect = (...args) => React.useEffect(...args);
const useRef = (...args) => React.useRef(...args);

function useStoreSnapshot(store) {
  const [snapshot, setSnapshot] = useState(store.getSnapshot);
  useEffect(
    () => store.subscribe(() => setSnapshot(store.getSnapshot())),
    [store],
  );
  return snapshot;
}

// Owns Roam's renderString/unmountNode lifecycle for one immutable string.
function RoamString({ api, text, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
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
  return <div className={className} ref={ref} />;
}

function CopyButton({
  copyText,
  roleLabel,
  text,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  const [copyState, setCopyState] = useState("idle");
  const timerRef = useRef(null);
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeoutImpl(timerRef.current);
  }, [clearTimeoutImpl]);

  const idleLabel = `Copy ${roleLabel} message as Roam text`;
  const title = copyState === "copied"
    ? "Copied"
    : copyState === "error"
      ? "Could not copy Roam text"
      : "Copy Roam text";
  const ariaLabel = copyState === "copied"
    ? "Copied Roam text"
    : copyState === "error"
      ? "Could not copy Roam text"
      : idleLabel;

  const onClick = async (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (timerRef.current !== null) clearTimeoutImpl(timerRef.current);
    timerRef.current = null;
    setCopyState("copying");
    let next;
    try {
      await copyText(text);
      next = "copied";
    } catch {
      next = "error";
    }
    setCopyState(next);
    timerRef.current = setTimeoutImpl(() => {
      timerRef.current = null;
      setCopyState("idle");
    }, 1_400);
  };

  return (
    <button
      type="button"
      className="roam-codex-chat-copy"
      data-state={copyState}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
    />
  );
}

function ProgressRow({ snapshot, now, setIntervalImpl, clearIntervalImpl }) {
  const { running, runStartedAt, progress } = snapshot;
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    setElapsedMs(0);
    if (!setIntervalImpl || !clearIntervalImpl) return undefined;
    const intervalId = setIntervalImpl(() => {
      setElapsedMs(now() - runStartedAt);
    }, 1000);
    return () => clearIntervalImpl(intervalId);
  }, [running, runStartedAt, now, setIntervalImpl, clearIntervalImpl]);

  const hidden = !progress.text && !running;
  return (
    <div
      className="roam-codex-chat-progress"
      aria-live="polite"
      data-kind={progress.kind}
      hidden={hidden}
    >
      <span className="roam-codex-chat-progress-meta" hidden={!running}>
        <span className="roam-codex-chat-progress-timer">
          {formatRunningElapsed(running ? elapsedMs : 0)}
        </span>
      </span>
      <span className="roam-codex-chat-progress-text">{progress.text}</span>
    </div>
  );
}

function Transcript({
  snapshot,
  store,
  api,
  matchMediaImpl,
  setTimeoutImpl,
  clearTimeoutImpl,
  setIntervalImpl,
  clearIntervalImpl,
  transcriptRef,
}) {
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
    const distanceFromBottom = Math.max(
      0,
      scrollHeight - clientHeight - scrollTop,
    );
    setShowLatest(
      messages.length > 0 &&
      overflowing &&
      distanceFromBottom > CHAT_SCROLL_BOTTOM_THRESHOLD,
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
      matchMediaImpl?.("(prefers-reduced-motion: reduce)")?.matches,
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
    maxHeight: `${transcriptHeight}px`,
  };
  const transcriptHidden = !messages.length && !progressVisible;

  return (
    <div className="roam-codex-chat-transcript-wrap">
      <div
        className="roam-codex-chat-transcript"
        role="log"
        aria-live="polite"
        ref={transcriptRef}
        hidden={transcriptHidden}
        style={heightStyle}
        onScroll={measureLatest}
      >
        {messages.map((message, index) => {
          if (!message || !["user", "assistant"].includes(message.role)) {
            return null;
          }
          const roleLabel = message.role === "user" ? "You" : "Codex";
          return (
            <article
              key={`${index}-${message.role}`}
              className={`roam-codex-chat-message roam-codex-chat-message-${message.role}`}
            >
              <CopyButton
                copyText={store.copyText}
                roleLabel={roleLabel}
                text={message.text}
                setTimeoutImpl={setTimeoutImpl}
                clearTimeoutImpl={clearTimeoutImpl}
              />
              <RoamString
                api={api}
                text={message.text}
                className="roam-codex-chat-message-text"
              />
            </article>
          );
        })}
        <ProgressRow
          snapshot={snapshot}
          now={store.now}
          setIntervalImpl={setIntervalImpl}
          clearIntervalImpl={clearIntervalImpl}
        />
      </div>
      <button
        type="button"
        className="roam-codex-chat-scroll-latest"
        title="Scroll to latest message"
        aria-label="Scroll to latest message"
        hidden={!showLatest}
        onClick={scrollToLatest}
      >
        <span className="roam-codex-chat-scroll-latest-icon" aria-hidden="true">
          ↓
        </span>
      </button>
    </div>
  );
}

function ResizeHandle({ snapshot, store, doc, transcriptRef }) {
  const dragRef = useRef(null);
  useEffect(() => () => {
    if (dragRef.current) dragRef.current.stop();
  }, []);

  const onPointerDown = (event) => {
    if (!Number.isFinite(event?.clientY)) return;
    const measured = transcriptRef.current?.getBoundingClientRect?.()?.height;
    const startHeight = Number.isFinite(measured) && measured > 0
      ? measured
      : snapshot.transcriptHeight;
    const startY = event.clientY;
    const onMove = (moveEvent) => {
      if (!Number.isFinite(moveEvent?.clientY)) return;
      store.setTranscriptHeight(startHeight + (moveEvent.clientY - startY));
      moveEvent.preventDefault?.();
    };
    const stop = () => {
      dragRef.current = null;
      doc.removeEventListener?.("pointermove", onMove, true);
      doc.removeEventListener?.("pointerup", stop, true);
      store.persistTranscriptHeight();
    };
    dragRef.current = { stop };
    doc.addEventListener?.("pointermove", onMove, true);
    doc.addEventListener?.("pointerup", stop, true);
    event.preventDefault?.();
  };

  return (
    <div
      className="roam-codex-chat-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the conversation area"
      hidden={!snapshot.messages.length}
      onPointerDown={onPointerDown}
    />
  );
}

function PickerMenu({ snapshot, store }) {
  const { picker, models } = snapshot;
  const rows = [
    [
      "Model",
      picker.selectedModel?.displayName || picker.selectedModel?.id || "—",
      "model",
    ],
    ["Effort", picker.effortId ? effortLabel(picker.effortId) : "—", "effort"],
  ];
  if (picker.tiers.length) {
    rows.push([
      "Speed",
      picker.currentTier?.name || picker.currentTier?.id || "—",
      "speed",
    ]);
  }

  const option = (label, active, onPick, description = "") => (
    <button
      key={label}
      type="button"
      className={`roam-codex-chat-picker-option${active ? " is-active" : ""}`}
      role="menuitemradio"
      aria-checked={active}
      title={description}
      onClick={() => onPick()}
    >
      <span className="roam-codex-chat-picker-option-label">{label}</span>
      {description
        ? (
          <span className="roam-codex-chat-picker-option-description">
            {description}
          </span>
        )
        : null}
    </button>
  );

  let submenuOptions = null;
  if (picker.level === "model") {
    submenuOptions = models
      .filter((model) => model && typeof model.id === "string")
      .map((model) => {
        const displayName = model.displayName || model.id;
        return option(
          model.isDefault ? `${displayName} (Default)` : displayName,
          model.id === picker.modelId,
          () => store.pickModel(model.id),
          model.description || "",
        );
      });
  } else if (picker.level === "effort") {
    submenuOptions = picker.efforts.map((effort) =>
      option(
        effort === picker.defaultEffort
          ? `${effortLabel(effort)} (Default)`
          : effortLabel(effort),
        effort === picker.effortId,
        () => store.pickEffort(effort),
        picker.selectedModel?.supportedReasoningEfforts?.find(
          (entry) => entry?.reasoningEffort === effort,
        )?.description || "",
      )
    );
  } else if (picker.level === "speed") {
    submenuOptions = picker.tiers.map((tier) => {
      const name = tier.name || tier.id;
      return option(
        tier.id === picker.defaultTierId ? `${name} (Default)` : name,
        tier.id === picker.speedId,
        () => store.pickSpeed(tier.id),
        tier.description || "",
      );
    });
  }

  return (
    <>
      <div
        className="roam-codex-chat-picker-menu"
        role="menu"
        aria-label="Model, effort, and speed options"
        hidden={!picker.open}
      >
        {rows.map(([label, value, level]) => {
          const open = picker.level === level;
          const openLevel = () => store.openPickerLevel(level);
          return (
            <button
              key={level}
              type="button"
              className={`roam-codex-chat-picker-item${open ? " is-open" : ""}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open}
              data-level={level}
              title={`Choose ${label.toLowerCase()}`}
              onMouseEnter={openLevel}
              onFocus={openLevel}
              onClick={openLevel}
              onKeyDown={(event) => {
                if (!["ArrowRight", "Enter", " "].includes(event.key)) return;
                event.preventDefault?.();
                openLevel();
              }}
            >
              <span className="roam-codex-chat-picker-item-label">{label}</span>
              <span className="roam-codex-chat-picker-item-value">{value}</span>
              <span
                className="roam-codex-chat-picker-item-chevron"
                aria-hidden="true"
              >
                ›
              </span>
            </button>
          );
        })}
      </div>
      <div
        className="roam-codex-chat-picker-submenu"
        role="menu"
        aria-label={picker.level ? `${effortLabel(picker.level)} options` : ""}
        hidden={!picker.open || !picker.level}
      >
        {submenuOptions}
      </div>
    </>
  );
}

function ControlsBar({ snapshot, store, pickerWrapRef }) {
  const { running, modelsReady, picker, sendShortcutIsMac } = snapshot;
  return (
    <div className="roam-codex-chat-model-row">
      <div className="roam-codex-chat-picker" ref={pickerWrapRef}>
        <button
          type="button"
          className="roam-codex-chat-picker-button"
          title="Choose the model, reasoning effort, and speed"
          aria-label="Model, effort, and speed"
          aria-haspopup="menu"
          aria-expanded={picker.open}
          disabled={running || !modelsReady}
          onClick={() => store.togglePicker()}
        >
          {picker.label}
        </button>
        <PickerMenu snapshot={snapshot} store={store} />
      </div>
      <div className="roam-codex-chat-actions">
        <button
          type="button"
          className="roam-codex-chat-stop"
          title="Stop the current Codex turn"
          hidden={!running}
          onClick={(event) => {
            event.currentTarget.disabled = true;
            void store.stop().catch(() => {
              // The store surfaces the failure in the progress row.
            });
          }}
        >
          Stop
        </button>
        <button
          type="button"
          className="roam-codex-chat-send"
          title={`Send the focused block in this chat's Block Outline (${
            sendShortcutIsMac ? "Option" : "Alt"
          }+Enter, rebindable in Settings → Hotkeys)`}
          hidden={running}
          disabled={running || !modelsReady}
          onMouseDown={(event) => {
            // Keep Roam's native block editor focused until send() snapshots it.
            event.preventDefault?.();
          }}
          onClick={() => void store.send()}
        >
          Send
          <kbd className="roam-codex-chat-send-kbd" aria-hidden="true">
            {sendShortcutIsMac ? "⌥⏎" : "Alt ⏎"}
          </kbd>
        </button>
      </div>
    </div>
  );
}

function HeaderContent({ snapshot, store, onCloseRequested }) {
  const { running, history, conversationLabel } = snapshot;
  return (
    <div className="roam-codex-chat-heading">
      <button
        type="button"
        className="roam-codex-chat-conversation"
        aria-haspopup="menu"
        aria-expanded={history.open}
        disabled={running}
        title={history.activeThreadId
          ? `Current conversation: ${conversationLabel}`
          : "Start a new conversation or open history"}
        onClick={() => {
          if (running) return;
          if (history.open) store.closeHistory();
          else store.openHistory();
        }}
      >
        {conversationLabel}
      </button>
      <div
        className="roam-codex-chat-history"
        role="menu"
        aria-label="Conversation history"
        hidden={!history.open}
      >
        <button
          type="button"
          role="menuitem"
          className={`roam-codex-chat-history-item roam-codex-chat-history-new${
            history.activeThreadId ? "" : " is-active"
          }`}
          aria-current={history.activeThreadId ? undefined : "true"}
          title="Start a new conversation"
          disabled={running}
          onClick={() => store.beginNewConversation()}
        >
          + New chat
        </button>
        {history.items.length
          ? history.items.map((item) => (
            <button
              key={item.threadId}
              type="button"
              role="menuitem"
              className={`roam-codex-chat-history-item${
                item.active ? " is-active" : ""
              }`}
              aria-current={item.active ? "true" : undefined}
              data-thread-id={item.threadId}
              data-availability={item.availability}
              title={`Resume ${item.title}`}
              disabled={running}
              onClick={() => store.selectConversation(item.threadId)}
            >
              <span className="roam-codex-chat-history-title">
                {item.title}
              </span>
              <span className="roam-codex-chat-history-date">
                {["missing", "unavailable"].includes(item.availability)
                  ? "Unavailable"
                  : conversationDateLabel(item.updatedAt)}
              </span>
            </button>
          ))
          : (
            <div className="roam-codex-chat-history-empty">
              {history.error || "No previous chats yet."}
            </div>
          )}
        {history.items.length && history.error
          ? <div className="roam-codex-chat-history-error">{history.error}</div>
          : null}
      </div>
      <button
        type="button"
        className="roam-codex-chat-close"
        title="Close Codex chat"
        aria-label="Close Codex chat"
        onClick={onCloseRequested}
      >
        ✕
      </button>
    </div>
  );
}

function ChatPanelRoot({
  store,
  doc,
  api,
  headerEl,
  controlsEl,
  matchMediaImpl,
  setTimeoutImpl,
  clearTimeoutImpl,
  setIntervalImpl,
  clearIntervalImpl,
  onCloseRequested,
}) {
  const snapshot = useStoreSnapshot(store);
  const transcriptRef = useRef(null);
  const pickerWrapRef = useRef(null);
  const headerElRef = useRef(headerEl);

  useEffect(() => {
    void store.loadModels();
    void store.loadInitialConversation();
  }, [store]);

  useEffect(() => {
    const handleKeydown = (event) => {
      const current = store.getSnapshot();
      if (
        !event.defaultPrevented &&
        event.key === "Escape" &&
        (current.history.open || current.picker.open)
      ) {
        event.preventDefault();
        event.stopPropagation?.();
        if (current.history.open) store.closeHistory();
        if (current.picker.open) store.closePicker();
        return;
      }
      if (
        !event.defaultPrevented &&
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        event.key === "Enter"
      ) {
        if (store.maybeSendFromShortcut()) {
          event.preventDefault();
          event.stopPropagation?.();
        }
      }
    };
    const handleClick = (event) => {
      const current = store.getSnapshot();
      if (
        current.history.open &&
        !headerElRef.current?.contains?.(event.target)
      ) {
        store.closeHistory();
      }
      if (
        current.picker.open &&
        !pickerWrapRef.current?.contains?.(event.target)
      ) {
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
  }, [store, doc]);

  return (
    <>
      {ReactDOM.createPortal(
        <HeaderContent
          snapshot={snapshot}
          store={store}
          onCloseRequested={onCloseRequested}
        />,
        headerEl,
      )}
      <div className="roam-codex-chat-body">
        <Transcript
          snapshot={snapshot}
          store={store}
          api={api}
          matchMediaImpl={matchMediaImpl}
          setTimeoutImpl={setTimeoutImpl}
          clearTimeoutImpl={clearTimeoutImpl}
          setIntervalImpl={setIntervalImpl}
          clearIntervalImpl={clearIntervalImpl}
          transcriptRef={transcriptRef}
        />
        <ResizeHandle
          snapshot={snapshot}
          store={store}
          doc={doc}
          transcriptRef={transcriptRef}
        />
      </div>
      {ReactDOM.createPortal(
        <ControlsBar
          snapshot={snapshot}
          store={store}
          pickerWrapRef={pickerWrapRef}
        />,
        controlsEl,
      )}
    </>
  );
}

export function createChatPanel(options = {}) {
  const {
    doc = globalThis.document,
    api = getRoamApi(),
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    setIntervalImpl = globalThis.setInterval?.bind(globalThis),
    clearIntervalImpl = globalThis.clearInterval?.bind(globalThis),
    matchMediaImpl = globalThis.matchMedia?.bind(globalThis),
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
    const removal = typeof removeWindow === "function"
      ? Promise.resolve(removeWindow({
        window: { type: "block", "block-uid": storeOptions.rootBlockUid },
      })).catch(() => {})
      : Promise.resolve();
    void removal.then(() => close());
  };

  ReactDOM.render(
    <ChatPanelRoot
      store={store}
      doc={doc}
      api={api}
      headerEl={header}
      controlsEl={controls}
      matchMediaImpl={matchMediaImpl}
      setTimeoutImpl={setTimeoutImpl}
      clearTimeoutImpl={clearTimeoutImpl}
      setIntervalImpl={setIntervalImpl}
      clearIntervalImpl={clearIntervalImpl}
      onCloseRequested={onCloseRequested}
    />,
    panel,
  );

  return {
    element: panel,
    headerElement: header,
    controlsElement: controls,
    rootBlockUid: storeOptions.rootBlockUid,
    close,
    focus: store.focusRoot,
    send: store.send,
  };
}
