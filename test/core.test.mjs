import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEvents, SessionIndex } from "../server/sessions.mjs";
import { Hub } from "../server/hub.mjs";
import { Store } from "../server/store.mjs";
import { CodexRpc } from "../server/rpc.mjs";
import { WebSocketServer } from "ws";
import http from "node:http";

const event = (type, payload, timestamp = "2026-10-25T00:00:00Z") =>
  JSON.stringify({ type, payload, timestamp });
test("turn completion, later turn, and interruption remain distinct", () => {
  const lines = [
    event("session_meta", { id: "t1", cwd: "/project" }),
    event("event_msg", { type: "task_started", turn_id: "a" }),
    event("event_msg", {
      type: "task_complete",
      last_agent_message: "result A",
    }),
    event("event_msg", { type: "task_started", turn_id: "b" }),
  ];
  const s = parseEvents(lines);
  assert.equal(s.state, "running");
  assert.equal(s.result.text, "result A");
  assert.equal(
    parseEvents([...lines, event("event_msg", { type: "turn_aborted" })]).state,
    "interrupted",
  );
});
test("a final-looking commentary is not treated as a final result; encrypted reasoning is excluded", () => {
  const s = parseEvents([
    event("response_item", {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ text: "<script>test</script>" }],
    }),
    event("response_item", {
      type: "reasoning",
      encrypted_content: "NEVER_RENDER",
    }),
  ]);
  assert.equal(s.result, undefined);
  assert.equal(s.messages[0].text, "<script>test</script>");
  assert.ok(!JSON.stringify(s).includes("NEVER_RENDER"));
});
test("embedded parent metadata does not collapse a fork into its parent thread", () => {
  const s = parseEvents([
    event("session_meta", {
      id: "child",
      cwd: "/child",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "parent",
            agent_nickname: "test-agent",
          },
        },
      },
    }),
    event("session_meta", { id: "parent", cwd: "/parent", source: "cli" }),
  ]);
  assert.equal(s.id, "child");
  assert.equal(s.cwd, "/child");
  assert.equal(s.parentThreadId, "parent");
});
test("a later tool event prevents stale completion from being shown as current completion", () => {
  const s = parseEvents([
    event("event_msg", { type: "task_complete", last_agent_message: "old" }),
    event(
      "response_item",
      { type: "function_call", name: "exec" },
      "2026-10-25T00:01:00Z",
    ),
  ]);
  assert.equal(s.state, "unknown");
  assert.equal(s.result.text, "old");
});
test("index reads the end of a medium log and tolerates an incomplete final line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-test-"));
  try {
    await mkdir(join(dir, "sessions"));
    const filename = join(
      dir,
      "sessions",
      "rollout-2026-01-01-01a176eb-b0a9-7073-bacd-469a616e7635.jsonl",
    );
    await writeFile(
      filename,
      [
        event("session_meta", { id: "medium", cwd: "/work" }),
        ...Array(110).fill(
          event("response_item", {
            type: "reasoning",
            encrypted_content: "x".repeat(1700),
          }),
        ),
        event("event_msg", {
          type: "task_complete",
          last_agent_message: "tail result",
        }),
        '{"partial":',
      ].join("\n"),
    );
    const [s] = await new SessionIndex().scan([{ id: "codex1", home: dir }]);
    assert.equal(s.result.text, "tail result");
    assert.equal(s.profile, "codex1");
  } finally {
    await rm(dir, { recursive: true });
  }
});
test("store restart does not replay a possibly executed command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-test-"));
  try {
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({
        commands: [{ id: "cmd", state: "sending" }],
        reviewed: {},
      }),
    );
    const store = new Store(dir);
    await store.load();
    assert.equal(store.data.commands[0].state, "uncertain");
  } finally {
    await rm(dir, { recursive: true });
  }
});
function hubFixture({ state = "idle", sendError } = {}) {
  const store = { data: { commands: [], reviewed: {} }, save: async () => {} };
  const hub = new Hub(store);
  const calls = [];
  hub.sessions.set("codex:a", {
    key: "codex:a",
    id: "a",
    live: true,
    canControl: true,
    state,
    messages: [],
  });
  hub.clientFor = async () => ({
    rpc: {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/read")
          return {
            thread: {
              status: { type: state === "running" ? "active" : "idle" },
            },
          };
        if (method === "turn/start") {
          if (sendError) throw sendError;
          return { turn: { id: "new-turn" } };
        }
      },
    },
  });
  return { hub, calls };
}
test("duplicate HTTP submission id sends a single model turn", async () => {
  const { hub, calls } = hubFixture();
  const a = await hub.command("codex:a", "do work", "next", "request-12345");
  const b = await hub.command("codex:a", "do work", "next", "request-12345");
  assert.equal(a.state, "sent");
  assert.equal(a, b);
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 1);
  await assert.rejects(
    hub.command("codex:a", "different", "next", "request-12345"),
    /编号/,
  );
});
test("queue remains pending while running; cancellation prevents subsequent dispatch", async () => {
  const { hub, calls } = hubFixture({ state: "running" });
  const c = await hub.command(
    "codex:a",
    "afterwards",
    "queue",
    "request-queue",
  );
  assert.equal(c.state, "queued");
  assert.equal(calls.length, 0);
  await hub.cancel(c.id);
  assert.equal(c.state, "cancelled");
});
test("uncertain write is retained without retry", async () => {
  const { hub, calls } = hubFixture({
    sendError: Object.assign(new Error("lost response"), { uncertain: true }),
  });
  const c = await hub.command("codex:a", "do work", "next", "request-lost");
  assert.equal(c.state, "uncertain");
  await hub.command("codex:a", "do work", "next", "request-lost");
  assert.equal(calls.filter((c) => c.method === "turn/start").length, 1);
});
test("a cancelled queue record cannot be dispatched", async () => {
  const { hub, calls } = hubFixture();
  const c = {
    id: "cancelled",
    key: "codex:a",
    text: "never send",
    state: "cancelled",
  };
  await hub.dispatch(c);
  assert.equal(calls.length, 0);
});
test("a new loaded thread without a rollout can receive its first input without resume", async () => {
  const hub = new Hub({ data: { commands: [], reviewed: {} } });
  const calls = [];
  const client = {
    rpc: { ready: true, request: async (method) => calls.push(method) },
    subscribed: new Set(),
  };
  hub.clients.set("new-endpoint", client);
  const found = await hub.clientFor({
    live: true,
    id: "new",
    endpoint: "new-endpoint",
  });
  assert.equal(found, client);
  assert.deepEqual(calls, []);
});
test("Unix WebSocket performs official handshake and marks an interrupted write uncertain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-test-"));
  const socket = join(dir, "rpc.sock");
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const methods = [];
  wss.on("connection", (ws) =>
    ws.on("message", (bytes) => {
      const m = JSON.parse(bytes);
      methods.push(m.method);
      if (m.method === "initialize")
        ws.send(JSON.stringify({ id: m.id, result: {} }));
      if (m.method === "turn/start") ws.close();
    }),
  );
  await new Promise((resolve) => server.listen(socket, resolve));
  const rpc = new CodexRpc({ socket, home: dir });
  try {
    await rpc.connect();
    await assert.rejects(
      rpc.request("turn/start", {}, { write: true }),
      (e) => e.uncertain === true,
    );
    assert.deepEqual(methods.slice(0, 3), [
      "initialize",
      "initialized",
      "turn/start",
    ]);
  } finally {
    rpc.close();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true });
  }
});
