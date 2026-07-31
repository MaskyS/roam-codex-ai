import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = {
  fetch,
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  roamAlphaAPI: {
    ui: {
      toaster: {
        show: () => {},
      },
    },
  },
};

const {
  CHAT_COMPOSER_PLACEHOLDER,
  RUNNING_BLOCK_TEXT,
  applyRunPlan,
  buildConversationHistory,
  clearScratchPromptBlock,
  cleanupStaleRunningStatuses,
  copyRoamText,
  createChatPanel,
  findChatPanelHost,
  findSidebarBlockWindow,
  findSidebarChatLauncherPlacement,
  formatRunningElapsed,
  openChatPanel,
  openPromptBlockInSidebar,
  pairBridge,
  readChatState,
  readFocusedPromptBlock,
  readPromptOutlineUids,
  removeResetChatPromptBlocks,
  removeScratchPromptBlock,
  resolveChatPromptBlock,
  requestPanelChat,
  requestPanelThreadSummaries,
  requestProbe,
  requestRunCancellation,
  renderRoamMarkdown,
  restoreClearedChatPromptBlock,
  runningPresentationText,
  sendActiveChatMessage,
  shouldClearChatPrompt,
  startRunningPresentation,
  installSidebarChatLauncher,
  mountSidebarChatLauncher,
  unmountRoamMarkdown,
  workOnBlock,
  writeChatState,
} = await import("../extension.js");

test("chat messages use Roam's native string renderer and unmount cleanly", async () => {
  const element = { textContent: "" };
  const calls = [];
  const api = {
    ui: {
      components: {
        renderString: async (input) => calls.push(["render", input]),
        unmountNode: async (input) => calls.push(["unmount", input]),
      },
    },
  };

  assert.equal(
    await renderRoamMarkdown(
      element,
      "**Bold** [[Project]] ((block123))",
      { api },
    ),
    true,
  );
  assert.equal(await unmountRoamMarkdown(element, { api }), true);
  assert.deepEqual(calls, [
    ["render", {
      el: element,
      string: "**Bold** [[Project]] ((block123))",
    }],
    ["unmount", { el: element }],
  ]);
});

test("copyRoamText preserves the exact string supplied to the renderer", async () => {
  const copied = [];
  const text = "  **Bold** [[Project]]\n((block123))  ";
  await copyRoamText(text, {
    navigatorImpl: {
      clipboard: {
        writeText: async (value) => copied.push(value),
      },
    },
  });
  assert.deepEqual(copied, [text]);
  await assert.rejects(
    copyRoamText(text, { navigatorImpl: {} }),
    /Clipboard access is unavailable/,
  );
});

test("chat message rendering falls back safely to plain text", async () => {
  const element = { textContent: "" };
  assert.equal(
    await renderRoamMarkdown(element, "[[Still visible]]", {
      api: {
        ui: {
          components: {
            renderString: async () => {
              throw new Error("renderer unavailable");
            },
          },
        },
      },
    }),
    false,
  );
  assert.equal(element.textContent, "[[Still visible]]");
});

test("the chat transcript renders every message with Roam and unmounts it", async () => {
  const rendered = [];
  const unmounted = [];
  const copied = [];
  const pendingTimers = new Map();
  const clearedTimers = [];
  let nextTimer = 1;
  const doc = createFakePanelDocument();
  const api = {
    ui: {
      components: {
        renderString: async ({ el, string }) => {
          rendered.push(string);
          el.textContent = `rendered:${string}`;
        },
        unmountNode: async ({ el }) => unmounted.push(el),
      },
      rightSidebar: {
        getWindows: () => [{
          type: "block",
          "block-uid": "prompt123",
          "window-id": "sidebar-prompt123",
        }],
      },
    },
  };
  const controller = createChatPanel({
    doc,
    api,
    storage: {
      getItem: () => null,
      setItem: () => {},
    },
    rootBlockUid: "prompt123",
    readPromptImpl: async () => ({
      uid: "prompt123",
      text: "Question about [[Project]]",
    }),
    requestChatImpl: async () => ({
      threadId: "thread_render_123",
      turnId: "turn-render",
      reply: "See **bold** and ((block123))",
    }),
    requestModelsImpl: async () => [],
    requestMessagesImpl: async () => [],
    requestHistoryImpl: async () => ({
      threads: [],
      missingThreadIds: [],
      unavailableThreadIds: [],
    }),
    copyTextImpl: async (text) => {
      if (text.startsWith("See ")) throw new Error("clipboard denied");
      copied.push(text);
    },
    setTimeoutImpl: (callback) => {
      const id = nextTimer;
      nextTimer += 1;
      pendingTimers.set(id, callback);
      return id;
    },
    clearTimeoutImpl: (id) => {
      clearedTimers.push(id);
      pendingTimers.delete(id);
    },
  });

  await controller.send();
  await Promise.resolve();
  assert.deepEqual(rendered, [
    "Question about [[Project]]",
    "Question about [[Project]]",
    "See **bold** and ((block123))",
  ]);
  assert.equal(unmounted.length, 2);
  const copyButtons = panelElements(controller).filter(
    (element) => element.className === "roam-codex-chat-copy",
  );
  assert.equal(copyButtons.length, 2);
  assert.equal(copyButtons[1]["aria-label"], "Copy Codex message as Roam text");
  await copyButtons[0].listeners.click({
    preventDefault() {},
    stopPropagation() {},
  });
  assert.deepEqual(copied, ["Question about [[Project]]"]);
  assert.equal(copyButtons[0].dataset.state, "copied");
  assert.equal(copyButtons[0].title, "Copied");
  await copyButtons[1].listeners.click({
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(copyButtons[1].dataset.state, "error");
  assert.equal(copyButtons[1].title, "Could not copy Roam text");
  assert.equal(pendingTimers.size, 2);

  const unmountedBeforeClose = unmounted.length;
  await controller.close();
  await Promise.resolve();
  assert.ok(unmounted.length >= unmountedBeforeClose + 2);
  assert.deepEqual(clearedTimers, [1, 2]);
  assert.equal(pendingTimers.size, 0);
});

function createFakePanelDocument() {
  const documentListeners = {};
  const makeElement = (tagName) => {
    const classes = new Set();
    let ownText = "";
    const element = {
      tagName,
      children: [],
      listeners: {},
      dataset: {},
      className: "",
      value: "",
      removed: false,
      scrollHeight: 0,
      scrollTop: 0,
      clientHeight: 0,
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      replaceChildren(...children) {
        this.children = [];
        for (const child of children) this.appendChild(child);
      },
      setAttribute(name, value) {
        this[name] = String(value);
      },
      addEventListener(name, handler) {
        this.listeners[name] = handler;
      },
      removeEventListener(name, handler) {
        if (this.listeners[name] === handler) delete this.listeners[name];
      },
      remove() {
        this.removed = true;
      },
      focus() {
        this.focused = true;
      },
      contains(target) {
        return target === this || this.children.some(
          (child) => child.contains?.(target),
        );
      },
      classList: {
        toggle(value) {
          if (classes.has(value)) {
            classes.delete(value);
            return false;
          }
          classes.add(value);
          return true;
        },
      },
      get textContent() {
        return ownText || this.children.map((child) => child.textContent).join("");
      },
      set textContent(value) {
        ownText = String(value);
      },
    };
    return element;
  };
  return {
    createElement: makeElement,
    listeners: documentListeners,
    addEventListener(name, handler) {
      documentListeners[name] = handler;
    },
    removeEventListener(name, handler) {
      if (documentListeners[name] === handler) delete documentListeners[name];
    },
  };
}

function panelElements(controller) {
  const elements = [];
  const visit = (element) => {
    elements.push(element);
    for (const child of element.children || []) visit(child);
  };
  visit(controller.element);
  visit(controller.controlsElement);
  return elements;
}

test("chat state keeps versioned conversation records without a parallel draft", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const initial = readChatState({ storage, key: "chat-test" });
  assert.equal(Object.hasOwn(initial, "draft"), false);
  assert.equal(initial.activeThreadId, null);

  const state = {
    ...initial,
    activeThreadId: "thread_12345678",
    conversations: {
      thread_12345678: {
        threadId: "thread_12345678",
        createdAt: 10,
        updatedAt: 20,
        model: "model-from-list",
        effort: "medium",
        speed: null,
        threadPageUid: null,
      },
    },
  };
  writeChatState(state, { storage, key: "chat-test" });

  assert.deepEqual(readChatState({ storage, key: "chat-test" }), state);
  values.set("chat-test", "{broken");
  assert.equal(readChatState({ storage, key: "chat-test" }).activeThreadId, null);
});

test("conversation history is graph-record scoped, labeled, and newest first", () => {
  const state = {
    activeThreadId: "thread_old_123",
    conversations: {
      thread_old_123: {
        threadId: "thread_old_123",
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      thread_new_456: {
        threadId: "thread_new_456",
        createdAt: 3_000,
        updatedAt: 4_000,
      },
    },
  };
  const history = buildConversationHistory(state, [
    {
      id: "thread_old_123",
      name: null,
      preview: "First prompt",
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: "thread_new_456",
      name: "Named conversation",
      preview: "Ignored preview",
      createdAt: 3,
      updatedAt: 4,
    },
    {
      id: "thread_other_789",
      name: "Unrelated app-server task",
      preview: "Must not appear",
      createdAt: 5,
      updatedAt: 6,
    },
  ]);

  assert.deepEqual(history.map((item) => ({
    threadId: item.threadId,
    title: item.title,
    active: item.active,
  })), [
    {
      threadId: "thread_new_456",
      title: "Named conversation",
      active: false,
    },
    {
      threadId: "thread_old_123",
      title: "First prompt",
      active: true,
    },
  ]);
});

test("panel summary request sends only exact graph-scoped thread IDs", async () => {
  let captured;
  const result = await requestPanelThreadSummaries(
    ["thread_old_123", "thread_new_456"],
    {
      token: "local-token",
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return new Response(JSON.stringify({
          threads: [],
          missingThreadIds: ["thread_old_123"],
          unavailableThreadIds: ["thread_new_456"],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  assert.equal(
    captured.url,
    "http://127.0.0.1:47321/threads/summaries",
  );
  assert.equal(captured.init.method, "POST");
  assert.deepEqual(JSON.parse(captured.init.body), {
    graph: "maskys",
    threadIds: ["thread_old_123", "thread_new_456"],
  });
  assert.deepEqual(result, {
    threads: [],
    missingThreadIds: ["thread_old_123"],
    unavailableThreadIds: ["thread_new_456"],
  });
});

test("panel chat streams a thread id, progress, and a panel-only reply", async () => {
  const encoder = new TextEncoder();
  const starts = [];
  const threads = [];
  const progress = [];
  let captured;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          '{"type":"started","runId":"run-1"}\n' +
            '{"type":"conversation","threadId":"thread_12345678"}\n' +
            '{"type":"progress","kind":"summary","text":"Thinking"}\n' +
            '{"type":"completed","result":{"threadId":"thread_12345678",' +
            '"turnId":"turn-1","reply":"Panel reply"}}\n',
        ),
      );
      controller.close();
    },
  });

  const result = await requestPanelChat("Hello", {
    token: "local-token",
    promptBlockUid: "prompt123",
    threadId: "thread_12345678",
    model: "model-from-list",
    effort: "medium",
    onStarted: (event) => starts.push(event),
    onThread: (event) => threads.push(event),
    onProgress: (event) => progress.push(event),
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    },
  });

  assert.equal(captured.url, "http://127.0.0.1:47321/chat");
  assert.deepEqual(JSON.parse(captured.init.body), {
    graph: "maskys",
    message: "Hello",
    promptBlockUid: "prompt123",
    threadId: "thread_12345678",
    model: "model-from-list",
    effort: "medium",
  });
  assert.deepEqual(starts, [{ runId: "run-1" }]);
  assert.deepEqual(threads, [{ threadId: "thread_12345678" }]);
  assert.deepEqual(progress, [{ kind: "summary", text: "Thinking" }]);
  assert.equal(result.reply, "Panel reply");
});

test("chat panel mounts in the exact native prompt-block window", () => {
  const promptWindow = {};
  const globalSidebar = {};
  const doc = {
    getElementById: (id) =>
      id === "sidebar-window-sidebar-block-prompt123" ? promptWindow :
        id === "roam-right-sidebar-content" ? globalSidebar : null,
  };
  const sidebarWindow = { "window-id": "sidebar-block-prompt123" };
  assert.equal(findChatPanelHost(doc, sidebarWindow), promptWindow);
  assert.equal(findChatPanelHost(doc, { "window-id": "missing" }), null);
  assert.equal(findChatPanelHost(doc), null);
});

function createSidebarLauncherDocument() {
  const makeElement = (tagName) => {
    const element = {
      tagName,
      id: "",
      className: "",
      children: [],
      listeners: {},
      dataset: {},
      hidden: false,
      isConnected: false,
      parentNode: null,
      title: "",
      disabled: false,
      width: 480,
      appendChild(child) {
        child.parentNode = this;
        child.isConnected = this.isConnected;
        this.children.push(child);
        return child;
      },
      insertBefore(child, before) {
        child.parentNode = this;
        child.isConnected = this.isConnected;
        const index = this.children.indexOf(before);
        if (index < 0) this.children.push(child);
        else this.children.splice(index, 0, child);
        return child;
      },
      remove() {
        if (this.parentNode) {
          const index = this.parentNode.children.indexOf(this);
          if (index >= 0) this.parentNode.children.splice(index, 1);
        }
        this.parentNode = null;
        this.isConnected = false;
      },
      contains(target) {
        return target === this || this.children.some(
          (child) => child.contains?.(target),
        );
      },
      addEventListener(name, listener) {
        this.listeners[name] = listener;
      },
      setAttribute(name, value) {
        this[name] = String(value);
      },
      getBoundingClientRect() {
        return { width: this.width };
      },
    };
    return element;
  };
  const body = makeElement("body");
  body.isConnected = true;
  const sidebar = makeElement("aside");
  sidebar.id = "right-sidebar";
  const header = makeElement("div");
  header.className = "flex-h-box";
  const nativeToggle = makeElement("button");
  nativeToggle.id = "native-sidebar-toggle";
  const content = makeElement("div");
  content.id = "roam-right-sidebar-content";
  header.appendChild(nativeToggle);
  sidebar.appendChild(header);
  sidebar.appendChild(content);
  body.appendChild(sidebar);
  sidebar.isConnected = true;
  header.isConnected = true;
  nativeToggle.isConnected = true;
  content.isConnected = true;
  const findById = (element, id) => {
    if (element.id === id) return element;
    for (const child of element.children) {
      const found = findById(child, id);
      if (found) return found;
    }
    return null;
  };
  const doc = {
    body,
    documentElement: body,
    createElement: makeElement,
    getElementById: (id) => findById(body, id),
    defaultView: {
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    },
  };
  return { doc, sidebar, header, nativeToggle, content };
}

test("the visible right sidebar receives one AI chat launcher beside its toggle", async () => {
  const { doc, sidebar, header, nativeToggle } = createSidebarLauncherDocument();
  const opens = [];
  const closes = [];
  let chatOpen = false;
  const placement = findSidebarChatLauncherPlacement(doc);
  assert.equal(placement.header, header);
  assert.equal(placement.nativeToggle, nativeToggle);

  const button = mountSidebarChatLauncher({
    doc,
    openChatImpl: async () => {
      opens.push("open");
      chatOpen = true;
    },
    closeChatImpl: async () => {
      closes.push("close");
      chatOpen = false;
    },
    isChatOpenImpl: () => chatOpen,
  });
  assert.deepEqual(header.children, [button, nativeToggle]);
  assert.equal(button.title, "Open Codex chat");
  assert.equal(button["aria-label"], "Open Codex chat");
  assert.equal(mountSidebarChatLauncher({
    doc,
    isChatOpenImpl: () => chatOpen,
  }), button);
  assert.equal(header.children.length, 2);

  await button.listeners.click();
  assert.deepEqual(opens, ["open"]);
  assert.equal(button.dataset.state, "idle");
  assert.equal(button.dataset.chatOpen, "true");
  assert.equal(button.title, "Close Codex chat");
  assert.equal(button["aria-label"], "Close Codex chat");
  assert.equal(button["aria-pressed"], "true");
  assert.equal(button.disabled, false);

  await button.listeners.click();
  assert.deepEqual(closes, ["close"]);
  assert.equal(button.dataset.chatOpen, "false");
  assert.equal(button.title, "Open Codex chat");
  assert.equal(button["aria-pressed"], "false");

  sidebar.width = 0;
  assert.equal(mountSidebarChatLauncher({ doc }), null);
  assert.deepEqual(header.children, [nativeToggle]);
});

test("sidebar launcher reports opening failures and observer cleanup removes it", async () => {
  const { doc, sidebar } = createSidebarLauncherDocument();
  const notifications = [];
  const timers = new Map();
  let nextTimer = 1;
  let observed;
  let disconnected = false;
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target, options) {
      observed = { target, options, observer: this };
    }
    disconnect() {
      disconnected = true;
    }
  }
  const controller = installSidebarChatLauncher({
    doc,
    MutationObserverImpl: FakeMutationObserver,
    requestAnimationFrameImpl: (callback) => {
      callback();
      return 1;
    },
    cancelAnimationFrameImpl: () => {},
    openChatImpl: async () => {
      throw new Error("no bridge");
    },
    notifyImpl: (...args) => notifications.push(args),
    setTimeoutImpl: (callback) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeoutImpl: (id) => timers.delete(id),
  });
  const button = doc.getElementById("roam-codex-sidebar-chat-launcher");
  await button.listeners.click();
  assert.equal(button.dataset.state, "error");
  assert.deepEqual(notifications, [[
    "Codex chat could not open: no bridge",
    "danger",
  ]]);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.equal(button.dataset.state, "idle");
  assert.equal(observed.target, doc.body);
  assert.equal(observed.options.subtree, true);

  sidebar.width = 0;
  observed.observer.callback([{ target: sidebar }]);
  assert.equal(doc.getElementById("roam-codex-sidebar-chat-launcher"), null);

  controller.dispose();
  assert.equal(disconnected, true);
});

test("prompt blocks open through Roam's native right-sidebar window API", async () => {
  const windows = [];
  const calls = [];
  const api = {
    ui: {
      rightSidebar: {
        addWindow: async (input) => {
          calls.push(input);
          windows.push({
            ...input.window,
            "window-id": "sidebar-block-prompt123",
            "collapsed?": false,
          });
        },
        getWindows: () => windows,
      },
    },
  };

  const sidebarWindow = await openPromptBlockInSidebar("prompt123", { api });
  assert.deepEqual(calls, [{
    window: { type: "block", "block-uid": "prompt123", order: 0 },
  }]);
  assert.equal(sidebarWindow["window-id"], "sidebar-block-prompt123");
  assert.equal(findSidebarBlockWindow("prompt123", { api }), sidebarWindow);
});

test("chat uses a focused block without creating or changing graph data", async () => {
  let created = false;
  const api = {
    ui: {
      getFocusedBlock: () => ({ "block-uid": "focused123" }),
    },
    data: {
      block: {
        create: async () => {
          created = true;
        },
      },
    },
  };

  assert.deepEqual(await resolveChatPromptBlock(undefined, { api }), {
    uid: "focused123",
    scratch: false,
  });
  assert.equal(created, false);
});

test("chat creates one ordinary scratch block on the current main view when nothing is focused", async () => {
  const writes = [];
  const api = {
    ui: {
      getFocusedBlock: () => null,
      mainWindow: {
        getOpenPageOrBlockUid: async () => "current123",
      },
    },
    util: { generateUID: () => "scratch123" },
    data: {
      block: {
        create: async (input) => writes.push(input),
      },
    },
  };

  assert.deepEqual(await resolveChatPromptBlock(undefined, { api }), {
    uid: "scratch123",
    scratch: true,
    parentUid: "current123",
  });
  assert.deepEqual(writes, [{
    location: { "parent-uid": "current123", order: "last" },
    block: { uid: "scratch123", string: CHAT_COMPOSER_PLACEHOLDER },
  }]);
});

test("chat uses today's Daily Note when the main window is the Daily Notes log", async () => {
  const pageWrites = [];
  const blockWrites = [];
  const date = new Date(2026, 6, 31, 12);
  const api = {
    ui: {
      getFocusedBlock: () => null,
      mainWindow: { getOpenPageOrBlockUid: async () => null },
    },
    util: {
      dateToPageUid: () => "07-31-2026",
      dateToPageTitle: () => "July 31st, 2026",
      generateUID: () => "scratch456",
    },
    data: {
      async: { pull: async () => null },
      page: { create: async (input) => pageWrites.push(input) },
      block: { create: async (input) => blockWrites.push(input) },
    },
  };

  assert.deepEqual(await resolveChatPromptBlock(undefined, { api, date }), {
    uid: "scratch456",
    scratch: true,
    parentUid: "07-31-2026",
  });
  assert.deepEqual(pageWrites, [{ page: { title: "July 31st, 2026" } }]);
  assert.equal(blockWrites[0].location["parent-uid"], "07-31-2026");
});

test("scratch prompt cleanup removes its native window and exact block UID", async () => {
  const calls = [];
  const api = {
    ui: {
      rightSidebar: {
        getWindows: () => [{ type: "block", "block-uid": "scratch123" }],
        removeWindow: async (input) => calls.push(["window", input]),
      },
    },
    data: {
      block: {
        delete: async (input) => calls.push(["block", input]),
      },
    },
  };

  await removeScratchPromptBlock("scratch123", { api });
  assert.deepEqual(calls, [
    ["window", { window: { type: "block", "block-uid": "scratch123" } }],
    ["block", { block: { uid: "scratch123" } }],
  ]);
});

test("composer reset clears the unchanged submitted outline but keeps its root UID", async () => {
  let currentText = "Question with [[Project]]";
  const updates = [];
  const deletions = [];
  const api = {
    data: {
      async: {
        pull: async () => ({
          ":block/uid": "scratch123",
          ":block/string": currentText,
          ":block/children": [{
            ":block/uid": "child123",
            ":block/string": "Nested context",
          }],
        }),
      },
      block: {
        update: async (input) => updates.push(input),
        delete: async (input) => deletions.push(input),
      },
    },
  };
  const prompt = {
    uid: "scratch123",
    text: "Question with [[Project]]",
    outline: {
      uid: "scratch123",
      string: "Question with [[Project]]",
      children: [{
        uid: "child123",
        string: "Nested context",
        children: [],
      }],
    },
  };

  assert.equal(await clearScratchPromptBlock(prompt, { api }), true);
  assert.deepEqual(updates, [{
    block: { uid: "scratch123", string: CHAT_COMPOSER_PLACEHOLDER },
  }]);
  assert.deepEqual(deletions, [{ block: { uid: "child123" } }]);

  currentText = "A new draft typed during the turn";
  assert.equal(await clearScratchPromptBlock(prompt, { api }), false);
  assert.equal(updates.length, 1);
});

test("failed send restoration recreates the exact submitted outline", async () => {
  const creates = [];
  const updates = [];
  const api = {
    data: {
      async: {
        pull: async () => ({
          ":block/uid": "scratchRoot",
          ":block/string": CHAT_COMPOSER_PLACEHOLDER,
          ":block/children": [],
        }),
      },
      block: {
        create: async (input) => creates.push(input),
        update: async (input) => updates.push(input),
      },
    },
  };
  const prompt = {
    uid: "nestedPrompt",
    text: "Please use ((sourceUid))",
    outline: {
      uid: "nestedPrompt",
      string: "Please use ((sourceUid))",
      children: [],
    },
    rootOutline: {
      uid: "scratchRoot",
      string: "Planning question",
      children: [{
        uid: "nestedPrompt",
        string: "Please use ((sourceUid))",
        children: [{
          uid: "context123",
          string: "Nested [[context]]",
          children: [],
        }],
      }],
    },
  };

  assert.equal(await restoreClearedChatPromptBlock(prompt, {
    api,
    rootBlockUid: "scratchRoot",
    scratchPrompt: true,
  }), true);
  assert.deepEqual(creates, [{
    location: { "parent-uid": "scratchRoot", order: 0 },
    block: { uid: "nestedPrompt", string: "Please use ((sourceUid))" },
  }, {
    location: { "parent-uid": "nestedPrompt", order: 0 },
    block: { uid: "context123", string: "Nested [[context]]" },
  }]);
  assert.deepEqual(updates, [{
    block: { uid: "scratchRoot", string: "Planning question" },
  }]);
});

test("failed send restoration never overwrites a newer composer draft", async () => {
  const writes = [];
  const api = {
    data: {
      async: {
        pull: async () => ({
          ":block/uid": "prompt123",
          ":block/string": "A newer draft",
          ":block/children": [],
        }),
      },
      block: {
        create: async (input) => writes.push(input),
        update: async (input) => writes.push(input),
      },
    },
  };
  const prompt = {
    uid: "prompt123",
    text: "Submitted draft",
    outline: {
      uid: "prompt123",
      string: "Submitted draft",
      children: [],
    },
  };

  assert.equal(await restoreClearedChatPromptBlock(prompt, { api }), false);
  assert.deepEqual(writes, []);
});

test("a submitted child resets the complete extension-created composer root", async () => {
  const updates = [];
  const deletions = [];
  const api = {
    data: {
      async: {
        pull: async () => ({
          ":block/uid": "scratchRoot",
          ":block/string": "testing nested",
          ":block/children": [{
            ":block/uid": "focusedChild",
            ":block/string": "hello again seeing if it clears",
          }],
        }),
      },
      block: {
        update: async (input) => updates.push(input),
        delete: async (input) => deletions.push(input),
      },
    },
  };
  const prompt = {
    uid: "focusedChild",
    text: "hello again seeing if it clears",
    outline: {
      uid: "focusedChild",
      string: "hello again seeing if it clears",
      children: [],
    },
    rootOutline: {
      uid: "scratchRoot",
      string: "testing nested",
      children: [{
        uid: "focusedChild",
        string: "hello again seeing if it clears",
        children: [],
      }],
    },
  };

  assert.equal(await clearScratchPromptBlock(prompt, {
    api,
    rootBlockUid: "scratchRoot",
    scratchPrompt: true,
  }), true);
  assert.deepEqual(deletions, [{ block: { uid: "focusedChild" } }]);
  assert.deepEqual(updates, [{
    block: { uid: "scratchRoot", string: CHAT_COMPOSER_PLACEHOLDER },
  }]);
});

test("composer reset preserves the whole outline after an in-flight child edit", async () => {
  const writes = [];
  const api = {
    data: {
      async: {
        pull: async () => ({
          ":block/uid": "prompt123",
          ":block/string": "Question",
          ":block/children": [{
            ":block/uid": "child123",
            ":block/string": "Edited while Codex worked",
          }],
        }),
      },
      block: {
        update: async (input) => writes.push(input),
        delete: async (input) => writes.push(input),
      },
    },
  };
  const prompt = {
    uid: "prompt123",
    text: "Question",
    outline: {
      uid: "prompt123",
      string: "Question",
      children: [{ uid: "child123", string: "Original", children: [] }],
    },
  };

  assert.equal(await clearScratchPromptBlock(prompt, { api }), false);
  assert.deepEqual(writes, []);
});

test("composer cleanup deletes only an untouched temporary placeholder", async () => {
  const strings = new Map([
    ["empty123", CHAT_COMPOSER_PLACEHOLDER],
    ["draft123", `${CHAT_COMPOSER_PLACEHOLDER}Next question`],
    ["gone123", null],
  ]);
  const deleted = [];
  const api = {
    data: {
      async: {
        pull: async (_pattern, [_attribute, uid]) => {
          const string = strings.get(uid);
          return typeof string === "string" ? { ":block/string": string } : null;
        },
      },
      block: {
        delete: async ({ block }) => deleted.push(block.uid),
      },
    },
  };

  assert.deepEqual(
    await removeResetChatPromptBlocks(
      new Set(["empty123", "draft123", "gone123"]),
      { api },
    ),
    ["empty123"],
  );
  assert.deepEqual(deleted, ["empty123"]);
});

test("chat snapshots every block that existed in the outline when it opened", async () => {
  const api = {
    data: {
      async: {
        pull: async () => ({
          ":block/uid": "root123",
          ":block/children": [{
            ":block/uid": "child123",
            ":block/children": [{ ":block/uid": "grand123" }],
          }],
        }),
      },
    },
  };

  assert.deepEqual(
    [...await readPromptOutlineUids("root123", { api })],
    ["root123", "child123", "grand123"],
  );
});

test("only scratch roots and blocks created after chat opened are clearable", () => {
  const protectedPromptUids = new Set(["root123", "existing1"]);
  assert.equal(shouldClearChatPrompt("root123", {
    scratchPrompt: false,
    protectedPromptUids,
  }), false);
  assert.equal(shouldClearChatPrompt("existing1", {
    scratchPrompt: false,
    protectedPromptUids,
  }), false);
  assert.equal(shouldClearChatPrompt("newchild1", {
    scratchPrompt: false,
    protectedPromptUids,
  }), true);
  assert.equal(shouldClearChatPrompt("scratch1", {
    scratchPrompt: true,
    protectedPromptUids: null,
  }), true);
  assert.equal(shouldClearChatPrompt("unknown1", {
    scratchPrompt: false,
    protectedPromptUids: null,
  }), false);
});

test("open chat defers scratch cleanup until an active turn is idle", async () => {
  const nativeContent = {};
  const classes = new Set();
  const headerClasses = new Set();
  let insertedBefore;
  let appendedControls;
  const host = {
    firstElementChild: {
      nextSibling: nativeContent,
      classList: {
        add: (value) => headerClasses.add(value),
        remove: (value) => headerClasses.delete(value),
      },
    },
    insertBefore(element, before) {
      this.inserted = element;
      insertedBefore = before;
    },
    appendChild(element) {
      appendedControls = element;
    },
    classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
    },
  };
  const doc = {
    getElementById: (id) =>
      id === "sidebar-window-sidebar-block-scratch789" ? host : null,
  };
  let releaseIdle;
  const idle = new Promise((resolve) => {
    releaseIdle = resolve;
  });
  const removed = [];
  let panelOptions;
  const controller = await openChatPanel({
    api: {},
    doc,
    storage: {},
    resolvePromptBlock: async () => ({ uid: "scratch789", scratch: true }),
    openPromptBlock: async () => ({
      type: "block",
      "block-uid": "scratch789",
      "window-id": "sidebar-block-scratch789",
    }),
    removeScratchPrompt: async (uid) => removed.push(uid),
    createPanel: (options) => {
      panelOptions = options;
      return {
        element: { isConnected: true },
        controlsElement: { role: "controls" },
        rootBlockUid: options.rootBlockUid,
        focus: async () => {},
        close: () => options.onClose({ whenIdle: () => idle }),
      };
    },
  });

  assert.equal(panelOptions.rootBlockUid, "scratch789");
  assert.equal(panelOptions.scratchPrompt, true);
  assert.equal(insertedBefore, nativeContent);
  assert.deepEqual(appendedControls, { role: "controls" });
  assert.equal(classes.has("roam-codex-chat-window"), true);
  assert.equal(headerClasses.has("roam-codex-native-window-header"), true);
  const closing = controller.close();
  await Promise.resolve();
  assert.equal(classes.has("roam-codex-chat-window"), false);
  assert.equal(headerClasses.has("roam-codex-native-window-header"), false);
  assert.deepEqual(removed, []);
  releaseIdle();
  await closing;
  assert.deepEqual(removed, ["scratch789"]);
});

test("open chat removes a newly created scratch block when sidebar opening fails", async () => {
  const removed = [];
  await assert.rejects(
    openChatPanel({
      api: {},
      doc: {},
      storage: {},
      resolvePromptBlock: async () => ({ uid: "scratch999", scratch: true }),
      openPromptBlock: async () => {
        throw new Error("sidebar unavailable");
      },
      removeScratchPrompt: async (uid) => removed.push(uid),
    }),
    /sidebar unavailable/,
  );
  assert.deepEqual(removed, ["scratch999"]);
});

test("the focused native sidebar block supplies the message", async () => {
  const api = {
    ui: {
      getFocusedBlock: () => ({
        "block-uid": "message123",
        "window-id": "sidebar-block-root123",
      }),
      rightSidebar: {
        getWindows: () => [{
          type: "block",
          "block-uid": "root123",
          "window-id": "sidebar-block-root123",
        }],
      },
    },
    data: {
      async: {
        pull: async (_pattern, [_attribute, uid]) => uid === "root123"
          ? {
            ":block/uid": "root123",
            ":block/string": "Root context",
            ":block/children": [{
              ":block/uid": "message123",
              ":block/string": `${CHAT_COMPOSER_PLACEHOLDER}Compare ((source123)) with [[Project Plan]]`,
              ":block/children": [{
                ":block/uid": "context123",
                ":block/string": "Nested context",
              }],
            }],
          }
          : {
            ":block/uid": "message123",
            ":block/string": `${CHAT_COMPOSER_PLACEHOLDER}Compare ((source123)) with [[Project Plan]]`,
            ":block/children": [{
              ":block/uid": "context123",
              ":block/string": "Nested context",
            }],
          },
      },
    },
  };

  assert.deepEqual(await readFocusedPromptBlock("root123", { api }), {
    uid: "message123",
    text: "Compare ((source123)) with [[Project Plan]]",
    outline: {
      uid: "message123",
      string: `${CHAT_COMPOSER_PLACEHOLDER}Compare ((source123)) with [[Project Plan]]`,
      children: [{
        uid: "context123",
        string: "Nested context",
        children: [],
      }],
    },
    rootOutline: {
      uid: "root123",
      string: "Root context",
      children: [{
        uid: "message123",
        string: `${CHAT_COMPOSER_PLACEHOLDER}Compare ((source123)) with [[Project Plan]]`,
        children: [{
          uid: "context123",
          string: "Nested context",
          children: [],
        }],
      }],
    },
  });
});

test("an empty focused child sends its nearest non-empty composer ancestor", async () => {
  const root = {
    ":block/uid": "root123",
    ":block/string": "test 123",
    ":block/children": [{
      ":block/uid": "emptyChild",
      ":block/string": "",
    }],
  };
  const api = {
    ui: {
      getFocusedBlock: () => ({
        "block-uid": "emptyChild",
        "window-id": "sidebar-block-root123",
      }),
      rightSidebar: {
        getWindows: () => [{
          type: "block",
          "block-uid": "root123",
          "window-id": "sidebar-block-root123",
        }],
      },
    },
    data: {
      async: {
        pull: async (_pattern, [_attribute, uid]) => uid === "root123"
          ? root
          : {
            ":block/uid": "emptyChild",
            ":block/string": "",
          },
      },
    },
  };

  assert.deepEqual(await readFocusedPromptBlock("root123", { api }), {
    uid: "root123",
    text: "test 123",
    outline: {
      uid: "root123",
      string: "test 123",
      children: [{
        uid: "emptyChild",
        string: "",
        children: [],
      }],
    },
    rootOutline: {
      uid: "root123",
      string: "test 123",
      children: [{
        uid: "emptyChild",
        string: "",
        children: [],
      }],
    },
  });
});

test("an empty focused outline still asks for a message", async () => {
  const api = {
    ui: {
      getFocusedBlock: () => ({
        "block-uid": "emptyChild",
        "window-id": "sidebar-block-root123",
      }),
      rightSidebar: {
        getWindows: () => [{
          type: "block",
          "block-uid": "root123",
          "window-id": "sidebar-block-root123",
        }],
      },
    },
    data: {
      async: {
        pull: async (_pattern, [_attribute, uid]) => uid === "root123"
          ? {
            ":block/uid": "root123",
            ":block/string": CHAT_COMPOSER_PLACEHOLDER,
            ":block/children": [{
              ":block/uid": "emptyChild",
              ":block/string": "",
            }],
          }
          : {
            ":block/uid": "emptyChild",
            ":block/string": "",
          },
      },
    },
  };

  await assert.rejects(
    readFocusedPromptBlock("root123", { api }),
    /Write a message in this Roam outline before sending/,
  );
});

test("chat clears a scratch composer before requesting a reply", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const makeElement = (tagName) => {
    const classes = new Set();
    const element = {
      tagName,
      children: [],
      listeners: {},
      dataset: {},
      className: "",
      value: "",
      removed: false,
      scrollHeight: 0,
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      replaceChildren(...children) {
        this.children = children;
      },
      setAttribute(name, value) {
        this[name] = String(value);
      },
      addEventListener(name, handler) {
        this.listeners[name] = handler;
      },
      remove() {
        this.removed = true;
      },
      focus() {
        this.focused = true;
      },
      classList: {
        toggle(value) {
          if (classes.has(value)) {
            classes.delete(value);
            return false;
          }
          classes.add(value);
          return true;
        },
      },
    };
    return element;
  };
  const doc = { createElement: makeElement };
  let focusAfterClear;
  let resetPromptUidsAtClose;
  const api = {
    ui: {
      getFocusedBlock: () => null,
      rightSidebar: {
        getWindows: () => [{
          type: "block",
          "block-uid": "root123",
          "window-id": "sidebar-block-root123",
        }],
      },
      setBlockFocusAndSelection: async (input) => {
        focusAfterClear = input;
      },
    },
  };
  let chatRequests = 0;
  const messageRequests = [];
  const historyRequests = [];
  const clearedPrompts = [];
  const lifecycle = [];
  const controller = createChatPanel({
    doc,
    storage,
    api,
    rootBlockUid: "root123",
    readPromptImpl: async () => ({ uid: "prompt123", text: "Hello" }),
    requestChatImpl: async () => {
      lifecycle.push("request");
      chatRequests += 1;
      return {
        threadId: "thread_12345678",
        turnId: "turn-1",
        reply: "Hello back",
      };
    },
    scratchPrompt: true,
    protectedPromptUids: new Set(["root123"]),
    clearScratchPromptImpl: async (prompt) => {
      lifecycle.push("clear");
      clearedPrompts.push(prompt);
      return true;
    },
    onClose: ({ resetPromptUids }) => {
      resetPromptUidsAtClose = resetPromptUids;
    },
    requestModelsImpl: async () => [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      isDefault: true,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "medium" },
        { reasoningEffort: "high" },
      ],
    }],
    requestMessagesImpl: async (threadId) => {
      messageRequests.push(threadId);
      return [
        { role: "user", text: "Hello" },
        { role: "assistant", text: "Hello back" },
      ];
    },
    requestHistoryImpl: async (threadIds) => {
      historyRequests.push(threadIds);
      return {
        threads: threadIds.map((id) => ({
          id,
          name: null,
          preview: "Authoritative first prompt",
          createdAt: 10,
          updatedAt: 20,
        })),
        missingThreadIds: [],
        unavailableThreadIds: [],
      };
    },
  });
  await Promise.resolve();

  assert.equal(controller.element.id, "roam-codex-chat-panel");
  const allElements = [];
  const visit = (element) => {
    allElements.push(element);
    for (const child of element.children || []) visit(child);
  };
  visit(controller.element);
  visit(controller.controlsElement);
  assert.equal(allElements.some((element) => element.tagName === "textarea"), false);
  assert.equal(
    allElements.some((element) => element.className === "roam-codex-chat-empty"),
    false,
  );
  assert.equal(
    allElements.some(
      (element) => element.className === "roam-codex-chat-send-hint",
    ),
    false,
  );
  const panelText = allElements
    .map((element) => element.textContent || "")
    .join(" ");
  assert.doesNotMatch(panelText, /Write in the native Block Outline/);
  assert.doesNotMatch(panelText, /Temporary Roam block/);
  assert.equal(
    allElements.find(
      (element) => element.className === "roam-codex-chat-transcript",
    ).hidden,
    true,
  );
  const pickerButton = allElements.find(
    (element) => element.className === "roam-codex-chat-picker-button",
  );
  const pickerMenu = allElements.find(
    (element) => element.className === "roam-codex-chat-picker-menu",
  );
  assert.equal(pickerButton.textContent, "GPT-5.6-Sol · Low");
  assert.equal(pickerMenu.hidden, true);
  pickerButton.listeners.click();
  assert.equal(pickerMenu.hidden, false);
  assert.deepEqual(
    pickerMenu.children.map((row) => row.children?.[0]?.textContent),
    ["Model", "Effort"],
  );
  assert.deepEqual(
    pickerMenu.children.map((row) => row.children?.[1]?.textContent),
    ["GPT-5.6-Sol", "Low"],
  );
  pickerMenu.children[1].listeners.click();
  assert.deepEqual(
    pickerMenu.children.map((option) => option.textContent),
    ["‹ Effort", "Low (Default)", "Medium", "High"],
  );
  assert.deepEqual(
    pickerMenu.children
      .slice(1)
      .map((option) => option.className.includes("is-active")),
    [true, false, false],
  );
  pickerMenu.children[0].listeners.click();
  assert.deepEqual(
    pickerMenu.children.map((row) => row.children?.[0]?.textContent),
    ["Model", "Effort"],
  );
  pickerButton.listeners.click();
  assert.equal(pickerMenu.hidden, true);
  assert.equal(chatRequests, 0);
  assert.equal(readChatState({ storage }).activeThreadId, null);

  const result = await controller.send();
  assert.equal(result.reply, "Hello back");
  assert.equal(chatRequests, 1);
  assert.deepEqual(lifecycle, ["clear", "request"]);
  assert.deepEqual(clearedPrompts, [{ uid: "prompt123", text: "Hello" }]);
  assert.deepEqual(focusAfterClear, {
    location: {
      "block-uid": "root123",
      "window-id": "sidebar-block-root123",
    },
  });

  await Promise.resolve();
  await Promise.resolve();
  const conversationButton = allElements.find(
    (element) => element.className === "roam-codex-chat-conversation",
  );
  const historyPopover = allElements.find(
    (element) => element.className === "roam-codex-chat-history",
  );
  assert.equal(conversationButton.textContent, "Authoritative first prompt");
  assert.deepEqual(historyRequests, [["thread_12345678"]]);

  conversationButton.listeners.click();
  assert.equal(historyPopover.hidden, false);
  assert.equal(historyPopover.children[0].textContent, "+ New chat");
  historyPopover.children[0].listeners.click();
  assert.equal(readChatState({ storage }).activeThreadId, null);
  assert.equal(readChatState({ storage }).conversations.thread_12345678.threadId,
    "thread_12345678");
  assert.deepEqual(readChatState({ storage }).newConversationPreferences, {
    model: "gpt-5.6-sol",
    effort: "low",
    speed: null,
  });
  assert.equal(chatRequests, 1);
  assert.equal(
    allElements.find(
      (element) => element.className === "roam-codex-chat-transcript",
    ).hidden,
    true,
  );

  conversationButton.listeners.click();
  const historyThreadButton = historyPopover.children.find(
    (element) => element.dataset?.threadId === "thread_12345678",
  );
  historyThreadButton.listeners.click();
  await Promise.resolve();
  assert.equal(readChatState({ storage }).activeThreadId, "thread_12345678");
  assert.deepEqual(messageRequests, ["thread_12345678"]);

  await controller.close();
  assert.deepEqual([...resetPromptUidsAtClose], ["root123"]);
  assert.equal(controller.element.removed, true);
  assert.equal(controller.controlsElement.removed, true);
});

test("a failed or stopped turn restores the submitted outline after optimistic clear", async (t) => {
  for (const scenario of ["failure", "stop"]) {
    await t.test(scenario, async () => {
      const lifecycle = [];
      const focusedUids = [];
      const failure = new Error(
        scenario === "stop" ? "Turn interrupted." : "Bridge unavailable",
      );
      if (scenario === "stop") failure.code = "TURN_INTERRUPTED";
      const controller = createChatPanel({
        doc: createFakePanelDocument(),
        storage: {
          getItem: () => null,
          setItem: () => {},
        },
        api: {
          ui: {
            rightSidebar: {
              getWindows: () => [{
                type: "block",
                "block-uid": "root123",
                "window-id": "sidebar-block-root123",
              }],
            },
            setBlockFocusAndSelection: async ({ location }) => {
              focusedUids.push(location["block-uid"]);
            },
          },
        },
        rootBlockUid: "root123",
        protectedPromptUids: new Set(["root123"]),
        readPromptImpl: async () => ({
          uid: "prompt123",
          text: "Retry this",
          outline: {
            uid: "prompt123",
            string: "Retry this",
            children: [],
          },
        }),
        clearScratchPromptImpl: async () => {
          lifecycle.push("clear");
          return true;
        },
        restorePromptImpl: async () => {
          lifecycle.push("restore");
          return true;
        },
        requestChatImpl: async () => {
          lifecycle.push("request");
          throw failure;
        },
        requestModelsImpl: async () => [],
        requestHistoryImpl: async () => ({
          threads: [],
          missingThreadIds: [],
          unavailableThreadIds: [],
        }),
      });

      assert.equal(await controller.send(), null);
      assert.deepEqual(lifecycle, ["clear", "request", "restore"]);
      assert.deepEqual(focusedUids, ["prompt123", "prompt123"]);
      await controller.close();
    });
  }
});

test("send aborts before the request when the composer cannot clear safely", async () => {
  const lifecycle = [];
  const controller = createChatPanel({
    doc: createFakePanelDocument(),
    storage: {
      getItem: () => null,
      setItem: () => {},
    },
    api: { ui: { rightSidebar: { getWindows: () => [] } } },
    rootBlockUid: "root123",
    protectedPromptUids: new Set(["root123"]),
    readPromptImpl: async () => ({ uid: "prompt123", text: "Changed" }),
    clearScratchPromptImpl: async () => {
      lifecycle.push("clear");
      return false;
    },
    restorePromptImpl: async () => {
      lifecycle.push("restore");
      return true;
    },
    requestChatImpl: async () => {
      lifecycle.push("request");
      return null;
    },
    requestModelsImpl: async () => [],
    requestHistoryImpl: async () => ({
      threads: [],
      missingThreadIds: [],
      unavailableThreadIds: [],
    }),
  });

  assert.equal(await controller.send(), null);
  assert.deepEqual(lifecycle, ["clear"]);
  await controller.close();
});

test("rapid history selections cannot render a stale transcript", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const state = readChatState({ storage });
  state.conversations = {
    thread_new_456: {
      threadId: "thread_new_456",
      createdAt: 30,
      updatedAt: 40,
      model: "gpt-5.6-sol",
      effort: "low",
      threadPageUid: null,
    },
    thread_old_123: {
      threadId: "thread_old_123",
      createdAt: 10,
      updatedAt: 20,
      model: "gpt-5.6-sol",
      effort: "low",
      threadPageUid: null,
    },
  };
  writeChatState(state, { storage });

  const pendingMessages = new Map();
  const doc = createFakePanelDocument();
  const controller = createChatPanel({
    doc,
    storage,
    api: {
      ui: {
        rightSidebar: {
          getWindows: () => [{
            type: "block",
            "block-uid": "root123",
            "window-id": "sidebar-block-root123",
          }],
        },
      },
    },
    rootBlockUid: "root123",
    requestModelsImpl: async () => [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      isDefault: true,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    }],
    requestHistoryImpl: async (threadIds) => ({
      threads: threadIds.map((id) => ({
        id,
        name: null,
        preview: id === "thread_new_456" ? "Newer chat" : "Older chat",
        createdAt: id === "thread_new_456" ? 30 : 10,
        updatedAt: id === "thread_new_456" ? 40 : 20,
      })),
      missingThreadIds: [],
      unavailableThreadIds: [],
    }),
    requestMessagesImpl: (threadId) => new Promise((resolve) => {
      pendingMessages.set(threadId, resolve);
    }),
  });
  await Promise.resolve();
  await Promise.resolve();

  const elements = panelElements(controller);
  const conversationButton = elements.find(
    (element) => element.className === "roam-codex-chat-conversation",
  );
  const historyPopover = elements.find(
    (element) => element.className === "roam-codex-chat-history",
  );
  conversationButton.listeners.click();
  historyPopover.children.find(
    (element) => element.dataset?.threadId === "thread_new_456",
  ).listeners.click();
  conversationButton.listeners.click();
  historyPopover.children.find(
    (element) => element.dataset?.threadId === "thread_old_123",
  ).listeners.click();

  pendingMessages.get("thread_old_123")([
    { role: "user", text: "Older question" },
    { role: "assistant", text: "Older reply" },
  ]);
  await Promise.resolve();
  pendingMessages.get("thread_new_456")([
    { role: "user", text: "Newer question" },
    { role: "assistant", text: "Newer reply" },
  ]);
  await Promise.resolve();

  const transcript = elements.find(
    (element) => element.className === "roam-codex-chat-transcript",
  );
  assert.match(transcript.textContent, /Older question/);
  assert.doesNotMatch(transcript.textContent, /Newer question/);
  assert.equal(readChatState({ storage }).activeThreadId, "thread_old_123");
  await controller.close();
});

test("history closes accessibly and cannot switch during an active turn", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const state = readChatState({ storage });
  state.activeThreadId = "thread_active_1";
  state.conversations = {
    thread_active_1: {
      threadId: "thread_active_1",
      createdAt: 10,
      updatedAt: 20,
      model: "gpt-5.6-sol",
      effort: "low",
      threadPageUid: null,
    },
  };
  writeChatState(state, { storage });

  let finishTurn;
  const turn = new Promise((resolve) => {
    finishTurn = resolve;
  });
  const doc = createFakePanelDocument();
  const controller = createChatPanel({
    doc,
    storage,
    api: {
      ui: {
        rightSidebar: {
          getWindows: () => [{
            type: "block",
            "block-uid": "root123",
            "window-id": "sidebar-block-root123",
          }],
        },
        setBlockFocusAndSelection: async () => {},
      },
    },
    rootBlockUid: "root123",
    readPromptImpl: async () => ({ uid: "newPrompt1", text: "Next" }),
    clearScratchPromptImpl: async () => true,
    requestChatImpl: async () => {
      await turn;
      return {
        threadId: "thread_active_1",
        turnId: "turn-1",
        reply: "Done",
      };
    },
    requestModelsImpl: async () => [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      isDefault: true,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    }],
    requestMessagesImpl: async () => [],
    requestHistoryImpl: async (threadIds) => ({
      threads: threadIds.map((id) => ({
        id,
        name: null,
        preview: "Active chat",
        createdAt: 10,
        updatedAt: 20,
      })),
      missingThreadIds: [],
      unavailableThreadIds: [],
    }),
  });
  await Promise.resolve();
  await Promise.resolve();

  const elements = panelElements(controller);
  const conversationButton = elements.find(
    (element) => element.className === "roam-codex-chat-conversation",
  );
  const historyPopover = elements.find(
    (element) => element.className === "roam-codex-chat-history",
  );
  conversationButton.listeners.click();
  let prevented = false;
  doc.listeners.keydown({
    key: "Escape",
    defaultPrevented: false,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {},
  });
  assert.equal(prevented, true);
  assert.equal(historyPopover.hidden, true);
  assert.equal(conversationButton.focused, true);

  conversationButton.listeners.click();
  doc.listeners.click({ target: doc.createElement("div") });
  assert.equal(historyPopover.hidden, true);

  conversationButton.listeners.click();
  const sending = controller.send();
  assert.equal(conversationButton.disabled, true);
  assert.equal(
    historyPopover.children.every((child) =>
      child.className?.includes("history-item") ? child.disabled : true
    ),
    true,
  );
  finishTurn();
  await sending;
  assert.equal(conversationButton.disabled, false);
  await controller.close();
});

test("Send yields its slot to Stop while a turn runs and names its shortcut", async () => {
  let finishTurn;
  const turn = new Promise((resolve) => {
    finishTurn = resolve;
  });
  const doc = createFakePanelDocument();
  const controller = createChatPanel({
    doc,
    api: {},
    storage: {
      getItem: () => null,
      setItem: () => {},
    },
    rootBlockUid: "root123",
    navigatorImpl: { platform: "MacIntel" },
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
    readPromptImpl: async () => ({ uid: "root123", text: "Hi" }),
    requestChatImpl: async () => {
      await turn;
      return { threadId: "thread_slot_1234", turnId: "turn-1", reply: "Done" };
    },
    requestModelsImpl: async () => [],
    requestMessagesImpl: async () => [],
    requestHistoryImpl: async () => ({
      threads: [],
      missingThreadIds: [],
      unavailableThreadIds: [],
    }),
  });

  const elements = panelElements(controller);
  const sendButton = elements.find(
    (element) => element.className === "roam-codex-chat-send",
  );
  const stopButton = elements.find(
    (element) => element.className === "roam-codex-chat-stop",
  );
  const shortcut = sendButton.children.find(
    (element) => element.className === "roam-codex-chat-send-kbd",
  );
  const progressMeta = elements.find(
    (element) => element.className === "roam-codex-chat-progress-meta",
  );
  const progressTimer = elements.find(
    (element) => element.className === "roam-codex-chat-progress-timer",
  );
  assert.match(sendButton.title, /Option\+Enter/);
  assert.equal(shortcut.textContent, "⌥⏎");
  assert.equal(shortcut["aria-hidden"], "true");
  assert.equal(sendButton.hidden, false);
  assert.equal(stopButton.hidden, true);
  assert.equal(progressMeta.hidden, true);

  const sending = controller.send();
  assert.equal(sendButton.hidden, true);
  assert.equal(stopButton.hidden, false);
  assert.equal(progressMeta.hidden, false);
  assert.equal(progressTimer.textContent, "0:00");

  finishTurn();
  await sending;
  assert.equal(sendButton.hidden, false);
  assert.equal(stopButton.hidden, true);
  assert.equal(progressMeta.hidden, true);
  await controller.close();
});

test("the transcript resize handle drags, clamps, and persists its height", async () => {
  const values = new Map();
  const doc = createFakePanelDocument();
  const controller = createChatPanel({
    doc,
    api: {},
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    rootBlockUid: "root123",
    requestModelsImpl: async () => [],
    requestMessagesImpl: async () => [],
    requestHistoryImpl: async () => ({
      threads: [],
      missingThreadIds: [],
      unavailableThreadIds: [],
    }),
  });

  const handle = panelElements(controller).find(
    (element) => element.className === "roam-codex-chat-resize",
  );
  assert.equal(handle.hidden, true);
  assert.equal(handle.role, "separator");

  handle.listeners.pointerdown({ clientY: 100, preventDefault() {} });
  doc.listeners.pointermove({ clientY: 160, preventDefault() {} });
  doc.listeners.pointerup();
  assert.equal(
    values.get("roam-codex-lab.chat-transcript-height.maskys"),
    "360",
  );

  handle.listeners.pointerdown({ clientY: 0, preventDefault() {} });
  doc.listeners.pointermove({ clientY: 10_000, preventDefault() {} });
  doc.listeners.pointerup();
  assert.equal(
    values.get("roam-codex-lab.chat-transcript-height.maskys"),
    "640",
  );
  assert.equal(doc.listeners.pointermove, undefined);
  assert.equal(doc.listeners.pointerup, undefined);
  await controller.close();
});

test("the transcript offers a reduced-motion scroll-to-latest control", async () => {
  const doc = createFakePanelDocument();
  const controller = createChatPanel({
    doc,
    api: {},
    storage: {
      getItem: () => null,
      setItem: () => {},
    },
    rootBlockUid: "root123",
    matchMediaImpl: () => ({ matches: true }),
    readPromptImpl: async () => ({ uid: "root123", text: "Question" }),
    requestChatImpl: async () => ({
      threadId: "thread_scroll_1234",
      turnId: "turn-scroll",
      reply: "A sufficiently long answer",
    }),
    requestModelsImpl: async () => [],
    requestMessagesImpl: async () => [],
    requestHistoryImpl: async () => ({
      threads: [],
      missingThreadIds: [],
      unavailableThreadIds: [],
    }),
  });

  await controller.send();
  const elements = panelElements(controller);
  const transcript = elements.find(
    (element) => element.className === "roam-codex-chat-transcript",
  );
  const scrollLatest = elements.find(
    (element) => element.className === "roam-codex-chat-scroll-latest",
  );
  assert.equal(scrollLatest.hidden, true);
  assert.equal(scrollLatest["aria-label"], "Scroll to latest message");

  transcript.scrollHeight = 1_000;
  transcript.clientHeight = 200;
  transcript.scrollTop = 400;
  transcript.listeners.scroll();
  assert.equal(scrollLatest.hidden, false);

  let scrollOptions;
  transcript.scrollTo = (options) => {
    scrollOptions = options;
    transcript.scrollTop = options.top;
  };
  scrollLatest.listeners.click();
  assert.deepEqual(scrollOptions, { top: 1_000, behavior: "auto" });
  assert.equal(scrollLatest.hidden, true);

  transcript.scrollTop = 775;
  transcript.listeners.scroll();
  assert.equal(scrollLatest.hidden, false);
  transcript.scrollTop = 776;
  transcript.listeners.scroll();
  assert.equal(scrollLatest.hidden, true);

  transcript.clientHeight = 1_000;
  transcript.scrollTop = 0;
  transcript.listeners.scroll();
  assert.equal(scrollLatest.hidden, true);

  await controller.close();
  assert.equal(transcript.listeners.scroll, undefined);
});

test("the panel close control removes the native window before closing", async () => {
  const removals = [];
  const doc = createFakePanelDocument();
  const controller = createChatPanel({
    doc,
    api: {
      ui: {
        rightSidebar: {
          getWindows: () => [],
          removeWindow: async (request) => removals.push(request),
        },
      },
    },
    storage: {
      getItem: () => null,
      setItem: () => {},
    },
    rootBlockUid: "root123",
    requestModelsImpl: async () => [],
    requestMessagesImpl: async () => [],
    requestHistoryImpl: async () => ({
      threads: [],
      missingThreadIds: [],
      unavailableThreadIds: [],
    }),
  });

  const closeButton = panelElements(controller).find(
    (element) => element.className === "roam-codex-chat-close",
  );
  assert.equal(closeButton["aria-label"], "Close Codex chat");
  closeButton.listeners.click();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(removals, [
    { window: { type: "block", "block-uid": "root123" } },
  ]);
  assert.equal(controller.element.removed, true);
  assert.equal(controller.controlsElement.removed, true);
});

test("the send command acts only when focus is inside the chat window", () => {
  const sends = [];
  const panel = {
    element: { isConnected: true },
    rootBlockUid: "root123",
    send: () => {
      sends.push(true);
      return Promise.resolve(null);
    },
  };
  const apiWithFocus = (windowId) => ({
    ui: {
      getFocusedBlock: () => ({ "block-uid": "b1", "window-id": windowId }),
      rightSidebar: {
        getWindows: () => [{
          type: "block",
          "block-uid": "root123",
          "window-id": "sidebar-block-root123",
        }],
      },
    },
  });

  assert.equal(
    sendActiveChatMessage({ api: apiWithFocus("main-window"), panel }),
    null,
  );
  assert.equal(sends.length, 0);
  sendActiveChatMessage({ api: apiWithFocus("sidebar-block-root123"), panel });
  assert.equal(sends.length, 1);
  assert.equal(
    sendActiveChatMessage({
      api: apiWithFocus("sidebar-block-root123"),
      panel: null,
    }),
    null,
  );
  assert.equal(sends.length, 1);
});

test("the picker offers Speed from serviceTiers and sends the chosen tier", async () => {
  const doc = createFakePanelDocument();
  const sent = [];
  const controller = createChatPanel({
    doc,
    api: {},
    storage: {
      getItem: () => null,
      setItem: () => {},
    },
    rootBlockUid: "root123",
    readPromptImpl: async () => ({ uid: "root123", text: "Hi" }),
    requestChatImpl: async (message, options) => {
      sent.push({
        model: options.model,
        effort: options.effort,
        serviceTier: options.serviceTier,
      });
      return { threadId: "thread_speed_123", turnId: "turn-1", reply: "ok" };
    },
    requestModelsImpl: async () => [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      isDefault: true,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      defaultServiceTier: "standard",
      serviceTiers: [
        { id: "standard", name: "Standard" },
        { id: "priority", name: "Fast" },
      ],
    }],
    requestMessagesImpl: async () => [],
    requestHistoryImpl: async () => ({
      threads: [],
      missingThreadIds: [],
      unavailableThreadIds: [],
    }),
  });
  await Promise.resolve();
  await Promise.resolve();

  const elements = panelElements(controller);
  const pickerButton = elements.find(
    (element) => element.className === "roam-codex-chat-picker-button",
  );
  const pickerMenu = elements.find(
    (element) => element.className === "roam-codex-chat-picker-menu",
  );
  assert.equal(pickerButton.textContent, "GPT-5.6-Sol · Low");

  pickerButton.listeners.click();
  assert.deepEqual(
    pickerMenu.children.map((row) => row.children?.[0]?.textContent),
    ["Model", "Effort", "Speed"],
  );
  pickerMenu.children[2].listeners.click();
  assert.deepEqual(
    pickerMenu.children.map((option) => option.textContent),
    ["‹ Speed", "Standard (Default)", "Fast"],
  );
  pickerMenu.children[2].listeners.click();
  assert.equal(pickerMenu.hidden, true);
  assert.equal(pickerButton.textContent, "GPT-5.6-Sol · Low · Fast");

  await controller.send();
  assert.deepEqual(sent, [
    { model: null, effort: null, serviceTier: "priority" },
  ]);
  await controller.close();
});

test("missing history is removed while unavailable history is retained", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const state = readChatState({ storage });
  state.activeThreadId = "thread_missing_1";
  state.conversations = {
    thread_missing_1: {
      threadId: "thread_missing_1",
      createdAt: 10,
      updatedAt: 20,
      model: "gpt-5.6-sol",
      effort: "low",
      threadPageUid: null,
    },
    thread_unavailable_2: {
      threadId: "thread_unavailable_2",
      createdAt: 30,
      updatedAt: 40,
      model: "gpt-5.6-sol",
      effort: "low",
      threadPageUid: null,
    },
  };
  writeChatState(state, { storage });

  const controller = createChatPanel({
    doc: createFakePanelDocument(),
    storage,
    api: { ui: { rightSidebar: { getWindows: () => [] } } },
    rootBlockUid: "root123",
    requestModelsImpl: async () => [],
    requestMessagesImpl: async () => [],
    requestHistoryImpl: async () => ({
      threads: [],
      missingThreadIds: ["thread_missing_1"],
      unavailableThreadIds: ["thread_unavailable_2"],
    }),
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const saved = readChatState({ storage });
  assert.equal(saved.activeThreadId, null);
  assert.equal(Object.hasOwn(saved.conversations, "thread_missing_1"), false);
  assert.equal(Object.hasOwn(saved.conversations, "thread_unavailable_2"), true);
  assert.deepEqual(saved.newConversationPreferences, {
    model: "gpt-5.6-sol",
    effort: "low",
    speed: null,
  });
  await controller.close();
});

test("running presentation uses a compact elapsed timer", () => {
  assert.equal(formatRunningElapsed(0), "0:00");
  assert.equal(formatRunningElapsed(65_900), "1:05");
  assert.equal(runningPresentationText(0), "Starting · 0:00");
  assert.equal(runningPresentationText(5_000), "Working · 0:05");
  assert.equal(runningPresentationText(45_000), "Still working · 0:45");
});

test("running presentation evolves in the DOM without graph writes", async () => {
  const badges = [];
  const classes = new Set();
  const host = {
    appendChild: (badge) => badges.push(badge),
  };
  const container = {
    matches: (selector) => selector === ".roam-block-container",
    querySelector: (selector) => {
      if (selector === ".rm-block-main") return host;
      if (selector === ".roam-codex-running-status") {
        return badges.find((badge) => !badge.removed);
      }
      return null;
    },
    classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
    },
  };
  const createElement = () => {
    let ownText = "";
    return {
      children: [],
      listeners: {},
      removed: false,
      appendChild(child) {
        this.children.push(child);
      },
      addEventListener(name, handler) {
        this.listeners[name] = handler;
      },
      click() {
        return this.listeners.click?.();
      },
      querySelector(selector) {
        return this.children.find(
          (child) => `.${child.className}` === selector,
        ) || null;
      },
      setAttribute(name, value) {
        this[name] = value;
      },
      remove() {
        this.removed = true;
      },
      get textContent() {
        return ownText || this.children.map((child) => child.textContent).join("");
      },
      set textContent(value) {
        ownText = String(value);
      },
    };
  };
  const doc = {
    getElementById: (id) =>
      id === "block-input-status-uid" ? container : null,
    querySelectorAll: () => [],
    createElement,
  };
  let elapsed = 0;
  let tick;
  let clearedInterval;

  const stop = startRunningPresentation("status-uid", {
    doc,
    now: () => elapsed,
    setIntervalImpl: (callback) => {
      tick = callback;
      return 17;
    },
    clearIntervalImpl: (intervalId) => {
      clearedInterval = intervalId;
    },
  });

  assert.equal(badges.length, 1);
  assert.equal(
    badges[0]
      .querySelector(".roam-codex-running-meta")
      .querySelector(".roam-codex-running-timer").textContent,
    "0:00",
  );
  assert.equal(
    badges[0].querySelector(".roam-codex-running-summary").textContent,
    "Starting",
  );
  assert.equal(classes.has("roam-codex-running-block"), true);

  const cancelButton = badges[0]
    .querySelector(".roam-codex-running-meta")
    .querySelector(".roam-codex-running-cancel");
  assert.equal(cancelButton.hidden, true);
  let cancelled = false;
  stop.setCancelHandler(async () => {
    cancelled = true;
  });
  assert.equal(cancelButton.hidden, false);

  stop.update({ kind: "summary", text: "Reading graph context" });
  assert.equal(
    badges[0].querySelector(".roam-codex-running-summary").textContent,
    "Reading graph context",
  );
  assert.match(badges[0].title, /Roam block is not being updated/);

  elapsed = 46_000;
  tick();
  assert.equal(
    badges[0]
      .querySelector(".roam-codex-running-meta")
      .querySelector(".roam-codex-running-timer").textContent,
    "0:46",
  );
  assert.equal(
    badges[0].querySelector(".roam-codex-running-summary").textContent,
    "Reading graph context",
  );

  await cancelButton.click();
  assert.equal(cancelled, true);
  assert.equal(cancelButton.disabled, true);
  assert.equal(
    badges[0].querySelector(".roam-codex-running-summary").textContent,
    "Stopping",
  );

  stop();
  assert.equal(clearedInterval, 17);
  assert.equal(badges[0].removed, true);
  assert.equal(classes.size, 0);
});

test("pairBridge stores the origin-checked local token", async () => {
  let captured;
  const stored = [];
  const result = await pairBridge({
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ graph: "maskys", token: "paired-token" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
    storage: {
      setItem: (key, value) => stored.push([key, value]),
    },
  });

  assert.equal(captured.url, "http://127.0.0.1:47321/pair");
  assert.equal(captured.init.method, "POST");
  assert.deepEqual(JSON.parse(captured.init.body), { graph: "maskys" });
  assert.deepEqual(stored, [
    ["roam-codex-lab.bridge-token", "paired-token"],
  ]);
  assert.equal(result.graph, "maskys");
});

test("requestProbe sends the fixed graph, UID, and bearer token", async () => {
  let captured;
  const result = await requestProbe("abcdefghi", {
    token: "local-token",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({
          runId: "run-1",
          plan: {
            outcome: "applied",
            research: "not_needed",
            edits: [{ id: "b1", parent: "source", text: "Test" }],
            comments: [],
            sources: [],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  assert.equal(captured.url, "http://127.0.0.1:47321/probe");
  assert.equal(captured.init.headers.authorization, "Bearer local-token");
  assert.deepEqual(JSON.parse(captured.init.body), {
    graph: "maskys",
    blockUid: "abcdefghi",
  });
  assert.equal(result.runId, "run-1");
});

test("requestProbe streams progress before returning the completed result", async () => {
  const encoder = new TextEncoder();
  const progress = [];
  const starts = [];
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          '{"type":"started","runId":"run-1"}\n' +
            '{"type":"progress","kind":"summary","text":"Reading',
        ),
      );
      controller.enqueue(
        encoder.encode(
          ' context"}\n' +
            '{"type":"completed","result":{"runId":"run-1","plan":' +
            '{"outcome":"applied","research":"not_needed","edits":[],' +
            '"comments":[],"sources":[]}}}\n',
        ),
      );
      controller.close();
    },
  });

  const result = await requestProbe("abcdefghi", {
    token: "local-token",
    onProgress: (event) => progress.push(event),
    onStarted: (event) => starts.push(event),
    fetchImpl: async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
  });

  assert.deepEqual(progress, [
    { kind: "summary", text: "Reading context" },
  ]);
  assert.deepEqual(starts, [{ runId: "run-1" }]);
  assert.equal(result.runId, "run-1");
  assert.equal(result.plan.outcome, "applied");
});

test("requestProbe surfaces an error delivered after streaming starts", async () => {
  await assert.rejects(
    requestProbe("abcdefghi", {
      token: "local-token",
      fetchImpl: async () =>
        new Response(
          '{"type":"started","runId":"run-1"}\n' +
            '{"type":"error","error":"Turn failed."}\n',
          {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          },
        ),
    }),
    /Turn failed/,
  );
});

test("requestProbe surfaces bridge errors", async () => {
  await assert.rejects(
    requestProbe("abcdefghi", {
      token: "local-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "No MCP connection." }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    }),
    /No MCP connection/,
  );
});

test("requestRunCancellation calls the authenticated run endpoint", async () => {
  let captured;
  const result = await requestRunCancellation(
    "12345678-1234-1234-1234-123456789abc",
    {
      token: "local-token",
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return new Response(
          JSON.stringify({ ok: true, status: "interrupting" }),
          {
            status: 202,
            headers: { "content-type": "application/json" },
          },
        );
      },
    },
  );

  assert.equal(
    captured.url,
    "http://127.0.0.1:47321/runs/12345678-1234-1234-1234-123456789abc/cancel",
  );
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.authorization, "Bearer local-token");
  assert.equal(result.status, "interrupting");
});

test("applyRunPlan appends edits and puts linked sources in targeted comments", async () => {
  const generatedUids = ["created-1", "created-2"];
  const creates = [];
  const comments = [];
  const api = {
    util: {
      generateUID: () => generatedUids.shift(),
    },
    data: {
      block: {
        create: async (input) => creates.push(input),
        addComment: async (input) => {
          comments.push(input);
          return {
            uids: [`reply-${comments.length}`],
            parentUid: "comments-uid",
          };
        },
      },
    },
  };

  const result = await applyRunPlan(
    "source-uid",
    {
      outcome: "applied",
      research: "completed",
      edits: [
        { id: "b1", parent: "source", text: "First result" },
        { id: "b2", parent: "b1", text: "Nested result" },
      ],
      comments: [
        { target: "source", kind: "note", text: "Source note" },
        { target: "b2", kind: "question", text: "Which date?" },
      ],
      sources: [
        {
          target: "b2",
          title: "Official ] guide",
          url: "https://authority.example/guide(one)",
          supports: "The current deadline.",
        },
      ],
    },
    { api },
  );

  assert.deepEqual(result, {
    outcome: "applied",
    research: "completed",
    createdUids: ["created-1", "created-2"],
    sourceCommentUids: ["reply-1"],
    commentUids: ["reply-1", "reply-2", "reply-3"],
  });
  assert.deepEqual(creates, [
    {
      location: { "parent-uid": "source-uid", order: "last" },
      block: { uid: "created-1", string: "First result" },
    },
    {
      location: { "parent-uid": "created-1", order: "last" },
      block: { uid: "created-2", string: "Nested result" },
    },
  ]);
  assert.deepEqual(comments, [
    {
      "block-uid": "created-2",
      "reply-markdown":
        "- **Codex** — Sources\n  - [Official \\] guide](https://authority.example/guide%28one%29) — The current deadline.",
      "open-comment": false,
    },
    {
      "block-uid": "source-uid",
      "reply-string": "**Codex** — Source note",
      "open-comment": false,
    },
    {
      "block-uid": "created-2",
      "reply-string": "**Codex** — Which date?",
      "open-comment": true,
    },
  ]);
});

test("applyRunPlan opens the first source comment when there is no conversation", async () => {
  const comments = [];
  const api = {
    util: { generateUID: () => "created-1" },
    data: {
      block: {
        create: async () => {},
        addComment: async (input) => {
          comments.push(input);
          return { uids: ["source-reply"], parentUid: "comments-uid" };
        },
      },
    },
  };

  const result = await applyRunPlan(
    "source-uid",
    {
      outcome: "applied",
      research: "completed",
      edits: [{ id: "b1", parent: "source", text: "Current result" }],
      comments: [],
      sources: [
        {
          target: "b1",
          title: "Official guide",
          url: "https://authority.example/guide",
          supports: "The current result.",
        },
      ],
    },
    { api },
  );

  assert.deepEqual(result.sourceCommentUids, ["source-reply"]);
  assert.equal(comments[0]["open-comment"], true);
});

test("workOnBlock creates the status first and deletes it after applying edits", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const generatedUids = ["status-uid", "edit-uid"];
  const events = [];
  const api = {
    util: { generateUID: () => generatedUids.shift() },
    data: {
      block: {
        create: async (input) => events.push(["create", input]),
        delete: async (input) => events.push(["delete", input]),
        addComment: async () => ({ uids: [] }),
      },
    },
  };
  const notifications = [];

  const result = await workOnBlock("source-uid", {
    api,
    storage,
    startPresentation: (statusUid) => {
      events.push(["presentation-start", statusUid]);
      const stop = () => events.push(["presentation-stop", statusUid]);
      stop.update = (progress) =>
        events.push(["presentation-update", progress.text]);
      return stop;
    },
    request: async (_blockUid, { onProgress }) => {
      events.push(["request"]);
      onProgress({ kind: "summary", text: "Reading graph context" });
      return {
        plan: {
          outcome: "applied",
          research: "not_needed",
          edits: [{ id: "b1", parent: "source", text: "Direct result" }],
          comments: [],
          sources: [],
        },
      };
    },
    notifyImpl: (...args) => notifications.push(args),
  });

  assert.equal(events[0][0], "create");
  assert.deepEqual(events[0][1], {
    location: { "parent-uid": "source-uid", order: "last" },
    block: { uid: "status-uid", string: RUNNING_BLOCK_TEXT },
  });
  assert.deepEqual(events[1], ["presentation-start", "status-uid"]);
  assert.equal(events[2][0], "request");
  assert.deepEqual(events[3], [
    "presentation-update",
    "Reading graph context",
  ]);
  assert.deepEqual(events[4], [
    "create",
    {
      location: { "parent-uid": "source-uid", order: "last" },
      block: { uid: "edit-uid", string: "Direct result" },
    },
  ]);
  assert.deepEqual(events[5], ["presentation-stop", "status-uid"]);
  assert.deepEqual(events[6], [
    "delete",
    { block: { uid: "status-uid" } },
  ]);
  assert.equal(values.size, 0);
  assert.equal(result.outcome, "applied");
  assert.equal(result.research, "not_needed");
  assert.deepEqual(result.sourceCommentUids, []);
  assert.deepEqual(notifications, [
    ["Codex updated the outline.", "success"],
  ]);
});

test("workOnBlock removes the running status when the bridge fails", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const deletes = [];
  const api = {
    util: { generateUID: () => "status-uid" },
    data: {
      block: {
        create: async () => {},
        delete: async (input) => deletes.push(input),
      },
    },
  };

  await assert.rejects(
    workOnBlock("source-uid", {
      api,
      storage,
      request: async () => {
        throw new Error("Bridge failed.");
      },
      notifyImpl: () => {},
    }),
    /Bridge failed/,
  );
  assert.deepEqual(deletes, [{ block: { uid: "status-uid" } }]);
  assert.equal(values.size, 0);
});

test("workOnBlock treats an interrupted turn as a neutral stopped outcome", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const deletes = [];
  const notifications = [];
  const api = {
    util: { generateUID: () => "status-uid" },
    data: {
      block: {
        create: async () => {},
        delete: async (input) => deletes.push(input),
      },
    },
  };
  const interrupted = new Error("Codex turn was stopped.");
  interrupted.code = "TURN_INTERRUPTED";

  const result = await workOnBlock("source-uid", {
    api,
    storage,
    request: async () => {
      throw interrupted;
    },
    notifyImpl: (...args) => notifications.push(args),
  });

  assert.equal(result.outcome, "stopped");
  assert.deepEqual(deletes, [{ block: { uid: "status-uid" } }]);
  assert.deepEqual(notifications, [["Codex stopped.", "primary"]]);
});

test("extension startup removes only recorded stale running blocks", async () => {
  const values = new Map([
    [
      "roam-codex-lab.running-status-uids",
      JSON.stringify(["stale-1", "stale-2"]),
    ],
  ]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const deleted = [];

  const removed = await cleanupStaleRunningStatuses({
    api: {
      data: {
        block: {
          delete: async ({ block }) => deleted.push(block.uid),
        },
      },
    },
    storage,
  });

  assert.equal(removed, 2);
  assert.deepEqual(deleted, ["stale-1", "stale-2"]);
  assert.equal(values.size, 0);
});
