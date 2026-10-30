import http from "node:http";
import {
  readFile,
  writeFile,
  mkdir,
  chmod,
  appendFile,
} from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Store } from "./store.mjs";
import { Hub } from "./hub.mjs";
import { requestPolicy } from "./request-policy.mjs";
import { ChangeBatch } from "./changes.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = resolve(process.env.CODEX_WEB_DATA_DIR || join(ROOT, ".local"));
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4317);
const contextFor = requestPolicy({
  publicOrigin: process.env.PUBLIC_ORIGIN || "",
  trustLoopbackProxy: process.env.TRUST_LOOPBACK_PROXY === "1",
});
await mkdir(DATA, { recursive: true, mode: 0o700 });
await chmod(DATA, 0o700);
let accessKey;
try {
  accessKey = (await readFile(join(DATA, "access-key"), "utf8")).trim();
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  accessKey = randomBytes(24).toString("base64url");
  await writeFile(join(DATA, "access-key"), accessKey + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
const store = new Store(DATA);
const hub = new Hub(store);
const browsers = new Map();
const streams = new Set();
const attempts = new Map();
let initialized = false;
const same = (a, b) => {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
};
function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
function session(req) {
  const token = (req.headers.cookie || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("codex_web="))
    ?.slice(10);
  const s = browsers.get(token);
  if (!s || s.expires < Date.now()) {
    browsers.delete(token);
    return null;
  }
  return s;
}
async function body(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 128 * 1024) {
      const e = new Error("请求过大");
      e.code = "INVALID";
      throw e;
    }
  }
  try {
    const parsed = data ? JSON.parse(data) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed;
  } catch {
    const e = new Error("JSON 无效");
    e.code = "INVALID";
    throw e;
  }
}
const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/style.css", ["style.css", "text/css"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/vendor/marked.js", ["vendor/marked.js", "text/javascript"]],
  ["/vendor/purify.js", ["vendor/purify.js", "text/javascript"]],
  ["/vendor/highlight.js", ["vendor/highlight.js", "text/javascript"]],
  ["/render.js", ["render.js", "text/javascript"]],
]);
async function audit(context, action, fields = {}) {
  await appendFile(
    join(DATA, "audit.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      clientAddress: context.clientAddress,
      action,
      ...fields,
    }) + "\n",
    { mode: 0o600 },
  );
}
const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  try {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    if (req.headers["sec-fetch-site"] === "cross-site")
      return json(res, 403, { error: "拒绝跨站请求" });
    const context = contextFor(req);
    if (context.error)
      return json(res, context.status, { error: context.error });
    if (req.method === "POST") {
      if (
        req.headers["x-codex-web"] !== "1" ||
        !req.headers["content-type"]?.startsWith("application/json")
      )
        return json(res, 403, { error: "请求校验失败" });
    }
    if (path === "/api/login" && req.method === "POST") {
      const addr = context.clientAddress;
      const a = attempts.get(addr) || { n: 0, until: Date.now() + 60000 };
      if (a.until < Date.now()) {
        a.n = 0;
        a.until = Date.now() + 60000;
      }
      attempts.set(addr, a);
      if (++a.n > 12) {
        await audit(context, path, { outcome: "rate_limited" });
        return json(res, 429, { error: "尝试过于频繁，请稍后重试" });
      }
      let b;
      try {
        b = await body(req);
      } catch (error) {
        await audit(context, path, { outcome: "invalid_request" });
        throw error;
      }
      if (typeof b.key !== "string" || !same(b.key, accessKey)) {
        await audit(context, path, { outcome: "invalid_key" });
        return json(res, 401, { error: "访问密钥不正确" });
      }
      await audit(context, path, { outcome: "success" });
      attempts.delete(addr);
      const token = randomBytes(32).toString("base64url");
      browsers.set(token, { expires: Date.now() + 12 * 3600000 });
      const secure = context.secure ? "; Secure" : "";
      res.setHeader(
        "Set-Cookie",
        `codex_web=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`,
      );
      return json(res, 200, { ok: true });
    }
    if (path === "/api/auth" && req.method === "GET")
      return json(res, 200, { authenticated: !!session(req) });
    if (path.startsWith("/api/") && !session(req))
      return json(res, 401, { error: "请先输入本机访问密钥" });
    if (path.startsWith("/api/") && !initialized)
      return json(res, 503, { error: "工作台正在初始化，请稍后重试" });
    if (path === "/api/logout" && req.method === "POST") {
      const token = (req.headers.cookie || "").match(/codex_web=([^;]+)/)?.[1];
      const s = browsers.get(token);
      browsers.delete(token);
      for (const stream of streams) if (stream.auth === s) stream.res.end();
      res.setHeader(
        "Set-Cookie",
        `codex_web=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${context.secure ? "; Secure" : ""}`,
      );
      await audit(context, path, { outcome: "success" });
      return json(res, 200, { ok: true });
    }
    if (path === "/api/snapshot" && req.method === "GET")
      return json(res, 200, hub.snapshot());
    if (path === "/api/events" && req.method === "GET") {
      if (
        streams.size >= 128 ||
        [...streams].filter((s) => s.auth === session(req)).length >= 4
      )
        return json(res, 429, { error: "实时连接数量已达上限" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("event: change\ndata: {}\n\n");
      const stream = { res, auth: session(req) };
      streams.add(stream);
      req.on("close", () => streams.delete(stream));
      return;
    }
    if (path === "/api/detail" && req.method === "GET")
      return json(res, 200, await hub.detail(url.searchParams.get("key")));
    if (path === "/api/models" && req.method === "GET")
      return json(
        res,
        200,
        await hub.models(
          url.searchParams.get("profile"),
          url.searchParams.get("cwd"),
        ),
      );
    if (req.method === "POST") {
      const b = await body(req);
      await audit(context, path, {
        requestId: typeof b.id === "string" ? b.id.slice(0, 120) : undefined,
      });
      let result;
      if (path === "/api/command")
        result = await hub.command(b.key, b.text, b.mode, b.id);
      else if (path === "/api/cancel") result = await hub.cancel(b.id);
      else if (path === "/api/interrupt") result = await hub.interrupt(b.key);
      else if (path === "/api/reply") result = await hub.reply(b.id, b);
      else if (path === "/api/create")
        result = await hub.create(b.profile, b.cwd, {
          model: b.model,
          effort: b.effort,
        });
      else if (path === "/api/trash") result = await hub.trash(b.key);
      else if (path === "/api/restore") result = await hub.restore(b.key);
      else if (path === "/api/reviewed") result = await hub.reviewed(b.key);
      else return json(res, 404, { error: "接口不存在" });
      return json(res, 200, result || { ok: true });
    }
    if (req.method === "GET" && assets.has(path)) {
      const [name, type] = assets.get(path);
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
      return res.end(await readFile(join(ROOT, "public", name)));
    }
    json(res, 404, { error: "页面不存在" });
  } catch (error) {
    const status =
      {
        NOT_FOUND: 404,
        CONFLICT: 409,
        INVALID: 400,
        UNAVAILABLE: 503,
        UNSUPPORTED: 422,
      }[error.code] || 500;
    json(res, status, {
      error: error.message,
      code: error.code,
      uncertain: !!error.uncertain,
    });
  }
});
let notifyTimer;
let changes = new ChangeBatch();
hub.on("change", (change) => {
  changes.add(change);
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const payload = `event: change\ndata: ${JSON.stringify(changes.take())}\n\n`;
    changes = new ChangeBatch();
    for (const s of streams) {
      if (s.auth.expires < Date.now() || s.res.writableLength > 256 * 1024)
        s.res.end();
      else s.res.write(payload);
    }
  }, 250);
});
server.requestTimeout = 45000;
// Acquire the listening port before reading/recovering the command ledger, so
// an accidental second launch on the same port cannot alter in-flight writes.
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, HOST, resolve);
});
await store.load();
console.log(
  `Codex Web: http://${HOST}:${server.address().port}\n访问密钥文件：${join(DATA, "access-key")}\n按 Ctrl+C 停止工作台；已有 Codex 会话继续运行。`,
);
async function refresh() {
  try {
    await hub.refresh();
  } catch (e) {
    hub.errors = ["扫描暂不可用：" + e.message];
    hub.emit("change");
  }
}
await refresh();
initialized = true;
const timer = setInterval(refresh, 4000);
const heartbeat = setInterval(() => {
  for (const s of streams) {
    if (s.auth.expires < Date.now()) s.res.end();
    else s.res.write(": heartbeat\n\n");
  }
  for (const [key, value] of browsers)
    if (value.expires < Date.now()) browsers.delete(key);
  for (const [key, value] of attempts)
    if (value.until < Date.now()) attempts.delete(key);
}, 20000);
function stop() {
  clearInterval(timer);
  clearInterval(heartbeat);
  clearTimeout(notifyTimer);
  for (const s of streams) s.res.end();
  hub.close();
  server.close();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
