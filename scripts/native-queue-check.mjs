import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

// Run only against an explicitly supplied, dedicated standalone test terminal.
// Start it in .local/native-queue-workspace, then pass its ID with TEST_THREAD_ID.
const threadId = process.env.TEST_THREAD_ID;
assert.ok(threadId, "TEST_THREAD_ID must name a dedicated test terminal");
const base = process.env.BASE_URL || "http://127.0.0.1:4317";
const key = `codex2:${threadId}`;
const resultText = "CODEX_NATIVE_WEB_QUEUE_OK";
const errors = [];
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
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page
    .locator("#access-key")
    .fill((await readFile(".local/access-key", "utf8")).trim());
  await page.locator("#login-form button").click();
  await page.locator("#app").waitFor({ state: "visible" });
  const detailUrl = `${base}/api/detail?key=${encodeURIComponent(key)}`;
  const initialResponse = await context.request.get(detailUrl);
  assert.equal(initialResponse.status(), 200);
  const initial = await initialResponse.json();
  assert.equal(
    initial.cwd,
    resolve(".local/native-queue-workspace"),
    "Refuse to write to a non-test workspace",
  );
  assert.equal(initial.live, false);
  assert.equal(initial.canControl, false);
  assert.equal(initial.canQueue, true);
  assert.equal(initial.controlMode, "native_queue");
  assert.ok(
    ["completed", "idle"].includes(initial.state),
    "Dedicated terminal must be idle",
  );
  assert.ok(initial.processes.length > 0);
  const card = page.locator(`.session-card[data-key="${key}"]`);
  await card.waitFor();
  await card.click();
  await page.locator("#composer").waitFor();
  assert.equal(await page.locator("#prompt").isEnabled(), true);
  assert.equal(await page.locator("#send-mode").inputValue(), "queue");
  assert.match(
    await page.locator("#control-note").innerText(),
    /Codex 原生队列/,
  );
  await page
    .locator("#prompt")
    .fill(
      `这是网页原生队列验收。不要调用工具，不要读写文件，不要执行命令。只回复一行：${resultText}`,
    );
  const submitted = page.waitForResponse(
    (r) => r.url() === `${base}/api/command` && r.request().method() === "POST",
  );
  await page.locator("#send").click();
  const response = await submitted;
  assert.equal(response.status(), 200);
  const command = await response.json();
  assert.equal(command.key, key);
  assert.equal(command.delivery, "native");
  assert.equal(command.state, "queued");
  let completed;
  for (const deadline = Date.now() + 120000; Date.now() < deadline; ) {
    const d = await (await context.request.get(detailUrl)).json();
    const c = d.commands.find((c) => c.id === command.id);
    assert.ok(!["failed", "uncertain"].includes(c?.state), c?.error);
    if (
      c?.state === "sent" &&
      d.result?.text.trim() === resultText &&
      ["completed", "idle"].includes(d.state)
    ) {
      completed = { command: c, detail: d };
      break;
    }
    await page.waitForTimeout(1500);
  }
  assert.ok(
    completed,
    "Native terminal did not complete the submitted test message",
  );
  assert.equal(
    completed.detail.live,
    false,
    "Original terminal must remain independently owned",
  );
  assert.deepEqual(completed.detail.processes, initial.processes);
  await page.getByRole("button", { name: "最终回复", exact: true }).click();
  await page
    .locator("#detail-content")
    .filter({ hasText: resultText })
    .waitFor();
  await page.screenshot({
    path: ".local/checks/codex2-native-web.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: ".local/checks/codex2-native-web-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    base,
    threadId,
    checks: [
      "Normal DNS and public HTTPS login",
      "Standalone terminal permits native queue input",
      "Browser submitted one native queued command",
      "Same terminal consumed the client message ID and completed the next turn",
      "Desktop and 390px mobile result rendered without script errors",
    ],
    commandId: command.id,
    nativeQueueId: command.nativeQueueId,
    state: completed.command.state,
    turnId: completed.command.turnId,
    terminalPid: initial.processes,
    result: completed.detail.result.text.trim(),
    browserErrors: errors,
  };
  await writeFile(
    ".local/checks/codex2-native-web.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
