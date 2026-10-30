import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

// Self-contained HTTP/SSE fixtures: no credentials or real Codex writes.
const streams = new Set(),
  errors = [],
  checks = [],
  counts = { snapshot: 0, detail: 0, command: 0 };
const session = {
  key: "codex:review",
  id: "review",
  profile: "codex",
  title: "审查回归会话",
  cwd: "/workspace/review",
  state: "running",
  live: true,
  canControl: true,
  model: "fixture",
  processes: [],
  updatedAt: Date.now(),
  pending: [],
  commands: [],
  tokenUsage: { input_tokens: 12345, output_tokens: 678 },
  messages: [
    {
      role: "assistant",
      phase: "final_answer",
      text: '**已完成**\n\n- 第一项\n- 第二项\n\n```js\nconst answer = "safe";\n```\n\n<script>window.pwned = true</script>\n\n[危险](javascript:alert(1))\n\n<img src=x onerror="window.pwned=true">',
    },
  ],
};
let releaseCommand;
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    res.write(": ready\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  if (path.startsWith("/api/")) {
    let data = {};
    if (path === "/api/auth") data = { authenticated: true };
    if (path === "/api/snapshot") {
      counts.snapshot++;
      data = {
        sessions: [session],
        processes: [],
        profiles: [{ id: "codex", connected: 1 }],
        updatedAt: Date.now(),
      };
    }
    if (path === "/api/detail") {
      counts.detail++;
      data = session;
    }
    if (path === "/api/command") {
      counts.command++;
      let body = "";
      for await (const part of req) body += part;
      data = { ...JSON.parse(body), state: "queued" };
      await new Promise((resolve) => {
        releaseCommand = resolve;
      });
      session.commands.push(data);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(data));
  }
  const assets = new Map([
    ["/", ["index.html", "text/html"]],
    ["/app.js", ["app.js", "text/javascript"]],
    ["/render.js", ["render.js", "text/javascript"]],
    ["/style.css", ["style.css", "text/css"]],
    ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
    ...["marked", "purify", "highlight"].map((name) => [
      `/vendor/${name}.js`,
      [`vendor/${name}.js`, "text/javascript"],
    ]),
  ]);
  if (!assets.has(path)) {
    res.writeHead(404);
    return res.end();
  }
  const [file, type] = assets.get(path);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
  });
  res.end(await readFile(new URL("../public/" + file, import.meta.url)));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const emit = (change) => {
  for (const stream of streams)
    stream.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
};
await mkdir(".local/checks", { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_EXECUTABLE_PATH || "/usr/bin/microsoft-edge",
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copied = text;
        },
      },
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator(".session-card").click();
  await page.locator("#composer").waitFor();
  await page.locator(".markdown strong").waitFor();
  assert.equal(await page.locator(".markdown li").count(), 2);
  assert.ok(await page.locator(".markdown code .hljs-keyword").count());
  assert.equal(
    await page
      .locator(
        ".markdown script, .markdown img, .markdown svg, .markdown [onerror], .markdown a[href^='javascript:']",
      )
      .count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await page.locator(".copy-message").first().click();
  assert.equal(
    await page.evaluate(() => window.copied),
    session.messages[0].text,
  );
  await page.locator(".copy-code").click();
  assert.equal(
    await page.evaluate(() => window.copied),
    'const answer = "safe";',
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined });
    document.execCommand = () => {
      window.copied = document.activeElement.value;
      return true;
    };
  });
  await page.locator(".copy-code").click();
  assert.equal(
    await page.evaluate(() => window.copied),
    'const answer = "safe";',
  );
  checks.push(
    "Markdown、语法高亮、XSS 防护、回复原文和代码复制、HTTP 复制回退",
  );
  await page.screenshot({
    path: ".local/checks/review-desktop.png",
    fullPage: true,
  });

  // Real EventSource receives token deltas; no snapshot/detail fetches follow.
  await page.waitForTimeout(500);
  const before = { ...counts };
  for (let i = 0; i < 80; i++) {
    emit({
      snapshot: false,
      keys: [],
      streams: [
        {
          key: session.key,
          itemId: "stream",
          delta: "片段",
          start: i * 2,
          end: (i + 1) * 2,
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  await page.waitForFunction(() =>
    document
      .querySelector("#detail-content")
      .textContent.includes("片段".repeat(80)),
  );
  assert.equal(counts.snapshot, before.snapshot);
  assert.equal(counts.detail, before.detail);
  emit({
    snapshot: false,
    keys: [],
    streams: [
      {
        key: session.key,
        itemId: "stream",
        delta: "片段".repeat(80),
        start: 0,
        end: 160,
      },
    ],
  });
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator(".message-text").last().innerText(),
    "片段".repeat(80),
  );
  assert.equal(counts.detail, before.detail);
  emit({ snapshot: false, keys: ["codex:another"], streams: [] });
  await page.waitForTimeout(100);
  assert.equal(counts.detail, before.detail);
  emit({ snapshot: false, keys: [session.key], streams: [] });
  await page.waitForFunction(
    () =>
      !document.querySelector("#detail-content").textContent.includes("片段"),
  );
  assert.equal(counts.snapshot, before.snapshot);
  assert.equal(counts.detail, before.detail + 1);
  checks.push(
    "80 次真实 SSE 增量产生 0 次快照/详情请求；非选中会话通知不拉取详情",
  );
  session.stream = { itemId: "stream", text: "缺口后的同步结果", length: 1000 };
  emit({
    snapshot: false,
    keys: [],
    streams: [
      {
        key: session.key,
        itemId: "stream",
        delta: "结果",
        start: 998,
        end: 1000,
      },
    ],
  });
  await page.waitForFunction(() =>
    document
      .querySelector("#detail-content")
      .textContent.includes("缺口后的同步结果"),
  );
  assert.equal(counts.snapshot, before.snapshot);
  assert.equal(counts.detail, before.detail + 2);
  delete session.stream;
  checks.push("SSE 重叠范围不重复拼接，偏移缺口仅重取选中详情");

  await page.locator("#prompt").fill("原始指令");
  await page.locator("#prompt").press("Control+Enter");
  await page.waitForFunction(() => document.querySelector("#send").disabled);
  await page.evaluate(() => {
    document.querySelector("#composer").requestSubmit();
    document.querySelector("#composer").requestSubmit();
  });
  const detailBefore = counts.detail;
  emit({ snapshot: true, allDetails: true, keys: [], streams: [] });
  await page.waitForTimeout(350);
  assert.ok(counts.detail > detailBefore);
  assert.equal(await page.locator("#send").isDisabled(), true);
  assert.equal(counts.command, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goBack();
  await page.locator("#session-list").waitFor({ state: "visible" });
  await page.goForward();
  await page.locator("#composer").waitFor();
  assert.equal(await page.locator("#send").isDisabled(), true);
  await page.locator("#prompt").fill("发送期间新增的草稿");
  releaseCommand();
  await page.waitForFunction(() => !document.querySelector("#send").disabled);
  assert.equal(
    await page.locator("#prompt").inputValue(),
    "发送期间新增的草稿",
  );
  checks.push(
    "快捷键及 requestSubmit 并发只发一次，刷新不解锁，发送期间的新草稿保留",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#prompt").fill("多行需求\n".repeat(20));
  assert.ok(await page.locator("#prompt").evaluate((e) => e.clientHeight > 90));
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: ".local/checks/review-mobile-light.png",
    fullPage: true,
  });
  await page.goBack();
  await page.locator("#session-list").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).hash, "");
  await page.goForward();
  await page.locator("#composer").waitFor();
  assert.ok((await page.locator("#prompt").inputValue()).includes("多行需求"));
  await page.reload();
  await page.locator("#composer").waitFor();
  assert.ok(new URL(page.url()).hash.includes("session="));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(200); // Let existing background transitions finish before visual capture.
  assert.equal(
    await page
      .locator("#composer")
      .evaluate((e) => getComputedStyle(e).backgroundColor),
    "rgb(28, 39, 34)",
  );
  await page.screenshot({
    path: ".local/checks/review-mobile-dark.png",
    fullPage: true,
  });
  const wakeBefore = counts.snapshot;
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await page.waitForTimeout(350);
  assert.ok(counts.snapshot > wakeBefore);
  assert.match(await page.locator(".token-usage").innerText(), /12,345/);
  checks.push(
    "390px 无横向溢出、自适应输入框、浏览器返回/前进、刷新恢复会话、深色主题、唤醒核对、Token 用量",
  );

  // Check the review's cookie assertion in a real browser on a synthetic HTTPS origin.
  const cookies = await browser.newContext();
  const cookiePage = await cookies.newPage();
  await cookiePage.route("https://cookie.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "cookie fixture",
      headers: {
        "Set-Cookie":
          new URL(route.request().url()).pathname === "/set"
            ? "example=one; Secure; HttpOnly; SameSite=Strict; Path=/"
            : "example=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      },
    }),
  );
  await cookiePage.goto("https://cookie.example/set");
  assert.equal((await cookies.cookies()).length, 1);
  await cookiePage.goto("https://cookie.example/clear");
  assert.equal((await cookies.cookies()).length, 0);
  checks.push(
    "实际浏览器确认：HTTPS 响应不带 Secure 也能删除原 Secure Cookie，审查的规范推断不成立",
  );
  await cookies.close();
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    checks,
    browserErrors: errors,
    fixtureOnly: true,
    counts,
  };
  await writeFile(
    ".local/checks/review-browser.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await context.close();
} finally {
  await browser.close();
  releaseCommand?.();
  for (const stream of streams) stream.end();
  await new Promise((resolve) => server.close(resolve));
}
