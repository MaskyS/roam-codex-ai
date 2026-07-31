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
  RUNNING_BLOCK_TEXT,
  applyRunPlan,
  cleanupStaleRunningStatuses,
  formatRunningElapsed,
  pairBridge,
  requestProbe,
  requestRunCancellation,
  runningPresentationText,
  startRunningPresentation,
  workOnBlock,
} = await import("../extension.js");

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
