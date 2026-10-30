import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexRpc } from "../server/rpc.mjs";
import { homedir } from "node:os";

const base = process.env.BASE_URL || "http://127.0.0.1:4317";
const workspace = resolve(".local/smoke-workspace");
await mkdir(workspace, { recursive: true });
const login = await fetch(base + "/api/login", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Codex-Web": "1" },
  body: JSON.stringify({
    key: (await readFile(".local/access-key", "utf8")).trim(),
  }),
});
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("登录失败");
async function api(path, body) {
  const r = await fetch(base + "/api/" + path, {
    headers: { cookie, "Content-Type": "application/json", "X-Codex-Web": "1" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
const { key } = await api("create", { profile: "codex", cwd: workspace });
const prompt = (value) =>
  `这是工作台的接口验收测试。不要调用工具，不要读写文件，不要执行命令。只回复一行：${value}`;
const firstRequest = {
  key,
  id: randomUUID(),
  text: prompt("CODEX_WEB_API_ONE"),
  mode: "next",
};
const first = await api("command", firstRequest);
const duplicate = await api("command", firstRequest);
const second = await api("command", {
  key,
  id: randomUUID(),
  text: prompt("CODEX_WEB_API_TWO"),
  mode: "queue",
});
const result = {
  key,
  first: first.state,
  duplicateSameId: duplicate.id === first.id,
  secondInitial: second.state,
};
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  const d = await api("detail?key=" + encodeURIComponent(key));
  const queued = d.commands.find((c) => c.id === second.id);
  if (["failed", "uncertain"].includes(queued?.state))
    throw new Error(queued.error || queued.state);
  if (
    d.result?.text?.trim() === "CODEX_WEB_API_TWO" &&
    ["completed", "idle"].includes(d.state)
  ) {
    result.pass = true;
    result.finalReply = d.result.text;
    result.secondFinal = queued.state;
    result.commandCount = d.commands.length;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
if (!result.pass) result.error = "没有在时限内收到第二轮最终回复";
if (result.pass) {
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
    result.archived = true;
  } finally {
    rpc.close();
  }
}
await writeFile(
  ".local/checks/api-smoke.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exitCode = 1;
