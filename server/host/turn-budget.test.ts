import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../contracts.ts";
import { parseConfigPatch, parseStoredConfig } from "../config.ts";
import { createTurnBudget, type TurnBudgetSettings } from "./turn-budget.ts";

function rig() {
  const state = { current: "turn-1", waiting: false, live: true, settings: { enabled: true, maxToolCalls: 2 } as TurnBudgetSettings };
  const interrupt = vi.fn(async () => {});
  const append = vi.fn();
  const log = vi.fn();
  const budget = createTurnBudget({
    settings: () => state.settings,
    live: (_threadId, turnId) => state.live && state.current === turnId,
    waiting: () => state.waiting,
    interrupt, append, log,
  });
  let seq = 0;
  const event = (fields: Partial<RuntimeEvent>, turnId: string | undefined = state.current): RuntimeEvent => ({
    eventId: `event-${++seq}`, provider: "fake", threadId: "thread", createdAt: new Date().toISOString(), turnId,
    type: "turn.started", ...fields,
  } as RuntimeEvent);
  const started = (turnId = state.current) => budget.onEvent(event({ type: "turn.started" }, turnId));
  const completed = (itemId: string, turnId = state.current) => budget.onEvent(event({ type: "item.completed", itemType: "tool", itemId, ok: true }, turnId));
  const delta = () => budget.onEvent(event({ type: "content.delta", streamKind: "assistant_text", delta: "Working" }));
  const ended = (turnId = state.current) => budget.onEvent(event({ type: "turn.completed", ok: true }, turnId));
  started();
  return { state, budget, interrupt, append, log, event, started, completed, delta, ended };
}

describe("turn tool budget", () => {
  it("stops once at the completed-call limit, regardless of tool name or success", () => {
    const r = rig();
    r.completed("first");
    expect(r.interrupt).not.toHaveBeenCalled();
    r.budget.onEvent(r.event({ type: "item.completed", itemType: "tool", itemId: "second", ok: false, output: "secret output" }));
    r.completed("third");
    r.delta();
    expect(r.interrupt).toHaveBeenCalledTimes(1);
    expect(r.append).toHaveBeenCalledTimes(1);
    expect(r.interrupt.mock.calls[0]).toEqual(["thread", expect.stringContaining("after 2 tool calls")]);
    expect(JSON.stringify([r.append.mock.calls, r.log.mock.calls])).not.toContain("secret output");
  });

  it("does not count duplicate receipts, tool starts, model output or token updates", () => {
    const r = rig();
    r.completed("first");
    r.completed("first");
    r.budget.onEvent(r.event({ type: "item.started", itemType: "tool", itemId: "second" }));
    r.budget.onEvent(r.event({ type: "item.completed", itemType: "assistant_text", text: "done", itemId: "answer" }));
    r.budget.onEvent(r.event({ type: "thread.token-usage.updated", input: 100000000, output: 10 }));
    r.delta();
    expect(r.interrupt).not.toHaveBeenCalled();
    r.completed("second");
    expect(r.interrupt).toHaveBeenCalledOnce();
  });

  it("defers the stop while waiting for a person or computer", () => {
    const r = rig();
    r.state.waiting = true;
    r.completed("first");
    r.completed("second");
    r.delta();
    expect(r.interrupt).not.toHaveBeenCalled();
    r.state.waiting = false;
    r.delta();
    expect(r.interrupt).toHaveBeenCalledOnce();
  });

  it("does not stop a settled or no-longer-live turn", () => {
    const r = rig();
    r.completed("first");
    r.state.live = false;
    r.completed("second");
    expect(r.interrupt).not.toHaveBeenCalled();
    r.ended();
    r.state.live = true;
    r.completed("third");
    expect(r.interrupt).not.toHaveBeenCalled();
  });

  it("ignores stale starts, completions and session exits without resetting the new turn", () => {
    const r = rig();
    r.completed("first");
    r.state.current = "turn-2";
    r.started();
    r.completed("new-first");
    r.started("turn-1");
    r.completed("old-second", "turn-1");
    r.ended("turn-1");
    r.budget.onEvent(r.event({ type: "session.exited" }, "turn-1"));
    expect(r.interrupt).not.toHaveBeenCalled();
    r.completed("new-second");
    expect(r.interrupt).toHaveBeenCalledOnce();
  });

  it("does not reset its count for a duplicate turn.started", () => {
    const r = rig();
    r.completed("first");
    r.started();
    r.completed("second");
    expect(r.interrupt).toHaveBeenCalledOnce();
  });

  it("requires identified turns and tool calls", () => {
    const r = rig();
    r.budget.onEvent({ ...r.event({ type: "item.completed", itemType: "tool", itemId: "first", ok: true }), turnId: undefined });
    r.budget.onEvent(r.event({ type: "item.completed", itemType: "tool", ok: true }));
    r.completed("second");
    expect(r.interrupt).not.toHaveBeenCalled();
  });

  it("leaves the limit off unless both enabled and configured", () => {
    const r = rig();
    r.state.settings.enabled = false;
    r.completed("first");
    r.completed("second");
    r.state.settings = { enabled: true };
    r.completed("third");
    r.completed("fourth");
    expect(r.interrupt).not.toHaveBeenCalled();
    r.state.settings.maxToolCalls = 2;
    r.completed("fifth");
    expect(r.interrupt).not.toHaveBeenCalled();
    r.completed("sixth");
    expect(r.interrupt).toHaveBeenCalledOnce();
  });

  it("clears accounting explicitly and starts a fresh turn budget", () => {
    const r = rig();
    r.completed("first");
    r.budget.settle("thread");
    r.completed("second");
    expect(r.interrupt).not.toHaveBeenCalled();
    r.started();
    r.completed("third");
    r.completed("fourth");
    expect(r.interrupt).toHaveBeenCalledOnce();
  });

  it("contains stop failures without a repeated stop loop", async () => {
    const r = rig();
    r.interrupt.mockRejectedValueOnce(new Error("unavailable"));
    r.completed("first");
    r.completed("second");
    await Promise.resolve();
    r.completed("third");
    expect(r.interrupt).toHaveBeenCalledOnce();
    expect(r.log).toHaveBeenCalledWith(expect.stringContaining("stop rejected"));
  });

  it("accepts a bounded tool limit in stored configuration and patches", () => {
    expect(parseConfigPatch({ loopGuard: { enabled: true, maxToolCalls: 80 } })).toEqual({ loopGuard: { enabled: true, maxToolCalls: 80 } });
    expect(parseStoredConfig({ loopGuard: { enabled: true, maxToolCalls: 80 } }).loopGuard?.maxToolCalls).toBe(80);
    for (const maxToolCalls of [0, -1, 1.5, 10001]) {
      expect(() => parseConfigPatch({ loopGuard: { maxToolCalls } })).toThrow();
    }
  });
});
