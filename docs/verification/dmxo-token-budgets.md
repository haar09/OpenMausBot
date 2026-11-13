# Coding coordination and continuity

Delegation uses upstream's progress-based limits and repeat-failure guard. The
custom lifetime-assignment, lifetime-execution and per-turn tool-count caps have
been removed from the implementation and configuration schema.

The production loop guard remains `{ "enabled": true, "correctiveRounds": 2 }`.
Upstream's runtime and provider limits still apply.

A custom reassignment rule remains: a teammate with a recorded budget failure
cannot receive another assignment under the same root request, including rework
from another branch after a restart. Completed work is preserved. A fresh user
request can assign that teammate again.

Communication profiles use the existing runtime protocol:

- Assign work once; finish the dispatching turn and receive the automatic result.
- Consult a specialist with `consult: true`; advice is not completed implementation.
- A blocked worker ends with `NEEDS INPUT:`; the requester answers through
  `coordinate_bots` with `answers` identifying the waiting assignment.
- Return results normally, not as acknowledgements or new assignments back upstream.
- Request concrete corrective work with `rework: true` when evidence requires it;
  there is no one-correction quota.
- Existing ancestor-cycle and duplicate-dispatch protections remain. Communication
  peer allowlists introduced by this deployment are restored to their prior state.

Run the isolated checks:

```sh
node node_modules/vitest/vitest.mjs run server/dmxo/coding-communication.e2e.test.ts server/dmxo/unrestricted-tools.e2e.test.ts server/dmxo/planner-workers.e2e.test.ts server/dmxo/monitor-profile.test.ts server/dmxo/monitor-profile.e2e.test.ts
```

The fixtures prove a worker can consult QA and continue, duplicate dispatch does
not duplicate work, upstream work cycles are refused, two Sonnet workers run in
parallel, 65 successful tools complete, and 17 corrective assignments /35 model
turns complete. They use real API/MCP/runtime paths with fake model providers.
They do not prove that a real model always follows its profile or quantify savings.

Monitoring still uses a model and keeps incomplete source reads visible. It is
not a deterministic model-free collector. API accounting follows upstream drivers.
