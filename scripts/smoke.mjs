import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { CodexRpc } from "../server/rpc.mjs";

// Explicit integration check: creates dedicated threads, asks for a fixed
// no-tool reply, and archives only those threads after completion.
const cwd = resolve(".local/smoke-workspace");
await mkdir(cwd, { recursive: true });
const results = [];
for (const profile of ["codex", "codex1", "codex2"]) {
  const home = join(homedir(), "." + profile);
  const rpc = new CodexRpc({
    socket: join(home, "app-server-control/app-server-control.sock"),
    home,
  });
  const result = { profile, startedAt: new Date().toISOString() };
  let id;
  try {
    await rpc.connect();
    const { thread } = await rpc.request(
      "thread/start",
      { cwd },
      { write: true },
    );
    id = thread.id;
    result.threadId = id;
    await rpc.request(
      "thread/name/set",
      { threadId: id, name: "[codex-web 自检] 最小回复测试" },
      { write: true },
    );
    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("120 秒内没有收到轮次结束事件")),
        120000,
      );
      rpc.on("notification", (m) => {
        if (m.params?.threadId !== id) return;
        if (
          m.method === "item/completed" &&
          m.params.item.type === "agentMessage"
        )
          result.reply = m.params.item.text;
        if (m.method === "turn/completed") {
          clearTimeout(timer);
          result.status = m.params.turn.status;
          resolve();
        }
      });
      rpc.on("disconnect", () => {
        clearTimeout(timer);
        reject(new Error("连接中断，结果未知"));
      });
    });
    const started = await rpc.request(
      "turn/start",
      {
        threadId: id,
        clientUserMessageId: randomUUID(),
        input: [
          {
            type: "text",
            text: "这是 codex-web 的最小连通性测试。不要读写文件，不要调用任何工具，不要执行命令。只回复一行：CODEX_WEB_SMOKE_OK",
            text_elements: [],
          },
        ],
      },
      { write: true },
    );
    result.turnId = started.turn.id;
    await completion;
    result.pass =
      result.status === "completed" &&
      result.reply?.trim() === "CODEX_WEB_SMOKE_OK";
    if (result.status !== "inProgress") {
      await rpc.request("thread/archive", { threadId: id }, { write: true });
      result.archived = true;
    }
  } catch (e) {
    result.error = e.message;
    result.pass = false;
  } finally {
    rpc.close();
  }
  results.push(result);
  console.log(JSON.stringify(result));
}
await writeFile(
  ".local/checks/smoke.json",
  JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
);
if (results.some((r) => !r.pass)) process.exitCode = 1;
