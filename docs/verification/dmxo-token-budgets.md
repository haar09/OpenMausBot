# Delegation and tool budgets

The deployment enables lifetime limits in `config.json`:

```json
{
  "coordination": { "depth": 2, "totalRequests": 12, "totalExecutions": 32 },
  "loopGuard": { "enabled": true, "steerAt": 2, "stopAt": 3, "correctiveRounds": 1, "maxToolCalls": 60 },
  "context": { "autoCompact": true, "compactAt": 100000 }
}
```

Coordination settings are read at startup and require a server restart. The
request budget counts every child under a root, including completed children.
Executions include resumes and restarts. Duplicate dispatch lookups do not count
again. A new user request creates a fresh root. A worker stopped for a budget
cannot be reissued under the same root, including after restart.

`maxToolCalls` is a cooperative, engine-independent stop after completed tool
calls. Calls already in flight may finish. It is not an authorization check or
a hard billing cap. It ignores stale/duplicate events and defers while waiting
on a person or computer. Identical failure stopping remains a separate guard.

Run the tests against disposable fixture data:

```sh
node node_modules/vitest/vitest.mjs run server/runtime/runtime.test.ts server/runtime-coordinator.test.ts server/runtime-coordination.e2e.test.ts server/host/turn-budget.test.ts server/host/loop-guard.test.ts server/turn-budget.e2e.test.ts
node node_modules/vitest/vitest.mjs run server/drivers/openai-chat-tools.test.ts server/drivers/openai-responses.test.ts server/usage-ledger-api.test.ts
node node_modules/vitest/vitest.mjs run server/dmxo/planner-workers.e2e.test.ts server/dmxo/monitor-profile.test.ts server/dmxo/monitor-profile.e2e.test.ts
```

The fixture evidence includes actions and resulting messages, budget refusals,
two simultaneous Sonnet workers, one Opus resume, and fresh monitoring runs.
Monitoring still uses a model. Its profile reduces effort, output, repeated
lookups and delegation; it is not a model-free AWS/PostHog collector. Incomplete
source reads remain visible. Provider-specific live cost savings require later
usage observation and cannot be inferred from fake-provider tests.

Chat and Responses usage preserve cached input when all model rounds report it.
If any round omits it, the aggregate stays unknown. Cached input is part of input,
not an additional amount. Unknown model prices stay unpriced.
