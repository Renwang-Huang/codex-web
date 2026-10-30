import { readdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const clip = (s, n = 16000) => (typeof s === "string" ? s.slice(0, n) : "");
const messageText = (content) =>
  typeof content === "string"
    ? content
    : (content || []).map((c) => c.text || "").join("\n");
const skipUser = (text) =>
  /^(# AGENTS\.md|<environment_context>|<permissions instructions>|<turn_aborted>|<collaboration_mode>)/.test(
    text.trim(),
  );

export function parseEvents(lines, base = {}) {
  const s = {
    messages: [],
    activity: [],
    plan: [],
    state: "unknown",
    clientReceipts: {},
    ...base,
  };
  s.messages = [...s.messages];
  s.activity = [...s.activity];
  s.clientReceipts = { ...s.clientReceipts };
  const addMessage = (role, text, time, phase) => {
    if (!text || (role === "user" && skipUser(text))) return;
    if (role === "assistant" && ["final_answer", "final"].includes(phase))
      s.result = { text: clip(text, 80000), time };
    const last = s.messages.at(-1);
    if (
      last?.role === role &&
      last.text === clip(text) &&
      last.turnId === s.turnId
    ) {
      if (phase) last.phase = phase;
      return;
    }
    s.messages.push({ role, text: clip(text), time, phase, turnId: s.turnId });
    if (role === "user") {
      s.title ||= clip(text.replace(/\s+/g, " "), 90);
      s.lastPrompt = clip(text);
    } else {
      s.latestMessage = clip(text, 220);
      if (phase === "final_answer" || phase === "final")
        s.result = { text: clip(text, 80000), time };
    }
  };
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const p = e.payload || {};
    const time = e.timestamp;
    // Fork rollouts may embed their parent's session_meta after their own.
    // The first metadata record establishes this file's identity.
    if (e.type === "session_meta" && !s.id)
      Object.assign(s, {
        id: p.id,
        cwd: p.cwd,
        source: p.source,
        cliVersion: p.cli_version,
        parentThreadId:
          p.parent_thread_id ||
          p.source?.subagent?.thread_spawn?.parent_thread_id ||
          null,
        agentNickname:
          p.agent_nickname ||
          p.source?.subagent?.thread_spawn?.agent_nickname ||
          null,
      });
    if (e.type === "turn_context") {
      s.model = p.model;
      s.reasoningEffort = p.effort ?? p.reasoning_effort ?? null;
      s.modelSource = "turn_context";
      s.turnId = p.turn_id;
    }
    if (e.type === "response_item") {
      if (
        ["function_call", "custom_tool_call"].includes(p.type) ||
        (p.type === "message" &&
          p.role === "user" &&
          !skipUser(messageText(p.content)))
      )
        s.lastWorkAt = time;
      if (p.type === "message" && ["user", "assistant"].includes(p.role))
        addMessage(p.role, messageText(p.content), time, p.phase);
      if (["function_call", "custom_tool_call"].includes(p.type)) {
        s.activity.push({ time, type: "tool", text: p.name || "工具调用" });
        if (/update_plan$/.test(p.name)) {
          try {
            const plan = JSON.parse(p.arguments || p.input);
            if (plan.plan) s.plan = plan.plan;
          } catch {}
        }
      }
    }
    if (e.type !== "event_msg") continue;
    if (p.type === "task_started") {
      s.state = "running";
      s.lifecycleEvidence = "task_started";
      s.turnStartedAt = time;
      s.turnId = p.turn_id;
      s.plan = [];
      s.lastWorkAt = time;
    }
    if (p.type === "task_complete") {
      s.state = "completed";
      s.lifecycleEvidence = "task_complete";
      s.completedAt = time;
      if (p.last_agent_message) {
        s.result = { text: clip(p.last_agent_message, 80000), time };
        addMessage("assistant", p.last_agent_message, time, "final_answer");
      }
    }
    if (p.type === "turn_aborted") {
      s.state = "interrupted";
      s.lifecycleEvidence = "turn_aborted";
    }
    if (p.type === "agent_message")
      addMessage("assistant", p.message, time, p.phase);
    if (p.type === "user_message") addMessage("user", p.message, time);
    if (p.type === "token_count" && p.info) {
      s.tokenUsage = p.info.total_token_usage;
      s.contextUsage = p.info.last_token_usage;
      s.contextWindow = p.info.model_context_window;
    }
    if (p.type === "item_completed") {
      const it = p.item || {};
      if (it.type === "UserMessage" && it.client_id)
        s.clientReceipts[it.client_id] = { turnId: p.turn_id, time };
      if (it.type === "CommandExecution")
        s.activity.push({
          time,
          type: "command",
          text: `命令${it.exit_code === 0 ? "完成" : it.exit_code != null ? `退出 ${it.exit_code}` : "执行"}`,
          detail: clip(it.command, 500),
        });
      if (it.type === "FileChange")
        s.activity.push({
          time,
          type: "file",
          text: "文件变更",
          detail: Object.keys(it.changes || {}).join(", "),
        });
    }
  }
  s.messages = s.messages.slice(-50);
  s.activity = s.activity.slice(-40);
  s.clientReceipts = Object.fromEntries(
    Object.entries(s.clientReceipts).slice(-500),
  );
  if (
    s.state === "completed" &&
    Date.parse(s.lastWorkAt) > Date.parse(s.completedAt)
  )
    s.state = "unknown";
  return s;
}

async function filesUnder(root) {
  const out = [];
  try {
    for (const e of await readdir(root, { withFileTypes: true })) {
      const p = join(root, e.name);
      if (e.isDirectory()) out.push(...(await filesUnder(p)));
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return out;
}
async function chunk(fh, start, length) {
  const b = Buffer.alloc(length);
  const { bytesRead } = await fh.read(b, 0, length, start);
  return b.subarray(0, bytesRead).toString("utf8");
}

// Only active rollout files need complete lifecycle evidence. Read each once,
// then consume appended complete records; a long turn can exceed the tail
// window by many megabytes without losing its task_started marker or plan.
export async function readActiveEvents(path, start, size, base = {}) {
  if (size <= start) return { session: base, offset: start };
  const decoder = new StringDecoder("utf8");
  let pending = "",
    batch = [],
    session = base,
    cursor = start,
    offset = start;
  for await (const buffer of createReadStream(path, {
    start,
    end: size - 1,
    highWaterMark: 64 * 1024,
  })) {
    const lastNewline = buffer.lastIndexOf(10);
    if (lastNewline >= 0) offset = cursor + lastNewline + 1;
    cursor += buffer.length;
    pending += decoder.write(buffer);
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      batch.push(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (batch.length >= 64) {
        session = parseEvents(batch, session);
        batch = [];
      }
    }
  }
  if (batch.length) session = parseEvents(batch, session);
  return { session, offset };
}

export class SessionIndex {
  cache = new Map();
  inventory = new Map();
  inventoryAt = 0;
  constructor({ inventoryInterval = 30000 } = {}) {
    this.inventoryInterval = inventoryInterval;
  }
  invalidate() {
    this.inventoryAt = 0;
  }
  async scan(
    profiles,
    { activePaths = new Set(), reuseInventory = false } = {},
  ) {
    const all = [];
    const full =
      !reuseInventory ||
      !this.inventoryAt ||
      Date.now() - this.inventoryAt >= this.inventoryInterval;
    const seen = new Set();
    for (const profile of profiles) {
      const paths = full
        ? [
            ...(await filesUnder(join(profile.home, "sessions"))).map(
              (path) => ({
                path,
                archived: false,
              }),
            ),
            ...(await filesUnder(join(profile.home, "archived_sessions"))).map(
              (path) => ({ path, archived: true }),
            ),
          ]
        : [...(this.inventory.get(profile.id) || [])];
      // Newly opened logs are indexed immediately between reconciliations.
      for (const path of activePaths)
        if (
          path.startsWith(join(profile.home, "sessions") + "/") &&
          !paths.some((p) => p.path === path)
        )
          paths.push({ path, archived: false });
      this.inventory.set(profile.id, paths);
      for (const { path, archived } of paths) {
        seen.add(path);
        try {
          const old = this.cache.get(path);
          const active = activePaths.has(path);
          if (!full && !active && !old?.activeIndexed && old) {
            all.push(old.session);
            continue;
          }
          const st = await stat(path);
          if (
            old?.size === st.size &&
            old?.mtime === st.mtimeMs &&
            old?.inode === st.ino &&
            (!active || old.activeIndexed)
          ) {
            if (!active) old.activeIndexed = false;
            all.push(old.session);
            continue;
          }
          let session, offset;
          if (active) {
            const incremental =
              old?.activeIndexed &&
              old.inode === st.ino &&
              st.size >= old.offset &&
              (st.size !== old.size || st.mtimeMs === old.mtime);
            const result = await readActiveEvents(
              path,
              incremental ? old.offset : 0,
              st.size,
              incremental ? old.session : {},
            );
            session = result.session;
            offset = result.offset;
          } else {
            const fh = await open(path, "r");
            let head, tail;
            try {
              head = await chunk(fh, 0, Math.min(st.size, 1024 * 1024));
              const start = Math.max(1024 * 1024, st.size - 1024 * 1024);
              tail =
                st.size > start ? await chunk(fh, start, st.size - start) : "";
            } finally {
              await fh.close();
            }
            const lines = head.split("\n");
            lines.pop();
            if (tail) {
              const t = tail.split("\n");
              t.shift();
              t.pop();
              lines.push(...t);
            }
            session = parseEvents(lines);
          }
          session.id ||= path.match(
            /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/,
          )?.[1];
          if (!session.id) continue;
          Object.assign(session, {
            key: `${profile.id}:${session.id}`,
            profile: profile.id,
            path,
            updatedAt: st.mtimeMs,
            historyPartial: !active && st.size > 1024 * 1024,
            stateSource: active ? "active_rollout" : "rollout_summary",
            logBytes: st.size,
            archived,
          });
          this.cache.set(path, {
            size: st.size,
            mtime: st.mtimeMs,
            inode: st.ino,
            activeIndexed: active,
            offset,
            session,
          });
          all.push(session);
        } catch (e) {
          if (e.code === "ENOENT") this.cache.delete(path);
        }
      }
    }
    if (full) {
      this.inventoryAt = Date.now();
      for (const path of this.cache.keys())
        if (!seen.has(path)) this.cache.delete(path);
    }
    return all;
  }
}
