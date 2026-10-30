import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { isIPv4 } from "node:net";
const exec = promisify(execFile);
const base = process.env.BASE_URL;
const ip = process.env.RELAY_IP;
assert(base && isIPv4(ip || ""), "Set BASE_URL and RELAY_IP explicitly; this test restarts local services");
assert.equal(new URL(base).protocol, "https:");
assert.equal(new URL(base).origin, base, "BASE_URL must be an origin without a trailing slash");
const relayDomain = new URL(base).hostname;
let cookie;
function request(path, data) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      base + path,
      {
        lookup: (_host, o, cb) =>
          o.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4),
        timeout: 12000,
        method: data ? "POST" : "GET",
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(data
            ? {
                "Content-Type": "application/json",
                "X-Codex-Web": "1",
                Origin: base,
              }
            : {}),
        },
      },
      (res) => {
        let b = "";
        res.on("data", (x) => (b += x));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: b, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}
async function waitFor(status) {
  for (let i = 0; i < 20; i++) {
    try {
      if ((await request("/api/auth")).status === status) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Relay did not reach expected status " + status);
}
const report = { checkedAt: new Date().toISOString(), checks: [] };
await exec("systemctl", ["--user", "stop", "codex-web-tunnel.service"]);
try {
  await waitFor(502);
  assert.equal((await request("/")).status, 200);
  report.checks.push("本机隧道离线时，LA 仍可提供前端，API 明确不可用");
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || "/usr/bin/microsoft-edge",
    headless: true,
    args: [`--host-resolver-rules=MAP ${relayDomain} ${ip}`],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.goto(base);
    await page.locator("#login-error").filter({ hasText: "离线" }).waitFor();
    await page.screenshot({
      path: ".local/checks/public-offline.png",
      fullPage: true,
    });
    report.checks.push("手机视口页面明确提示本机离线");
  } finally {
    await browser.close();
  }
} finally {
  await exec("systemctl", ["--user", "start", "codex-web-tunnel.service"]);
}
await waitFor(200);
report.checks.push("隧道重新启动后 API 恢复");
await exec("systemctl", [
  "--user",
  "kill",
  "--signal=KILL",
  "codex-web-tunnel.service",
]);
await waitFor(200);
report.checks.push("SSH 进程异常退出后，systemd 自动重建连接");
await exec("systemctl", ["--user", "restart", "codex-web.service"]);
await waitFor(200);
const login = await request("/api/login", {
  key: (await readFile(".local/access-key", "utf8")).trim(),
});
assert.equal(login.status, 200);
cookie = login.headers["set-cookie"][0].split(";")[0];
let snapshot;
for (let i = 0; i < 10; i++) {
  snapshot = await request("/api/snapshot");
  if (snapshot.status === 200) break;
  await new Promise((r) => setTimeout(r, 1000));
}
assert.equal(snapshot.status, 200);
assert.equal(JSON.parse(snapshot.body).profiles.length, 3);
report.checks.push("本机服务重启后可重新登录，并恢复三个入口的状态读取");
await writeFile(
  ".local/checks/relay-recovery.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
