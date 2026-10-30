import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelStartParams } from "../server/model-settings.mjs";
import { parseEvents, SessionIndex } from "../server/sessions.mjs";
import { Hub } from "../server/hub.mjs";

const catalog = {
  defaults: { model: "primary", effort: "high" },
  models: [
    {
      model: "primary",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high"].map(
        (reasoningEffort) => ({ reasoningEffort }),
      ),
    },
    {
      model: "light",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    },
  ],
};
test("new session defaults match the effective configuration, while another model uses its own effort default", () => {
  assert.deepEqual(modelStartParams({}, catalog), {
    model: "primary",
    allowProviderModelFallback: false,
    config: { model_reasoning_effort: "high" },
  });
  assert.equal(
    modelStartParams({ model: "light" }, catalog).config.model_reasoning_effort,
    "low",
  );
  assert.throws(
    () => modelStartParams({ model: "light", effort: "high" }, catalog),
    /不支持/,
  );
  assert.throws(
    () => modelStartParams({ model: "bad name" }, catalog),
    /名称无效/,
  );
  assert.deepEqual(
    modelStartParams(
      {
        model: "gateway/custom",
        effort: "high",
        approvalPolicy: "never",
        config: { secret: "never-pass" },
      },
      catalog,
    ),
    {
      model: "gateway/custom",
      allowProviderModelFallback: false,
      config: { model_reasoning_effort: "high" },
    },
  );
});
test("turn metadata records effort and clears a previous explicit effort when a later turn has none", () => {
  const line = (payload) => JSON.stringify({ type: "turn_context", payload });
  const first = parseEvents([line({ model: "primary", effort: "high" })]);
  assert.equal(first.reasoningEffort, "high");
  const next = parseEvents([line({ model: "light", effort: null })], first);
  assert.equal(next.model, "light");
  assert.equal(next.reasoningEffort, null);
});
test("native archived logs appear only as archived and move back on restoration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-web-trash-"));
  try {
    await mkdir(join(dir, "sessions"));
    await mkdir(join(dir, "archived_sessions"));
    const name = "rollout-test.jsonl",
      from = join(dir, "sessions", name),
      to = join(dir, "archived_sessions", name);
    await writeFile(
      from,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "move", cwd: "/work" },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: { model: "primary", effort: "high" },
        }),
        "",
      ].join("\n"),
    );
    const index = new SessionIndex(),
      profiles = [{ id: "codex", home: dir }];
    assert.equal((await index.scan(profiles))[0].archived, false);
    await rename(from, to);
    const archived = await index.scan(profiles);
    assert.equal(archived.length, 1);
    assert.equal(archived[0].archived, true);
    assert.equal(archived[0].reasoningEffort, "high");
    await rename(to, from);
    const restored = await index.scan(profiles);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].archived, false);
  } finally {
    await rm(dir, { recursive: true });
  }
});
function managementFixture() {
  const hub = new Hub({
    data: { commands: [], reviewed: {}, trash: {} },
    save: async () => {},
  });
  const root = {
    key: "codex:parent",
    id: "parent",
    profile: "codex",
    live: false,
    processes: [],
    state: "completed",
    archived: false,
  };
  const child = {
    ...root,
    key: "codex:child",
    id: "child",
    parentThreadId: root.id,
  };
  hub.sessions.set(root.key, root);
  hub.sessions.set(child.key, child);
  const calls = [];
  let nativeItems = [];
  const rpc = {
    ready: true,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read")
        return { thread: { status: { type: "notLoaded" } } };
      if (method === "thread/queue/list") return { data: nativeItems };
      if (method === "thread/archive") {
        root.archived = true;
        child.archived = true;
        return {};
      }
      if (method === "thread/unarchive") {
        root.archived = false;
        return { thread: { id: root.id } };
      }
      throw Error("Unexpected unsafe method " + method);
    },
  };
  hub.clients.set("endpoint", { profile: "codex", rpc });
  hub.refresh = async () => {};
  return {
    hub,
    root,
    child,
    calls,
    setNativeItems: (items) => {
      nativeItems = items;
    },
  };
}
test("trash refuses an active descendant, an open terminal, and unresolved commands without archiving", async () => {
  const { hub, root, child, calls } = managementFixture();
  child.state = "running";
  await assert.rejects(hub.trash(root.key), /仍在执行/);
  child.state = "completed";
  child.processes = [123];
  await assert.rejects(hub.trash(root.key), /独立终端/);
  child.processes = [];
  hub.store.data.commands.push({ key: child.key, state: "uncertain" });
  await assert.rejects(hub.trash(root.key), /未处理/);
  assert.equal(calls.length, 0);
});
test("trash checks native queues, archives through Codex without resuming, and restores reversibly", async () => {
  const { hub, root, child, calls, setNativeItems } = managementFixture();
  setNativeItems([{ id: "submitted-elsewhere" }]);
  await assert.rejects(hub.trash(root.key), /原生队列/);
  assert.ok(!calls.some((c) => c.method === "thread/archive"));
  setNativeItems([]);
  await hub.trash(root.key);
  assert.equal(root.archived, true);
  assert.equal(child.archived, true);
  assert.ok(hub.store.data.trash[root.key].deletedAt);
  assert.ok(
    !calls.some(
      (c) => c.method === "thread/resume" || c.method === "turn/interrupt",
    ),
  );
  await assert.rejects(
    hub.command(root.key, "never send", "next", "request-trash-1"),
    /回收站/,
  );
  await hub.restore(root.key);
  assert.equal(root.archived, false);
  assert.equal(child.archived, true); // Native restore is per thread; no hidden cascading resume.
  assert.equal(hub.store.data.trash[root.key], undefined);
});
test("models endpoint exposes only model choices and defaults, excluding provider credentials", async () => {
  const { hub } = managementFixture();
  const c = hub.profileClient("codex");
  c.rpc.request = async (method) =>
    method === "config/read"
      ? {
          config: {
            model: "primary",
            model_reasoning_effort: "high",
            token: "NEVER_EXPOSE",
            model_providers: { secret: "NEVER_EXPOSE" },
          },
        }
      : {
          data: [
            {
              model: "primary",
              displayName: "Primary",
              supportedReasoningEfforts: [
                { reasoningEffort: "high", description: "High" },
              ],
            },
          ],
          nextCursor: null,
        };
  const result = await hub.models("codex");
  assert.equal(result.defaults.effort, "high");
  assert.ok(!JSON.stringify(result).includes("NEVER_EXPOSE"));
});
