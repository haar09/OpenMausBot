import { admit } from "../admission.ts";
import type { AppConfig } from "../config.ts";
import type { ProviderAdapter } from "../contracts.ts";
import type { LiveTurns } from "../live-turns.ts";
import type { RoutineManager } from "../routines.ts";
import type { Store } from "../store.ts";
import type { TurnStops } from "../turn-outcome.ts";
import type { TurnWatchdog } from "../turn-watchdog.ts";
import { createLoopGuard, loopGuardSettings } from "./loop-guard.ts";
import { createTurnBudget } from "./turn-budget.ts";

export interface ExecutionGuardsDeps {
  store: Pick<Store, "botByThread" | "appendMessage" | "activePath">;
  config(): Pick<AppConfig, "loopGuard">;
  engine(threadId: string): ProviderAdapter | undefined;
  pendingComputerSelection(threadId: string): boolean;
  threadBusy(botId: string, threadId: string): boolean;
  watchdog: Pick<TurnWatchdog, "waiting">;
  turnStops: Pick<TurnStops, "stopping">;
  liveTurnByThread: ReadonlyMap<string, string>;
  liveTurns: Pick<LiveTurns, "running">;
  routines(): Pick<RoutineManager, "failThread"> | null | undefined;
  interruptDirectThread(botId: string, threadId: string, cause?: string, outcome?: "stopped" | "budget"): Promise<void>;
}

export function createExecutionGuards(deps: ExecutionGuardsDeps) {
  const { store, threadBusy, watchdog, turnStops, liveTurnByThread, liveTurns, interruptDirectThread } = deps;
  const canSteerThread = (threadId: string) => {
    const engine = deps.engine(threadId);
    return admit("direct-busy", { pendingComputerSelection: deps.pendingComputerSelection(threadId),
      engineCanSteer: Boolean(engine?.capabilities.queueing && engine.steer) }).action === "steer";
  };
  const steerThread = async (threadId: string, text: string) => (await deps.engine(threadId)?.steer?.(threadId, text)) ?? "refused";
  const repeats = createLoopGuard({
    settings: () => loopGuardSettings(deps.config()),
    append: (threadId, tool) => void store.appendMessage(threadId, { role: "bot", kind: "activity", tool }),
    live: (threadId) => { const bot = store.botByThread(threadId); return Boolean(bot && threadBusy(bot.id, threadId)); },
    waiting: (threadId) => watchdog.waiting(threadId),
    canSteer: canSteerThread, steer: steerThread,
    interrupt: async (threadId, cause) => {
      const bot = store.botByThread(threadId);
      if (!bot) return;
      turnStops.stopping(threadId, liveTurnByThread.get(threadId), cause);
      deps.routines()?.failThread(threadId, `${cause.charAt(0).toUpperCase()}${cause.slice(1)}`, { cause: "cap" });
      await interruptDirectThread(bot.id, threadId, cause);
    },
  });
  const turnBudget = createTurnBudget({
    settings: () => ({ enabled: loopGuardSettings(deps.config()).enabled, maxToolCalls: deps.config().loopGuard?.maxToolCalls }),
    live: (threadId, turnId) => {
      const bot = store.botByThread(threadId);
      return liveTurns.running(threadId) === turnId && Boolean(bot && threadBusy(bot.id, threadId));
    },
    waiting: (threadId) => watchdog.waiting(threadId),
    append: (threadId, tool) => {
      const last = store.activePath(threadId).at(-1);
      if (last?.role === "bot" && last.kind === "activity" && last.tool?.name === tool.name) return;
      store.appendMessage(threadId, { role: "bot", kind: "activity", tool });
    },
    interrupt: async (threadId, cause) => {
      const bot = store.botByThread(threadId);
      if (!bot) return;
      turnStops.stopping(threadId, liveTurnByThread.get(threadId), cause);
      deps.routines()?.failThread(threadId, cause, { cause: "cap" });
      await interruptDirectThread(bot.id, threadId, cause, "budget");
    },
  });
  return { repeats, turnBudget, canSteerThread, steerThread };
}
