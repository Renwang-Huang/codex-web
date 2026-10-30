import https from "node:https";
import http from "node:http";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { CodexRpc } from "../server/rpc.mjs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isIPv4 } from "node:net";

const base = process.env.BASE_URL;
const ip = process.env.RELAY_IP;
assert(base && isIPv4(ip || ""), "Set BASE_URL and RELAY_IP explicitly; this test sends real model requests");
assert.equal(new URL(base).protocol, "https:");
assert.equal(new URL(base).origin, base, "BASE_URL must be an origin without a trailing slash");
const relayDomain = new URL(base).hostname;
const checks = [];
let cookie;
function request(
  path,
  { data, headers = {}, stream = false, plain = false } = {},
) {
  return new Promise((resolve, reject) => {
    const transport = plain ? http : https;
    const req = transport.request(
      new URL(path, plain ? base.replace("https:", "http:") : base),
      {
        method: data === undefined ? "GET" : "POST",
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, [{ address: ip, family: 4 }])
            : callback(null, ip, 4),
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(data === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "X-Codex-Web": "1",
                Origin: base,
              }),
          ...headers,
        },
        timeout: 45000,
      },
      (res) => {
        let body = "";
        const cert = res.socket.getPeerCertificate?.();
        const meta = {
          status: res.statusCode,
          headers: res.headers,
          issuer: cert?.issuer?.O,
          authorized: res.socket.authorized,
        };
        res.on("data", (chunk) => {
          body += chunk;
          if (stream && body.includes("event: change")) {
            resolve({ ...meta, body });
            req.destroy();
          }
        });
        res.on("end", () => {
          let json;
          try {
            json = JSON.parse(body);
          } catch {}
          resolve({ ...meta, body, json });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Public request timed out")));
    req.on("error", reject);
    if (data !== undefined) req.write(JSON.stringify(data));
    req.end();
  });
}
async function api(path, data) {
  const r = await request("/api/" + path, { data });
  if (r.status !== 200)
    throw new Error(
      `${path}: ${r.status} ${r.json?.error || r.body.slice(0, 150)}`,
    );
  return r.json;
}

await mkdir(".local/checks", { recursive: true });
const page = await request("/");
assert.equal(page.status, 200);
assert.equal(page.authorized, true);
checks.push("公网 HTTPS 页面与证书链有效");
const redirect = await request("/", { plain: true });
assert.ok([301, 302, 307, 308].includes(redirect.status));
assert.ok(redirect.headers.location.startsWith(base));
checks.push("HTTP 自动跳转 HTTPS");
assert.equal((await request("/api/snapshot")).status, 401);
checks.push("未认证公网 API 被拒绝");
const login = await request("/api/login", {
  data: { key: (await readFile(".local/access-key", "utf8")).trim() },
});
assert.equal(login.status, 200);
const setCookie = login.headers["set-cookie"][0];
assert.ok(/; Secure(?:;|$)/.test(setCookie));
assert.ok(setCookie.includes("HttpOnly"));
cookie = setCookie.split(";")[0];
checks.push("访问密钥登录成功，Cookie 设置 Secure / HttpOnly");
const snapshot = await api("snapshot");
assert.equal(snapshot.profiles.length, 3);
assert.ok(snapshot.sessions.length > 0);
checks.push("LA 经加密隧道读取三个本机入口的真实状态");
assert.equal(
  (
    await request("/api/command", {
      data: {},
      headers: { Origin: "https://unrelated.example" },
    })
  ).status,
  403,
);
checks.push("公网跨来源写入被拒绝");
const sse = await request("/api/events", { stream: true });
assert.equal(sse.status, 200);
assert.ok(sse.body.includes("event: change"));
checks.push("公网 SSE 事件即时送达");

// Real control-path check uses a new, dedicated test thread only.
const cwd = resolve(".local/smoke-workspace");
await mkdir(cwd, { recursive: true });
const { key } = await api("create", { profile: "codex", cwd });
const prompt = (word) =>
  `这是公网中继验收。不要调用任何工具，不要读写文件，不要执行命令。只回复一行：${word}`;
const one = {
  key,
  id: randomUUID(),
  text: prompt("CODEX_WEB_PUBLIC_ONE"),
  mode: "next",
};
const first = await api("command", one);
assert.equal(first.state, "sent");
const duplicate = await api("command", one);
assert.equal(duplicate.id, first.id);
const second = await api("command", {
  key,
  id: randomUUID(),
  text: prompt("CODEX_WEB_PUBLIC_TWO"),
  mode: "queue",
});
assert.ok(["queued", "sent"].includes(second.state));
let completed = false;
for (const deadline = Date.now() + 120000; Date.now() < deadline; ) {
  const d = await api("detail?key=" + encodeURIComponent(key));
  const c = d.commands.find((c) => c.id === second.id);
  if (["failed", "uncertain"].includes(c?.state)) throw new Error(c.error);
  if (
    d.result?.text.trim() === "CODEX_WEB_PUBLIC_TWO" &&
    ["completed", "idle"].includes(d.state)
  ) {
    completed = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
assert.equal(completed, true);
checks.push("公网首次指令、重复去重、第二轮排队及真实最终回复通过");
const rpc = new CodexRpc({
  socket: resolve(
    homedir(),
    ".codex/app-server-control/app-server-control.sock",
  ),
  home: resolve(homedir(), ".codex"),
});
try {
  await rpc.connect();
  await rpc.request(
    "thread/archive",
    { threadId: key.slice(key.indexOf(":") + 1) },
    { write: true },
  );
} finally {
  rpc.close();
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || "/usr/bin/microsoft-edge",
  headless: true,
  args: [
    `--host-resolver-rules=MAP ${relayDomain} ${ip}, EXCLUDE localhost`,
  ],
});
const errors = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const tab = await context.newPage();
  tab.on("pageerror", (e) => errors.push(e.message));
  await tab.goto(base);
  await tab.locator("#login").waitFor({ state: "visible" });
  await tab
    .locator("#access-key")
    .fill((await readFile(".local/access-key", "utf8")).trim());
  await tab.locator("#login-form button").click();
  await tab.locator("#app").waitFor({ state: "visible" });
  await tab.locator(".session-card").first().waitFor();
  await tab.screenshot({
    path: ".local/checks/public-desktop.png",
    fullPage: true,
  });
  await tab.setViewportSize({ width: 390, height: 844 });
  await tab.screenshot({
    path: ".local/checks/public-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await tab.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  checks.push("真实公网域名的桌面与 390px 手机视口登录、渲染通过");
  await context.close();
} finally {
  await browser.close();
}
const report = {
  checkedAt: new Date().toISOString(),
  origin: base,
  tlsIssuer: page.issuer,
  checks,
  browserErrors: errors,
  dedicatedThreadArchived: true,
};
await writeFile(".local/checks/public.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
