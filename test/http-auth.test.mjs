import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test(
  "isolated HTTP server audits authentication, clears HTTPS cookies, closes logout streams and serves local renderer assets",
  { timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-web-http-"));
    const key = "fixture-only-access-key";
    await writeFile(join(dir, "access-key"), key, { mode: 0o600 });
    const child = spawn(process.execPath, ["server/index.mjs"], {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "0",
        CODEX_WEB_DATA_DIR: dir,
        PUBLIC_ORIGIN: "https://workbench.example",
        TRUST_LOOPBACK_PROXY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const ready = new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/Codex Web: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]);
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.once("exit", (code) =>
        reject(new Error(`HTTP child exited ${code}: ${output}`)),
      );
    });
    try {
      const base = await ready;
      const headers = {
        host: "workbench.example",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "192.0.2.10",
        "content-type": "application/json",
        "x-codex-web": "1",
      };
      const post = (path, data, extra = {}) =>
        fetch(base + path, {
          method: "POST",
          headers: { ...headers, ...extra },
          body: JSON.stringify(data),
        });
      assert.equal((await post("/api/login", null)).status, 400);
      assert.equal(
        (await post("/api/login", { key: "invalid", password: "NEVER_LOG" }))
          .status,
        401,
      );
      assert.equal(
        (await post("/api/login", { key: { not: "a string" } })).status,
        401,
      );
      const login = await post("/api/login", { key });
      assert.equal(login.status, 200);
      const cookieHeader = login.headers.get("set-cookie");
      assert.match(cookieHeader, /; Secure/);
      const cookie = cookieHeader.split(";")[0];
      let snapshot;
      for (let i = 0; i < 100; i++) {
        const response = await fetch(base + "/api/snapshot", {
          headers: { ...headers, cookie },
        });
        if (response.ok) {
          snapshot = await response.json();
          break;
        }
        assert.equal(response.status, 503);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(snapshot);
      for (const path of [
        "/render.js",
        "/vendor/marked.js",
        "/vendor/purify.js",
        "/vendor/highlight.js",
      ]) {
        const asset = await fetch(base + path);
        assert.equal(asset.status, 200);
        assert.match(asset.headers.get("content-type"), /javascript/);
        await asset.arrayBuffer();
      }
      const stream = await fetch(base + "/api/events", {
        headers: { ...headers, cookie },
      });
      const reader = stream.body.getReader();
      await reader.read();
      const logout = await post("/api/logout", {}, { cookie });
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get("set-cookie"), /Max-Age=0; Secure/);
      while (!(await reader.read()).done) {
        /* The final pending change may precede EOF. */
      }
      const auth = await fetch(base + "/api/auth", {
        headers: { ...headers, cookie },
      });
      assert.equal((await auth.json()).authenticated, false);
      const lan = await fetch(base + "/api/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-web": "1" },
        body: JSON.stringify({ key }),
      });
      assert.equal(lan.status, 200);
      assert.doesNotMatch(lan.headers.get("set-cookie"), /; Secure/);
      for (let i = 0; i < 13; i++) {
        const response = await post(
          "/api/login",
          { key: "bad" },
          { "x-forwarded-for": "192.0.2.99" },
        );
        assert.equal(response.status, i < 12 ? 401 : 429);
      }
      const audit = await readFile(join(dir, "audit.jsonl"), "utf8");
      const events = audit.trim().split("\n").map(JSON.parse);
      assert.ok(events.some((e) => e.outcome === "invalid_request"));
      assert.ok(
        events.some(
          (e) =>
            e.outcome === "rate_limited" && e.clientAddress === "192.0.2.99",
        ),
      );
      assert.ok(
        events.some(
          (e) => e.action === "/api/logout" && e.outcome === "success",
        ),
      );
      assert.ok(
        events.some(
          (e) => e.action === "/api/login" && e.outcome === "success",
        ),
      );
      assert.ok(
        !audit.includes(key) &&
          !audit.includes("NEVER_LOG") &&
          !audit.includes(cookie),
      );
    } finally {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await once(child, "exit");
      clearTimeout(timer);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
