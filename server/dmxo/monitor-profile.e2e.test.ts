import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import type { Routine, RoutineRun } from "../routines.ts";
import { splitLaunchNote } from "../testing/launch-note.ts";
import { MONITOR_TOOL_GUIDANCE, monitorBotPatch, monitorRoutinePatch } from "./monitor-profile.ts";

it("applies the monitor patches through the real API, uses fresh bounded continuity, and keeps partial checks visible", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async <T>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as T;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, result: value });
    return value;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const state = async (id: string) => (await api<{ runs: RoutineRun[] }>("GET", "/api/routines")).runs.find(run => run.id === id);
  try {
    const { bot } = await control(["new-bot", "--name", "Monitor fixture"]) as { bot: { id: string } };
    const { bot: planner } = await control(["new-bot", "--name", "Escalation fixture"]) as { bot: { id: string } };
    await api("PATCH", `/api/bots/${bot.id}`, monitorBotPatch(planner.id, "Fixture sources only; never access production."));
    const schedule = { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 };
    const { routine } = await api<{ routine: Routine }>("POST", "/api/routines", {
      name: "Monitor fixture check", botId: bot.id, prompt: "Original fixture check", enabled: false, schedule,
    }, 201);
    const patch = monitorRoutinePatch({ accountId: "123456789012", region: "eu-central-1", logGroups: ["/fixture/web"] });
    const { routine: saved } = await api<{ routine: Routine }>("PATCH", `/api/routines/${routine.id}`, patch);
    expect(saved).toMatchObject({ id: routine.id, botId: bot.id, enabled: false, continuity: true, prompt: patch.prompt, schedule });
    const longReport = `Previous run: vm_exec failed with No such tool available; do not assume the VM is disconnected now. UTC fixture. AWS fixture group read. PostHog fixture read. Incident fingerprint fixture-one. ${"x".repeat(3000)} NOT_IN_BOUNDED_CARRY`;
    const partialReport = "AWS fixture group read: 0 errors. PostHog access denied; check incomplete.";
    const planPath = join(fixture.info.dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { script: [
      { key: "long-report", match: ["Monitor fixture check"], reply: longReport },
      { key: "partial", match: ["Monitor fixture check"], expectSystemIncludes: [MONITOR_TOOL_GUIDANCE], steps: [{ tool: "list_triggers", arguments: {} }], reply: partialReport },
      { key: "healthy", match: ["Monitor fixture check"], reply: "AWS and PostHog fixture reads complete.\nNOTHING NEW" },
    ] } }));
    const completed: RoutineRun[] = [];
    for (let index = 0; index < 3; index++) {
      const { run } = await api<{ run: RoutineRun }>("POST", `/api/routines/${routine.id}/run`, undefined, 201);
      await expect.poll(async () => (await state(run.id))?.status, { timeout: 30_000 }).toBe("completed");
      await expect.poll(async () => (await state(run.id))?.report?.state, { timeout: 30_000 }).toBe(index === 2 ? "quiet" : "posted");
      const finished = (await state(run.id))!;
      completed.push(finished);
      const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { argv: string[]; prompt: unknown };
      expect(dump.argv).not.toContain("--resume");
      const parsedPrompt = splitLaunchNote(dump.prompt).prompt as { message: { content: string } };
      const prompt = JSON.stringify(parsedPrompt);
      if (index === 1) {
        expect(prompt).toContain("previous-run");
        expect(prompt).toContain(MONITOR_TOOL_GUIDANCE.replaceAll("\n", "\\n"));
        expect(prompt).toContain("fixture-one");
        const carried = /<previous-run[^>]*>\n([\s\S]*?)\n<\/previous-run>/u.exec(parsedPrompt.message.content)?.[1];
        expect(carried).toBeTruthy();
        expect(carried!.length).toBeLessThanOrEqual(2000);
        expect(prompt).not.toContain("NOT_IN_BOUNDED_CARRY");
      }
      evidence.push(await control(["wait", "--bot", bot.id, "--task", finished.threadId!]));
      evidence.push(await control(["messages", "--bot", bot.id, "--task", finished.threadId!, "--limit", "10"]));
    }
    expect(new Set(completed.map(run => run.threadId)).size).toBe(3);
    const turns = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const partialTurn = turns.find(turn => turn.planKey === "partial");
    expect(partialTurn.system).toContain(MONITOR_TOOL_GUIDANCE);
    const catalog = partialTurn.evidence.find((row: any) => row.result?.tools)?.result.tools;
    expect(catalog.map((tool: any) => tool.name)).toContain("vm_exec");
    expect(partialTurn.evidence.find((row: any) => row.step?.tool === "list_triggers").response.result.isError).toBeFalsy();
    const { messages } = await api<{ messages: Array<{ text?: string; automation?: { runId: string } }> }>("GET", `/api/threads/${completed[0]!.resultsThreadId}/messages?limit=100`);
    const reports = messages.filter(message => message.automation);
    expect(reports).toHaveLength(2);
    expect(reports.find(message => message.automation?.runId === completed[1]!.id)?.text).toBe(partialReport);
    expect(reports.some(message => message.automation?.runId === completed[2]!.id)).toBe(false);
    evidence.push({ completed, reports });
  } finally {
    const evidencePath = `${fixture.info.logPath}.monitor-profile.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 120_000);
