import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../server/hub.mjs";
import { SessionIndex } from "../server/sessions.mjs";

const event = (type, payload) =>
  JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
test("active long rollout retains the current turn and plan across an omitted middle and incomplete append", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-active-"));
  try {
    await mkdir(join(dir, "sessions"));
    const path = join(
      dir,
      "sessions",
      "rollout-test-01a176eb-b0a9-7073-bacd-469a616e7635.jsonl",
    );
    const padding = event("response_item", {
      type: "reasoning",
      encrypted_content: "x".repeat(600000),
    });
    const lines = [
      event("session_meta", { id: "active-thread", cwd: "/work" }),
      event("event_msg", { type: "task_started", turn_id: "old" }),
      event("event_msg", {
        type: "task_complete",
        last_agent_message: "old result",
      }),
      padding,
      padding,
      event("event_msg", { type: "task_started", turn_id: "current" }),
      event("response_item", {
        type: "function_call",
        name: "update_plan",
        arguments: JSON.stringify({
          plan: [{ step: "Current step", status: "in_progress" }],
        }),
      }),
      padding,
      padding,
      event("response_item", { type: "function_call", name: "exec" }),
    ];
    await writeFile(path, lines.join("\n") + "\n");
    const index = new SessionIndex(),
      profiles = [{ id: "codex2", home: dir }],
      activePaths = new Set([path]);
    const [s] = await index.scan(profiles, { activePaths });
    assert.equal(s.state, "running");
    assert.equal(s.turnId, "current");
    assert.equal(s.plan[0].step, "Current step");
    assert.equal(s.historyPartial, false);
    const record =
      event("event_msg", {
        type: "task_complete",
        last_agent_message: "新结果",
      }) + "\n";
    const bytes = Buffer.from(record),
      split = bytes.indexOf(Buffer.from("新")) + 1;
    await appendFile(path, bytes.subarray(0, split));
    assert.equal(
      (await index.scan(profiles, { activePaths }))[0].state,
      "running",
    );
    await appendFile(path, bytes.subarray(split));
    const [done] = await index.scan(profiles, { activePaths });
    assert.equal(done.state, "completed");
    assert.equal(done.result.text, "新结果");
    assert.equal(index.cache.get(path).offset, (await stat(path)).size);
    const [cached] = await index.scan(profiles, { activePaths });
    assert.equal(cached.messages.length, done.messages.length);
  } finally {
    await rm(dir, { recursive: true });
  }
});

function fixture() {
  const store = { data: { commands: [], reviewed: {} }, save: async () => {} },
    hub = new Hub(store),
    items = new Map(),
    calls = [];
  const session = {
    id: "legacy-thread",
    key: "codex2:legacy-thread",
    profile: "codex2",
    live: false,
    canControl: false,
    canQueue: true,
    state: "running",
    processes: [123],
    clientReceipts: {},
  };
  hub.sessions.set(session.key, session);
  const rpc = {
    ready: true,
    request: async (method, params) => {
      calls.push(method);
      if (method === "thread/queue/add") {
        const item = {
          id: "native-" + params.clientUserMessageId,
          clientUserMessageId: params.clientUserMessageId,
          input: params.input,
        };
        items.set(item.id, item);
        return { queuedSubmission: item };
      }
      if (method === "thread/queue/list")
        return { data: [...items.values()], nextCursor: null };
      if (method === "thread/queue/delete")
        return { deleted: items.delete(params.queuedSubmissionId) };
      throw new Error("Unsafe unexpected method: " + method);
    },
  };
  hub.clients.set("test-socket", {
    profile: "codex2",
    rpc,
    nativeQueueSupported: true,
  });
  return { hub, session, calls, items };
}
test("legacy queue submits once through the native API without resume, turn/start, or terminal input", async () => {
  const { hub, session, calls } = fixture();
  const c = await hub.command(
    session.key,
    "next task",
    "queue",
    "request-native-1",
  );
  assert.equal(c.state, "queued");
  assert.equal(c.delivery, "native");
  assert.ok(c.nativeQueueId);
  await hub.command(session.key, "next task", "queue", "request-native-1");
  await hub.dispatch(c);
  assert.deepEqual(calls, ["thread/queue/add"]);
  await assert.rejects(
    hub.command(session.key, "do now", "steer", "request-steer-1"),
    /只能监控/,
  );
});
test("native queue receipts reconcile to sent, while native cancellation removes the actual entry", async () => {
  const { hub, session, items } = fixture();
  const c = await hub.command(session.key, "next", "queue", "request-receipt");
  items.clear();
  session.clientReceipts[c.id] = {
    turnId: "turn-next",
    time: new Date().toISOString(),
  };
  await hub.refreshNativeQueues(hub.sessions);
  assert.equal(c.state, "sent");
  assert.equal(c.turnId, "turn-next");
  const cancel = await hub.command(
    session.key,
    "cancel this",
    "queue",
    "request-cancel-1",
  );
  await hub.cancel(cancel.id);
  assert.equal(cancel.state, "cancelled");
  assert.equal(items.size, 0);
});
test("a lost native write response is reconciled by read-only client-message identity, never replayed", async () => {
  const { hub, session, calls } = fixture();
  const client = [...hub.clients.values()][0],
    request = client.rpc.request;
  client.rpc.request = async (...args) => {
    const result = await request(...args);
    if (args[0] === "thread/queue/add")
      throw Object.assign(new Error("lost response"), { uncertain: true });
    return result;
  };
  const c = await hub.command(
    session.key,
    "next",
    "queue",
    "request-native-lost",
  );
  assert.equal(c.state, "uncertain");
  await hub.refreshNativeQueues(hub.sessions);
  assert.equal(c.state, "queued");
  assert.ok(c.nativeQueueId);
  await hub.command(session.key, "next", "queue", c.id);
  assert.equal(calls.filter((x) => x === "thread/queue/add").length, 1);
});
test("absence from the native queue is not assumed to mean successful execution", async () => {
  const { hub, session, items } = fixture();
  const c = await hub.command(
    session.key,
    "removed elsewhere",
    "queue",
    "request-absent-1",
  );
  items.clear();
  await hub.refreshNativeQueues(hub.sessions);
  assert.equal(c.state, "queued");
  c.missingSince = Date.now() - 16000;
  await hub.refreshNativeQueues(hub.sessions);
  assert.equal(c.state, "uncertain");
});

test("interrupting a later shared owner also removes a previously native queued command", async () => {
  const { hub, session, items, calls } = fixture();
  const queued = await hub.command(
    session.key,
    "next",
    "queue",
    "request-before-owner-change",
  );
  session.live = true;
  session.canControl = true;
  const client = [...hub.clients.values()][0];
  const request = client.rpc.request;
  client.rpc.request = async (method, ...args) => {
    if (method === "thread/turns/list")
      return { data: [{ id: "active-turn", status: "inProgress" }] };
    if (method === "turn/interrupt") {
      calls.push(method);
      return {};
    }
    return request(method, ...args);
  };
  hub.clientFor = async () => client;
  await hub.interrupt(session.key);
  assert.equal(queued.state, "cancelled");
  assert.equal(items.size, 0);
  assert.ok(
    calls.indexOf("thread/queue/delete") < calls.indexOf("turn/interrupt"),
  );
});
