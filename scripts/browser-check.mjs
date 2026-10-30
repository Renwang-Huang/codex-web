import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";

const base = process.env.BASE_URL || "http://127.0.0.1:4317";
await mkdir(".local/checks", { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_EXECUTABLE_PATH || "/usr/bin/microsoft-edge",
  headless: true,
});
const errors = [];
const checks = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const unauthorized = await context.request.get(`${base}/api/snapshot`);
  assert.equal(unauthorized.status(), 401);
  checks.push("未登录 API 被拒绝");
  await page.goto(base);
  await page.locator("#login").waitFor({ state: "visible" });
  await page
    .locator("#access-key")
    .fill((await readFile(".local/access-key", "utf8")).trim());
  await page.locator("#login-form button").click();
  await page.locator("#app").waitFor({ state: "visible" });
  await page.locator(".session-card").first().waitFor();
  assert.ok((await page.locator(".session-card").count()) > 0);
  checks.push("真实登录、进程及会话加载");
  await page.screenshot({
    path: ".local/checks/desktop-live.png",
    fullPage: true,
  });
  const s = await (await context.request.get(`${base}/api/snapshot`)).json();
  assert.equal(s.profiles.length, 3);
  checks.push(
    `读取 ${s.sessions.length} 个本机会话、${s.processes.length} 个相关进程`,
  );
  const cross = await context.request.post(`${base}/api/reviewed`, {
    data: { key: "none" },
    headers: { Origin: "https://unrelated.example", "x-codex-web": "1" },
  });
  assert.equal(cross.status(), 403);
  checks.push("跨来源写请求被拒绝");
  await context.close();

  // Deterministic UI fixtures never send commands to a user's real session.
  const fixtureContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const fpage = await fixtureContext.newPage();
  fpage.on("pageerror", (e) => errors.push(e.message));
  const now = Date.now();
  const commands = [];
  const sent = [];
  let failCommand = false;
  const session = {
    key: "codex1:demo",
    id: "demo",
    profile: "codex1",
    title: "完善移动端会话工作台",
    cwd: "/workspace/codex-web",
    state: "running",
    model: "沿用本机模型",
    live: true,
    canControl: true,
    processes: [4321],
    updatedAt: now,
    plan: [
      { step: "核查三个 Codex 入口与共享会话接口", status: "completed" },
      { step: "实现桌面与手机端交互", status: "completed" },
      { step: "验证指令排队与连接恢复", status: "in_progress" },
    ],
    result: null,
    messages: [
      {
        role: "user",
        text: "请完成工作台，并验证手机端查看进展和下发下一轮指令。",
        time: new Date(now - 180000).toISOString(),
      },
      {
        role: "assistant",
        phase: "commentary",
        text: "桌面和手机布局已完成。正在检查排队指令的去重，以及连接中断后的发送状态。\n\n当前进展：\n✓ 三个入口均可独立连接\n✓ 真实会话状态与最终回复已接入\n◉ 验证指令队列与中断操作",
        time: new Date(now).toISOString(),
      },
    ],
    activity: [{ type: "tool", text: "运行接口回归测试", time: now }],
    pending: [],
    commands,
    historyPartial: false,
  };
  await fpage.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/events")
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": fixture\n\n",
      });
    let data = {};
    if (path === "/api/auth") data = { authenticated: true };
    if (path === "/api/snapshot")
      data = {
        updatedAt: now,
        errors: [],
        profiles: ["codex", "codex1", "codex2"].map((id) => ({
          id,
          connected: 1,
        })),
        sessions: [session],
        processes: [
          {
            pid: 4321,
            ppid: 1,
            comm: "codex",
            profile: "codex1",
            kind: "app-server",
            rssKb: 128000,
            cwd: "/workspace/codex-web",
          },
        ],
      };
    if (path === "/api/detail") data = session;
    if (path === "/api/command") {
      if (failCommand) return route.fulfill({ status: 502, body: "" });
      const c = route.request().postDataJSON();
      sent.push(c);
      const command = {
        ...c,
        state: "queued",
        createdAt: now,
        ...(!session.canControl && session.canQueue
          ? { delivery: "native" }
          : {}),
      };
      commands.push(command);
      data = command;
    }
    if (path === "/api/cancel") {
      const { id } = route.request().postDataJSON();
      commands.find((c) => c.id === id).state = "cancelled";
      data = { ok: true };
    }
    return route.fulfill({ json: data });
  });
  await fpage.goto(base);
  await fpage.locator(".session-card").first().click();
  await fpage.locator("#composer").waitFor();
  await fpage.locator("#prompt").fill("完成当前验证后，整理验收结果。");
  await fpage.screenshot({ path: ".local/checks/desktop.png", fullPage: true });
  assert.equal(await fpage.locator("#send-mode").inputValue(), "queue");
  await fpage.locator("#send").click();
  await fpage.waitForFunction(
    () => document.querySelector("#prompt").value === "",
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].mode, "queue");
  checks.push("运行中默认排队、单次提交、成功后清空输入");
  await fpage.setViewportSize({ width: 390, height: 844 });
  await fpage.locator("#prompt").fill("手机端草稿");
  assert.equal(
    await fpage.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await fpage.screenshot({
    path: ".local/checks/mobile-detail.png",
    fullPage: true,
  });
  await fpage.locator("#back").click();
  await fpage.locator("#session-list").waitFor({ state: "visible" });
  await fpage.screenshot({
    path: ".local/checks/mobile-list.png",
    fullPage: true,
  });
  await fpage.locator(".session-card").first().click();
  await fpage.locator("#composer").waitFor();
  assert.equal(await fpage.locator("#prompt").inputValue(), "手机端草稿");
  checks.push("390 px 手机列表、会话返回和草稿保留，无横向溢出");
  await fpage.getByRole("button", { name: "活动与指令", exact: true }).click();
  assert.equal(await fpage.locator(".command-record").count(), 1);
  checks.push("排队指令在活动面板可见");
  failCommand = true;
  await fpage.locator("#prompt").fill("连接中断时的指令");
  await fpage.locator("#send").click();
  await fpage
    .locator("#toast")
    .filter({ hasText: "发送状态尚未确认" })
    .waitFor();
  assert.equal(await fpage.locator("#prompt").inputValue(), "连接中断时的指令");
  assert.equal(sent.length, 1);
  checks.push("代理丢失写响应时显示结果待确认，保留草稿且不自动重发");

  failCommand = false;
  session.live = false;
  session.canControl = false;
  session.canQueue = true;
  session.controlMode = "native_queue";
  await fpage.reload();
  await fpage.locator(".session-card").first().click();
  await fpage.locator("#composer").waitFor();
  assert.match(await fpage.locator("#detail-meta").innerText(), /执行中/);
  assert.equal(await fpage.locator("#prompt").isEnabled(), true);
  assert.equal(await fpage.locator("#send-mode").inputValue(), "queue");
  assert.equal(
    await fpage.locator("#send-mode option[value=next]").isDisabled(),
    true,
  );
  assert.equal(
    await fpage.locator("#send-mode option[value=steer]").isDisabled(),
    true,
  );
  assert.equal(await fpage.locator("#interrupt").isVisible(), false);
  assert.match(
    await fpage.locator("#control-note").innerText(),
    /Codex 原生队列/,
  );
  await fpage.locator("#prompt").fill("独立终端的下一轮指令");
  await fpage.locator("#send").click();
  await fpage
    .locator("#toast")
    .filter({ hasText: "已加入 Codex 原生队列" })
    .waitFor();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].mode, "queue");
  await fpage.getByRole("button", { name: "活动与指令", exact: true }).click();
  const nativeRecord = fpage
    .locator(".command-record")
    .filter({ hasText: "独立终端的下一轮指令" });
  assert.match(await nativeRecord.innerText(), /原生队列等待终端接收/);
  await fpage.screenshot({
    path: ".local/checks/mobile-native-queue.png",
    fullPage: true,
  });
  await nativeRecord.getByRole("button", { name: "撤回指令" }).click();
  await nativeRecord.filter({ hasText: "已撤回" }).waitFor();
  checks.push(
    "独立终端执行状态、原生队列输入、发送与撤回可用；即时补充及中断保持禁用",
  );
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    checks,
    browserErrors: errors,
    browser: "headless Microsoft Edge / Playwright",
    fixtureCommandsOnly: true,
  };
  await writeFile(
    ".local/checks/browser.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await fixtureContext.close();
} finally {
  await browser.close();
}
