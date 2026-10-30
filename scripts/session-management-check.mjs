import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

// Creates its own thread in a dedicated workspace. Never sends to existing tasks.
const base = process.env.BASE_URL || "http://127.0.0.1:4317";
const cwd = resolve(".local/settings-smoke-workspace");
await mkdir(cwd, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_EXECUTABLE_PATH || "/usr/bin/microsoft-edge",
  headless: true,
});
const errors = [],
  checks = [];
let key, api;
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(base);
  await page
    .locator("#access-key")
    .fill((await readFile(".local/access-key", "utf8")).trim());
  await page.locator("#login-form button").click();
  await page.locator("#app").waitFor({ state: "visible" });
  api = async (path, data) => {
    const r = await context.request[data === undefined ? "get" : "post"](
      `${base}/api/${path}`,
      data === undefined
        ? {}
        : { data, headers: { "X-Codex-Web": "1", Origin: base } },
    );
    const b = await r.json();
    assert.equal(r.status(), 200, b.error);
    return b;
  };
  const before = await api("snapshot");
  const legacy = before.sessions.find(
    (s) => s.profile === "codex2" && s.processes?.length && !s.live,
  );
  if (legacy) {
    await page.locator(`.session-card[data-key="${legacy.key}"]`).click();
    await page
      .locator("#session-model")
      .filter({ hasText: legacy.model })
      .waitFor();
    assert.match(
      await page.locator("#session-effort").innerText(),
      new RegExp(legacy.reasoningEffort),
    );
    assert.equal(await page.locator("#trash-session").isDisabled(), true);
    checks.push(
      "Existing independent terminal displays its recorded model and effort and remains protected from deletion",
    );
  }
  await page.locator("#new-session").click();
  await page.locator("#new-cwd").fill(cwd);
  await page.locator("#new-cwd").press("Tab");
  await page.locator("#new-profile").selectOption("codex2");
  await page.waitForFunction(
    () =>
      !document.querySelector("#new-model").disabled &&
      document
        .querySelector("#new-model option")
        .textContent.includes("gpt-6-astra"),
  );
  checks.push(
    "Changing the entry loads that entry's model and reasoning options",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".local/checks/settings-create-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.locator("#new-profile").selectOption("codex");
  await page.waitForFunction(
    () =>
      !document.querySelector("#new-model").disabled &&
      document
        .querySelector("#new-model option")
        .textContent.includes("gpt-6.1-sol"),
  );
  await page.locator("#new-model").selectOption("gpt-6-luna");
  await page.locator("#new-effort").selectOption("high");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({
    path: ".local/checks/settings-create-desktop.png",
    fullPage: true,
  });
  const creation = page.waitForResponse(
    (r) => r.url() === `${base}/api/create` && r.request().method() === "POST",
  );
  await page.locator("#create-button").click();
  const created = await creation;
  const body = created.request().postDataJSON();
  assert.equal(body.cwd, cwd);
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.effort, "high");
  const result = await created.json();
  assert.equal(created.status(), 200, result.error);
  key = result.key;
  let d = await api("detail?key=" + encodeURIComponent(key));
  assert.equal(d.cwd, cwd);
  await page
    .locator("#session-model")
    .filter({ hasText: "gpt-6-luna" })
    .waitFor();
  assert.match(await page.locator("#session-effort").innerText(), /high/);
  checks.push(
    "Browser creates a dedicated thread with the chosen model and reasoning effort",
  );

  await page.locator("#trash-session").click();
  await page.locator("#restore-session").waitFor();
  assert.equal(await page.locator("#composer").isVisible(), false);
  assert.equal(
    (await api("detail?key=" + encodeURIComponent(key))).archived,
    true,
  );
  await page.locator("#restore-session").click();
  await page.locator("#composer").waitFor({ state: "visible" });
  d = await api("detail?key=" + encodeURIComponent(key));
  assert.equal(d.archived, false);
  assert.equal(d.model, "gpt-6-luna");
  assert.equal(d.reasoningEffort, "high");
  checks.push(
    "Empty thread can be trashed and restored with its selected configuration intact",
  );

  const word = "CODEX_SETTINGS_TRASH_RESTORE_OK";
  await page
    .locator("#prompt")
    .fill(
      `这是工作台模型及回收站验收。不要调用工具，不要读写文件，不要执行命令。只回复一行：${word}`,
    );
  const submission = page.waitForResponse(
    (r) => r.url() === `${base}/api/command` && r.request().method() === "POST",
  );
  await page.locator("#send").click();
  const submitted = await submission,
    command = await submitted.json();
  assert.equal(submitted.status(), 200, command.error);
  assert.equal(command.key, key);
  assert.equal(command.state, "sent");
  let completed = false;
  for (const deadline = Date.now() + 120000; Date.now() < deadline; ) {
    d = await api("detail?key=" + encodeURIComponent(key));
    if (
      ["idle", "completed"].includes(d.state) &&
      d.result?.text.trim() === word
    ) {
      completed = true;
      break;
    }
    await page.waitForTimeout(1200);
  }
  assert.ok(completed, "Dedicated restored thread did not complete");
  assert.equal(d.model, "gpt-6-luna");
  assert.equal(d.reasoningEffort, "high");
  await page.getByRole("button", { name: "最终回复", exact: true }).click();
  await page.locator("#detail-content").filter({ hasText: word }).waitFor();
  await page.screenshot({
    path: ".local/checks/settings-restored-result.png",
    fullPage: true,
  });
  checks.push(
    "Restored thread completes a real model turn using the selected model and effort",
  );
  await page.locator("#trash-session").click();
  await page.locator("#restore-session").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".local/checks/settings-trash-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  const report = {
    checkedAt: new Date().toISOString(),
    base,
    key,
    model: d.model,
    effort: d.reasoningEffort,
    result: d.result.text.trim(),
    checks,
    browserErrors: errors,
  };
  await writeFile(
    ".local/checks/session-management-browser.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Cleanup is also reversible and uses only the test thread created above.
  if (key && api) {
    try {
      const d = await api("detail?key=" + encodeURIComponent(key));
      if (!d.archived && d.canTrash) await api("trash", { key });
    } catch (e) {
      console.error("Dedicated test cleanup: " + e.message);
    }
  }
  await browser.close();
}
