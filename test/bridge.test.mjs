import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import {
  AppServerClient,
  buildProbePrompt,
  createBridgeServer,
  createProgressNormalizer,
  isAllowedOrigin,
  parseAndValidatePlan,
  runtimeAppServerArgs,
} from "../bridge.mjs";

test("runtime app-server keeps its separate read-only Roam tool boundary", () => {
  const args = runtimeAppServerArgs({ roamHome: "/runtime/roam-home" });
  const joined = args.join(" ");

  assert.match(joined, /mcp_servers\.roam\.env=\{HOME="\/runtime\/roam-home"\}/);
  assert.match(joined, /mcp_servers\.roam\.enabled_tools=/);
  assert.match(joined, /get_graph_guidelines/);
  assert.match(joined, /get_comments/);
  assert.doesNotMatch(joined, /create_block/);
  assert.match(joined, /mcp_servers\.node_repl\.enabled=false/);
});

test("runtime prompt keeps useful links in the outline and source lists in comments", () => {
  const prompt = buildProbePrompt({
    graph: "maskys",
    blockUid: "abcdefghi",
  });

  assert.match(prompt, /Include contextual links/);
  assert.match(prompt, /outline should remain useful with comments closed/);
  assert.match(prompt, /do not create Sources, Citations, or References blocks/);
  assert.match(prompt, /renders each targeted source group as a native Roam comment/);
  assert.doesNotMatch(prompt, /never inline in edit text/);
});

test("plan parser accepts topologically ordered edits and targeted comments", () => {
  assert.deepEqual(
    parseAndValidatePlan(
      JSON.stringify({
        outcome: "applied",
        research: "completed",
        edits: [
          { id: "b1", parent: "source", text: "Find the form" },
          { id: "b2", parent: "b1", text: "Check the deadline" },
        ],
        comments: [
          {
            target: "b2",
            kind: "question",
            text: "Which vehicle is this for?",
          },
        ],
        sources: [
          {
            target: "b1",
            title: "Official form",
            url: "https://authority.example/form",
            supports: "The current application form.",
          },
        ],
      }),
    ),
    {
      outcome: "applied",
      research: "completed",
      edits: [
        { id: "b1", parent: "source", text: "Find the form" },
        { id: "b2", parent: "b1", text: "Check the deadline" },
      ],
      comments: [
        {
          target: "b2",
          kind: "question",
          text: "Which vehicle is this for?",
        },
      ],
      sources: [
        {
          target: "b1",
          title: "Official form",
          url: "https://authority.example/form",
          supports: "The current application form.",
        },
      ],
    },
  );
});

test("plan parser rejects forward parent references", () => {
  assert.throws(
    () =>
      parseAndValidatePlan(
        JSON.stringify({
          outcome: "applied",
          research: "not_needed",
          edits: [
            { id: "b1", parent: "b2", text: "First" },
            { id: "b2", parent: "source", text: "Second" },
          ],
          comments: [],
          sources: [],
        }),
      ),
    /earlier edit/,
  );
});

test("needs-input plans require a question and cannot edit", () => {
  assert.throws(
    () =>
      parseAndValidatePlan(
        JSON.stringify({
          outcome: "needs_input",
          research: "not_needed",
          edits: [{ id: "b1", parent: "source", text: "Guess" }],
          comments: [
            { target: "source", kind: "question", text: "Which one?" },
          ],
          sources: [],
        }),
      ),
    /cannot contain edits/,
  );
  assert.throws(
    () =>
      parseAndValidatePlan(
        JSON.stringify({
          outcome: "needs_input",
          research: "not_needed",
          edits: [],
          comments: [
            { target: "source", kind: "note", text: "More detail needed." },
          ],
          sources: [],
        }),
      ),
    /question comment/,
  );
});

test("completed research requires valid sources", () => {
  assert.throws(
    () =>
      parseAndValidatePlan(
        JSON.stringify({
          outcome: "applied",
          research: "completed",
          edits: [{ id: "b1", parent: "source", text: "Current fact" }],
          comments: [],
          sources: [],
        }),
      ),
    /must contain a source/,
  );
  assert.throws(
    () =>
      parseAndValidatePlan(
        JSON.stringify({
          outcome: "applied",
          research: "completed",
          edits: [{ id: "b1", parent: "source", text: "Current fact" }],
          comments: [],
          sources: [
            {
              target: "b1",
              title: "Unsafe",
              url: "javascript:alert(1)",
              supports: "Nothing",
            },
          ],
        }),
      ),
    /public http\(s\) URL/,
  );
});

test("unavailable required research cannot make edits", () => {
  assert.throws(
    () =>
      parseAndValidatePlan(
        JSON.stringify({
          outcome: "applied",
          research: "unavailable",
          edits: [{ id: "b1", parent: "source", text: "Unverified fact" }],
          comments: [
            {
              target: "source",
              kind: "warning",
              text: "Research failed.",
            },
          ],
          sources: [],
        }),
      ),
    /Unavailable research requires no changes/,
  );
});

test("origin policy allows Roam and rejects unrelated sites", () => {
  assert.equal(isAllowedOrigin("https://roamresearch.com"), true);
  assert.equal(isAllowedOrigin("roam://maskys"), true);
  assert.equal(isAllowedOrigin("https://evil.example"), false);
});

test("progress normalizer combines readable summaries and labels tool activity", () => {
  const progress = [];
  const normalize = createProgressNormalizer((event) => progress.push(event));

  normalize({
    method: "item/started",
    params: { item: { type: "mcpToolCall", tool: "get_graph_guidelines" } },
  });
  normalize({
    method: "item/reasoning/summaryPartAdded",
    params: { itemId: "reason-1", summaryIndex: 0 },
  });
  normalize({
    method: "item/reasoning/summaryTextDelta",
    params: { itemId: "reason-1", summaryIndex: 0, delta: "**Checking" },
  });
  normalize({
    method: "item/reasoning/summaryTextDelta",
    params: { itemId: "reason-1", summaryIndex: 0, delta: " context**" },
  });
  normalize({
    method: "item/started",
    params: {
      item: { type: "webSearch", action: { type: "openPage" } },
    },
  });

  assert.deepEqual(progress, [
    { kind: "activity", text: "Reading the graph guidelines" },
    { kind: "summary", text: "Checking" },
    { kind: "summary", text: "Checking context" },
    { kind: "activity", text: "Reading a web source" },
  ]);
});

test("app-server probe requests concise summaries and forwards only its turn", async () => {
  const client = new AppServerClient();
  const requests = [];
  const progress = [];
  client.start = async () => {};
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-test" } };
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        client.emit("notification", {
          method: "item/reasoning/summaryTextDelta",
          params: {
            threadId: "other-thread",
            turnId: "other-turn",
            itemId: "reason-other",
            summaryIndex: 0,
            delta: "Ignore me",
          },
        });
        client.emit("notification", {
          method: "item/reasoning/summaryTextDelta",
          params: {
            threadId: "thread-test",
            turnId: "turn-test",
            itemId: "reason-test",
            summaryIndex: 0,
            delta: "Reading context",
          },
        });
        client.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "thread-test",
            turnId: "turn-test",
            item: {
              type: "agentMessage",
              phase: "final_answer",
              text: JSON.stringify({
                outcome: "applied",
                research: "not_needed",
                edits: [{ id: "b1", parent: "source", text: "Result" }],
                comments: [],
                sources: [],
              }),
            },
          },
        });
        client.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread-test",
            turn: { id: "turn-test", status: "completed", items: [] },
          },
        });
      });
      return { turn: { id: "turn-test" } };
    }
    return {};
  };

  const result = await client.runProbe({
    graph: "maskys",
    blockUid: "abcdefghi",
    onProgress: (event) => progress.push(event),
  });

  const turnStart = requests.find((request) => request.method === "turn/start");
  assert.equal(turnStart.params.summary, "concise");
  assert.deepEqual(progress, [{ kind: "summary", text: "Reading context" }]);
  assert.equal(result.plan.edits[0].text, "Result");
});

test("bridge enforces bearer auth and graph restriction", async (t) => {
  const calls = [];
  const client = {
    ready: false,
    async runProbe({ onProgress, onStarted, ...input }) {
      calls.push(input);
      onProgress({ kind: "activity", text: "Reading the selected block" });
      await onStarted({ threadId: "thr_test", turnId: "turn_test" });
      return {
        threadId: "thr_test",
        turnId: "turn_test",
        plan: {
          outcome: "applied",
          research: "not_needed",
          edits: [{ id: "b1", parent: "source", text: "Test" }],
          comments: [],
          sources: [],
        },
      };
    },
  };
  const traceEntries = [];
  const server = createBridgeServer({
    token: "secret-token",
    graph: "maskys",
    client,
    trace: async (entry) => traceEntries.push(entry),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const unauthorized = await fetch(`${base}/probe`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: "maskys", blockUid: "abcdefghi" }),
  });
  assert.equal(unauthorized.status, 401);

  const untrustedPair = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(untrustedPair.status, 403);

  const pair = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { origin: "https://roamresearch.com" },
  });
  assert.equal(pair.status, 200);
  assert.deepEqual(await pair.json(), {
    graph: "maskys",
    token: "secret-token",
  });

  const wrongGraph = await fetch(`${base}/probe`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      authorization: "Bearer secret-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: "other", blockUid: "abcdefghi" }),
  });
  assert.equal(wrongGraph.status, 400);

  const success = await fetch(`${base}/probe`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      authorization: "Bearer secret-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: "maskys", blockUid: "abcdefghi" }),
  });
  assert.equal(success.status, 200);
  assert.match(success.headers.get("content-type"), /application\/x-ndjson/);
  const events = (await success.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), [
    "started",
    "progress",
    "completed",
  ]);
  assert.equal(events[1].text, "Reading the selected block");
  assert.equal(events[2].result.plan.edits[0].text, "Test");
  assert.deepEqual(calls, [{ graph: "maskys", blockUid: "abcdefghi" }]);
  assert.deepEqual(
    traceEntries.map((entry) => entry.event),
    ["probe.started", "probe.completed"],
  );
});

test("bridge cancellation interrupts the active app-server turn", async (t) => {
  let rejectProbe;
  const interruptCalls = [];
  const client = {
    ready: true,
    async runProbe({ onStarted }) {
      await onStarted({ threadId: "thread-cancel", turnId: "turn-cancel" });
      return new Promise((_resolve, reject) => {
        rejectProbe = reject;
      });
    },
    async interruptTurn(input) {
      interruptCalls.push(input);
      const error = new Error("Codex turn was stopped.");
      error.code = "TURN_INTERRUPTED";
      rejectProbe(error);
    },
  };
  const traceEntries = [];
  const server = createBridgeServer({
    token: "secret-token",
    graph: "maskys",
    client,
    trace: async (entry) => traceEntries.push(entry),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    origin: "https://roamresearch.com",
    authorization: "Bearer secret-token",
  };

  const probeResponse = await fetch(`${base}/probe`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ graph: "maskys", blockUid: "abcdefghi" }),
  });
  const reader = probeResponse.body.getReader();
  const decoder = new TextDecoder();
  const firstChunk = decoder.decode((await reader.read()).value);
  const started = JSON.parse(firstChunk.trim());

  const cancelResponse = await fetch(
    `${base}/runs/${started.runId}/cancel`,
    { method: "POST", headers },
  );
  assert.equal(cancelResponse.status, 202);
  assert.deepEqual(await cancelResponse.json(), {
    ok: true,
    status: "interrupting",
  });

  let remaining = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    remaining += decoder.decode(value, { stream: true });
  }
  const finalEvent = JSON.parse(remaining.trim());
  assert.equal(finalEvent.type, "error");
  assert.equal(finalEvent.code, "TURN_INTERRUPTED");
  assert.deepEqual(interruptCalls, [
    { threadId: "thread-cancel", turnId: "turn-cancel" },
  ]);
  assert.deepEqual(
    traceEntries.map((entry) => entry.event),
    ["probe.started", "probe.cancel.requested", "probe.interrupted"],
  );
});
