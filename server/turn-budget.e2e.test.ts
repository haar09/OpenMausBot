import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { failedTurnCause } from "../shared/failed-turn.ts";
import { openSse } from "./testing/sse.ts";

it("stops a native engine's successful tool loop only when its tool budget is enabled", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-turn-budget-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_MODE: "slow",
    FAKE_CLAUDE_SLOW_FINISH_GATE: gate,
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ name: "Bash", input: { command: `echo ${i}` }, ok: true, output: String(i) }))),
  }).catch((error) => {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  });
  const stream = await openSse(`${fixture.info.url}/api/events`, { origin: fixture.info.url });
  const actions: unknown[] = [];
  const control = (args: string[]) => {
    const command = [...args, "--url", fixture.info.url];
    actions.push({ command });
    return runControlOmb(command) as Promise<any>;
  };
  const api = async (method: string, path: string, body?: unknown) => {
    actions.push({ method, path, body });
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const ended = (threadId: string) => stream.until((frame) => frame.kind === "runtime" && frame.event?.threadId === threadId && frame.event.type === "turn.completed", 60_000);
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
  try {
    await api("PATCH", "/api/config", { loopGuard: { enabled: false, maxToolCalls: 3 } });
    const { bot: off } = await control(["new-bot", "--name", "Unbounded fixture"]);
    expect((await control(["send", "--bot", off.id, "--task", off.activeTaskId, "--text", "Perform the six fixture checks"])).success).toBe(true);
    await stream.until(() => stream.frames.filter((frame) => frame.kind === "runtime" && frame.event?.threadId === off.activeTaskId && frame.event.type === "item.completed" && frame.event.itemType === "tool").length >= 6, 60_000);
    writeFileSync(gate, "finish");
    expect((await ended(off.activeTaskId)).event.ok).toBe(true);
    expect((await messages(off.activeTaskId)).some((message) => failedTurnCause(message.tool?.name ?? "") !== null)).toBe(false);
    rmSync(gate);

    await api("PATCH", "/api/config", { loopGuard: { enabled: true } });
    const { bot: limited } = await control(["new-bot", "--name", "Bounded fixture"]);
    expect((await control(["send", "--bot", limited.id, "--task", limited.activeTaskId, "--text", "Perform the six fixture checks"])).success).toBe(true);
    expect((await ended(limited.activeTaskId)).event.ok).toBe(false);
    const cause = "Stopped after 3 tool calls in this turn. Completed calls already ran; continue only the unfinished work.";
    await stream.until((frame) => frame.kind === "message" && frame.threadId === limited.activeTaskId && failedTurnCause(frame.message?.tool?.name ?? "") === cause, 60_000);
    const result = await messages(limited.activeTaskId);
    expect(result.filter((message) => failedTurnCause(message.tool?.name ?? "") === cause)).toHaveLength(1);
    expect(result.find((message) => message.role === "user")?.requestCancelled).toBe(true);
    const wait = await control(["wait", "--bot", limited.id, "--task", limited.activeTaskId, "--timeout", "30"]);
    expect((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === limited.id).busy).toBe(false);
    expect(stream.frames.filter((frame) => frame.kind === "runtime" && frame.event?.threadId === limited.activeTaskId && frame.event.type === "turn.started")).toHaveLength(1);
    const db = new DatabaseSync(join(fixture.info.dataDir, "runtime.db"), { readOnly: true });
    let assignments: unknown[];
    try {
      assignments = db.prepare("SELECT json FROM assignments WHERE assignee_thread_id = ?").all(limited.activeTaskId).map((row) => JSON.parse(String(row.json)));
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({ status: "failed", outcome: "budget", reportedAt: expect.any(Number) });
    } finally {
      db.close();
    }
    const evidence = `${fixture.info.logPath}.turn-budget.json`;
    writeFileSync(evidence, JSON.stringify({ fixture: fixture.info, actions, wait, messages: result, assignments }, null, 2));
    console.info(evidence);
  } finally {
    stream.close();
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);
