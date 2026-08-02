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
              <BlockString string={message.text} />
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
  dateLabel,
  onNew,
  onSelect,
}) {
  const entries = items.length
    ? items.map((entry) => (
      <button
        key={entry.threadId}
        type="button"
        className={`roam-codex-chat-history-item${
          entry.active ? " is-active" : ""
        }`}
        title={`Resume ${entry.title}`}
        role="menuitem"
        disabled={running}
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
    ))
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

function ChatPicker({ picker, levelLabel, onToggle, onOpenLevel, onPick }) {
  const openLevel = (level) => onOpenLevel(level);
  return (
    <div className="roam-codex-chat-picker">
      <button
        type="button"
        className="roam-codex-chat-picker-button"
        title="Choose the model, reasoning effort, speed, and access"
        aria-label="Model, effort, speed, and access"
        aria-haspopup="menu"
        aria-expanded={String(picker.open)}
        data-speed={picker.speed}
        disabled={picker.disabled}
        onClick={onToggle}
      >
        {picker.label}
      </button>
      <div
        className="roam-codex-chat-picker-menu"
        role="menu"
        aria-label="Model, effort, speed, and access options"
        hidden={!picker.open}
      >
        {picker.rows.map((row) => (
          <button
            key={row.level}
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
        ))}
      </div>
      <div
        className="roam-codex-chat-picker-submenu"
        role="menu"
        aria-label={picker.level
          ? `${levelLabel(picker.level)} options`
          : undefined}
        hidden={!picker.level}
      >
        {picker.options.map((option) => (
          <ChatPickerOption key={option.id} option={option} onPick={onPick} />
        ))}
      </div>
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
    ? "Add the focused block to Codex's current turn without stopping it"
    : `Send the focused block in this chat's Block Outline (${
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
          hidden={!running}
          disabled={stopDisabled}
          onClick={actions.stop}
        >
          Stop
        </button>
        <button
          type="button"
          className={`roam-codex-chat-send${steering ? " is-steering" : ""}`}
          title={sendTitle}
          hidden={false}
          disabled={sendDisabled}
          onMouseDown={(event) => event.preventDefault?.()}
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
