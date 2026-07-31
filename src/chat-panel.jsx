import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal, render, unmountComponentAtNode } from "react-dom";
import { useSyncExternalStore } from "use-sync-external-store/shim/index.js";
import { createChatPanelStore } from "./chat-panel-store.js";
import {
  getRoamApi,
  renderRoamMarkdown,
  unmountRoamMarkdown,
  formatRunningElapsed,
  conversationDateLabel,
  modelEfforts,
  modelTierChoices,
  effortLabel,
  CHAT_PANEL_ID,
  CHAT_CONTROLS_ID,
  CHAT_PANEL_CLASS,
  CHAT_SCROLL_BOTTOM_THRESHOLD,
} from "./core.js";

// One context carries the store and per-panel environment; one subscription
// at the root threads the current snapshot through the same object. Created
// lazily so importing the bundle never requires React to be present.
let PanelContext = null;
const getPanelContext = () => (PanelContext ??= createContext(null));
const usePanel = () => useContext(getPanelContext());

// Owns Roam's renderString/unmountNode lifecycle for one immutable string.
function RoamString({ text, className }) {
  const { api } = usePanel();
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

function CopyButton({ roleLabel, text }) {
  const { store } = usePanel();
  const [copyState, setCopyState] = useState("idle");
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);
  // Feedback states expire on their own; cleanup covers unmount and restarts.
  useEffect(() => {
    if (copyState !== "copied" && copyState !== "error") return undefined;
    const timer = setTimeout(() => setCopyState("idle"), 1_400);
    return () => clearTimeout(timer);
  }, [copyState]);

  const title = copyState === "copied"
    ? "Copied"
    : copyState === "error"
      ? "Could not copy Roam text"
      : "Copy Roam text";
  const ariaLabel = copyState === "copied"
    ? "Copied Roam text"
    : copyState === "error"
      ? "Could not copy Roam text"
      : `Copy ${roleLabel} message as Roam text`;

  const onClick = async (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setCopyState("copying");
    let next;
    try {
      await store.copyText(text);
      next = "copied";
    } catch {
      next = "error";
    }
    if (mountedRef.current) setCopyState(next);
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

function ProgressRow() {
  const { store, snapshot } = usePanel();
  const { running, runStartedAt, progress } = snapshot;
  // The interval only invalidates; elapsed time derives during render.
  const [, tick] = useReducer((count) => count + 1, 0);
  useEffect(() => {
    if (!running) return undefined;
    const intervalId = setInterval(tick, 1000);
    return () => clearInterval(intervalId);
  }, [running]);
  const elapsedMs = running ? Math.max(0, store.now() - runStartedAt) : 0;

  return (
    <div
      className="roam-codex-chat-progress"
      aria-live="polite"
      data-kind={progress.kind}
      hidden={!progress.text && !running}
    >
      <span className="roam-codex-chat-progress-meta" hidden={!running}>
        <span className="roam-codex-chat-progress-timer">
          {formatRunningElapsed(elapsedMs)}
        </span>
      </span>
      <span className="roam-codex-chat-progress-text">{progress.text}</span>
    </div>
  );
}

// Memoized so streaming progress emits don't re-render settled messages;
// message objects keep their identity in the store's append-only array.
const ChatMessage = memo(function ChatMessage({ message }) {
  if (!message || !["user", "assistant"].includes(message.role)) return null;
  const roleLabel = message.role === "user" ? "You" : "Codex";
  return (
    <article
      className={`roam-codex-chat-message roam-codex-chat-message-${message.role}`}
    >
      <CopyButton roleLabel={roleLabel} text={message.text} />
      <RoamString
        text={message.text}
        className="roam-codex-chat-message-text"
      />
    </article>
  );
});

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
      messages.length > 0 &&
      overflowing &&
      fromBottom > CHAT_SCROLL_BOTTOM_THRESHOLD,
    );
  };

  // Layout effect so new content is scrolled into place before paint.
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    measureLatest();
  }, [messages.length, progressVisible]);

  const scrollToLatest = () => {
    const el = transcriptRef.current;
    if (!el) return;
    const reduceMotion = Boolean(
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches,
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

  return (
    <div className="roam-codex-chat-transcript-wrap" style={heightStyle}>
      <div
        className="roam-codex-chat-transcript"
        role="log"
        aria-live="polite"
        ref={transcriptRef}
        hidden={!messages.length && !progressVisible}
        style={heightStyle}
        onScroll={measureLatest}
      >
        {messages.map((message, index) => (
          <ChatMessage key={`${index}-${message?.role}`} message={message} />
        ))}
        <ProgressRow />
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

function ResizeHandle({ transcriptRef }) {
  const { store, snapshot, doc } = usePanel();
  const dragRef = useRef(null);
  useEffect(() => () => dragRef.current?.stop(), []);

  const onPointerDown = (event) => {
    if (!Number.isFinite(event?.clientY)) return;
    const transcript = transcriptRef.current;
    const measured = transcript?.getBoundingClientRect?.()?.height;
    const startHeight = Number.isFinite(measured) && measured > 0
      ? measured
      : snapshot.transcriptHeight;
    const startY = event.clientY;
    let height = startHeight;
    // Transient drag values mutate styles directly; the store (and React)
    // hear about the final height once, on release.
    const onMove = (moveEvent) => {
      if (!Number.isFinite(moveEvent?.clientY)) return;
      height = store.clampTranscriptHeight(
        startHeight + (moveEvent.clientY - startY),
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

  return (
    <div
      className="roam-codex-chat-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the conversation area"
      onPointerDown={onPointerDown}
    />
  );
}

function PickerOption({ label, active, level, id, description }) {
  const { store } = usePanel();
  return (
    <button
      type="button"
      className={`roam-codex-chat-picker-option${active ? " is-active" : ""}`}
      role="menuitemradio"
      aria-checked={active}
      title={description}
      onClick={() => store.pick(level, id)}
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
}

// Derives the option lists from the raw snapshot instead of storing them.
function pickerModelView(snapshot) {
  const { models, pickerModel, pickerEffort, pickerSpeed } = snapshot;
  const selected = models.find((model) => model.id === pickerModel) ||
    models.find((model) => model.isDefault) ||
    models[0] || null;
  const efforts = modelEfforts(selected);
  const tiers = modelTierChoices(selected);
  const defaultTierId = tiers.some(
    (tier) => tier.id === selected?.defaultServiceTier,
  )
    ? selected.defaultServiceTier
    : "";
  return {
    selected,
    efforts,
    defaultEffort: efforts.includes(selected?.defaultReasoningEffort)
      ? selected.defaultReasoningEffort
      : null,
    tiers,
    defaultTierId,
    currentTier: tiers.find((tier) => tier.id === pickerSpeed) || null,
    effortId: pickerEffort,
    speedId: pickerSpeed,
    modelId: pickerModel,
  };
}

function PickerMenu({ view }) {
  const { store, snapshot } = usePanel();
  const { pickerOpen, pickerLevel, models } = snapshot;
  const rows = [
    ["Model", view.selected?.displayName || view.selected?.id || "—", "model"],
    ["Effort", view.effortId ? effortLabel(view.effortId) : "—", "effort"],
  ];
  if (view.tiers.length) {
    rows.push([
      "Speed",
      view.currentTier?.name || view.currentTier?.id || "—",
      "speed",
    ]);
  }

  let options = null;
  if (pickerLevel === "model") {
    options = models
      .filter((model) => model && typeof model.id === "string")
      .map((model) => {
        const displayName = model.displayName || model.id;
        return (
          <PickerOption
            key={model.id}
            label={model.isDefault ? `${displayName} (Default)` : displayName}
            active={model.id === view.modelId}
            level="model"
            id={model.id}
            description={model.description || ""}
          />
        );
      });
  } else if (pickerLevel === "effort") {
    options = view.efforts.map((effort) => (
      <PickerOption
        key={effort}
        label={effort === view.defaultEffort
          ? `${effortLabel(effort)} (Default)`
          : effortLabel(effort)}
        active={effort === view.effortId}
        level="effort"
        id={effort}
        description={view.selected?.supportedReasoningEfforts?.find(
          (entry) => entry?.reasoningEffort === effort,
        )?.description || ""}
      />
    ));
  } else if (pickerLevel === "speed") {
    options = view.tiers.map((tier) => (
      <PickerOption
        key={tier.id}
        label={tier.id === view.defaultTierId
          ? `${tier.name || tier.id} (Default)`
          : tier.name || tier.id}
        active={tier.id === view.speedId}
        level="speed"
        id={tier.id}
        description={tier.description || ""}
      />
    ));
  }

  return (
    <>
      <div
        className="roam-codex-chat-picker-menu"
        role="menu"
        aria-label="Model, effort, and speed options"
        hidden={!pickerOpen}
      >
        {rows.map(([label, value, level]) => {
          const open = pickerLevel === level;
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
        aria-label={pickerLevel ? `${effortLabel(pickerLevel)} options` : ""}
        hidden={!pickerOpen || !pickerLevel}
      >
        {options}
      </div>
    </>
  );
}

function ControlsBar() {
  const { store, snapshot } = usePanel();
  const { running, modelsReady, stopping, pickerOpen, pickerLabel } = snapshot;
  const view = pickerModelView(snapshot);
  const shortcutIsMac = snapshot.sendShortcutIsMac;
  return (
    <div className="roam-codex-chat-model-row">
      <div className="roam-codex-chat-picker">
        <button
          type="button"
          className="roam-codex-chat-picker-button"
          title="Choose the model, reasoning effort, and speed"
          aria-label="Model, effort, and speed"
          aria-haspopup="menu"
          aria-expanded={pickerOpen}
          data-speed={modelsReady
            ? (view.currentTier?.id === "priority" ? "fast" : "standard")
            : undefined}
          disabled={running || !modelsReady}
          onClick={() => store.togglePicker()}
        >
          {pickerLabel}
        </button>
        <PickerMenu view={view} />
      </div>
      <div className="roam-codex-chat-actions">
        <button
          type="button"
          className="roam-codex-chat-stop"
          title="Stop the current Codex turn"
          hidden={!running}
          disabled={stopping}
          onClick={() => {
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
            shortcutIsMac ? "Option" : "Alt"
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
            {shortcutIsMac ? "⌥↵" : "Alt ↵"}
          </kbd>
        </button>
      </div>
    </div>
  );
}

function HeaderContent({ onCloseRequested }) {
  const { store, snapshot } = usePanel();
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
        onClick={() =>
          history.open ? store.closeHistory() : store.openHistory()}
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

function ChatPanelRoot({ store, doc, api, headerEl, controlsEl, onCloseRequested }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const transcriptRef = useRef(null);
  const Context = getPanelContext();
  return (
    <Context.Provider value={{ store, snapshot, api, doc }}>
      {createPortal(
        <HeaderContent onCloseRequested={onCloseRequested} />,
        headerEl,
      )}
      <div className="roam-codex-chat-body">
        <Transcript transcriptRef={transcriptRef} />
        <ResizeHandle transcriptRef={transcriptRef} />
      </div>
      {createPortal(<ControlsBar />, controlsEl)}
    </Context.Provider>
  );
}

// Document-level behavior reads the store imperatively and never touches
// component state, so it lives beside the store rather than in an effect.
function attachDocumentBehavior({ store, doc, headerEl, controlsEl }) {
  const handleKeydown = (event) => {
    const current = store.getSnapshot();
    if (
      !event.defaultPrevented &&
      event.key === "Escape" &&
      (current.history.open || current.pickerOpen)
    ) {
      event.preventDefault();
      event.stopPropagation?.();
      if (current.history.open) store.closeHistory();
      if (current.pickerOpen) store.closePicker();
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
    if (current.history.open && !headerEl.contains?.(event.target)) {
      store.closeHistory();
    }
    const pickerWrap = controlsEl.querySelector?.(".roam-codex-chat-picker");
    if (current.pickerOpen && !pickerWrap?.contains?.(event.target)) {
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
}

export function createChatPanel(options = {}) {
  const {
    doc = globalThis.document,
    api = getRoamApi(),
    ...storeOptions
  } = options;
  if (!doc?.createElement) {
    throw new Error("A document is required to create the Codex chat panel.");
  }
  const host = globalThis.window ?? globalThis;
  if (!host.React?.createElement || !host.ReactDOM?.render) {
    throw new Error("Roam's bundled React is unavailable.");
  }
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
      detachDocument();
      unmountComponentAtNode(panel);
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

  render(
    <ChatPanelRoot
      store={store}
      doc={doc}
      api={api}
      headerEl={header}
      controlsEl={controls}
      onCloseRequested={onCloseRequested}
    />,
    panel,
  );
  const detachDocument = attachDocumentBehavior({
    store,
    doc,
    headerEl: header,
    controlsEl: controls,
  });
  void store.loadModels();
  void store.loadInitialConversation();

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
