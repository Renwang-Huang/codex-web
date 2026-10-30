// Capture the real UI with synthetic data. No keys, Codex sessions, or model calls.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const root = new URL("../", import.meta.url);
const output = new URL("docs/images/", root);
await mkdir(output, { recursive: true });
const now = Date.UTC(2026, 9, 29, 10, 30);
const answer = [
  "### 会话筛选已完成",
  "",
  "- 按标题、工作目录和模型搜索会话。",
  "- 支持按运行入口筛选，并保留手机端返回导航。",
  "",
  "```js",
  'const visible = sessions.filter((session) =>',
  '  session.title.toLowerCase().includes(query.toLowerCase())',
  ');',
  "```",
  "",
  "已核对桌面与手机布局，可以继续查看变更。",
].join("\n");
const sessions = [
  {
    key: "codex:demo-search", id: "demo-search", profile: "codex",
    title: "优化会话筛选与移动端导航", cwd: "/workspace/codex-web",
    state: "completed", live: true, canControl: true, reviewed: false,
    canTrash: false, trashReason: "演示会话 · 仅展示界面",
    model: "demo-model", reasoningEffort: "high", modelSource: "turn_context",
    updatedAt: now, latestMessage: "会话筛选与移动端导航已完成。",
    processes: [], pending: [], commands: [],
    result: { text: answer, preview: "会话筛选与移动端导航已完成。", timestamp: now },
    messages: [{ role: "assistant", phase: "final_answer", text: answer }],
    tokenUsage: { input_tokens: 12480, output_tokens: 2360 },
  },
  {
    key: "codex1:demo-tests", id: "demo-tests", profile: "codex1",
    title: "检查 API 认证与队列回归", cwd: "/workspace/service-api",
    state: "running", live: true, canControl: true, queuedCount: 1,
    model: "demo-model", reasoningEffort: "high", updatedAt: now - 120000,
    latestMessage: "正在核对重连后的请求去重与状态恢复。", processes: [],
    pending: [], commands: [], messages: [],
  },
  {
    key: "codex2:demo-review", id: "demo-review", profile: "codex2",
    title: "梳理部署文档与配置示例", cwd: "/workspace/docs-site",
    state: "approval", live: true, canControl: true,
    model: "demo-model", reasoningEffort: "medium", updatedAt: now - 300000,
    latestMessage: "部署示例已整理，等待确认后继续。", processes: [],
    pending: [], commands: [], messages: [],
  },
];
const processes = ["codex", "codex1", "codex2"].map((profile, i) => ({
  profile, pid: 1000 + i, ppid: 1, comm: "codex", kind: "app-server",
  rssKb: 32768, cwd: "/workspace/demo",
}));
const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/render.js", ["render.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ...["marked", "purify", "highlight"].map(name => [
    `/vendor/${name}.js`, [`vendor/${name}.js`, "text/javascript"],
  ]),
]);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(': demo\nevent: change\ndata: {"snapshot":false}\n\n');
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    const data = {
      "/api/auth": { authenticated: true },
      "/api/snapshot": {
        sessions, processes, updatedAt: now,
        profiles: ["codex", "codex1", "codex2"].map(id => ({ id, connected: 1 })),
      },
      "/api/detail": sessions.find(s => s.key === url.searchParams.get("key")),
    }[url.pathname];
    res.writeHead(data ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data || { error: "Demo endpoint unavailable" }));
    return;
  }
  const asset = assets.get(url.pathname);
  if (!asset) {
    res.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(new URL(`public/${asset[0]}`, root));
    res.writeHead(200, { "Content-Type": asset[1] });
    res.end(data);
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || "/usr/bin/microsoft-edge",
    headless: true,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, viewport, colorScheme] of [
    ["workbench-desktop", { width: 1440, height: 1100 }, "light"],
    ["workbench-mobile", { width: 390, height: 940 }, "dark"],
  ]) {
    const context = await browser.newContext({ viewport, colorScheme, locale: "zh-CN", timezoneId: "UTC" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("requestfailed", request => errors.push(request.failure()?.errorText));
    await page.clock.setFixedTime(now + 30000);
    await page.goto(`${base}/#session=${encodeURIComponent(sessions[0].key)}`);
    await page.locator(".markdown pre code").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      document.querySelector("#detail-content").scrollTop = 0;
    });
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: new URL(`${name}.png`, output).pathname });
    await context.close();
  }
  console.log("Captured desktop and mobile previews with synthetic data; no real sessions accessed.");
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
