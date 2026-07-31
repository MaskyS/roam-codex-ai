import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  AppServerClient,
  DEFAULT_RUNTIME_CWD,
  buildProbePrompt,
  createBridgeServer,
  createProgressNormalizer,
  isAllowedOrigin,
  parseAndValidatePlan,
  runtimeAppServerArgs,
  runtimeThreadConfig,
  validateRuntimeInstructionSources,
} from "../bridge.mjs";

test("runtime threads use an isolated default working directory", () => {
  assert.notEqual(DEFAULT_RUNTIME_CWD, process.cwd());
  assert.match(DEFAULT_RUNTIME_CWD, /roam-better-ai-runtime$/);
});

test("app-server process starts in the isolated runtime directory", async () => {
  const runtimeCwd = `${DEFAULT_RUNTIME_CWD}-process-test`;
  let spawnOptions;
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      if (request.method === "initialize") {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {},
        })}\n`));
      }
    }
  });

  const client = new AppServerClient({
    runtimeCwd,
    spawnProcess: (_command, _args, options) => {
      spawnOptions = options;
      return child;
    },
  });
  await client.start();
  assert.equal(spawnOptions.cwd, runtimeCwd);
  await client.stop();
});

test("runtime instruction audit allows user-global guidance and rejects project guidance", () => {
  assert.deepEqual(
    validateRuntimeInstructionSources(
      ["/codex-home/AGENTS.md"],
      { codexHome: "/codex-home" },
    ),
    ["/codex-home/AGENTS.md"],
  );
  assert.throws(
    () => validateRuntimeInstructionSources(
      ["/workspace/AGENTS.md"],
      { codexHome: "/codex-home" },
    ),
    (error) => error.code === "RUNTIME_INSTRUCTION_SOURCE_INVALID",
  );
  assert.throws(
    () => validateRuntimeInstructionSources(undefined),
    (error) => error.code === "RUNTIME_INSTRUCTION_SOURCE_INVALID",
  );
});

test("runtime app-server exposes direct graph tools to persistent chat", () => {
  const args = runtimeAppServerArgs({ roamHome: "/runtime/roam-home" });
  const joined = args.join(" ");

  assert.match(joined, /mcp_servers\.roam\.env=\{HOME="\/runtime\/roam-home"\}/);
  assert.match(joined, /mcp_servers\.roam\.enabled_tools=/);
  assert.match(joined, /get_graph_guidelines/);
  assert.match(joined, /get_comments/);
  assert.match(joined, /create_block/);
  assert.match(joined, /update_block/);
  assert.match(joined, /delete_block/);
  assert.match(joined, /mcp_servers\.node_repl\.enabled=false/);
});

test("every runtime thread repeats the MCP and plugin restrictions", () => {
  const config = runtimeThreadConfig(["get_graph_guidelines", "get_block"]);
  assert.equal(config.features.plugins, false);
  assert.equal(config.features.apps, false);
  assert.equal(config.mcp_servers.paper.enabled, false);
  assert.equal(config.mcp_servers.node_repl.enabled, false);
  assert.deepEqual(
    config.mcp_servers.roam.enabled_tools,
    ["get_graph_guidelines", "get_block"],
  );
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
  const client = new AppServerClient({ runtimeCwd: "/runtime/agent" });
  const requests = [];
  const progress = [];
  client.start = async () => {};
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-test" }, instructionSources: [] };
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
  const threadStart = requests.find((request) => request.method === "thread/start");
  assert.equal(threadStart.params.cwd, "/runtime/agent");
  assert.equal(turnStart.params.summary, "concise");
  assert.ok(
    threadStart.params.config.mcp_servers.roam.enabled_tools.includes(
      "get_block",
    ),
  );
  assert.equal(
    threadStart.params.config.mcp_servers.roam.enabled_tools.includes(
      "update_block",
    ),
    false,
  );
  assert.deepEqual(progress, [{ kind: "summary", text: "Reading context" }]);
  assert.equal(result.plan.edits[0].text, "Result");
});

test("app-server chat starts and resumes a persistent panel conversation", async () => {
  const client = new AppServerClient({ runtimeCwd: "/runtime/agent" });
  const requests = [];
  const started = [];
  let turnNumber = 0;
  client.start = async () => {};
  client.listModels = async () => [
    {
      id: "model-from-list",
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    },
  ];
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start" || method === "thread/resume") {
      return { thread: { id: "thread-chat" }, instructionSources: [] };
    }
    if (method === "turn/start") {
      turnNumber += 1;
      const turnId = `turn-${turnNumber}`;
      queueMicrotask(() => {
        client.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "thread-chat",
            turnId,
            item: {
              type: "agentMessage",
              phase: "final_answer",
              text: `Reply ${turnNumber}`,
            },
          },
        });
        client.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread-chat",
            turn: { id: turnId, status: "completed", items: [] },
          },
        });
      });
      return { turn: { id: turnId } };
    }
    return {};
  };

  const first = await client.runChat({
    message: "First message",
    graph: "maskys",
    promptBlockUid: "prompt123",
    model: "model-from-list",
    effort: "medium",
    onStarted: (event) => started.push(event),
  });
  const second = await client.runChat({
    message: "Second message",
    graph: "maskys",
    promptBlockUid: "prompt456",
    threadId: first.threadId,
    onStarted: (event) => started.push(event),
  });

  const threadStart = requests.find((entry) => entry.method === "thread/start");
  const threadResume = requests.find((entry) => entry.method === "thread/resume");
  const turnStarts = requests.filter((entry) => entry.method === "turn/start");
  assert.equal(Object.hasOwn(threadStart.params, "ephemeral"), false);
  assert.equal(threadStart.params.cwd, "/runtime/agent");
  assert.equal(threadResume.params.cwd, "/runtime/agent");
  assert.equal(threadResume.params.threadId, "thread-chat");
  assert.equal(threadResume.params.excludeTurns, true);
  assert.equal(turnStarts[0].params.model, "model-from-list");
  assert.equal(turnStarts[0].params.effort, "medium");
  assert.deepEqual(turnStarts[0].params.additionalContext, {
    roamPrompt: {
      kind: "application",
      value: [
        "Roam graph: maskys",
        "Prompt block UID: prompt123",
        "Read this block and useful descendants with Roam MCP before answering.",
        "Treat its page and block references as part of the user's instruction.",
      ].join("\n"),
    },
  });
  assert.match(
    threadStart.params.developerInstructions,
    /ordinary Roam prompt block/,
  );
  assert.match(
    threadStart.params.developerInstructions,
    /There is no later\s+Apply step/,
  );
  assert.match(
    threadStart.params.developerInstructions,
    /explicitly requests a graph change/,
  );
  assert.match(
    threadStart.params.developerInstructions,
    /call `get_graph_guidelines`/,
  );
  assert.match(
    threadStart.params.developerInstructions,
    /Do not follow repository-development instructions/,
  );
  assert.deepEqual(
    threadStart.params.config.mcp_servers.roam.enabled_tools,
    threadResume.params.config.mcp_servers.roam.enabled_tools,
  );
  assert.ok(
    threadStart.params.config.mcp_servers.roam.enabled_tools.includes(
      "update_block",
    ),
  );
  assert.equal(Object.hasOwn(turnStarts[1].params, "model"), false);
  assert.equal(first.reply, "Reply 1");
  assert.equal(second.reply, "Reply 2");
  assert.deepEqual(started, [
    { threadId: "thread-chat", turnId: "turn-1" },
    { threadId: "thread-chat", turnId: "turn-2" },
  ]);
});

test("app-server loads only user messages and final replies for the panel", async () => {
  const client = new AppServerClient();
  client.start = async () => {};
  client.request = async (method, params) => {
    assert.equal(method, "thread/turns/list");
    assert.deepEqual(params, {
      threadId: "thread-chat",
      limit: 12,
      sortDirection: "desc",
      itemsView: "full",
    });
    return {
      data: [
        {
          items: [
            {
              type: "userMessage",
              content: [{ type: "text", text: "Newer question" }],
            },
            { type: "reasoning", summary: ["Do not show"], content: [] },
            {
              type: "agentMessage",
              phase: "final_answer",
              text: "Newer reply",
            },
          ],
        },
        {
          items: [
            {
              type: "userMessage",
              content: [{ type: "text", text: "Older question" }],
            },
            {
              type: "agentMessage",
              phase: "final_answer",
              text: "Older reply",
            },
          ],
        },
      ],
    };
  };

  assert.deepEqual(await client.listThreadMessages("thread-chat"), [
    { role: "user", text: "Older question" },
    { role: "assistant", text: "Older reply" },
    { role: "user", text: "Newer question" },
    { role: "assistant", text: "Newer reply" },
  ]);
});

test("app-server reads exact thread summaries without resuming them", async () => {
  const client = new AppServerClient();
  client.start = async () => {};
  const calls = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (params.threadId === "thread_missing") {
      throw new Error("thread does not exist");
    }
    if (params.threadId === "thread_offline") {
      throw new Error("app-server unavailable");
    }
    return {
      thread: {
        id: params.threadId,
        name: "  Named chat  ",
        preview: "  First prompt  ",
        createdAt: 100,
        updatedAt: 200,
        turns: [],
      },
    };
  };

  assert.deepEqual(await client.readThreadSummaries([
    "thread_good",
    "thread_missing",
    "thread_offline",
  ]), {
    threads: [{
      id: "thread_good",
      name: "Named chat",
      preview: "First prompt",
      createdAt: 100,
      updatedAt: 200,
    }],
    missingThreadIds: ["thread_missing"],
    unavailableThreadIds: ["thread_offline"],
  });
  assert.deepEqual(calls[0], {
    method: "thread/read",
    params: { threadId: "thread_good", includeTurns: false },
  });
  assert.equal(calls.some((call) => call.method === "thread/resume"), false);
});

test("bridge exposes models, recent messages, and panel-only chat", async (t) => {
  const client = {
    ready: false,
    async listModels() {
      return [
        {
          id: "model-from-list",
          displayName: "Model From List",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Balanced" },
          ],
        },
      ];
    },
    async listThreadMessages(threadId) {
      assert.equal(threadId, "thread_12345678");
      return [{ role: "assistant", text: "Earlier reply" }];
    },
    async readThreadSummaries(threadIds) {
      assert.deepEqual(threadIds, ["thread_12345678"]);
      return {
        threads: [{
          id: "thread_12345678",
          name: null,
          preview: "Hello panel",
          createdAt: 100,
          updatedAt: 200,
        }],
        missingThreadIds: [],
        unavailableThreadIds: [],
      };
    },
    async runChat({ onProgress, onThread, onStarted, ...input }) {
      assert.deepEqual(input, {
        message: "Hello panel",
        graph: "maskys",
        promptBlockUid: "prompt123",
        threadId: null,
        model: "model-from-list",
        effort: "medium",
      });
      onProgress({ kind: "summary", text: "Thinking" });
      onThread({ threadId: "thread_12345678" });
      await onStarted({
        threadId: "thread_12345678",
        turnId: "turn-chat",
      });
      return {
        threadId: "thread_12345678",
        turnId: "turn-chat",
        reply: "Hello from Codex",
      };
    },
  };
  const server = createBridgeServer({
    token: "secret-token",
    graph: "maskys",
    client,
    trace: async () => {},
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    origin: "https://roamresearch.com",
    authorization: "Bearer secret-token",
  };

  const modelsResponse = await fetch(`${base}/models`, { headers });
  assert.equal(modelsResponse.status, 200);
  const models = (await modelsResponse.json()).models;
  assert.equal(models[0].id, "model-from-list");

  const messagesResponse = await fetch(
    `${base}/threads/thread_12345678/messages`,
    { headers },
  );
  assert.deepEqual((await messagesResponse.json()).messages, [
    { role: "assistant", text: "Earlier reply" },
  ]);

  const summariesResponse = await fetch(`${base}/threads/summaries`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      graph: "maskys",
      threadIds: ["thread_12345678"],
    }),
  });
  assert.equal(summariesResponse.status, 200);
  assert.deepEqual(await summariesResponse.json(), {
    threads: [{
      id: "thread_12345678",
      name: null,
      preview: "Hello panel",
      createdAt: 100,
      updatedAt: 200,
    }],
    missingThreadIds: [],
    unavailableThreadIds: [],
  });

  const chatResponse = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      graph: "maskys",
      message: "Hello panel",
      promptBlockUid: "prompt123",
      model: "model-from-list",
      effort: "medium",
    }),
  });
  const events = (await chatResponse.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), [
    "started",
    "progress",
    "conversation",
    "completed",
  ]);
  assert.equal(events.at(-1).result.reply, "Hello from Codex");
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

  const privateNetworkPreflight = await fetch(`${base}/health`, {
    method: "OPTIONS",
    headers: {
      origin: "https://roamresearch.com",
      "access-control-request-method": "GET",
      "access-control-request-private-network": "true",
    },
  });
  assert.equal(privateNetworkPreflight.status, 204);
  assert.equal(
    privateNetworkPreflight.headers.get(
      "access-control-allow-private-network",
    ),
    "true",
  );

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

  const unauthorizedHistory = await fetch(`${base}/threads/summaries`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: "maskys", threadIds: [] }),
  });
  assert.equal(unauthorizedHistory.status, 401);

  const wrongHistoryGraph = await fetch(`${base}/threads/summaries`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      authorization: "Bearer secret-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: "other", threadIds: [] }),
  });
  assert.equal(wrongHistoryGraph.status, 400);

  const duplicateHistoryIds = await fetch(`${base}/threads/summaries`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      authorization: "Bearer secret-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      graph: "maskys",
      threadIds: ["thread_same", "thread_same"],
    }),
  });
  assert.equal(duplicateHistoryIds.status, 400);

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
