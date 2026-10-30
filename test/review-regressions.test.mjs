import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hub } from "../server/hub.mjs";
import { ChangeBatch, overviewSignature } from "../server/changes.mjs";
import { mergeTurnMessages } from "../server/messages.mjs";
import { parseEvents, SessionIndex } from "../server/sessions.mjs";
import { Store } from "../server/store.mjs";

test("token notifications produce only bounded deltas, while state changes invalidate their own thread", () => {
  const hub = new Hub({ data: { commands: [], reviewed: {} } });
  const client = hub.addClient("fixture", { profile: "codex" });
  const session = { key: "codex:a", id: "a" };
  hub.sessions.set(session.key, session);
  const batch = new ChangeBatch();
  hub.on("change", (change) => batch.add(change));
  for (let i = 0; i < 500; i++)
    client.rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: "a", itemId: "item", delta: "x" },
    });
  const changes = batch.take();
  assert.equal(changes.snapshot, false);
  assert.deepEqual(changes.keys, []);
  assert.equal(changes.streams[0].delta, "x".repeat(500));
  assert.equal(session.stream.text, changes.streams[0].delta);
  client.rpc.emit("notification", {
    method: "turn/started",
    params: { threadId: "a", turn: { id: "turn" } },
  });
  assert.equal(batch.take().snapshot, true);
  assert.deepEqual(batch.take().keys, ["codex:a"]);
  hub.close();
});

test("scan-only timestamps, RSS and sort order do not invalidate the list, but session state and queue changes do", () => {
  const base = {
    profiles: [],
    errors: [],
    processes: [{ pid: 1, rssKb: 100 }],
    sessions: [
      { key: "a", state: "running", queuedCount: 0, updatedAt: 1 },
      { key: "b", state: "idle", updatedAt: 1 },
    ],
  };
  const later = structuredClone(base);
  later.processes[0].rssKb = 200;
  later.sessions[0].updatedAt = 200;
  later.sessions.reverse();
  assert.equal(overviewSignature(base), overviewSignature(later));
  later.sessions[1].queuedCount = 1;
  assert.notEqual(overviewSignature(base), overviewSignature(later));
  later.sessions[1].queuedCount = 0;
  later.sessions[1].state = "completed";
  assert.notEqual(overviewSignature(base), overviewSignature(later));
});

test("list snapshots contain bounded previews and exclude full prompts, plans, tool details and private metadata", () => {
  const hub = new Hub({ data: { commands: [], reviewed: {} } });
  for (let i = 0; i < 294; i++)
    hub.sessions.set("codex:" + i, {
      key: "codex:" + i,
      id: String(i),
      profile: "codex",
      title: "session",
      lastPrompt: "a".repeat(16000),
      latestMessage: "b".repeat(16000),
      result: { text: "c".repeat(80000) },
      messages: ["PRIVATE"],
      livePlan: ["PRIVATE"],
      source: { private: "PRIVATE" },
      endpoint: "PRIVATE",
    });
  const snapshot = hub.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 300000);
  assert.ok(!JSON.stringify(snapshot).includes("PRIVATE"));
  assert.equal(snapshot.sessions[0].lastPrompt.length, 220);
});

test("turn-aware merging preserves identical answers and users from distinct turns without duplicating rollout items", () => {
  const turns = ["b", "a"].map((id) => ({
    id,
    items: [
      { id: id + "u", type: "userMessage", text: "continue" },
      {
        id: id + "a",
        type: "agentMessage",
        text: "好的",
        phase: "final_answer",
      },
    ],
  }));
  const local = [
    { role: "user", text: "older", turnId: "old" },
    { role: "assistant", text: "好的", turnId: "a" },
    { role: "assistant", text: "好的", turnId: "b" },
  ];
  const merged = mergeTurnMessages(local, turns);
  assert.deepEqual(
    merged.map((m) => m.text),
    ["older", "continue", "好的", "continue", "好的"],
  );
  assert.equal(new Set(merged.slice(1).map((m) => m.itemId)).size, 4);
  assert.deepEqual(mergeTurnMessages(merged, turns), merged);
});

test("rollout duplicate representations stay deduplicated within a turn and identical subsequent turns survive", () => {
  const event = (type, payload) => JSON.stringify({ type, payload });
  const s = parseEvents([
    event("event_msg", { type: "task_started", turn_id: "a" }),
    event("event_msg", { type: "agent_message", message: "好的" }),
    event("response_item", {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ text: "好的" }],
    }),
    event("event_msg", { type: "task_started", turn_id: "b" }),
    event("event_msg", { type: "task_complete", last_agent_message: "好的" }),
  ]);
  assert.equal(s.messages.length, 2);
  assert.deepEqual(
    s.messages.map((m) => m.turnId),
    ["a", "b"],
  );
  assert.equal(s.messages[0].phase, "final_answer");
  assert.equal(s.result.text, "好的");
});

test("an empty official turn does not erase local messages that have not appeared in the history API", () => {
  const local = [
    { role: "assistant", text: "previous", turnId: "a" },
    { role: "user", text: "just sent", turnId: "b" },
  ];
  const merged = mergeTurnMessages(local, [
    { id: "b", items: [] },
    { id: "a", items: [{ type: "agentMessage", text: "previous" }] },
  ]);
  assert.deepEqual(
    merged.map((m) => m.text),
    ["previous", "just sent"],
  );
});

test("history compaction retains unresolved commands and restart-safe request identity without old prompt bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-retention-"));
  try {
    const store = new Store(dir);
    await store.load();
    const old = {
      id: "retired-request",
      key: "codex:a",
      mode: "next",
      text: "PRIVATE_BODY",
      state: "sent",
    };
    store.data.commands.push(
      old,
      ...Array.from({ length: 100 }, (_, i) => ({
        id: "request-" + i,
        key: "codex:a",
        mode: "queue",
        text: "x",
        state: "cancelled",
      })),
      ...["uncertain", "queued", "pending", "sending"].map((state) => ({
        id: state,
        state,
      })),
    );
    await store.save();
    assert.equal(store.data.commands.length, 104);
    const raw = await readFile(join(dir, "state.json"), "utf8");
    assert.ok(!raw.includes("PRIVATE_BODY"));
    const restarted = new Store(dir);
    await restarted.load();
    const receipt = await restarted.retiredCommand(old.id);
    assert.equal(receipt.state, "sent");
    assert.equal(receipt.text, undefined);
    const hub = new Hub(restarted);
    // No session or RPC client exists: only the durable receipt can answer.
    assert.equal(
      (await hub.command(old.key, old.text, old.mode, old.id)).retained,
      true,
    );
    await assert.rejects(
      hub.command(old.key, "changed", old.mode, old.id),
      /编号/,
    );
    assert.ok(
      restarted.data.commands.some(
        (c) => c.id === "sending" && c.state === "uncertain",
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("simultaneous duplicate submissions stay deduplicated across asynchronous receipt lookup", async () => {
  const hub = new Hub({
    data: { commands: [], reviewed: {} },
    retiredCommand: async () => null,
    save: async () => {},
  });
  hub.sessions.set("codex:a", {
    key: "codex:a",
    live: true,
    state: "running",
    canControl: true,
  });
  const commands = await Promise.all(
    [1, 2].map(() =>
      hub.command("codex:a", "work", "queue", "request-concurrent"),
    ),
  );
  assert.equal(commands[0], commands[1]);
  assert.equal(hub.store.data.commands.length, 1);
});

test("command preparation reserves the thread before persistence and queued work cannot overtake it", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let firstSave = true,
    starts = 0;
  const hub = new Hub({
    data: { commands: [], reviewed: {} },
    save: async () => {
      if (firstSave) {
        firstSave = false;
        await gate;
      }
    },
  });
  hub.sessions.set("codex:a", {
    key: "codex:a",
    id: "a",
    live: true,
    state: "idle",
    canControl: true,
  });
  hub.clientFor = async () => ({
    rpc: {
      request: async (method) => {
        if (method === "thread/read")
          return { thread: { status: { type: "idle" } } };
        starts++;
        return { turn: { id: "turn" } };
      },
    },
  });
  const first = hub.command("codex:a", "first", "next", "request-first");
  await assert.rejects(
    hub.command("codex:a", "second", "next", "request-second"),
    /正在发送/,
  );
  const queued = await hub.command(
    "codex:a",
    "later",
    "queue",
    "request-later",
  );
  assert.equal(queued.state, "queued");
  assert.equal(starts, 0);
  release();
  assert.equal((await first).state, "sent");
  assert.equal(starts, 1);
});

test("cached inventory discovers new active logs immediately and evicts removed history on reconciliation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-inventory-"));
  try {
    await mkdir(join(dir, "sessions"));
    const history = join(dir, "sessions/rollout-history.jsonl");
    const active = join(dir, "sessions/rollout-active.jsonl");
    const data = (id) =>
      JSON.stringify({ type: "session_meta", payload: { id } }) + "\n";
    await writeFile(history, data("history"));
    const profiles = [{ id: "codex", home: dir }];
    const index = new SessionIndex();
    await index.scan(profiles, { reuseInventory: true });
    await rm(history);
    await writeFile(active, data("active"));
    const sessions = await index.scan(profiles, {
      activePaths: new Set([active]),
      reuseInventory: true,
    });
    assert.ok(sessions.some((s) => s.id === "active"));
    index.invalidate();
    const reconciled = await index.scan(profiles, {
      activePaths: new Set([active]),
      reuseInventory: true,
    });
    assert.deepEqual(
      reconciled.map((s) => s.id),
      ["active"],
    );
    assert.equal(index.cache.has(history), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
