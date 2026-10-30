// Official items replace the same turns in the rollout, never equal text in
// unrelated turns. Legacy records without identity use ordered boundary overlap.
export function mergeTurnMessages(local, turns) {
  const ordered = turns.slice().reverse();
  const ids = new Set(
    ordered
      .filter((t) =>
        t.items.some((it) => ["userMessage", "agentMessage"].includes(it.type)),
      )
      .map((t) => t.id),
  );
  const remote = ordered.flatMap((turn) =>
    turn.items
      .filter((it) => ["userMessage", "agentMessage"].includes(it.type))
      .map((it) => ({
        turnId: turn.id,
        itemId: it.id,
        role: it.type === "userMessage" ? "user" : "assistant",
        text: it.text,
        phase: it.phase,
        time:
          turn.completedAt || turn.startedAt
            ? new Date(
                (turn.completedAt || turn.startedAt) * 1000,
              ).toISOString()
            : null,
      })),
  );
  if (!remote.length) return local.slice();
  const first = local.findIndex((m) => ids.has(m.turnId));
  if (first >= 0)
    return [
      ...local.slice(0, first),
      ...remote,
      ...local.slice(first).filter((m) => !ids.has(m.turnId)),
    ];
  let overlap = Math.min(local.length, remote.length);
  for (; overlap > 0; overlap--) {
    if (
      local
        .slice(-overlap)
        .every(
          (m, i) =>
            !m.turnId && m.role === remote[i].role && m.text === remote[i].text,
        )
    )
      break;
  }
  return [...local.slice(0, local.length - overlap), ...remote];
}
