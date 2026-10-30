import { markdown, copyText } from "./render.js";

const $ = (s) => document.querySelector(s);
// LAN HTTP is not a secure context, where crypto.randomUUID is unavailable.
// getRandomValues remains available there and keeps request IDs unpredictable.
const requestId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const labels = {
  running: "执行中",
  approval: "等待审批",
  input: "等待回答",
  completed: "本轮完成",
  idle: "等待指令",
  interrupted: "已中断",
  offline: "已离线",
  unconfirmed: "状态待确认",
  error: "执行异常",
  unknown: "状态未知",
};
const commandLabels = {
  queued: "等待当前轮结束",
  pending: "准备发送",
  sending: "正在发送",
  sent: "已下发",
  failed: "发送失败",
  uncertain: "结果未知，请核对会话",
  cancelled: "已撤回",
};
const effortNames = {
  none: "无",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "极限",
};
const effortText = (e) =>
  e
    ? `${effortNames[e] || e}${effortNames[e] ? `（${e}）` : ""}`
    : "默认 / 未记录";
const drafts = new Map();
const submissions = new Set();
let renderedCopies = [];
let modelCatalog = null,
  modelLoadId = 0;
let snapshot = { sessions: [], processes: [] },
  selected = null,
  detail = null,
  filter = "active",
  view = "sessions",
  source,
  refreshing = false,
  again = null,
  shown = 100,
  toastTimer;
function resizePrompt() {
  const input = $("#prompt");
  if (!input) return;
  input.style.height = "auto";
  input.style.height =
    Math.min(input.scrollHeight, innerHeight * 0.3, 240) + "px";
}
function time(t) {
  return t
    ? new Date(t).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
}
function relative(t) {
  const n = Math.max(0, Math.floor((Date.now() - t) / 1000));
  return n < 60
    ? "刚刚"
    : n < 3600
      ? `${Math.floor(n / 60)} 分钟前`
      : n < 86400
        ? `${Math.floor(n / 3600)} 小时前`
        : `${Math.floor(n / 86400)} 天前`;
}
function badge(s) {
  return `<span class="badge ${esc(s)}"><i></i>${labels[s] || esc(s)}</span>`;
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 5500);
}
async function api(path, data) {
  const uncertain = [
    "command",
    "interrupt",
    "reply",
    "create",
    "cancel",
    "trash",
    "restore",
  ].includes(path);
  const lostMessage =
    "发送状态尚未确认。请先查看会话和指令记录，再决定是否重新发送。";
  let r;
  try {
    r = await fetch(
      `/api/${path}`,
      data === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Codex-Web": "1" },
            body: JSON.stringify(data),
          },
    );
  } catch (error) {
    throw new Error(uncertain ? lostMessage : "连接不可用，请等待本机连接恢复");
  }
  const b = await r.json().catch(() => ({
    error:
      r.status >= 500 ? "本机工作台暂时离线，请等待连接恢复" : "服务器响应无效",
  }));
  if (!r.ok) {
    if (r.status === 401 && path !== "login") showLogin();
    if (uncertain && r.status >= 500) throw new Error(lostMessage);
    throw new Error(b.error || "请求失败");
  }
  return b;
}
function showLogin() {
  source?.close();
  $("#app").hidden = true;
  $("#login").hidden = false;
}
async function start() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  await refresh();
  if (routeKey() && routeKey() !== selected) await select(routeKey(), false);
  source?.close();
  source = new EventSource("/api/events");
  source.addEventListener("change", (event) => {
    let change;
    try {
      change = JSON.parse(event.data);
    } catch {
      return refresh();
    }
    if (!Object.hasOwn(change, "snapshot")) return refresh();
    let streamGap = false;
    for (const stream of change.streams || []) {
      if (detail?.key !== stream.key || selected !== stream.key) continue;
      if (detail.stream?.itemId !== stream.itemId)
        detail.stream = { itemId: stream.itemId, text: "", length: 0 };
      const length = detail.stream.length ?? detail.stream.text.length;
      if (stream.end <= length) continue;
      if (stream.start > length) {
        streamGap = true;
        continue;
      }
      detail.stream.text = (
        detail.stream.text +
        stream.delta.slice(Math.max(0, length - stream.start))
      ).slice(-80000);
      detail.stream.length = stream.end;
      renderContent();
    }
    const needsDetail =
      !!selected &&
      (streamGap || change.allDetails || change.keys?.includes(selected));
    if (change.snapshot || needsDetail)
      refresh({ snapshot: change.snapshot, detail: needsDetail });
  });
  source.onopen = () => {
    $("#connection-dot").className = "";
    $("#connection-text").textContent = "实时连接";
    refresh();
  };
  source.onerror = () => {
    $("#connection-dot").className = "disconnected";
    $("#connection-text").textContent = "连接中断，正在重连";
  };
}
async function refresh(options = {}) {
  const needs = {
    snapshot: options.snapshot !== false,
    detail: options.detail !== false,
  };
  if (refreshing) {
    again = {
      snapshot: !!(again?.snapshot || needs.snapshot),
      detail: !!(again?.detail || needs.detail),
    };
    return;
  }
  refreshing = true;
  try {
    if (needs.snapshot) {
      snapshot = await api("snapshot");
      renderOverview();
      renderList();
      renderProcesses();
    }
    if (selected && needs.detail) {
      const key = selected;
      const next = await api(`detail?key=${encodeURIComponent(key)}`);
      if (selected === key) {
        // A detail response can precede an SSE batch already applied here.
        if (
          detail?.stream?.itemId === next.stream?.itemId &&
          detail?.stream?.length > (next.stream?.length ?? 0)
        )
          next.stream = detail.stream;
        detail = next;
        renderDetail();
      }
    }
  } catch (e) {
    if (!$("#app").hidden) toast(e.message);
  } finally {
    refreshing = false;
    if (again) {
      const next = again;
      again = null;
      setTimeout(() => refresh(next), 300);
    }
  }
}
function renderOverview() {
  const s = snapshot.sessions.filter((s) => !s.archived);
  const counters = [
    [
      "正在执行",
      s.filter((s) => s.state === "running").length,
      "真实会话状态",
      "running",
    ],
    [
      "需要你处理",
      s.filter((s) => ["approval", "input"].includes(s.state)).length,
      "审批或补充回答",
      "attention",
    ],
    [
      "待查看结果",
      s.filter((s) => s.result && !s.reviewed).length,
      "已产生最终回复",
      "results",
    ],
    [
      "相关进程",
      snapshot.processes.length,
      `${snapshot.profiles?.filter((p) => p.connected).length || 0} / 3 个入口可连接`,
      "processes",
    ],
  ];
  $("#stats").innerHTML = counters
    .map(
      ([label, n, hint, cls], i) =>
        `<button class="stat ${cls}" data-stat="${cls}"><div class="stat-label">${label}<span>0${i + 1}</span></div><div class="stat-number">${n}<span>${i === 3 ? "processes" : "sessions"}</span></div><div class="stat-hint">${hint}<span>↗</span></div></button>`,
    )
    .join("");
  $("#stats")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          if (b.dataset.stat === "processes") switchView("processes");
          else {
            switchView("sessions");
            setFilter(b.dataset.stat === "results" ? "results" : "active");
          }
        }),
    );
  $("#profiles").innerHTML = (snapshot.profiles || [])
    .map(
      (p) =>
        `<button class="profile" data-profile="${p.id}"><span class="profile-icon ${p.id}">C${p.id.slice(5) || "0"}</span><span>${p.id}</span><i class="${p.connected ? "online" : ""}"></i></button>`,
    )
    .join("");
  $("#profiles")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          $("#profile-filter").value = b.dataset.profile;
          switchView("sessions");
          renderList();
        }),
    );
  $("#scan-errors").hidden = !snapshot.errors?.length;
  $("#scan-errors").textContent = snapshot.errors?.join(" · ");
  $("#updated").textContent = snapshot.updatedAt
    ? `更新于 ${time(snapshot.updatedAt)}`
    : "正在扫描本机会话…";
}
function setFilter(next) {
  filter = next;
  shown = 100;
  $("#status-filters")
    .querySelectorAll("button")
    .forEach((b) =>
      b.classList.toggle("selected", b.dataset.filter === filter),
    );
  $("#trash-note").hidden = filter !== "trash";
  renderList();
}
function renderList() {
  const q = $("#search").value.trim().toLowerCase(),
    p = $("#profile-filter").value;
  const sessions = snapshot.sessions.filter(
    (s) =>
      (p === "all" || s.profile === p) &&
      (filter === "trash" ? s.archived : !s.archived) &&
      (filter === "trash" ||
        filter === "all" ||
        (filter === "results"
          ? s.result && !s.reviewed
          : s.live || s.processes?.length)) &&
      `${s.title} ${s.cwd} ${s.model} ${s.id}`.toLowerCase().includes(q),
  );
  $("#session-count").textContent = sessions.length;
  $("#session-list").innerHTML =
    sessions
      .slice(0, shown)
      .map(
        (s) =>
          `<button class="session-card ${selected === s.key ? "selected" : ""}" data-key="${esc(s.key)}"><div class="card-top"><span class="entry-tag ${s.profile}">${s.profile}</span><span class="card-time">${relative(s.deletedAt || s.updatedAt || Date.now())}</span></div><h3>${esc(s.title || `未命名会话 ${s.id.slice(0, 8)}`)}</h3><div class="card-directory" title="${esc(s.cwd)}">⌁ ${esc(s.cwd || "目录未知")}</div><div class="card-model">${esc(s.model || "模型未记录")} · 推理 ${esc(effortText(s.reasoningEffort))}</div><p class="card-preview">${esc(s.state === "completed" ? s.result?.preview || s.latestMessage || "本轮已结束" : s.latestMessage || s.lastPrompt || "等待下一轮指令")}</p><div class="card-bottom">${s.archived ? '<span class="badge archived">已在回收站</span>' : badge(s.state)}<span>${s.archived ? "可恢复会话 ↗" : s.queuedCount ? `${s.queuedCount} 条排队` : s.canControl ? "可下发指令 ↗" : s.canQueue ? "可排队指令 ↗" : "监控模式"}</span></div></button>`,
      )
      .join("") ||
    `<div class="empty-list"><span>◎</span><h3>${filter === "trash" ? "回收站暂无匹配的会话" : filter === "results" ? "暂时没有待查看的结果" : filter === "active" ? "当前没有匹配的运行会话" : "没有匹配的历史会话"}</h3><p>${filter === "active" ? "可以切换历史记录，或启动一个 Codex 会话。" : "试试其他关键词或运行入口。"}</p></div>`;
  $("#session-list")
    .querySelectorAll("[data-key]")
    .forEach((b) => (b.onclick = () => select(b.dataset.key)));
  if (sessions.length > shown) {
    const b = document.createElement("button");
    b.className = "load-more";
    b.textContent = `加载更多 · 还有 ${sessions.length - shown} 个`;
    b.onclick = () => {
      shown += 100;
      renderList();
    };
    $("#session-list").append(b);
  }
}
async function select(key, navigate = true) {
  if (navigate && key !== routeKey()) {
    history.pushState(
      { session: key },
      "",
      `#session=${encodeURIComponent(key)}`,
    );
  }
  switchView("sessions");
  selected = key;
  detail = null;
  $("#app").classList.add("mobile-detail");
  renderList();
  $("#detail").innerHTML =
    '<div class="empty-detail"><p>正在读取会话…</p></div>';
  await refresh({ snapshot: false });
}
function routeKey() {
  try {
    return new URLSearchParams(location.hash.slice(1)).get("session");
  } catch {
    return null;
  }
}
function showSessionList() {
  selected = null;
  detail = null;
  $("#app").classList.remove("mobile-detail");
  $("#detail").removeAttribute("data-key");
  $("#detail").innerHTML =
    '<div class="empty-detail"><h2>选择一个会话</h2><p>进展、结果与下一轮指令，都在这里。</p></div>';
  renderList();
}
addEventListener("popstate", () =>
  routeKey() ? select(routeKey(), false) : showSessionList(),
);
addEventListener("hashchange", () => {
  if (routeKey() !== selected)
    routeKey() ? select(routeKey(), false) : showSessionList();
});
function switchView(next) {
  view = next;
  $("#session-view").hidden = view !== "sessions";
  $("#process-view").hidden = view !== "processes";
  $("#view-name").textContent = view === "sessions" ? "会话工作台" : "进程观察";
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (next === "processes") $("#app").classList.remove("mobile-detail");
}
function renderProcesses() {
  const related = new Map(snapshot.processes.map((p) => [p.pid, p]));
  function depth(p) {
    let n = 0,
      seen = new Set();
    while (related.has(p.ppid) && !seen.has(p.ppid) && n < 8) {
      seen.add(p.ppid);
      p = related.get(p.ppid);
      n++;
    }
    return n;
  }
  $("#process-list").innerHTML =
    `<div class="process-table"><table><thead><tr><th>进程 / 角色</th><th>入口</th><th>PID / PPID</th><th>内存</th><th>工作目录</th></tr></thead><tbody>${snapshot.processes.map((p) => `<tr><td><span class="tree-indent">${"　".repeat(depth(p))}${depth(p) ? "└ " : ""}</span><b>${esc(p.comm)}</b><span class="process-kind">${esc(p.kind)}</span></td><td><span class="entry-tag ${p.profile}">${p.profile}</span></td><td class="mono">${p.pid} <span class="muted">/ ${p.ppid}</span></td><td class="mono">${(p.rssKb / 1024).toFixed(1)} MB</td><td class="mono">${esc(p.cwd || "—")}</td></tr>`).join("")}</tbody></table></div>`;
}
function message(role, text, phase, timestamp) {
  const index = renderedCopies.push(text) - 1;
  return `<article class="message ${role}"><div class="message-label">${role === "user" ? "你" : phase === "final_answer" || phase === "final" ? "CODEX · 最终回复" : "CODEX · 进展"}<time>${timestamp ? time(timestamp) : ""}</time>${role === "assistant" ? `<button type="button" class="copy-message quiet" data-copy="${index}">复制</button>` : ""}</div><div class="message-text ${role === "assistant" ? "markdown" : ""}">${role === "assistant" ? markdown(text) : esc(text)}</div></article>`;
}
function renderDetail() {
  const s = detail;
  if (!s || s.key !== selected) return;
  const fresh = $("#detail").dataset.key !== s.key || !$("#composer");
  if (fresh) {
    $("#detail").dataset.key = s.key;
    $("#detail").innerHTML =
      `<div class="detail-header"><button id="back" class="mobile-back">← 全部会话</button><div id="detail-meta"></div></div><div class="detail-tabs"><button data-tab="progress" class="active">进展</button><button data-tab="result">最终回复</button><button data-tab="activity">活动与指令</button><button id="review" class="review-button">✓ 标为已读</button></div><div id="detail-content" class="detail-content"></div><div id="pending-requests"></div><form id="composer" class="composer"><div id="control-note" class="control-note"></div><textarea id="prompt" rows="3" maxlength="32000" aria-label="下一轮指令" placeholder="接下来，让 Codex 做什么？"></textarea><div class="composer-actions"><select id="send-mode" aria-label="发送方式"><option value="next">下一轮指令</option><option value="queue">完成当前轮后发送</option><option value="steer">补充到当前轮</option></select><button type="button" id="interrupt" class="quiet danger">中断</button><button class="primary" id="send">发送 <span>↗</span></button></div></form>`;
    $("#prompt").value = drafts.get(s.key) || "";
    $("#prompt").oninput = () => {
      drafts.set(s.key, $("#prompt").value);
      resizePrompt();
    };
    requestAnimationFrame(resizePrompt);
    $("#prompt").onkeydown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (
          !e.repeat &&
          !e.isComposing &&
          !$("#send").disabled &&
          !submissions.has(s.key)
        )
          $("#composer").requestSubmit();
      }
    };
    $("#send-mode").value =
      (!s.canControl && s.canQueue) ||
      ["running", "approval", "input"].includes(s.state)
        ? "queue"
        : "next";
    $("#back").onclick = () => {
      if (history.state?.session) history.back();
      else {
        history.replaceState(null, "", location.pathname + location.search);
        showSessionList();
      }
    };
    $("#detail")
      .querySelectorAll("[data-tab]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            $("#detail")
              .querySelectorAll("[data-tab]")
              .forEach((x) => x.classList.toggle("active", x === b));
            renderContent();
          }),
      );
    $("#review").onclick = async () => {
      try {
        await api("reviewed", { key: selected });
        toast("已标记为已读");
        await refresh();
      } catch (e) {
        toast(e.message);
      }
    };
    $("#interrupt").onclick = async () => {
      if (!confirm("中断当前轮？尚未发送的排队指令也会撤回。")) return;
      try {
        await api("interrupt", { key: selected });
        toast("已请求中断");
        await refresh();
      } catch (e) {
        toast(e.message);
      }
    };
    $("#composer").onsubmit = async (e) => {
      e.preventDefault();
      if (submissions.has(selected) || $("#send").disabled) return;
      const text = $("#prompt").value.trim();
      if (!text) return;
      const key = selected,
        button = $("#send");
      submissions.add(key);
      button.disabled = true;
      try {
        const cmd = await api("command", {
          key,
          text,
          mode: $("#send-mode").value,
          id: requestId(),
        });
        if (["sent", "queued"].includes(cmd.state)) {
          if (drafts.get(key)?.trim() === text) drafts.delete(key);
          if (selected === key && $("#prompt").value.trim() === text) {
            $("#prompt").value = "";
            resizePrompt();
          }
        }
        toast(
          cmd.error ||
            (cmd.delivery === "native" && cmd.state === "queued"
              ? "已加入 Codex 原生队列，终端空闲时自动接收"
              : commandLabels[cmd.state]),
        );
        await refresh();
      } catch (e) {
        toast(e.message);
      } finally {
        submissions.delete(key);
        if (selected === key && $("#send"))
          $("#send").disabled = !(detail?.canControl || detail?.canQueue);
      }
    };
  }
  $("#detail-meta").innerHTML =
    `<div class="detail-topline"><span class="entry-tag ${s.profile}">${s.profile}</span>${s.archived ? '<span class="badge archived">已在回收站</span>' : badge(s.state)}</div><h2>${esc(s.title || "未命名会话")}</h2><div class="detail-path">${esc(s.cwd || "目录未知")}</div><div class="detail-facts"><span id="session-model">模型：${esc(s.model || "未记录")}</span><span id="session-effort">推理强度：${esc(effortText(s.reasoningEffort))}</span></div><div class="detail-facts"><span>${s.modelSource === "app_server" ? "当前配置 · 控制接口" : s.modelSource === "creation_ack" ? "新建配置 · Codex 已确认" : s.modelSource === "persisted_metadata" ? "最近配置 · Codex 记录" : s.modelSource === "turn_context" ? "最近一轮配置 · 会话日志" : "配置来源未记录"}</span><span>${s.archived ? "本机回收站" : s.live ? "共享会话已连接" : s.processes?.length ? (s.canQueue ? "终端原生队列已连接" : "独立终端会话") : "历史会话"}</span><span>${esc(s.id.slice(0, 8))}</span></div><div class="session-actions">${s.archived ? `<button id="restore-session" class="quiet" ${s.canRestore ? "" : "disabled"}>恢复会话</button>` : `<button id="trash-session" class="quiet danger" ${s.canTrash ? "" : "disabled"}>删除会话</button>`}<span class="hint">${s.archived ? "保留会话记录，恢复后可继续使用" : s.trashReason ? esc(s.trashReason) : "删除后可从回收站恢复"}</span></div>`;
  if (s.tokenUsage) {
    const usage = document.createElement("div");
    usage.className = "detail-facts token-usage";
    const format = (n) =>
      Number.isFinite(n) ? n.toLocaleString("zh-CN") : "未记录";
    usage.textContent = `累计 Token · 输入 ${format(s.tokenUsage.input_tokens)} / 输出 ${format(s.tokenUsage.output_tokens)}`;
    if (s.contextWindow && s.contextUsage?.total_tokens != null)
      usage.textContent += ` · 最近请求 ${format(s.contextUsage.total_tokens)} / 窗口上限 ${format(s.contextWindow)}`;
    usage.title =
      "来自会话日志，累计用量不代表当前上下文占用；最新请求数值可能滞后。";
    $("#detail-meta").append(usage);
  }
  $("#composer").hidden = !!s.archived;
  const trashButton = $("#trash-session"),
    restoreButton = $("#restore-session");
  if (trashButton)
    trashButton.onclick = async () => {
      if (
        !confirm(
          `将此会话移入回收站？${s.descendantCount ? `同时归档其 ${s.descendantCount} 个子会话。` : ""}可在回收站恢复。`,
        )
      )
        return;
      trashButton.disabled = true;
      try {
        await api("trash", { key: s.key });
        setFilter("trash");
        await select(s.key);
        toast("会话已移入回收站");
      } catch (e) {
        toast(e.message);
        await refresh();
      }
    };
  if (restoreButton)
    restoreButton.onclick = async () => {
      restoreButton.disabled = true;
      try {
        await api("restore", { key: s.key });
        setFilter("all");
        await select(s.key);
        toast("会话已恢复，可继续下发指令");
      } catch (e) {
        toast(e.message);
        await refresh();
      }
    };
  $("#control-note").textContent = s.conflict
    ? "多个实例持有此会话，请先在终端确认。"
    : !s.canControl && s.canQueue
      ? "指令将加入 Codex 原生队列；终端空闲时会自动接收，现有任务继续运行。"
      : s.canControl
        ? s.live
          ? "指令发送到当前 Codex 会话，沿用现有配置。"
          : "发送时将在此入口续接历史会话。"
        : s.processes?.length
          ? "此独立终端未提供共享控制接口。可查看进展；退出原终端后可从网页续接。"
          : "该入口当前没有可用的控制接口。请先在本机启动对应 Codex。";
  const canSend = s.canControl || s.canQueue;
  $("#prompt").disabled = !canSend;
  $("#send").disabled = !canSend || submissions.has(s.key);
  $("#send-mode").disabled = !canSend;
  $("#send-mode").querySelector("[value=next]").disabled = !s.canControl;
  $("#send-mode").querySelector("[value=queue]").disabled =
    !s.live && !s.canQueue;
  if (!s.canControl && s.canQueue) $("#send-mode").value = "queue";
  $("#send-mode").querySelector("[value=steer]").disabled =
    !s.live || !["running", "approval", "input"].includes(s.state);
  $("#interrupt").hidden =
    !s.live ||
    !s.canControl ||
    !["running", "approval", "input"].includes(s.state);
  $("#review").textContent = s.reviewed ? "✓ 已读" : "✓ 标为已读";
  renderContent();
  renderPending();
}
function renderContent() {
  const s = detail;
  if (!s) return;
  const container = $("#detail-content");
  const stick =
    container.scrollHeight - container.scrollTop - container.clientHeight < 90;
  const tab = $("#detail .detail-tabs .active")?.dataset.tab || "progress";
  renderedCopies = [];
  let html = "";
  if (tab === "result") {
    html = s.result
      ? `<div class="result-notice">${!s.archived && s.state === "running" ? "上一轮的最终回复 · 当前轮仍在执行" : "最近一次最终回复"}<span>${time(s.result.time)}</span></div>${message("assistant", s.result.text, "final_answer", s.result.time)}`
      : '<div class="empty-list"><span>◌</span><h3>还没有最终回复</h3><p>本轮结束后，结果会显示在这里。</p></div>';
  } else if (tab === "activity") {
    html = `<h3 class="section-title">指令记录</h3>${
      s.commands?.length
        ? s.commands
            .slice()
            .reverse()
            .map(
              (c) =>
                `<div class="command-record"><div><b>${esc(c.delivery === "native" && c.state === "queued" ? "原生队列等待终端接收" : commandLabels[c.state] || c.state)}</b><time>${time(c.createdAt)}</time></div><p>${esc(c.text)}</p>${c.error ? `<p class="error">${esc(c.error)}</p>` : ""}${c.state === "queued" ? `<button class="quiet" data-cancel="${esc(c.id)}">撤回指令</button>` : ""}</div>`,
            )
            .join("")
        : '<p class="hint">从工作台发送的指令会记录在这里。</p>'
    }<h3 class="section-title">最近活动</h3>${
      (s.activity || [])
        .slice()
        .reverse()
        .map(
          (a) =>
            `<div class="activity"><span class="activity-dot"></span><div><b>${esc(a.text)}</b>${a.detail ? `<pre>${esc(a.detail)}</pre>` : ""}<time>${time(a.time)}</time></div></div>`,
        )
        .join("") || '<p class="hint">暂无可显示的工具活动。</p>'
    }`;
  } else {
    if (s.plan?.length)
      html += `<div class="plan"><div class="plan-heading">当前计划 <span>${s.plan.filter((p) => p.status === "completed").length} / ${s.plan.length}</span></div>${s.plan.map((p) => `<div class="plan-step ${esc(p.status)}"><span>${p.status === "completed" ? "✓" : p.status === "in_progress" || p.status === "inProgress" ? "◉" : "○"}</span>${esc(p.step)}</div>`).join("")}</div>`;
    if (s.historyError)
      html += `<p class="history-note">${esc(s.historyError)}</p>`;
    const msgs = (s.messages || []).map((m) =>
      s.stream?.text && m.itemId === s.stream.itemId
        ? { ...m, text: s.stream.text }
        : m,
    );
    html += msgs.map((m) => message(m.role, m.text, m.phase, m.time)).join("");
    if (
      s.stream?.text &&
      !msgs.some((m) => m.itemId && m.itemId === s.stream.itemId)
    )
      html += message("assistant", s.stream.text, "commentary");
    if (!msgs.length && !s.stream?.text)
      html +=
        '<div class="empty-list"><span>◎</span><h3>等待会话消息</h3><p>下发第一条指令后，进展会显示在这里。</p></div>';
    if (s.historyPartial)
      html +=
        '<p class="history-note">显示有界日志摘要；完整记录保留在原 Codex 会话中。</p>';
  }
  if (container.dataset.html !== html) {
    container.innerHTML = html;
    container.dataset.html = html;
    if (stick && tab === "progress")
      container.scrollTop = container.scrollHeight;
  }
  container.querySelectorAll(".copy-message").forEach((button) => {
    button.onclick = async () => {
      try {
        await copyText(renderedCopies[Number(button.dataset.copy)]);
        toast("已复制回复原文");
      } catch (e) {
        toast(e.message);
      }
    };
  });
  container.querySelectorAll(".markdown pre").forEach((pre) => {
    if (pre.querySelector("button")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-code quiet";
    button.textContent = "复制代码";
    button.onclick = async () => {
      try {
        await copyText(pre.querySelector("code").textContent);
        toast("已复制代码");
      } catch (e) {
        toast(e.message);
      }
    };
    pre.prepend(button);
  });
  container.querySelectorAll("[data-cancel]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api("cancel", { id: b.dataset.cancel });
          await refresh();
        } catch (e) {
          toast(e.message);
        }
      }),
  );
}
function renderPending() {
  if (detail.archived) {
    $("#pending-requests").innerHTML = "";
    return;
  }
  const pending = detail.pending || [];
  if (!pending.length && ["approval", "input"].includes(detail.state)) {
    $("#pending-requests").innerHTML =
      '<div class="request-card"><b>会话正在等待你的处理</b><p>当前连接尚未收到可回答的请求。请在原 Codex 客户端查看审批或问题；同步到此连接的请求会显示在这里。</p></div>';
    return;
  }
  $("#pending-requests").innerHTML = pending
    .map((p, i) => {
      const approval = [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
      ].includes(p.method);
      const input = p.method === "item/tool/requestUserInput";
      return `<div class="request-card"><b>${approval ? "需要你的审批" : input ? "Codex 有一个问题" : "需要在原客户端处理"}</b>${p.params.reason ? `<p>${esc(p.params.reason)}</p>` : ""}${p.params.command ? `<pre>${esc(p.params.command)}</pre>` : ""}${approval ? `<div class="request-actions"><button class="primary" data-reply="${i}" data-decision="accept" ${p.submitted ? "disabled" : ""}>允许本次</button><button class="quiet" data-reply="${i}" data-decision="decline" ${p.submitted ? "disabled" : ""}>拒绝</button></div>` : input ? `<form data-question="${i}">${(p.params.questions || []).map((q) => `<label>${esc(q.question)}</label>${q.options?.length ? `<p class="hint">${q.options.map((o) => esc(o.label)).join(" / ")}</p>` : ""}<input data-question-id="${esc(q.id)}" required ${p.submitted ? "disabled" : ""}>`).join("")}<button class="primary" ${p.submitted ? "disabled" : ""}>提交回答</button></form>` : `<p class="hint">${esc(p.method)}</p>`}${p.submitted ? '<p class="hint">已提交，等待 Codex 确认。</p>' : ""}</div>`;
    })
    .join("");
  $("#pending-requests")
    .querySelectorAll("[data-reply]")
    .forEach(
      (b) =>
        (b.onclick = async () => {
          try {
            await api("reply", {
              id: pending[b.dataset.reply].id,
              decision: b.dataset.decision,
            });
            await refresh();
          } catch (e) {
            toast(e.message);
          }
        }),
    );
  $("#pending-requests")
    .querySelectorAll("form")
    .forEach(
      (f) =>
        (f.onsubmit = async (e) => {
          e.preventDefault();
          const answers = {};
          f.querySelectorAll("[data-question-id]").forEach(
            (x) => (answers[x.dataset.questionId] = { answers: [x.value] }),
          );
          try {
            await api("reply", { id: pending[f.dataset.question].id, answers });
            await refresh();
          } catch (e) {
            toast(e.message);
          }
        }),
    );
}
$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("login", { key: $("#access-key").value.trim() });
    $("#access-key").value = "";
    $("#login-error").textContent = "";
    await start();
  } catch (e) {
    $("#login-error").textContent = e.message;
  }
};
$("#logout").onclick = async () => {
  await api("logout", {});
  showLogin();
};
document
  .querySelectorAll("[data-view]")
  .forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
$("#status-filters")
  .querySelectorAll("button")
  .forEach((b) => (b.onclick = () => setFilter(b.dataset.filter)));
$("#search").oninput = renderList;
$("#profile-filter").onchange = renderList;
function newEfforts(previous = "") {
  if (!modelCatalog) return;
  const selectedModel = $("#new-model").value;
  $("#custom-model-field").hidden = selectedModel !== "custom";
  $("#new-custom-model").required = selectedModel === "custom";
  const model = modelCatalog.models.find(
    (m) => m.model === (selectedModel || modelCatalog.defaults.model),
  );
  const options = model?.supportedReasoningEfforts || [
    ...new Map(
      modelCatalog.models
        .flatMap((m) => m.supportedReasoningEfforts)
        .map((e) => [e.reasoningEffort, e]),
    ).values(),
  ];
  const defaultEffort =
    selectedModel &&
    selectedModel !== "custom" &&
    selectedModel !== modelCatalog.defaults.model
      ? model?.defaultReasoningEffort
      : modelCatalog.defaults.effort || model?.defaultReasoningEffort;
  $("#new-effort").innerHTML =
    `<option value="">${selectedModel && selectedModel !== "custom" && selectedModel !== modelCatalog.defaults.model ? "模型默认" : "沿用入口"}：${esc(effortText(defaultEffort))}</option>` +
    options
      .map(
        (e) =>
          `<option value="${esc(e.reasoningEffort)}">${esc(effortText(e.reasoningEffort))}</option>`,
      )
      .join("");
  $("#new-effort").value = options.some((e) => e.reasoningEffort === previous)
    ? previous
    : "";
  $("#model-help").textContent =
    selectedModel === "custom"
      ? "自定义模型由所选入口的上游提供；名称和强度是否可用由上游验证。认证和权限沿用该入口。"
      : "模型和推理强度只用于新会话，认证和权限沿用所选入口。";
}
async function loadModels(preserve = false) {
  const sequence = ++modelLoadId;
  const profile = $("#new-profile").value,
    cwd = $("#new-cwd").value.trim();
  const previousModel = preserve ? $("#new-model").value : "",
    previousEffort = preserve ? $("#new-effort").value : "";
  modelCatalog = null;
  $("#create-button").disabled = true;
  $("#new-model").disabled = true;
  $("#new-effort").disabled = true;
  $("#create-error").textContent = "";
  try {
    const catalog = await api(
      `models?profile=${encodeURIComponent(profile)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`,
    );
    if (sequence !== modelLoadId) return;
    modelCatalog = catalog;
    $("#new-model").innerHTML =
      `<option value="">沿用入口：${esc(catalog.defaults.model || "默认模型")}</option>` +
      catalog.models
        .map(
          (m) =>
            `<option value="${esc(m.model)}">${esc(m.displayName)} · ${esc(m.model)}</option>`,
        )
        .join("") +
      '<option value="custom">自定义模型…</option>';
    $("#new-model").value =
      previousModel === "custom" ||
      catalog.models.some((m) => m.model === previousModel)
        ? previousModel
        : "";
    newEfforts(previousEffort);
  } catch (e) {
    if (sequence === modelLoadId) $("#create-error").textContent = e.message;
  } finally {
    if (sequence === modelLoadId) {
      $("#new-model").disabled = !modelCatalog;
      $("#new-effort").disabled = !modelCatalog;
      $("#create-button").disabled = !modelCatalog;
    }
  }
}
$("#new-session").onclick = () => {
  $("#recent-directories").innerHTML = [
    ...new Set(
      snapshot.sessions
        .filter((s) => !s.archived && s.cwd)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((s) => s.cwd),
    ),
  ]
    .slice(0, 30)
    .map((cwd) => `<option value="${esc(cwd)}"></option>`)
    .join("");
  if (!$("#new-cwd").value && detail?.cwd) $("#new-cwd").value = detail.cwd;
  $("#new-dialog").showModal();
  loadModels();
};
$("#new-profile").onchange = () => loadModels();
$("#new-cwd").onchange = () => loadModels(true);
$("#new-model").onchange = () => newEfforts();
$("#close-dialog").onclick = () => $("#new-dialog").close();
$("#new-form").onsubmit = async (e) => {
  e.preventDefault();
  $("#create-button").disabled = true;
  try {
    const r = await api("create", {
      profile: $("#new-profile").value,
      cwd: $("#new-cwd").value.trim(),
      model:
        ($("#new-model").value === "custom"
          ? $("#new-custom-model").value.trim()
          : $("#new-model").value) || undefined,
      effort: $("#new-effort").value || undefined,
    });
    $("#new-dialog").close();
    setFilter("active");
    await select(r.key);
    toast("会话已创建，可以下发指令");
  } catch (e) {
    $("#create-error").textContent = e.message;
  } finally {
    $("#create-button").disabled = !modelCatalog;
  }
};
setInterval(() => {
  if (!$("#app").hidden && !document.hidden && !refreshing) refresh();
}, 30000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !$("#app").hidden) refresh();
});
addEventListener("resize", resizePrompt);
try {
  const auth = await api("auth");
  if (auth.authenticated) await start();
  else showLogin();
} catch (error) {
  showLogin();
  $("#login-error").textContent = error.message;
}
