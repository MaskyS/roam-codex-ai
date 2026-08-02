import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  AppServerClient,
  DEFAULT_RUNTIME_CWD,
  createBridgeServer,
  createPairingSession,
  ensureRuntimeGraphAccess,
  createProgressNormalizer,
  isAllowedOrigin,
  runtimeAppServerArgs,
  runtimeCwdForGraph,
  requestPairingConsent,
  runtimeThreadConfig,
  scanConfigMcpServerNames,
  toolApprovalResponse,
  turnFailureError,
  validateRuntimeInstructionSources,
} from "../bridge.mjs";

test("runtime threads use a stable per-graph working directory", () => {
  assert.notEqual(DEFAULT_RUNTIME_CWD, process.cwd());
  assert.equal(
    DEFAULT_RUNTIME_CWD,
    resolve(homedir(), ".roam-better-ai", "graphs", "unconfigured"),
  );
  assert.match(runtimeCwdForGraph("My Graph!"), /\/my-graph-[A-Za-z0-9_-]{16}$/);
  assert.match(runtimeCwdForGraph(".."), /\/graph-[A-Za-z0-9_-]{16}$/);
  assert.notEqual(runtimeCwdForGraph("a/b"), runtimeCwdForGraph("a?b"));
  assert.notEqual(
    runtimeCwdForGraph("Graph").toLowerCase(),
    runtimeCwdForGraph("graph").toLowerCase(),
  );
  assert.ok(runtimeCwdForGraph("🧠".repeat(200)).split("/").at(-1).length < 100);
});

test("pairing codes expire, bound guesses, and succeed only once", () => {
  let now = 1_000;
  const oneTime = createPairingSession({
    code: "ABCDEF-123456",
    now: () => now,
    ttlMs: 1_000,
    maxAttempts: 2,
  });
  assert.equal(oneTime.verify("wrong"), false);
  assert.equal(oneTime.verify("abcdef-123456"), true);
  assert.equal(oneTime.verify("ABCDEF-123456"), false);

  const exhausted = createPairingSession({
    code: "PAIR-ME",
    now: () => now,
    ttlMs: 1_000,
    maxAttempts: 2,
  });
  assert.equal(exhausted.verify("wrong-1"), false);
  assert.equal(exhausted.verify("wrong-2"), false);
  assert.equal(exhausted.verify("PAIR-ME"), false);

  const restarted = createPairingSession({ code: "fresh-code" });
  assert.equal(restarted.verify("fresh-code"), true);

  const expired = createPairingSession({
    code: "TOO-LATE",
    now: () => now,
    ttlMs: 1_000,
  });
  now = 2_000;
  assert.equal(expired.verify("TOO-LATE"), false);
});

test("app-server process starts in the isolated runtime directory", async () => {
  const runtimeCwd = resolve(
    tmpdir(),
    `roam-better-ai-process-test-${process.pid}`,
  );
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
      if (request.method === "config/read") {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            config: {
              mcp_servers: { roam: {}, paper: {}, node_repl: {} },
            },
          },
        })}\n`));
      }
    }
  });

  const client = new AppServerClient({
    runtimeCwd,
    codexHome: "/nonexistent-codex-home",
    spawnProcess: (_command, _args, options) => {
      spawnOptions = options;
      return child;
    },
  });
  await client.start();
  assert.equal(spawnOptions.cwd, runtimeCwd);
  assert.deepEqual(client.knownMcpServers, ["node_repl", "paper"]);
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
  const args = runtimeAppServerArgs({
    disableServers: ["node_repl", "roam", "felt server", "node_repl"],
  });
  const joined = args.join(" ");

  assert.match(joined, /mcp_servers\.roam\.command="npx"/);
  assert.match(joined, /@roam-research\/roam-mcp/);
  assert.match(joined, /mcp_servers\.roam\.enabled=true/);
  assert.doesNotMatch(joined, /mcp_servers\.roam\.env=/);
  assert.match(joined, /mcp_servers\.roam\.enabled_tools=/);
  assert.match(joined, /get_graph_guidelines/);
  assert.match(joined, /get_comments/);
  assert.match(joined, /create_block/);
  assert.match(joined, /update_block/);
  assert.match(joined, /delete_block/);
  assert.match(joined, /"node_repl"=\{enabled=false\}/);
  assert.match(joined, /"felt server"=\{enabled=false\}/);
  assert.doesNotMatch(joined, /mcp_servers\.roam\.enabled=false/);
  assert.equal(
    args.filter((arg) => arg.includes('"node_repl"={enabled=false}')).length,
    1,
  );
});

test("every runtime thread disables all known servers except roam and opt-ins", () => {
  const config = runtimeThreadConfig(["get_graph_guidelines", "get_block"], {
    knownServers: ["paper", "node_repl", "felt", "roam"],
    enabledServers: ["felt", "unknown"],
  });
  assert.equal(config.features.plugins, false);
  assert.equal(config.features.apps, false);
  assert.equal(config.mcp_servers.paper.enabled, false);
  assert.equal(config.mcp_servers.node_repl.enabled, false);
  assert.equal(config.mcp_servers.felt.enabled, true);
  assert.equal(Object.hasOwn(config.mcp_servers, "unknown"), false);
  assert.equal(config.mcp_servers.roam.enabled, true);
  assert.deepEqual(
    config.mcp_servers.roam.enabled_tools,
    ["get_graph_guidelines", "get_block"],
  );
});

test("config scanner finds MCP server names in headers and dotted keys", () => {
  const names = scanConfigMcpServerNames([
    "[mcp_servers.Railway]",
    'args = ["-y"]',
    '[mcp_servers."felt server"]',
    'url = "https://felt.com/mcp"',
    'mcp_servers.paper.command = "python3"',
    "[mcp_servers.roam]",
    'command = "npx"',
    "[other.table]",
    "x = 1",
  ].join("\n"));
  assert.deepEqual(names, ["Railway", "felt server", "paper"]);
});

test("tool approvals answer every question with the exact offered label", () => {
  const questions = [{
    id: "approve_roam_write",
    options: [
      { label: "Accept", description: "Run it" },
      { label: "Decline", description: "Do not run it" },
      { label: "Cancel", description: "Stop" },
    ],
  }];
  assert.deepEqual(toolApprovalResponse(questions, "accept"), {
    answers: { approve_roam_write: { answers: ["Accept"] } },
  });
  assert.deepEqual(toolApprovalResponse(questions, "reject"), {
    answers: { approve_roam_write: { answers: ["Decline"] } },
  });
  assert.throws(
    () => toolApprovalResponse([{ id: "freeform", options: null }], "accept"),
    (error) => error.code === "APPROVAL_UNSUPPORTED",
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
    serviceTier: null,
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
  assert.equal(threadStart.params.approvalPolicy, "on-request");
  assert.equal(threadResume.params.cwd, "/runtime/agent");
  assert.equal(threadResume.params.threadId, "thread-chat");
  assert.equal(threadResume.params.excludeTurns, true);
  assert.equal(turnStarts[0].params.model, "model-from-list");
  assert.equal(turnStarts[0].params.effort, "medium");
  assert.equal(turnStarts[0].params.serviceTier, null);
  assert.equal(turnStarts[0].params.approvalPolicy, "on-request");
  assert.equal(Object.hasOwn(turnStarts[1].params, "serviceTier"), false);
  assert.deepEqual(turnStarts[0].params.additionalContext, {
    roamPrompt: {
      kind: "application",
      value: [
        "Roam graph: maskys",
        "Prompt block UID: prompt123",
        "Read this block and useful descendants with Roam MCP before answering.",
        "Treat its page and block references as part of the user's instruction.",
        "Access mode: Auto. Carry out explicitly requested Roam changes with the available tools without asking for a separate confirmation.",
        "Format for Roam renderString: use **bold** and __italic__, never single-asterisk emphasis.",
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
  assert.match(
    threadStart.params.developerInstructions,
    /`\*\*bold\*\*` and `__italic__`/,
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

test("chat access modes enforce tool visibility and answer write approvals", async () => {
  const makeClient = () => {
    const client = new AppServerClient({ runtimeCwd: "/runtime/agent" });
    const requests = [];
    const responses = [];
    client.start = async () => {};
    client.respondServerRequest = (id, result) => {
      responses.push({ id, result });
      queueMicrotask(() => {
        client.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "thread-access",
            turnId: "turn-access",
            item: {
              type: "agentMessage",
              phase: "final_answer",
              text: "Done",
            },
          },
        });
        client.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread-access",
            turn: {
              id: "turn-access",
              status: "completed",
              items: [],
            },
          },
        });
      });
    };
    client.request = async (method, params) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return { thread: { id: "thread-access" }, instructionSources: [] };
      }
      if (method === "turn/start") {
        queueMicrotask(() => client.serverRequestHandlers.get("thread-access")?.({
          id: 91,
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-access",
            turnId: "turn-access",
            itemId: "item-write",
            questions: [{
              id: "approval",
              header: "Update page",
              question: "Allow update_page?",
              options: [
                { label: "Accept", description: "Run it" },
                { label: "Decline", description: "Do not run it" },
              ],
            }],
          },
        }));
        return { turn: { id: "turn-access" } };
      }
      return {};
    };
    return { client, requests, responses };
  };

  const manual = makeClient();
  const approvals = [];
  await manual.client.runChat({
    message: "Rename the page",
    graph: "maskys",
    promptBlockUid: "prompt123",
    accessMode: "manual",
    onApproval: async (approval) => {
      approvals.push(approval);
      return "accept";
    },
  });
  assert.equal(approvals[0].itemId, "item-write");
  assert.deepEqual(manual.responses, [{
    id: 91,
    result: { answers: { approval: { answers: ["Accept"] } } },
  }]);
  const manualThread = manual.requests.find(({ method }) => method === "thread/start");
  assert.equal(manualThread.params.approvalPolicy, "on-request");
  assert.ok(manualThread.params.config.mcp_servers.roam.enabled_tools.includes(
    "update_page",
  ));

  const automatic = makeClient();
  await automatic.client.runChat({
    message: "Rename the page",
    graph: "maskys",
    promptBlockUid: "prompt123",
    accessMode: "auto",
    onApproval: async () => {
      throw new Error("Auto must not wait for the UI");
    },
  });
  assert.deepEqual(automatic.responses[0].result, {
    answers: { approval: { answers: ["Accept"] } },
  });
});

test("read-only chat hides Roam write tools and never requests approval", async () => {
  const client = new AppServerClient({ runtimeCwd: "/runtime/agent" });
  const requests = [];
  client.start = async () => {};
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-readonly" }, instructionSources: [] };
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        client.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "thread-readonly",
            turnId: "turn-readonly",
            item: {
              type: "agentMessage",
              phase: "final_answer",
              text: "Read only",
            },
          },
        });
        client.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread-readonly",
            turn: { id: "turn-readonly", status: "completed", items: [] },
          },
        });
      });
      return { turn: { id: "turn-readonly" } };
    }
    return {};
  };
  await client.runChat({
    message: "Inspect the page",
    graph: "maskys",
    promptBlockUid: "prompt123",
    accessMode: "read-only",
  });
  const threadStart = requests.find(({ method }) => method === "thread/start");
  const turnStart = requests.find(({ method }) => method === "turn/start");
  assert.equal(threadStart.params.approvalPolicy, "never");
  assert.equal(turnStart.params.approvalPolicy, "never");
  assert.equal(
    threadStart.params.config.mcp_servers.roam.enabled_tools.includes(
      "update_page",
    ),
    false,
  );
});

test("app-server chat waits for turn completion without an elapsed timeout", async () => {
  const client = new AppServerClient({ runtimeCwd: "/runtime/agent" });
  client.start = async () => {};
  client.request = async (method) => {
    if (method === "thread/start") {
      return { thread: { id: "thread-long" }, instructionSources: [] };
    }
    if (method === "turn/start") {
      setTimeout(() => {
        client.emit("notification", {
          method: "item/completed",
          params: {
            threadId: "thread-long",
            turnId: "turn-long",
            item: {
              type: "agentMessage",
              phase: "final_answer",
              text: "Finished after the former deadline",
            },
          },
        });
        client.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread-long",
            turn: { id: "turn-long", status: "completed", items: [] },
          },
        });
      }, 20);
      return { turn: { id: "turn-long" } };
    }
    return {};
  };

  const result = await client.runChat({
    message: "Take as long as needed",
    graph: "maskys",
    promptBlockUid: "prompt123",
    // Legacy callers may still pass the old option. It must not impose a cap.
    timeoutMs: 1,
  });

  assert.equal(result.reply, "Finished after the former deadline");
  assert.equal(client.listenerCount("notification"), 0);
  assert.equal(client.listenerCount("exit"), 0);
  assert.equal(client.listenerCount("protocolError"), 0);
});

test("app-server chat still fails promptly when its client process exits", async () => {
  const client = new AppServerClient({ runtimeCwd: "/runtime/agent" });
  client.start = async () => {};
  client.request = async (method) => {
    if (method === "thread/start") {
      return { thread: { id: "thread-exit" }, instructionSources: [] };
    }
    if (method === "turn/start") {
      queueMicrotask(() => client.emit("exit", new Error("app-server exited")));
      return { turn: { id: "turn-exit" } };
    }
    return {};
  };

  await assert.rejects(
    client.runChat({
      message: "Keep working",
      graph: "maskys",
      promptBlockUid: "prompt123",
    }),
    /app-server exited/,
  );
  assert.equal(client.listenerCount("notification"), 0);
  assert.equal(client.listenerCount("exit"), 0);
  assert.equal(client.listenerCount("protocolError"), 0);
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

test("app-server mirrors the graph page label into the Codex thread name", async () => {
  const client = new AppServerClient();
  client.start = async () => {};
  const calls = [];
  client.request = async (method, params) => calls.push({ method, params });
  assert.deepEqual(
    await client.setThreadName("thread_graph_123", "Readable graph title"),
    { threadId: "thread_graph_123", name: "Readable graph title" },
  );
  assert.deepEqual(calls, [{
    method: "thread/name/set",
    params: {
      threadId: "thread_graph_123",
      name: "Readable graph title",
    },
  }]);
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
    async listMcpServers() {
      return ["felt", "paper"];
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
    async setThreadName(threadId, name) {
      assert.equal(threadId, "thread_12345678");
      assert.equal(name, "Readable graph title");
      return { threadId, name };
    },
    async runChat({ onProgress, onThread, onStarted, onApproval, ...input }) {
      assert.equal(typeof onApproval, "function");
      assert.deepEqual(input, {
        message: "Hello panel",
        graph: "maskys",
        promptBlockUid: "prompt123",
        threadId: null,
        model: "model-from-list",
        effort: "medium",
        serviceTier: undefined,
        accessMode: "auto",
        enabledServers: ["felt"],
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

  const nameResponse = await fetch(
    `${base}/threads/thread_12345678/name`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        graph: "maskys",
        name: "Readable graph title",
      }),
    },
  );
  assert.equal(nameResponse.status, 200);
  assert.deepEqual(await nameResponse.json(), {
    threadId: "thread_12345678",
    name: "Readable graph title",
  });

  const serversResponse = await fetch(`${base}/mcp-servers`, { headers });
  assert.equal(serversResponse.status, 200);
  assert.deepEqual(await serversResponse.json(), {
    servers: ["felt", "paper"],
  });

  const badServersResponse = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      graph: "maskys",
      message: "Hello panel",
      promptBlockUid: "prompt123",
      enabledServers: ["ok", 7],
    }),
  });
  assert.equal(badServersResponse.status, 400);

  const chatResponse = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      graph: "maskys",
      message: "Hello panel",
      promptBlockUid: "prompt123",
      model: "model-from-list",
      effort: "medium",
      enabledServers: ["felt", "felt"],
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

test("manual chat streams an approval and resumes after the authenticated answer", async (t) => {
  let receivedDecision = null;
  const client = {
    ready: false,
    async runChat({ onThread, onStarted, onApproval }) {
      onThread({ threadId: "thread_manual_123" });
      await onStarted({
        threadId: "thread_manual_123",
        turnId: "turn-manual",
      });
      receivedDecision = await onApproval({
        itemId: "item-update-page",
        questions: [{
          header: "Update page",
          question: "Allow update_page to rename this page?",
        }],
      });
      return {
        threadId: "thread_manual_123",
        turnId: "turn-manual",
        reply: "Renamed",
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
    "content-type": "application/json",
  };

  const chatResponse = await fetch(`${base}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      graph: "maskys",
      message: "Rename it",
      promptBlockUid: "prompt123",
      accessMode: "manual",
    }),
  });
  const reader = chatResponse.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const events = [];
  let approval;
  while (!approval) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    events.push(...lines.filter(Boolean).map((line) => JSON.parse(line)));
    approval = events.find((event) => event.type === "approval");
  }
  assert.equal(approval.questions[0].header, "Update page");
  const runId = events.find((event) => event.type === "started")?.runId;
  assert.match(runId, /^[0-9a-f-]{36}$/i);

  const approvalResponse = await fetch(
    `${base}/runs/${runId}/approvals/${approval.approvalId}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "accept" }),
    },
  );
  assert.equal(approvalResponse.status, 200);
  assert.deepEqual(await approvalResponse.json(), { ok: true });

  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    events.push(...lines.filter(Boolean).map((line) => JSON.parse(line)));
    if (done) break;
  }
  if (pending.trim()) events.push(JSON.parse(pending));
  assert.equal(receivedDecision, "accept");
  assert.deepEqual(events.map((event) => event.type), [
    "started",
    "conversation",
    "approval",
    "completed",
  ]);
  assert.equal(events.at(-1).result.reply, "Renamed");
});

test("pairing binds the graph, creates its client, and persists the choice", async (t) => {
  const created = [];
  const bound = [];
  const server = createBridgeServer({
    token: "secret-token",
    graph: null,
    createClient: (graph) => {
      created.push(graph);
      return { ready: false, async listMcpServers() { return []; } };
    },
    onBind: async (graph) => bound.push(graph),
    requestConsent: async ({ graph }) => {
      assert.equal(graph, "My Graph");
      return { supported: true, allowed: true };
    },
    ensureGraphAccess: async () => ({ connected: true, alreadyConnected: true }),
    trace: async () => {},
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = "https://roamresearch.com";

  const unbound = await (await fetch(`${base}/health`, { headers: { origin } })).json();
  assert.equal(unbound.ok, true);
  assert.equal(unbound.graph, null);

  const tooEarly = await fetch(`${base}/mcp-servers`, {
    headers: { origin, authorization: "Bearer secret-token" },
  });
  assert.equal(tooEarly.status, 409);
  assert.equal((await tooEarly.json()).code, "NOT_BOUND");

  const paired = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ graph: "My Graph" }),
  });
  assert.equal(paired.status, 200);
  assert.deepEqual(await paired.json(), {
    graph: "My Graph",
    token: "secret-token",
  });
  assert.deepEqual(created, ["My Graph"]);
  assert.deepEqual(bound, ["My Graph"]);

  const health = await (await fetch(`${base}/health`, { headers: { origin } })).json();
  assert.equal(health.graph, "My Graph");

  const nowServed = await fetch(`${base}/mcp-servers`, {
    headers: { origin, authorization: "Bearer secret-token" },
  });
  assert.equal(nowServed.status, 200);
});

test("runtime graph access is reused when already connected", async () => {
  const home = resolve(tmpdir(), `roam-tools-home-${process.pid}`);
  await mkdir(home, { recursive: true });
  await writeFile(
    resolve(home, ".roam-tools.json"),
    JSON.stringify({
      version: 1,
      graphs: [{ name: "maskys", nickname: "maskys", accessLevel: "full" }],
    }),
  );
  let connectCalls = 0;
  assert.deepEqual(
    await ensureRuntimeGraphAccess({
      graph: "maskys",
      home,
      execFileImpl: async () => {
        connectCalls += 1;
        return { stdout: "" };
      },
    }),
    { connected: true, alreadyConnected: true },
  );
  assert.equal(connectCalls, 0);

  const connectArgs = [];
  assert.deepEqual(
    await ensureRuntimeGraphAccess({
      graph: "other-graph",
      home,
      execFileImpl: async (command, args) => {
        connectArgs.push([command, ...args]);
        return { stdout: "" };
      },
    }),
    { connected: true, alreadyConnected: false },
  );
  assert.deepEqual(connectArgs, [[
    "npx",
    "-y",
    "@roam-research/roam-mcp",
    "connect",
    "--graph",
    "other-graph",
    "--nickname",
    "other-graph",
    "--access-level",
    "full",
  ]]);

  const failed = await ensureRuntimeGraphAccess({
    graph: "unreachable",
    home,
    execFileImpl: async () => {
      throw new Error("Roam Desktop is not running");
    },
  });
  assert.equal(failed.connected, false);
  await rm(home, { recursive: true, force: true });
});

test("a declined pairing dialog refuses to bind", async (t) => {
  const server = createBridgeServer({
    token: "secret-token",
    graph: null,
    createClient: () => ({ ready: false }),
    requestConsent: async () => ({ supported: true, allowed: false }),
    trace: async () => {},
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = "https://roamresearch.com";

  const declined = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ graph: "maskys" }),
  });
  assert.equal(declined.status, 403);
  const health = await (await fetch(`${base}/health`, { headers: { origin } })).json();
  assert.equal(health.graph, null);
});

test("the consent dialog reads Allow, Deny, and timeouts from osascript", async () => {
  const allow = await requestPairingConsent({
    graph: "maskys",
    platform: "darwin",
    execFileImpl: async (command, args) => {
      assert.equal(command, "osascript");
      assert.match(args[1], /wants to use your local Codex bridge/);
      return { stdout: "button returned:Allow\n" };
    },
  });
  assert.deepEqual(allow, { supported: true, allowed: true });

  const timedOut = await requestPairingConsent({
    graph: "maskys",
    platform: "darwin",
    execFileImpl: async () => ({ stdout: "button returned:Deny, gave up:true\n" }),
  });
  assert.equal(timedOut.allowed, false);

  const denied = await requestPairingConsent({
    graph: "maskys",
    platform: "darwin",
    execFileImpl: async () => {
      throw Object.assign(new Error("User canceled"), { code: 1 });
    },
  });
  assert.deepEqual(denied, { supported: true, allowed: false });

  assert.deepEqual(
    await requestPairingConsent({ graph: "maskys", platform: "linux" }),
    { supported: false },
  );
});

test("a failed chat run streams the error classification to the client", async (t) => {
  const traceEntries = [];
  const client = {
    ready: true,
    async runChat() {
      const error = new Error("Codex turn did not complete: usage limit hit.");
      error.codexErrorInfo = "usageLimitExceeded";
      error.additionalDetails = "Your limit resets at 9pm.";
      error.httpStatusCode = 429;
      throw error;
    },
  };
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

  const response = await fetch(`${base}/chat`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      authorization: "Bearer secret-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      graph: "maskys",
      message: "Do the thing",
      promptBlockUid: "prompt123",
    }),
  });
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const failure = events.find((event) => event.type === "error");
  assert.equal(failure.codexErrorInfo, "usageLimitExceeded");
  assert.equal(failure.additionalDetails, "Your limit resets at 9pm.");
  assert.equal(failure.httpStatusCode, 429);

  const traced = traceEntries.find((entry) => entry.event === "chat.failed");
  assert.equal(traced.codexErrorInfo, "usageLimitExceeded");
  assert.equal(traced.httpStatusCode, 429);
  assert.equal(traced.additionalDetails, "Your limit resets at 9pm.");
});

test("a failed work run keeps the complete error classification in its trace", async (t) => {
  const traceEntries = [];
  const client = {
    ready: true,
    async runWork() {
      const error = new Error("Roam MCP request failed.");
      error.codexErrorInfo = "httpConnectionFailed";
      error.httpStatusCode = 503;
      error.additionalDetails = "The upstream graph service is unavailable.";
      throw error;
    },
  };
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

  const response = await fetch(`${base}/probe`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      authorization: "Bearer secret-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: "maskys", blockUid: "abcdefghi" }),
  });
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const failure = events.find((event) => event.type === "error");
  assert.equal(failure.codexErrorInfo, "httpConnectionFailed");
  assert.equal(failure.httpStatusCode, 503);
  assert.equal(
    failure.additionalDetails,
    "The upstream graph service is unavailable.",
  );

  const traced = traceEntries.find((entry) => entry.event === "work.failed");
  assert.equal(traced.codexErrorInfo, "httpConnectionFailed");
  assert.equal(traced.httpStatusCode, 503);
  assert.equal(
    traced.additionalDetails,
    "The upstream graph service is unavailable.",
  );
});

test("a work run is a chat turn with the block prompt and work instructions", async () => {
  const client = new AppServerClient({ runtimeCwd: "/runtime/agent" });
  const requests = [];
  client.start = async () => {};
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-work" }, instructionSources: [] };
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        client.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread-work",
            turn: {
              id: "turn-work",
              status: "completed",
              items: [{
                type: "agentMessage",
                phase: "final_answer",
                text: "Added a comparison beneath the block.",
              }],
            },
          },
        });
      });
      return { turn: { id: "turn-work" } };
    }
    return {};
  };

  const result = await client.runWork({
    graph: "maskys",
    blockUid: "abcdefghi",
  });
  assert.equal(result.reply, "Added a comparison beneath the block.");

  const threadStart = requests.find((entry) => entry.method === "thread/start");
  const turnStart = requests.find((entry) => entry.method === "turn/start");
  assert.equal(threadStart.params.ephemeral, true);
  assert.equal(threadStart.params.serviceName, "roam_codex_work");
  assert.match(
    threadStart.params.developerInstructions,
    /block-task runtime/,
  );
  assert.equal(
    threadStart.params.config.mcp_servers.roam.enabled_tools.includes(
      "create_block",
    ),
    true,
  );
  assert.equal(turnStart.params.outputSchema, undefined);
  assert.match(turnStart.params.input[0].text, /Work on Roam block UID/);
  assert.match(turnStart.params.input[0].text, /Codex\/running/);

  await assert.rejects(
    () => client.runWork({ graph: "maskys", blockUid: "no" }),
    (error) => error.code === "BLOCK_UID_INVALID",
  );
});

test("read-only access keeps write tools away from a work run", async () => {
  const client = new AppServerClient({ runtimeCwd: "/runtime/agent" });
  const requests = [];
  client.start = async () => {};
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-ro" }, instructionSources: [] };
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        client.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: "thread-ro",
            turn: {
              id: "turn-ro",
              status: "completed",
              items: [{ type: "agentMessage", phase: "final_answer", text: "Read only." }],
            },
          },
        });
      });
      return { turn: { id: "turn-ro" } };
    }
    return {};
  };

  await client.runWork({
    graph: "maskys",
    blockUid: "abcdefghi",
    accessMode: "read-only",
  });
  const threadStart = requests.find((entry) => entry.method === "thread/start");
  const tools = threadStart.params.config.mcp_servers.roam.enabled_tools;
  assert.equal(tools.includes("get_block"), true);
  assert.equal(tools.includes("create_block"), false);
  assert.equal(tools.includes("delete_block"), false);
  assert.equal(threadStart.params.approvalPolicy, "never");
});

test("a failed turn keeps the Codex error classification", async () => {
  const usageLimited = turnFailureError({
    status: "failed",
    error: {
      message: "You have hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: "resets at 9pm",
    },
  });
  assert.equal(usageLimited.codexErrorInfo, "usageLimitExceeded");
  assert.equal(usageLimited.additionalDetails, "resets at 9pm");
  assert.match(usageLimited.message, /usage limit/);

  const upstream = turnFailureError({
    status: "failed",
    error: {
      message: "Upstream failure.",
      codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
      additionalDetails: null,
    },
  });
  assert.equal(upstream.codexErrorInfo, "httpConnectionFailed");
  assert.equal(upstream.httpStatusCode, 503);

  const bare = turnFailureError({ status: "failed", error: null });
  assert.equal(bare.codexErrorInfo, undefined);
  assert.match(bare.message, /status failed/);
});

test("auth status and browser sign-in flow through the app-server client", async () => {
  const client = new AppServerClient({ runtimeCwd: "/runtime/agent" });
  client.start = async () => {};
  const calls = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "getAuthStatus") return { authMethod: "chatgpt" };
    if (method === "account/login/start") {
      return { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.example/start" };
    }
    return {};
  };

  assert.deepEqual(await client.readAuthStatus(), {
    authenticated: true,
    method: "chatgpt",
  });
  assert.deepEqual(await client.startAccountLogin(), {
    loginId: "login-1",
    authUrl: "https://auth.example/start",
  });
  assert.deepEqual(calls.map((call) => call.method), [
    "getAuthStatus",
    "account/login/start",
  ]);

  client.request = async () => ({ authMethod: null });
  assert.equal((await client.readAuthStatus()).authenticated, false);
});

test("bridge exposes health version plus auth state and sign-in endpoints", async (t) => {
  const client = {
    ready: false,
    async readAuthStatus() {
      return { authenticated: false, method: null };
    },
    async startAccountLogin() {
      return { loginId: "login-1", authUrl: "https://auth.example/start" };
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

  const health = await (await fetch(`${base}/health`, {
    headers: { origin: headers.origin },
  })).json();
  assert.equal(health.ok, true);
  assert.match(health.version, /^\d+\.\d+\.\d+$/);

  const unauthenticated = await fetch(`${base}/auth`, {
    headers: { origin: headers.origin },
  });
  assert.equal(unauthenticated.status, 401);

  const auth = await fetch(`${base}/auth`, { headers });
  assert.equal(auth.status, 200);
  assert.deepEqual(await auth.json(), { auth: "signed-out", method: null });

  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers,
  });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), {
    ok: true,
    loginId: "login-1",
    authUrl: "https://auth.example/start",
  });
});

test("steer requests append text input to the exact active turn", async () => {
  const client = new AppServerClient({ runtimeCwd: "/runtime/agent" });
  const calls = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    return { turnId: "turn-9" };
  };
  const result = await client.steerTurn({
    threadId: "thread-9",
    turnId: "turn-9",
    message: "Focus on failing tests first.",
  });
  assert.deepEqual(calls, [{
    method: "turn/steer",
    params: {
      threadId: "thread-9",
      input: [{ type: "text", text: "Focus on failing tests first." }],
      expectedTurnId: "turn-9",
    },
  }]);
  assert.deepEqual(result, { turnId: "turn-9" });
});

test("thread messages keep every steered user message in order", async () => {
  const client = new AppServerClient({ runtimeCwd: "/runtime/agent" });
  client.start = async () => {};
  client.request = async (method) => {
    assert.equal(method, "thread/turns/list");
    return {
      data: [{
        items: [
          {
            type: "userMessage",
            content: [{ type: "text", text: "First ask" }],
          },
          { type: "agentMessage", text: "Working on it", phase: "partial" },
          {
            type: "userMessage",
            content: [{ type: "text", text: "Actually focus on tests" }],
          },
          { type: "agentMessage", text: "Final answer", phase: "final_answer" },
        ],
      }],
    };
  };
  assert.deepEqual(await client.listThreadMessages("thread_12345678"), [
    { role: "user", text: "First ask" },
    { role: "user", text: "Actually focus on tests" },
    { role: "assistant", text: "Final answer" },
  ]);
});

test("an active chat turn accepts a steer through the bridge", async (t) => {
  let finishTurn;
  const turnDone = new Promise((resolve) => {
    finishTurn = resolve;
  });
  const steerCalls = [];
  const client = {
    ready: false,
    async runChat({ onThread, onStarted }) {
      onThread({ threadId: "thread_steer_123" });
      await onStarted({ threadId: "thread_steer_123", turnId: "turn-steer" });
      await turnDone;
      return {
        threadId: "thread_steer_123",
        turnId: "turn-steer",
        reply: "Adjusted",
      };
    },
    async steerTurn(input) {
      steerCalls.push(input);
      return { turnId: input.turnId };
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
    "content-type": "application/json",
  };

  const chatResponse = await fetch(`${base}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      graph: "maskys",
      message: "Start the work",
      promptBlockUid: "prompt123",
    }),
  });
  const reader = chatResponse.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const events = [];
  while (!events.some((event) => event.type === "started")) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    events.push(...lines.filter(Boolean).map((line) => JSON.parse(line)));
  }
  const runId = events.find((event) => event.type === "started").runId;

  const unknownResponse = await fetch(
    `${base}/runs/00000000-0000-4000-8000-000000000000/steer`,
    { method: "POST", headers, body: JSON.stringify({ message: "hi" }) },
  );
  assert.equal(unknownResponse.status, 404);

  const emptyResponse = await fetch(`${base}/runs/${runId}/steer`, {
    method: "POST",
    headers,
    body: JSON.stringify({ graph: "maskys", message: "   " }),
  });
  assert.equal(emptyResponse.status, 400);

  const missingGraphResponse = await fetch(`${base}/runs/${runId}/steer`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "Actually focus on tests" }),
  });
  assert.equal(missingGraphResponse.status, 400);

  const steerResponse = await fetch(`${base}/runs/${runId}/steer`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      graph: "maskys",
      message: "Actually focus on tests",
    }),
  });
  assert.equal(steerResponse.status, 200);
  assert.deepEqual(await steerResponse.json(), {
    ok: true,
    turnId: "turn-steer",
  });

  finishTurn();
  while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    events.push(...lines.filter(Boolean).map((line) => JSON.parse(line)));
    if (done) break;
  }
  assert.deepEqual(steerCalls, [{
    threadId: "thread_steer_123",
    turnId: "turn-steer",
    message: "Actually focus on tests",
  }]);
  assert.equal(
    events.find((event) => event.type === "completed")?.result.reply,
    "Adjusted",
  );
});

test("bridge enforces bearer auth and graph restriction", async (t) => {
  const calls = [];
  const client = {
    ready: false,
    async runWork({ onProgress, onStarted, onApproval, ...input }) {
      calls.push(input);
      onProgress({ kind: "activity", text: "Reading the selected block" });
      await onStarted({ threadId: "thr_test", turnId: "turn_test" });
      return {
        threadId: "thr_test",
        turnId: "turn_test",
        reply: "Added three blocks beneath it.",
      };
    },
  };
  const traceEntries = [];
  const server = createBridgeServer({
    token: "secret-token",
    graph: "maskys",
    client,
    requestConsent: async () => ({ supported: false }),
    ensureGraphAccess: async () => ({ connected: true, alreadyConnected: true }),
    pairingCodePath: resolve(tmpdir(), `roam-pairing-code-${process.pid}`),
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

  const codeless = await fetch(`${base}/pair`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: "maskys" }),
  });
  assert.equal(codeless.status, 200);
  assert.deepEqual(await codeless.json(), { codeRequired: true });

  const namelessGraph = await fetch(`${base}/pair`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: "   " }),
  });
  assert.equal(namelessGraph.status, 400);

  const incorrectCode = await fetch(`${base}/pair`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: "maskys", code: "wrong-code" }),
  });
  assert.equal(incorrectCode.status, 403);

  const issuedCode = (await readFile(
    resolve(tmpdir(), `roam-pairing-code-${process.pid}`),
    "utf8",
  )).trim();
  const pair = await fetch(`${base}/pair`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: "maskys", code: issuedCode }),
  });
  assert.equal(pair.status, 200);
  assert.deepEqual(await pair.json(), {
    graph: "maskys",
    token: "secret-token",
  });

  const replay = await fetch(`${base}/pair`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ graph: "maskys", code: "ABCDEF-123456" }),
  });
  assert.equal(replay.status, 403);

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

  const missingGraph = await fetch(`${base}/probe`, {
    method: "POST",
    headers: {
      origin: "https://roamresearch.com",
      authorization: "Bearer secret-token",
      "content-type": "application/json",
      "x-roam-graph": "maskys",
    },
    body: JSON.stringify({ blockUid: "abcdefghi" }),
  });
  assert.equal(missingGraph.status, 400);

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
  assert.equal(events[2].result.reply, "Added three blocks beneath it.");
  assert.deepEqual(calls, [{
    graph: "maskys",
    blockUid: "abcdefghi",
    accessMode: "auto",
  }]);
  assert.deepEqual(
    traceEntries.map((entry) => entry.event),
    ["pair.bound", "work.started", "work.completed"],
  );
});

test("bridge cancellation interrupts the active app-server turn", async (t) => {
  let rejectProbe;
  const interruptCalls = [];
  const client = {
    ready: true,
    async runWork({ onStarted }) {
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
    ["work.started", "work.cancel.requested", "work.interrupted"],
  );
});
