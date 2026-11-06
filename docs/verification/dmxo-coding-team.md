# Opus planner with two Sonnet workers

Run the isolated workflow check:

```sh
node node_modules/vitest/vitest.mjs run server/dmxo/planner-workers.e2e.test.ts
```

It uses `launchVerificationServer` and the repository's scripted Claude CLI.
The actual server, model selection, injected agents MCP server, peer checks,
assignment runtime, private task folders, and automatic result delivery run.
No live provider account or user's workspace is loaded.

The test creates an Opus planner and two Sonnet workers using the profiles in
`server/dmxo/coding-team.ts`. The planner addresses each worker directly with
`coordinate_bots`, with no `group_id`. Room recipients run sequentially, so a
shared room is not the parallel implementation path. Each worker is held by a
separate fixture gate; both must be running before either is released. Their
working directories and files must be distinct.

Profiles preserve existing communication permissions. A worker can consult a
specialist with `consult: true`. The test rejects work sent back to the requesting
planner using the existing ancestor-cycle rule, rather than blocking all worker
communications. The planner retries an identical request; only two implementation
assignments exist. Finishing both workers yields one combined review.

`coding-communication.e2e.test.ts` additionally verifies consultation, automatic
result delivery, and useful corrective work beyond the withdrawn 12-assignment /
32-turn limits. `unrestricted-tools.e2e.test.ts` completes 65 successful tools.

The retained `*.coding-team.json` file next to the server log records the send,
wait, messages, assignment states, models and isolated workspace paths. The
launcher removes only its fixture data when the check ends.

For an existing workspace, preserve the coding bot's ID, name, conversations,
approval settings and computer configuration. New workers need the selected
engine already connected and their own working environment. Apply the helper's
model and role fields through the bot API; preserve relevant existing safety
instructions with the helper's `preservedInstructions` argument. The helpers
do not widen execution permissions or copy credentials. `keepThreadModels`
preserves explicit model selections on existing conversations; inspect those
separately if the user also wants old conversations migrated.

The fake provider proves routing and coordination behavior, not a real model's
plan quality, coding quality, credential health, throughput or cost savings.
The planner's instruction to delegate implementation is a role instruction;
existing duplicate and ancestor-cycle protections are server-enforced. Test real coding quality on an
isolated repository and compare completed work, checks, token use and elapsed
time before attributing any savings to this setup.
