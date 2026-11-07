import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { openSse } from "../testing/sse.ts";
import { withWorkingEnvironmentGuidance, WORKING_ENVIRONMENT_GUIDANCE } from "./working-environment.ts";

it("updates future turn guidance while preserving the running turn, operator instructions and access settings", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-working-env-"));
  const gate = join(scratch, "finish-current-turn");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const stream = await openSse(`${fixture.info.url}/api/events`, { origin: fixture.info.url });
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = async (path: string, body?: unknown, method = "GET") => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);return result;
  };
  try {
    const { bot } = await cli("new-bot", "--name", "Environment fixture");
    await api(`/api/bots/${bot.id}`, { soul: "Keep the operator's existing project permissions.", computer: "off" }, "PATCH");
    const original = (await api("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Complete the existing fixture task.");
    await stream.until(frame => frame.kind === "runtime" && frame.event?.threadId === bot.activeTaskId && frame.event.type === "turn.started", 20_000);
    const soul = withWorkingEnvironmentGuidance(original.soul);
    expect(withWorkingEnvironmentGuidance(soul)).toBe(soul);
    await api(`/api/bots/${bot.id}`, { soul }, "PATCH");
    const changed = (await api("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
    expect(changed.busy).toBe(true);
    for (const key of ["computer", "modelSelection", "peers", "approvalMode", "toolScope", "mcpServers"]) expect(changed[key]).toEqual(original[key]);
    writeFileSync(gate, "finish");
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Continue with the fixture guidance.");
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(dump.systemPrompt).toContain(WORKING_ENVIRONMENT_GUIDANCE);
    expect(dump.systemPrompt).toContain("Keep the operator's existing project permissions.");
    const ends = stream.frames.filter(frame => frame.kind === "runtime" && frame.event?.threadId === bot.activeTaskId && frame.event.type === "turn.completed");
    expect(ends).toHaveLength(2);
    expect(ends.every(frame => frame.event.ok)).toBe(true);
  } finally { writeFileSync(gate, "finish");stream.close();await fixture.close();rmSync(scratch, { recursive: true, force: true }); }
}, 90_000);
