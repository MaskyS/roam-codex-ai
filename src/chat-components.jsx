export function ChatApprovalCards({ approvals, decide }) {
  const approvalButton = (approvalId, state, decision, label) => (
    <button
      type="button"
      className={`roam-codex-chat-approval-${decision}`}
      title={`${label} this Roam change`}
      disabled={state === "submitting"}
      onClick={() => decide(approvalId, decision)}
    >
      {label}
    </button>
  );
  return approvals.map(({ approvalId, questions, state }) => (
    <section
      key={approvalId}
      className="roam-codex-chat-approval"
      aria-label="Roam change approval"
      data-state={state || undefined}
    >
      <div className="roam-codex-chat-approval-title">
        {questions.find((question) => question?.header)?.header ||
          "Allow Roam change?"}
      </div>
      {questions.filter((question) => question?.question).map(
        (question, index) => (
          <div
            key={`${approvalId}-${index}`}
            className="roam-codex-chat-approval-question"
          >
            {question.question}
          </div>
        ),
      )}
      <div className="roam-codex-chat-approval-actions">
        {approvalButton(approvalId, state, "reject", "Reject")}
        {approvalButton(approvalId, state, "accept", "Allow")}
      </div>
    </section>
  ));
}

export function ConnectionCard({
  connection,
  note,
  pairingCodeRequired,
  focusInput,
  reveal,
  reduceMotion,
  actions,
}) {
  let title = "";
  let text = "";
  let command = "";
  let actionLabel = "";
  let activate = null;
  let pairingInput = null;

  if (connection.state === "checking") {
    title = "Connecting to the local Codex bridge…";
  } else if (connection.state === "wrong-graph") {
    title = "The bridge is paired to a different graph";
    text = connection.detail || "Pairing switches the bridge over to this graph.";
    actionLabel = "Use this graph instead";
    activate = () => actions.pair(pairingCodeRequired ? pairingInput?.value : undefined);
  } else if (connection.state === "unpaired") {
    title = "Pair this device with the bridge";
    text = pairingCodeRequired
      ? "Enter the one-time pairing code."
      : "Click Pair, then choose Allow in the dialog that opens on this computer.";
    actionLabel = "Pair";
    activate = () => actions.pair(pairingCodeRequired ? pairingInput?.value : undefined);
  } else if (connection.state === "signed-out") {
    title = "Sign in to Codex";
    text = "The bridge is running, but Codex has no signed-in ChatGPT account.";
    actionLabel = "Sign in";
    activate = actions.login;
  } else if (connection.state !== "connected") {
    title = "The Codex bridge isn't running";
    text = "Start it on this computer; this panel reconnects by itself.";
    command = "npx roam-codex-bridge";
    actionLabel = "Try again";
    activate = actions.retry;
  }

  return (
    <section
      className="roam-codex-connection-card"
      hidden={connection.state === "connected"}
      ref={(node) => {
        if (node && reveal) {
          node.scrollIntoView?.({
            block: "nearest",
            behavior: reduceMotion ? "auto" : "smooth",
          });
        }
      }}
    >
      {title && <h3 className="roam-codex-connection-title">{title}</h3>}
      {text && <p className="roam-codex-connection-text">{text}</p>}
      {pairingCodeRequired && ["unpaired", "wrong-graph"].includes(connection.state) && (
        <input
          type="text"
          className="roam-codex-connection-input"
          aria-label="Bridge pairing code"
          ref={(node) => {
            pairingInput = node;
            if (node && focusInput) node.focus?.();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void activate?.();
          }}
        />
      )}
      {command && <code className="roam-codex-connection-command">{command}</code>}
      {note && <p className="roam-codex-connection-note">{note}</p>}
      {actionLabel && (
        <div className="roam-codex-connection-actions">
          <button
            type="button"
            className="roam-codex-connection-button"
            onClick={() => void activate?.()}
          >
            {actionLabel}
          </button>
        </div>
      )}
    </section>
  );
}

function normalizedOutlineString(value) {
  return typeof value === "string"
    ? value.split("\u00a0").join("").trim()
    : "";
}

function snapshotOutlineRows(outline, depth = 0, rows = [], root = true) {
  const text = normalizedOutlineString(outline?.string);
  if (text) rows.push({ depth, text, root });
  for (const child of outline?.children || []) {
    snapshotOutlineRows(child, text ? depth + 1 : depth, rows, false);
  }
  return rows;
}

function serializedOutlineRows(value) {
  const lines = typeof value === "string" ? value.split(/\r?\n/) : [];
  const firstContent = lines.find((line) => line.trim());
  const rootOffset = firstContent && !/^\s*-\s/.test(firstContent) ? 1 : 0;
  const rows = [];
  for (const line of lines) {
    const item = /^(\s*)-\s(.*)$/.exec(line);
    if (item) {
      rows.push({
        depth: Math.floor(item[1].length / 2) + rootOffset,
        text: item[2],
        root: false,
      });
    } else if (!rows.length) {
      if (line.trim()) rows.push({ depth: 0, text: line, root: true });
    } else {
      rows.at(-1).text += `\n${line.trimStart()}`;
    }
  }
  return rows.filter((row) => row.text.trim());
}

export function chatMessageOutlineRows(message) {
  if (message?.role !== "user") return [];
  const rows = message.outline
    ? snapshotOutlineRows(message.outline)
    : serializedOutlineRows(message.text);
  return rows.length > 1 ? rows : [];
}

export function ChatTranscript({
  messages,
  approvals,
  progress,
  copyStates,
  BlockString,
  onCopy,
  onDecide,
  transcriptRef,
  onScroll,
  height,
}) {
  const hasProgress = Boolean(progress.text || progress.running);
  return (
    <div
      ref={transcriptRef}
      className="roam-codex-chat-transcript"
      role="log"
      aria-live="polite"
      hidden={!messages.length && !approvals.length && !hasProgress}
      onScroll={onScroll}
      style={{ height: `${height}px`, maxHeight: `${height}px` }}
    >
      {messages.map((message, index) => {
        if (!message || !["user", "assistant"].includes(message.role)) return null;
        const roleLabel = message.role === "user" ? "You" : "Codex";
        const copyState = copyStates.get(message) || "idle";
        const copied = copyState === "copied";
        const failed = copyState === "error";
        const outlineRows = chatMessageOutlineRows(message);
        return (
          <article
            key={message.id || `${message.role}-${index}`}
            className={`roam-codex-chat-message roam-codex-chat-message-${message.role}`}
          >
            <button
              type="button"
              className="roam-codex-chat-copy"
              title={copied ? "Copied" : failed ? "Could not copy Roam text" : "Copy Roam text"}
              aria-label={copied
                ? "Copied Roam text"
                : failed
                ? "Could not copy Roam text"
                : `Copy ${roleLabel} message as Roam text`}
              data-state={copyState}
              onClick={(event) => onCopy(message, event.currentTarget, roleLabel)}
            />
            <div className="roam-codex-chat-message-text">
              {outlineRows.length
                ? (
                  <div className="roam-codex-chat-message-outline">
                    {outlineRows.map((row, rowIndex) => (
                      <div
                        key={`${index}-${rowIndex}`}
                        className={`roam-codex-chat-message-outline-row${
                          row.root ? " is-root" : ""
                        }`}
                        style={{ marginLeft: `${row.depth * 14}px` }}
                      >
                        {!row.root && (
                          <span
                            className="roam-codex-chat-message-outline-bullet"
                            aria-hidden="true"
                          >
                            •
                          </span>
                        )}
                        <span className="roam-codex-chat-message-outline-text">
                          <BlockString string={row.text} />
                        </span>
                      </div>
                    ))}
                  </div>
                )
                : <BlockString string={message.text} />}
            </div>
          </article>
        );
      })}
      <div className="roam-codex-chat-approvals" hidden={!approvals.length}>
        <ChatApprovalCards approvals={approvals} decide={onDecide} />
      </div>
      <div
        className="roam-codex-chat-progress"
        aria-live="polite"
        data-kind={progress.kind}
        hidden={!hasProgress}
      >
        <span className="roam-codex-chat-progress-meta" hidden={!progress.running}>
          <span className="roam-codex-chat-progress-timer">{progress.elapsed}</span>
        </span>
        <span className="roam-codex-chat-progress-text">{progress.text}</span>
      </div>
    </div>
  );
}

export function ChatHistory({
  items,
  activeThreadId,
  error,
  running,
  menuThreadId,
  deletingThreadId,
  dateLabel,
  onNew,
  onSelect,
  onToggleMenu,
  onDelete,
}) {
  const entries = items.length
    ? items.map((entry) => {
      const menuOpen = menuThreadId === entry.threadId;
      const deleting = deletingThreadId === entry.threadId;
      return (
        <div
          key={entry.threadId}
          className={`roam-codex-chat-history-row${
            menuOpen ? " has-open-menu" : ""
          }`}
        >
          <button
            type="button"
            className={`roam-codex-chat-history-item${
              entry.active ? " is-active" : ""
            }`}
            title={`Resume ${entry.title}`}
            role="menuitem"
            disabled={running || deleting}
            data-thread-id={entry.threadId}
            data-availability={entry.availability}
            aria-current={entry.active ? "true" : undefined}
            onClick={() => onSelect(entry.threadId)}
          >
            <span className="roam-codex-chat-history-title">{entry.title}</span>
            <span className="roam-codex-chat-history-date">
              {["missing", "unavailable"].includes(entry.availability)
                ? "Unavailable"
                : dateLabel(entry.updatedAt)}
            </span>
          </button>
          <button
            type="button"
            className="roam-codex-chat-history-more"
            title={`Actions for ${entry.title}`}
            aria-label={`Actions for ${entry.title}`}
            aria-haspopup="menu"
            aria-expanded={String(menuOpen)}
            disabled={running || deleting}
            onClick={() => onToggleMenu(entry.threadId)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              className="roam-codex-chat-history-row-menu"
              role="menu"
              aria-label={`Actions for ${entry.title}`}
            >
              <button
                type="button"
                className="roam-codex-chat-history-delete"
                role="menuitem"
                disabled={deleting}
                onClick={() => onDelete(entry.threadId)}
              >
                <svg
                  className="roam-codex-chat-history-delete-icon"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M3.5 4.5h9M6 4.5v-2h4v2m-5.5 0 .6 9h5.8l.6-9M7 7v4m2-4v4" />
                </svg>
                <span>{deleting ? "Deleting…" : "Delete chat"}</span>
              </button>
            </div>
          )}
        </div>
      );
    })
    : [
      <div key="empty" className="roam-codex-chat-history-empty">
        {error || "No previous chats yet."}
      </div>,
    ];
  return [
    <button
      key="new"
      type="button"
      className={`roam-codex-chat-history-item roam-codex-chat-history-new${
        activeThreadId ? "" : " is-active"
      }`}
      title="Start a new conversation"
      role="menuitem"
      disabled={running}
      aria-current={activeThreadId ? undefined : "true"}
      onClick={onNew}
    >
      + New chat
    </button>,
    ...entries,
    ...(error && items.length
      ? [
        <div key="error" className="roam-codex-chat-history-error">
          {error}
        </div>,
      ]
      : []),
  ];
}

function ChatPickerOption({ option, onPick }) {
  return (
    <button
      type="button"
      className={`roam-codex-chat-picker-option${
        option.active ? " is-active" : ""
      }`}
      title={option.description || ""}
      role={option.toggle ? "menuitemcheckbox" : "menuitemradio"}
      aria-checked={String(option.active)}
      disabled={option.disabled}
      onClick={option.disabled ? undefined : () => onPick(option.id)}
    >
      <span className="roam-codex-chat-picker-option-label">{option.label}</span>
      {option.description && (
        <span className="roam-codex-chat-picker-option-description">
          {option.description}
        </span>
      )}
    </button>
  );
}

const PICKER_POPOVER_MODIFIERS = {
  flip: { enabled: true },
  preventOverflow: {
    boundariesElement: "viewport",
    padding: 8,
  },
};

function ChatPicker({ picker, levelLabel, onToggle, onOpenLevel, onPick }) {
  const Blueprint = globalThis.window?.Blueprint?.Core;
  if (!Blueprint?.Popover) {
    throw new Error("Codex chat requires Roam's Blueprint globals.");
  }
  const { Popover, Position } = Blueprint;
  const openLevel = (level) => onOpenLevel(level);
  const submenu = (row) => (
    <div
      className="roam-codex-chat-picker-submenu"
      role="menu"
      aria-label={`${levelLabel(row.level)} options`}
    >
      {picker.options.map((option) => (
        <ChatPickerOption key={option.id} option={option} onPick={onPick} />
      ))}
    </div>
  );
  const menu = (
    <div
      className="roam-codex-chat-picker-menu"
      role="menu"
      aria-label="Model, effort, speed, and access options"
    >
      {picker.rows.map((row) => (
        <Popover
          key={row.level}
          autoFocus={false}
          content={submenu(row)}
          isOpen={picker.open && row.level === picker.level}
          minimal={true}
          modifiers={PICKER_POPOVER_MODIFIERS}
          popoverClassName="roam-codex-chat-picker-popover roam-codex-chat-picker-submenu-popover"
          portalClassName="roam-codex-chat-picker-portal"
          position={Position.RIGHT_TOP}
          transitionDuration={100}
          usePortal={true}
        >
          <button
            type="button"
            className={`roam-codex-chat-picker-item${
              row.level === picker.level ? " is-open" : ""
            }`}
            title={`Choose ${row.label.toLowerCase()}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={String(row.level === picker.level)}
            data-level={row.level}
            onMouseEnter={() => openLevel(row.level)}
            onFocus={() => openLevel(row.level)}
            onClick={() => openLevel(row.level)}
            onKeyDown={(event) => {
              if (!["ArrowRight", "Enter", " "].includes(event.key)) return;
              event.preventDefault?.();
              openLevel(row.level);
            }}
          >
            <span className="roam-codex-chat-picker-item-label">{row.label}</span>
            <span className="roam-codex-chat-picker-item-value">{row.value}</span>
            <span
              className="roam-codex-chat-picker-item-chevron"
              aria-hidden="true"
            >
              ›
            </span>
          </button>
        </Popover>
      ))}
    </div>
  );
  return (
    <div className="roam-codex-chat-picker">
      <Popover
        autoFocus={false}
        content={menu}
        isOpen={picker.open}
        minimal={true}
        modifiers={PICKER_POPOVER_MODIFIERS}
        onInteraction={(nextOpen) => {
          if (Boolean(nextOpen) !== picker.open) onToggle(Boolean(nextOpen));
        }}
        popoverClassName="roam-codex-chat-picker-popover"
        portalClassName="roam-codex-chat-picker-portal"
        position={Position.BOTTOM_LEFT}
        transitionDuration={100}
        usePortal={true}
      >
        <button
          type="button"
          className="roam-codex-chat-picker-button"
          title="Choose the model, reasoning effort, speed, and access"
          aria-label="Model, effort, speed, and access"
          aria-haspopup="menu"
          aria-expanded={String(picker.open)}
          data-speed={picker.speed}
          disabled={picker.disabled}
        >
          {picker.label}
        </button>
      </Popover>
    </div>
  );
}

export function ChatControls({
  picker,
  running,
  steering,
  sendDisabled,
  stopDisabled,
  shortcutIsMac,
  levelLabel,
  actions,
}) {
  const sendTitle = steering
    ? "Add the selected composer message to Codex's current turn"
    : `Send the selected message from this chat composer (${
      shortcutIsMac ? "Option" : "Alt"
    }+Enter, rebindable in Settings → Hotkeys)`;
  return (
    <div className="roam-codex-chat-model-row">
      <ChatPicker
        picker={picker}
        levelLabel={levelLabel}
        onToggle={actions.togglePicker}
        onOpenLevel={actions.openPickerLevel}
        onPick={actions.pick}
      />
      <div className="roam-codex-chat-actions">
        <button
          type="button"
          className="roam-codex-chat-stop"
          title="Stop the current Codex turn"
          aria-label="Stop the current Codex turn"
          hidden={!running}
          disabled={stopDisabled}
          onClick={actions.stop}
        >
          <span className="roam-codex-chat-stop-icon" aria-hidden="true" />
        </button>
        {/* Remember the composer selection before a pointer click can move
            browser focus. Keyboard and accessibility activation use the
            panel's independently tracked composer UID. */}
        <button
          type="button"
          className={`roam-codex-chat-send${steering ? " is-steering" : ""}`}
          title={sendTitle}
          hidden={false}
          disabled={sendDisabled}
          onMouseDown={(event) => {
            actions.rememberComposerFocus?.();
            event.preventDefault?.();
          }}
          onClick={actions.send}
        >
          {steering ? "Steer" : "Send"}
          <kbd className="roam-codex-chat-send-kbd" aria-hidden="true">
            {shortcutIsMac ? "⌥↵" : "Alt ↵"}
          </kbd>
        </button>
      </div>
    </div>
  );
}
