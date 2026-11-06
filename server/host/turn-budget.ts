import { failedTurnTool, type FailedTurnTool } from "../../shared/failed-turn.ts";
import type { RuntimeEvent } from "../contracts.ts";

export interface TurnBudgetSettings {
  enabled: boolean;
  maxToolCalls?: number;
}

export interface TurnBudgetDeps {
  settings(): TurnBudgetSettings;
  live(threadId: string, turnId: string): boolean;
  waiting(threadId: string): boolean;
  interrupt(threadId: string, cause: string): Promise<unknown>;
  append(threadId: string, tool: FailedTurnTool): void;
  log?(line: string): void;
}

interface Turn {
  id: string;
  completed: Set<string>;
  stopped: boolean;
}

export function createTurnBudget(deps: TurnBudgetDeps) {
  const turns = new Map<string, Turn>();
  const settle = (threadId: string) => { turns.delete(threadId); };
  const log = (threadId: string, message: string) => deps.log?.(`[turn-budget] thread=${threadId} ${message}`);

  const onEvent = (event: RuntimeEvent) => {
    const { threadId, turnId } = event;
    if (!turnId) return;
    const turn = turns.get(threadId);
    if (event.type === "turn.completed" || event.type === "session.exited") {
      if (turn?.id === turnId) settle(threadId);
      return;
    }
    if (!deps.live(threadId, turnId)) return;
    if (event.type === "turn.started") {
      if (turn?.id !== turnId) turns.set(threadId, { id: turnId, completed: new Set(), stopped: false });
      return;
    }
    if (!turn || turn.id !== turnId || turn.stopped) return;
    const { enabled, maxToolCalls } = deps.settings();
    if (!enabled || maxToolCalls === undefined) {
      turn.completed.clear();
      return;
    }
    if (event.type === "item.completed" && event.itemType === "tool" && event.itemId && turn.completed.size < maxToolCalls) {
      turn.completed.add(event.itemId);
    }
    if (turn.completed.size < maxToolCalls || deps.waiting(threadId)) return;
    turn.stopped = true;
    const cause = `Stopped after ${maxToolCalls} tool calls in this turn. Completed calls already ran; continue only the unfinished work.`;
    try {
      const stopping = deps.interrupt(threadId, cause);
      deps.append(threadId, failedTurnTool(cause));
      log(threadId, `stop sent: tool-calls=${turn.completed.size}`);
      void stopping.catch(() => log(threadId, "stop rejected"));
    } catch {
      log(threadId, "stop not sent");
    }
  };

  return { onEvent, settle };
}
