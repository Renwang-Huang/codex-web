import { EventEmitter } from "node:events";
import { stat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { discover, profiles } from "./discovery.mjs";
import { SessionIndex } from "./sessions.mjs";
import { CodexRpc, RpcError } from "./rpc.mjs";
import { modelStartParams } from "./model-settings.mjs";
import { mergeTurnMessages } from "./messages.mjs";
import { commandFingerprint } from "./store.mjs";
import { overviewSignature } from "./changes.mjs";

export class Hub extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.index = new SessionIndex();
    this.clients = new Map();
    this.sessions = new Map();
    this.processes = [];
    this.pending = new Map();
    this.locks = new Set();
    this.preparing = new Set();
    this.errors = [];
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.scan();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }
  async scan() {
    const discovery = await discover();
    const activePaths = new Set([
      ...discovery.processes.flatMap((p) => p.sessions || []),
      ...[...this.sessions.values()]
        .filter((s) => s.live && s.path)
        .map((s) => s.path),
    ]);
    const local = await this.index.scan(profiles, {
      activePaths,
      reuseInventory: true,
    });
    this.processes = discovery.processes;
    this.errors = [];
    const alive = new Set(discovery.endpoints.map((e) => e.socket));
    for (const [key, c] of this.clients)
      if (!alive.has(key) && !c.owned) {
        c.rpc.close();
        this.clients.delete(key);
      }
    for (const e of discovery.endpoints)
      if (!this.clients.has(e.socket)) this.addClient(e.socket, e);
    const sessions = new Map();
    for (const s of local) {
      // A concurrent archive/unarchive can briefly expose both paths.
      if (sessions.has(s.key) && s.archived) continue;
      sessions.set(s.key, {
        ...s,
        live: false,
        endpoint: null,
        deletedAt: s.archived
          ? this.store.data.trash?.[s.key]?.deletedAt
          : null,
        processes: this.processes
          .filter((p) => p.sessions?.includes(s.path))
          .map((p) => p.pid),
      });
    }
    await Promise.all(
      [...this.clients].map(async ([key, c]) => {
        if (c.retryAt > Date.now()) return;
        try {
          await c.rpc.connect();
          c.error = null;
          const ids = [];
          let cursor;
          do {
            const page = await c.rpc.request("thread/loaded/list", {
              limit: 100,
              ...(cursor ? { cursor } : {}),
            });
            ids.push(...page.data);
            cursor = page.nextCursor;
          } while (cursor);
          for (const id of ids) {
            const { thread } = await c.rpc.request("thread/read", {
              threadId: id,
              includeTurns: false,
            });
            const sk = `${c.profile}:${id}`;
            const old = sessions.get(sk) || {
              id,
              key: sk,
              profile: c.profile,
              messages: [],
              activity: [],
              plan: [],
              processes: [],
            };
            const liveState = thread.status.type;
            const state =
              liveState === "active"
                ? thread.status.activeFlags.includes("waitingOnApproval")
                  ? "approval"
                  : thread.status.activeFlags.includes("waitingOnUserInput")
                    ? "input"
                    : "running"
                : liveState === "idle"
                  ? old.state === "completed"
                    ? "completed"
                    : "idle"
                  : liveState === "systemError"
                    ? "error"
                    : old.state;
            if (old.endpoint && old.endpoint !== key) {
              old.conflict = true;
              old.canControl = false;
              continue;
            }
            sessions.set(sk, {
              ...old,
              path: thread.path || old.path,
              title: thread.name || old.title || thread.preview?.slice(0, 90),
              model: thread.model || old.model,
              reasoningEffort:
                thread.model && Object.hasOwn(thread, "reasoningEffort")
                  ? thread.reasoningEffort
                  : (old.reasoningEffort ?? null),
              modelSource: thread.model ? "app_server" : old.modelSource,
              modelProvider: thread.modelProvider,
              cwd: thread.cwd,
              parentThreadId: thread.parentThreadId,
              updatedAt: Math.max(old.updatedAt || 0, thread.updatedAt * 1000),
              state,
              stateSource: "app_server",
              live: true,
              endpoint: key,
              canControl: true,
              processes: [
                ...new Set([...old.processes, c.pid].filter(Boolean)),
              ],
            });
          }
        } catch (e) {
          c.error = e.message;
          c.retryAt = Date.now() + 15000;
          this.errors.push(`${c.profile}: 控制接口暂不可用`);
        }
      }),
    );
    for (const s of sessions.values()) {
      const created = this.store.data.sessionConfigs?.[s.key];
      if (!s.model && created) {
        s.model = created.model;
        s.reasoningEffort = created.reasoningEffort;
        s.modelSource = "creation_ack";
      }
      if (
        s.live &&
        this.processes.some(
          (p) => p.kind === "terminal" && p.sessions?.includes(s.path),
        )
      ) {
        s.conflict = true;
        s.canControl = false;
      }
      if (!s.live) {
        s.canControl =
          !s.archived &&
          s.processes.length === 0 &&
          [...this.clients.values()].some(
            (c) => c.profile === s.profile && c.rpc.ready,
          );
        if (s.state === "running")
          s.state = s.processes.length
            ? s.stateSource === "active_rollout" &&
              s.lifecycleEvidence === "task_started"
              ? "running"
              : "unconfirmed"
            : "offline";
      }
      s.canQueue = !!(s.live && s.canControl);
      const old = this.sessions.get(s.key);
      if (old?.livePlan) {
        s.livePlan = old.livePlan;
        s.plan = old.livePlan;
      }
      if (old?.stream) s.stream = old.stream;
      if (old?.liveTurnId) s.liveTurnId = old.liveTurnId;
      s.pending = [...this.pending.values()].filter((p) => p.key === s.key);
      s.reviewed =
        this.store.data.reviewed[s.key] >=
        (Date.parse(s.result?.time) || s.updatedAt);
    }
    await this.refreshNativeQueues(sessions);
    for (const s of sessions.values()) {
      if (s.archived) {
        s.canControl = false;
        s.canQueue = false;
      }
      s.trashReason = this.trashBlocker(s, sessions);
      s.canTrash =
        !s.archived && !s.trashReason && !!this.profileClient(s.profile);
      s.canRestore = !!s.archived && !!this.profileClient(s.profile);
      s.descendantCount = this.sessionTree(s, sessions).length - 1;
    }
    const changedKeys = [...sessions.values()]
      .filter((s) => {
        const old = this.sessions.get(s.key);
        return (
          !old ||
          old.state !== s.state ||
          old.model !== s.model ||
          old.reasoningEffort !== s.reasoningEffort ||
          old.archived !== s.archived ||
          old.messages?.at(-1) !== s.messages?.at(-1) ||
          old.activity?.at(-1) !== s.activity?.at(-1) ||
          old.plan !== s.plan ||
          old.result !== s.result ||
          old.canControl !== s.canControl ||
          old.canQueue !== s.canQueue ||
          old.canTrash !== s.canTrash ||
          old.canRestore !== s.canRestore ||
          old.descendantCount !== s.descendantCount ||
          old.trashReason !== s.trashReason
        );
      })
      .map((s) => s.key);
    for (const key of this.sessions.keys())
      if (!sessions.has(key)) changedKeys.push(key);
    this.sessions = sessions;
    this.updatedAt = Date.now();
    const signature = overviewSignature(this.snapshot());
    const summaryChanged = signature !== this.lastSummarySignature;
    this.lastSummarySignature = signature;
    if (summaryChanged) this.emit("change", { snapshot: true });
    for (const key of changedKeys) this.emit("change", { key });
    for (const cmd of this.store.data.commands)
      if (cmd.state === "queued" && cmd.delivery !== "native") {
        const s = sessions.get(cmd.key);
        if (s?.live && ["idle", "completed"].includes(s.state) && s.canControl)
          this.dispatch(cmd).catch(() => {});
      }
  }
  addClient(key, info) {
    const rpc = new CodexRpc({ ...info, experimentalApi: true });
    const c = { ...info, rpc, subscribed: new Set(), retryAt: 0 };
    this.clients.set(key, c);
    rpc.on("disconnect", () => {
      c.subscribed.clear();
      c.nativeQueueSupported = undefined;
      for (const [id, p] of this.pending)
        if (p.endpoint === key) this.pending.delete(id);
      this.emit("change");
    });
    rpc.on("request", (msg) => {
      const id = `${key}:${msg.id}`;
      this.pending.set(id, {
        id,
        requestId: msg.id,
        endpoint: key,
        method: msg.method,
        params: msg.params,
        key: `${c.profile}:${msg.params?.threadId}`,
        createdAt: Date.now(),
      });
      this.emit("change");
    });
    rpc.on("notification", (msg) => {
      const p = msg.params || {};
      const s = this.sessions.get(`${c.profile}:${p.threadId}`);
      const resolved = this.pending.get(`${key}:${p.requestId}`);
      if (msg.method === "serverRequest/resolved")
        this.pending.delete(`${key}:${p.requestId}`);
      if (s && msg.method === "turn/plan/updated") {
        s.livePlan = p.plan;
        s.plan = p.plan;
      }
      if (s && msg.method === "item/agentMessage/delta") {
        if (s.stream?.itemId !== p.itemId)
          s.stream = { itemId: p.itemId, text: "", length: 0 };
        const offset = s.stream.length ?? s.stream.text.length;
        s.stream.text = (s.stream.text + p.delta).slice(-80000);
        s.stream.length = offset + p.delta.length;
        this.emit("change", {
          key: s.key,
          delta: { itemId: p.itemId, text: p.delta, offset },
        });
        return;
      }
      if (s && msg.method === "turn/started") {
        s.state = "running";
        s.liveTurnId = p.turn.id;
        s.livePlan = [];
        s.plan = [];
      }
      if (s && msg.method === "turn/completed") {
        s.stream = null;
        s.state =
          p.turn?.status === "failed"
            ? "error"
            : p.turn?.status === "interrupted"
              ? "interrupted"
              : "completed";
      }
      const visible = [
        "turn/plan/updated",
        "turn/started",
        "turn/completed",
        "item/started",
        "item/completed",
        "thread/status/changed",
        "thread/name/updated",
        "error",
      ];
      if ((s && visible.includes(msg.method)) || resolved)
        this.emit("change", {
          key: s?.key || resolved.key,
          snapshot:
            !!resolved ||
            [
              "turn/started",
              "turn/completed",
              "thread/status/changed",
              "thread/name/updated",
              "error",
            ].includes(msg.method),
        });
    });
    return c;
  }
  snapshot() {
    const queued = new Map(),
      pending = new Map();
    for (const c of this.store.data.commands)
      if (c.state === "queued") queued.set(c.key, (queued.get(c.key) || 0) + 1);
    for (const p of this.pending.values())
      pending.set(p.key, (pending.get(p.key) || 0) + 1);
    return {
      updatedAt: this.updatedAt,
      errors: this.errors,
      profiles: profiles.map((p) => ({
        id: p.id,
        connected: [...this.clients.values()].filter(
          (c) => c.profile === p.id && c.rpc.ready,
        ).length,
      })),
      processes: this.processes.map(
        ({ home, exe, sockets, sessions, ...p }) => ({
          ...p,
          sessionCount: sessions?.length || 0,
        }),
      ),
      sessions: [...this.sessions.values()]
        .map((s) => ({
          key: s.key,
          id: s.id,
          profile: s.profile,
          title: s.title,
          cwd: s.cwd,
          state: s.state,
          model: s.model,
          reasoningEffort: s.reasoningEffort,
          live: s.live,
          processes: s.processes,
          canControl: s.canControl,
          canQueue: s.canQueue,
          archived: s.archived,
          deletedAt: s.deletedAt,
          updatedAt: s.updatedAt,
          reviewed: s.reviewed,
          latestMessage: s.latestMessage?.slice(0, 220),
          lastPrompt: s.lastPrompt?.slice(0, 220),
          result: s.result
            ? { time: s.result.time, preview: s.result.text.slice(0, 250) }
            : null,
          pendingCount: pending.get(s.key) || 0,
          queuedCount: queued.get(s.key) || 0,
        }))
        .sort(
          (a, b) =>
            Number(b.live) - Number(a.live) || b.updatedAt - a.updatedAt,
        ),
    };
  }
  async detail(key) {
    const s = this.sessions.get(key);
    if (!s) throw new RpcError("会话不存在", "NOT_FOUND");
    let turns = [];
    let historyError = null;
    const c = this.clients.get(s.endpoint);
    if (!s.live && !s.processes?.length) {
      const reader = this.profileClient(s.profile);
      if (reader) {
        try {
          const { thread } = await reader.rpc.request("thread/read", {
            threadId: s.id,
            includeTurns: false,
          });
          if (thread.model) {
            s.model = thread.model;
            s.reasoningEffort = thread.reasoningEffort ?? null;
            s.modelSource = "persisted_metadata";
          }
        } catch {
          /* Keep the bounded local metadata if the reader is unavailable. */
        }
      }
    }
    if (!s.archived && c?.rpc.ready && !s.conflict) {
      try {
        if (!c.subscribed.has(s.id) && s.path) {
          await c.rpc.request("thread/resume", {
            threadId: s.id,
            excludeTurns: true,
          });
          c.subscribed.add(s.id);
        }
        const page = await c.rpc.request("thread/turns/list", {
          threadId: s.id,
          limit: 2,
          sortDirection: "desc",
          itemsView: "summary",
        });
        turns = page.data.map((t) => ({
          id: t.id,
          status: t.status,
          startedAt: t.startedAt,
          completedAt: t.completedAt,
          items: t.items
            .filter((it) =>
              ["userMessage", "agentMessage", "plan"].includes(it.type),
            )
            .map((it) => ({
              id: it.id,
              type: it.type,
              phase: it.phase,
              text: (
                it.text ||
                it.content
                  ?.filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join("\n") ||
                ""
              ).slice(0, 80000),
            })),
        }));
      } catch (e) {
        historyError = "官方历史接口暂不可用，显示本地日志摘要";
      }
    }
    const messages = mergeTurnMessages(s.messages || [], turns);
    let result = s.result;
    for (const turn of turns.slice().reverse())
      for (const it of turn.items) {
        if (
          it.type === "agentMessage" &&
          ["final_answer", "final"].includes(it.phase)
        )
          result = {
            text: it.text,
            time: turn.completedAt
              ? new Date(turn.completedAt * 1000).toISOString()
              : null,
          };
      }
    return {
      ...s,
      result,
      messages: messages.slice(-50),
      path: undefined,
      endpoint: undefined,
      clientReceipts: undefined,
      turns,
      historyError,
      pending: [...this.pending.values()]
        .filter((p) => p.key === key)
        .map(({ endpoint, ...p }) => p),
      commands: this.store.data.commands
        .filter((c) => c.key === key)
        .slice(-30),
    };
  }
  async clientFor(s) {
    if (s.archived) throw new RpcError("请先从回收站恢复此会话", "CONFLICT");
    if (s.conflict)
      throw new RpcError("多个运行实例持有该会话，请先在终端确认", "CONFLICT");
    let c = this.clients.get(s.endpoint);
    if (!s.live) {
      const now = await discover();
      if (now.processes.some((p) => p.sessions?.includes(s.path)))
        throw new RpcError(
          "该会话仍由独立终端运行，请先退出原终端再续接",
          "CONFLICT",
        );
      c = [...this.clients.values()].find(
        (c) => c.profile === s.profile && c.rpc.ready,
      );
      if (!c)
        throw new RpcError(
          "该入口没有可用的 app-server，请先启动对应 Codex 入口",
          "UNAVAILABLE",
        );
    }
    if (!c?.rpc.ready) throw new RpcError("控制连接不可用", "UNAVAILABLE");
    // A freshly started loaded thread may have no rollout until its first
    // input. Resuming it before that input fails with "no rollout found".
    if (!s.live || (!c.subscribed.has(s.id) && s.path)) {
      await c.rpc.request("thread/resume", {
        threadId: s.id,
        excludeTurns: true,
        ...(!s.live && s.model ? { model: s.model } : {}),
        ...(!s.live && s.reasoningEffort
          ? { config: { model_reasoning_effort: s.reasoningEffort } }
          : {}),
      });
      c.subscribed.add(s.id);
    }
    return c;
  }
  async command(key, text, mode, id) {
    if (
      !["next", "queue", "steer"].includes(mode) ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 32000 ||
      !/^[\w-]{8,100}$/.test(id || "")
    )
      throw new RpcError("指令参数无效", "INVALID");
    let found = this.store.data.commands.find((c) => c.id === id);
    if (!found && this.store.retiredCommand) {
      found = await this.store.retiredCommand(id);
      // Another submission can arrive while the receipt is being read.
      found ||= this.store.data.commands.find((c) => c.id === id);
    }
    if (found) {
      if (
        found.fingerprint
          ? found.fingerprint !== commandFingerprint({ key, text, mode })
          : found.key !== key || found.text !== text || found.mode !== mode
      )
        throw new RpcError("请求编号已用于其他指令", "CONFLICT");
      return found;
    }
    const s = this.sessions.get(key);
    if (!s) throw new RpcError("会话不存在", "NOT_FOUND");
    if (s.archived) throw new RpcError("请先从回收站恢复此会话", "CONFLICT");
    if (!s.canControl && !(mode === "queue" && s.canQueue))
      throw new RpcError("当前会话只能监控，无法可靠下发指令", "CONFLICT");
    if (mode === "queue" && !s.live && !s.canQueue)
      throw new RpcError("历史会话请直接发送下一轮指令", "CONFLICT");
    if (
      (mode !== "queue" || !s.canControl) &&
      (this.locks.has(key) || this.preparing.has(key))
    )
      throw new RpcError("该会话有指令正在发送，请稍后再试", "CONFLICT");
    if (mode === "next" && ["running", "approval", "input"].includes(s.state))
      throw new RpcError("会话正在执行，请选择排队或补充当前轮", "CONFLICT");
    if (mode === "steer" && !s.live)
      throw new RpcError("仅执行中的共享会话支持补充指令", "CONFLICT");
    const cmd = {
      id,
      key,
      text,
      mode,
      ...(!s.canControl && s.canQueue && mode === "queue"
        ? { delivery: "native" }
        : {}),
      state: mode === "queue" ? "queued" : "pending",
      createdAt: Date.now(),
    };
    const serialized = mode !== "queue" || !s.canControl;
    if (serialized) this.preparing.add(key);
    try {
      this.store.data.commands.push(cmd);
      await this.store.save();
      if (mode === "queue" && !s.canControl && s.canQueue)
        await this.enqueueNative(s, cmd);
      else if (mode !== "queue") await this.dispatch(cmd);
      else {
        this.emit("change");
        if (s.live && ["idle", "completed"].includes(s.state))
          await this.dispatch(cmd);
      }
      return cmd;
    } finally {
      if (serialized) this.preparing.delete(key);
    }
  }
  async dispatch(cmd) {
    if (cmd.delivery === "native") return;
    if (!["pending", "queued"].includes(cmd.state)) return;
    if (cmd.state === "queued" && this.preparing.has(cmd.key)) return;
    if (this.locks.has(cmd.key)) return;
    this.locks.add(cmd.key);
    try {
      const s = this.sessions.get(cmd.key);
      const c = await this.clientFor(s);
      const { thread } = await c.rpc.request("thread/read", {
        threadId: s.id,
        includeTurns: false,
      });
      if (cmd.mode !== "steer" && thread.status.type !== "idle") {
        if (cmd.mode === "queue") return;
        throw new RpcError("会话状态已变化，请重新确认", "CONFLICT");
      }
      let method = "turn/start";
      const params = {
        threadId: s.id,
        clientUserMessageId: cmd.id,
        input: [{ type: "text", text: cmd.text, text_elements: [] }],
      };
      if (cmd.mode === "steer") {
        const { data } = await c.rpc.request("thread/turns/list", {
          threadId: s.id,
          limit: 1,
          itemsView: "notLoaded",
          sortDirection: "desc",
        });
        const active = data.find((t) => t.status === "inProgress");
        if (!active)
          throw new RpcError("当前轮已结束，请发送下一轮指令", "CONFLICT");
        method = "turn/steer";
        params.expectedTurnId = active.id;
      }
      cmd.state = "sending";
      await this.store.save();
      const response = await c.rpc.request(method, params, {
        write: true,
        timeout: 30000,
      });
      cmd.state = "sent";
      cmd.sentAt = Date.now();
      cmd.turnId = response.turn?.id || response.turnId;
      s.state = "running";
    } catch (e) {
      cmd.state = e.uncertain ? "uncertain" : "failed";
      cmd.error = e.message;
    } finally {
      this.locks.delete(cmd.key);
      await this.store.save();
      this.emit("change");
    }
  }
  async cancel(id) {
    const c = this.store.data.commands.find((c) => c.id === id);
    if (!c || c.state !== "queued" || this.locks.has(c.key))
      throw new RpcError("只能撤回尚未发送的排队指令", "CONFLICT");
    if (c.delivery === "native") {
      const s = this.sessions.get(c.key);
      const client = this.nativeClient(s);
      if (!client || !c.nativeQueueId)
        throw new RpcError("原生队列连接不可用，请先核对原终端", "UNAVAILABLE");
      const result = await client.rpc.request(
        "thread/queue/delete",
        { threadId: s.id, queuedSubmissionId: c.nativeQueueId },
        { write: true },
      );
      c.state = result.deleted ? "cancelled" : "uncertain";
      if (!result.deleted)
        c.error = "指令已离开原生队列，请核对终端中的接收记录；不会自动重发";
    } else c.state = "cancelled";
    await this.store.save();
    this.emit("change");
  }

  nativeClient(s) {
    return [...this.clients.values()].find(
      (c) =>
        c.profile === s?.profile &&
        c.rpc.ready &&
        c.nativeQueueSupported !== false,
    );
  }
  profileClient(profile) {
    return [...this.clients.values()].find(
      (c) => c.profile === profile && c.rpc.ready,
    );
  }
  sessionTree(root, sessions = this.sessions) {
    const tree = [root],
      seen = new Set([root.key]);
    for (let i = 0; i < tree.length; i++)
      for (const s of sessions.values())
        if (
          s.profile === root.profile &&
          s.parentThreadId === tree[i].id &&
          !seen.has(s.key)
        ) {
          seen.add(s.key);
          tree.push(s);
        }
    return tree;
  }
  trashBlocker(root, sessions = this.sessions) {
    if (root.archived) return "会话已在回收站";
    for (const s of this.sessionTree(root, sessions)) {
      if (s.archived) continue;
      if (s.conflict || (!s.live && s.processes?.length))
        return "会话或子会话仍由独立终端持有，请退出该终端后删除";
      if (["running", "approval", "input", "unconfirmed"].includes(s.state))
        return "会话或子会话仍在执行，请结束当前任务后删除";
      if (
        this.locks.has(s.key) ||
        this.preparing.has(s.key) ||
        this.store.data.commands.some(
          (c) =>
            c.key === s.key &&
            ["pending", "queued", "sending", "uncertain"].includes(c.state),
        )
      )
        return "会话或子会话有未处理的指令，请先撤回或核对指令记录";
    }
    return null;
  }
  async trash(key) {
    await this.refresh();
    const s = this.sessions.get(key);
    if (!s) throw new RpcError("会话不存在", "NOT_FOUND");
    const reason = this.trashBlocker(s);
    if (reason) throw new RpcError(reason, "CONFLICT");
    const client =
      this.clients.get(s.endpoint) || this.profileClient(s.profile);
    if (!client?.rpc.ready)
      throw new RpcError("该入口的控制连接不可用", "UNAVAILABLE");
    const tree = this.sessionTree(s).filter((s) => !s.archived);
    for (const member of tree) this.locks.add(member.key);
    try {
      // Recheck ownership just before the official archive, which can also
      // archive descendants. Never resume or terminate a terminal for deletion.
      const now = await discover();
      if (
        now.processes.some(
          (p) =>
            tree.some((t) => t.path && p.sessions?.includes(t.path)) &&
            p.kind === "terminal",
        )
      )
        throw new RpcError("会话仍由终端持有，请退出该终端后删除", "CONFLICT");
      for (const member of tree) {
        const { thread } = await client.rpc.request("thread/read", {
          threadId: member.id,
          includeTurns: false,
        });
        if (thread.status.type === "active")
          throw new RpcError("会话或子会话正在执行，请结束后删除", "CONFLICT");
        if (client.nativeQueueSupported !== false) {
          try {
            const page = await client.rpc.request("thread/queue/list", {
              threadId: member.id,
              limit: 1,
            });
            if (page.data.length)
              throw new RpcError(
                "Codex 原生队列中还有指令，请先在终端或网页处理",
                "CONFLICT",
              );
          } catch (e) {
            if ([-32600, -32601].includes(e.code))
              client.nativeQueueSupported = false;
            else throw e;
          }
        }
      }
      await client.rpc.request(
        "thread/archive",
        { threadId: s.id },
        { write: true },
      );
      this.store.data.trash ||= {};
      for (const member of tree)
        this.store.data.trash[member.key] = { deletedAt: Date.now() };
      await this.store.save();
    } finally {
      for (const member of tree) this.locks.delete(member.key);
      this.index.invalidate();
      await this.refresh();
    }
    return { ok: true, key };
  }
  async restore(key) {
    await this.refresh();
    const s = this.sessions.get(key);
    if (!s?.archived)
      throw new RpcError("请在回收站选择要恢复的会话", "CONFLICT");
    if (this.locks.has(key)) throw new RpcError("此会话正在处理中", "CONFLICT");
    const client = this.profileClient(s.profile);
    if (!client) throw new RpcError("该入口的控制连接不可用", "UNAVAILABLE");
    this.locks.add(key);
    try {
      await client.rpc.request(
        "thread/unarchive",
        { threadId: s.id },
        { write: true },
      );
      delete this.store.data.trash?.[key];
      await this.store.save();
    } finally {
      this.locks.delete(key);
      this.index.invalidate();
      await this.refresh();
    }
    return { ok: true, key };
  }
  async refreshNativeQueues(sessions) {
    let dirty = false;
    for (const s of sessions.values()) {
      const commands = this.store.data.commands.filter(
        (c) =>
          c.key === s.key &&
          c.delivery === "native" &&
          ["queued", "uncertain"].includes(c.state),
      );
      const legacyOwner = !s.live && s.processes.length > 0;
      if (!legacyOwner && !commands.length) continue;
      const client = this.nativeClient(s);
      if (!client) continue;
      try {
        const items = [];
        let cursor;
        do {
          const page = await client.rpc.request("thread/queue/list", {
            threadId: s.id,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          items.push(...page.data);
          cursor = page.nextCursor;
        } while (cursor);
        client.nativeQueueSupported = true;
        if (legacyOwner && !s.conflict) {
          s.canQueue = true;
          s.controlMode = "native_queue";
        }
        for (const cmd of commands) {
          const receipt = s.clientReceipts?.[cmd.id];
          const queued = items.find((i) => i.clientUserMessageId === cmd.id);
          if (receipt) {
            cmd.state = "sent";
            cmd.turnId = receipt.turnId;
            cmd.sentAt = Date.parse(receipt.time) || Date.now();
            delete cmd.error;
            dirty = true;
          } else if (queued) {
            if (
              cmd.state !== "queued" ||
              cmd.nativeQueueId !== queued.id ||
              cmd.missingSince
            ) {
              cmd.state = "queued";
              cmd.nativeQueueId = queued.id;
              delete cmd.missingSince;
              delete cmd.error;
              dirty = true;
            }
          } else if (cmd.state === "queued") {
            if (!cmd.missingSince) {
              cmd.missingSince = Date.now();
              dirty = true;
            } else if (Date.now() - cmd.missingSince > 15000) {
              cmd.state = "uncertain";
              cmd.error =
                "指令已离开原生队列但尚未读到接收记录，请核对终端；不会自动重发";
              dirty = true;
            }
          }
        }
      } catch (error) {
        if ([-32600, -32601].includes(error.code))
          client.nativeQueueSupported = false;
      }
    }
    if (dirty) await this.store.save();
  }
  async enqueueNative(s, cmd) {
    if (this.locks.has(s.key)) {
      cmd.state = "failed";
      cmd.error = "该会话有指令正在发送，请稍后再试";
      await this.store.save();
      return;
    }
    this.locks.add(s.key);
    try {
      const client = this.nativeClient(s);
      if (!client) throw new RpcError("原生队列连接不可用", "UNAVAILABLE");
      cmd.delivery = "native";
      cmd.state = "sending";
      await this.store.save();
      const result = await client.rpc.request(
        "thread/queue/add",
        {
          threadId: s.id,
          clientUserMessageId: cmd.id,
          input: [{ type: "text", text: cmd.text, text_elements: [] }],
        },
        { write: true },
      );
      cmd.nativeQueueId = result.queuedSubmission.id;
      cmd.state = "queued";
      cmd.queuedAt = Date.now();
    } catch (error) {
      cmd.state = error.uncertain ? "uncertain" : "failed";
      cmd.error = error.message;
    } finally {
      this.locks.delete(s.key);
      await this.store.save();
      this.emit("change");
    }
  }
  async interrupt(key) {
    const s = this.sessions.get(key);
    if (!s?.live || !s.canControl)
      throw new RpcError("该会话没有可用的控制连接", "CONFLICT");
    const c = await this.clientFor(s);
    const { data } = await c.rpc.request("thread/turns/list", {
      threadId: s.id,
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    const active = data.find((t) => t.status === "inProgress");
    if (!active) throw new RpcError("没有执行中的轮次", "CONFLICT");
    for (const cmd of this.store.data.commands)
      if (cmd.key === key && cmd.state === "queued") {
        if (cmd.delivery === "native") await this.cancel(cmd.id);
        else cmd.state = "cancelled";
      }
    await this.store.save();
    await c.rpc.request(
      "turn/interrupt",
      { threadId: s.id, turnId: active.id },
      { write: true },
    );
    return { ok: true };
  }
  async reply(id, body) {
    const p = this.pending.get(id);
    if (!p) throw new RpcError("此请求已结束，请刷新会话", "CONFLICT");
    let result;
    if (
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(p.method)
    ) {
      if (!["accept", "decline", "cancel"].includes(body.decision))
        throw new RpcError("审批选项无效", "INVALID");
      result = { decision: body.decision };
    } else if (p.method === "item/tool/requestUserInput") {
      if (!body.answers || typeof body.answers !== "object")
        throw new RpcError("回答无效", "INVALID");
      result = { answers: body.answers };
    } else throw new RpcError("该类请求请在原 Codex 客户端处理", "UNSUPPORTED");
    const c = this.clients.get(p.endpoint);
    if (!c?.rpc.ready)
      throw new RpcError("连接已断开，请在原客户端核对请求", "UNAVAILABLE");
    c.rpc.respond(p.requestId, result);
    p.submitted = true;
    this.emit("change");
    return { submitted: true };
  }
  async models(profile, cwd) {
    if (!profiles.some((p) => p.id === profile))
      throw new RpcError("请选择有效的 Codex 入口", "INVALID");
    if (
      cwd &&
      (!isAbsolute(cwd) || !(await stat(cwd).catch(() => null))?.isDirectory())
    )
      throw new RpcError("工作目录必须是已存在的绝对路径", "INVALID");
    const c = this.profileClient(profile);
    if (!c)
      throw new RpcError(
        "该入口没有可用的控制连接，请先在本机启动",
        "UNAVAILABLE",
      );
    const { config } = await c.rpc.request("config/read", {
      includeLayers: false,
      ...(cwd ? { cwd } : {}),
    });
    const models = [];
    let cursor;
    do {
      const page = await c.rpc.request("model/list", {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      models.push(
        ...page.data.map((m) => ({
          model: m.model,
          displayName: m.displayName,
          isDefault: m.isDefault,
          defaultReasoningEffort: m.defaultReasoningEffort,
          supportedReasoningEfforts: m.supportedReasoningEfforts.map((e) => ({
            reasoningEffort: e.reasoningEffort,
            description: e.description,
          })),
        })),
      );
      cursor = page.nextCursor;
    } while (cursor);
    return {
      profile,
      models,
      defaults: {
        model: config.model || null,
        effort: config.model_reasoning_effort || null,
      },
    };
  }
  async create(profile, cwd, selection = {}) {
    const p = profiles.find((p) => p.id === profile);
    if (!p || !isAbsolute(cwd || "") || !(await stat(cwd)).isDirectory())
      throw new RpcError("请选择入口并提供存在的绝对目录", "INVALID");
    const c = this.profileClient(profile);
    if (!c)
      throw new RpcError(
        "请先在本机启动对应 Codex 入口，使其 app-server 可用",
        "UNAVAILABLE",
      );
    const catalog = await this.models(profile, cwd);
    const modelParams = modelStartParams(selection, catalog);
    const r = await c.rpc.request(
      "thread/start",
      { cwd: await realpath(cwd), ...modelParams },
      { write: true },
    );
    c.subscribed.add(r.thread.id);
    this.store.data.sessionConfigs ||= {};
    this.store.data.sessionConfigs[`${profile}:${r.thread.id}`] = {
      model: r.model,
      reasoningEffort: r.reasoningEffort ?? null,
    };
    await this.store.save();
    this.index.invalidate();
    await this.refresh();
    return { key: `${profile}:${r.thread.id}` };
  }
  async reviewed(key) {
    const s = this.sessions.get(key);
    if (!s) throw new RpcError("会话不存在", "NOT_FOUND");
    this.store.data.reviewed[key] = Math.max(Date.now(), s.updatedAt);
    await this.store.save();
    this.emit("change");
  }
  close() {
    for (const c of this.clients.values()) c.rpc.close();
  }
}
