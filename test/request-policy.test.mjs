import test from "node:test";
import assert from "node:assert/strict";
import { requestPolicy } from "../server/request-policy.mjs";

const make = (headers = {}, peer = "127.0.0.1") => ({
  headers: { host: "codex.example.com", ...headers },
  socket: { remoteAddress: peer },
});
const policy = requestPolicy({
  publicOrigin: "https://codex.example.com",
  trustLoopbackProxy: true,
});
test("trusted HTTPS proxy yields a Secure cookie context and the actual client address", () => {
  const c = policy(
    make({
      origin: "https://codex.example.com",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "203.0.113.8",
    }),
  );
  assert.equal(c.secure, true);
  assert.equal(c.clientAddress, "203.0.113.8");
  assert.equal(c.error, undefined);
});
test("untrusted network clients cannot claim TLS using forwarded headers", () => {
  assert.equal(
    policy(make({ "x-forwarded-proto": "https" }, "192.0.2.5")).status,
    403,
  );
});
test("public deployment rejects a mismatched Host and cross-origin writes", () => {
  assert.equal(
    policy(make({ host: "attacker.example", "x-forwarded-proto": "https" }))
      .status,
    421,
  );
  assert.equal(
    policy(
      make({
        origin: "https://attacker.example",
        "x-forwarded-proto": "https",
      }),
    ).status,
    403,
  );
});
test("loopback diagnostics remain usable without a Secure cookie on HTTP", () => {
  const c = policy(
    make({ host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" }),
  );
  assert.equal(c.secure, false);
  assert.equal(c.error, undefined);
});
test("default LAN mode does not trust forwarded client identity", () => {
  const c = requestPolicy()(
    make(
      {
        host: "10.0.0.204:4317",
        origin: "http://10.0.0.204:4317",
        "x-forwarded-for": "203.0.113.9",
      },
      "10.0.0.6",
    ),
  );
  assert.equal(c.clientAddress, "10.0.0.6");
  assert.equal(c.error, undefined);
});
test("public deployment configuration rejects a non-HTTPS origin", () => {
  assert.throws(
    () => requestPolicy({ publicOrigin: "http://codex.example.com" }),
    /HTTPS/,
  );
});
