import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { openSse } from "../testing/sse.ts";

it("completes sixty-five successful tool calls with the original loop guard settings", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_TOOL_CALLS: JSON.stringify(Array.from({ length: 65 }, (_, index) =>
    ({ name: "Bash", input: { command: `echo fixture-check-${index}` }, ok: true, output: `check-${index}-passed` }))) });
  const stream = await openSse(`${fixture.info.url}/api/events`, { origin: fixture.info.url });
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const response = await fetch(`${fixture.info.url}/api/config`, { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ loopGuard: { enabled: true, correctiveRounds: 2 } }) });
    expect(response.ok).toBe(true);
    const { bot } = await control("new-bot", "--name", "Long legitimate task");
    await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Complete all fixture checks.");
    const end = await stream.until(frame => frame.kind === "runtime" && frame.event?.threadId === bot.activeTaskId && frame.event.type === "turn.completed", 60_000);
    expect(end.event.ok).toBe(true);
    expect(stream.frames.filter(frame => frame.kind === "runtime" && frame.event?.threadId === bot.activeTaskId &&
      frame.event.type === "item.completed" && frame.event.itemType === "tool")).toHaveLength(65);
    expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
  } finally { stream.close(); await fixture.close(); }
}, 90_000);
