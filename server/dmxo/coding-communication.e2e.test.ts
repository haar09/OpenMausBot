import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { request } from "../../scripts/mcp-server.ts";
import { codingPlannerPatch, codingWorkerPatch } from "./coding-team.ts";

async function fixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path,
    body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const planner = (await cli("new-bot", "--name", "Kod Geliştirici")).bot;
    const workers = await Promise.all([0, 1].map(async index => (await cli("new-bot", "--name", `Worker ${index + 1}`)).bot));
    const expert = (await cli("new-bot", "--name", "QA expert")).bot;
    await api(`/api/bots/${planner.id}`, { ...codingPlannerPatch(workers.map(w => w.id)), computer: "off" }, "PATCH");
    for (const [index, worker] of workers.entries()) await api(`/api/bots/${worker.id}`,
      { ...codingWorkerPatch(index as 0 | 1), computer: "off" }, "PATCH");
    const planPath = join(session.info.dataDir, "room-plan.json");
    const rows = () => {
      const db = new DatabaseSync(join(session.info.dataDir, "runtime.db"), { readOnly: true });
      try { return db.prepare("SELECT json FROM assignments ORDER BY created_at, id").all().map(r => JSON.parse(String(r.json))); }
      finally { db.close(); }
    };
    const turns = () => readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
    const start = async (plan: unknown) => {
      writeFileSync(planPath, JSON.stringify(plan));
      await cli("send", "--bot", planner.id, "--task", planner.activeTaskId, "--text", "Implement and verify the requested fixture work.");
    };
    await test({ planner, workers, expert, api, cli, rows, turns, start, session });
  } finally { await session.close(); }
}

it("lets a worker consult QA and return its implementation automatically without reopening work at the planner", () => fixture(async f => {
  const worker = f.workers[0];
  const dispatch = { arguments: { bot_ids: [worker.id], message: "Implement the fixture module with the QA specialist's advice." } };
  await f.start({
    [f.planner.id]: { steps: [dispatch, dispatch], reply: "Implementation assigned", resumeReply: "Implementation reviewed; complete." },
    [worker.id]: {
      steps: [
        { arguments: { bot_ids: [f.planner.id], message: "Reopen my implementation at the planner" }, expectError: true },
        { arguments: { bot_ids: [f.expert.id], message: "Which fixture invariant should the implementation satisfy?", consult: true } },
      ], reply: "Waiting for the specialist's answer", resumeReply: "Implemented the invariant and verified the result.",
    },
    [f.expert.id]: { reply: "The fixture must preserve the input order; advice only, no implementation performed." },
  });
  await expect.poll(() => f.rows().length === 3 && f.rows().every((r: any) => r.status === "completed"), { timeout: 45_000 }).toBe(true);
  const rows = f.rows();
  expect(rows.filter((r: any) => r.mode === "consult")).toHaveLength(1);
  expect(rows.filter((r: any) => r.parentId && r.assignee.botId === f.planner.id)).toHaveLength(0);
  expect(f.turns().filter((t: any) => t.botId === worker.id)).toHaveLength(2);
  expect(f.turns().filter((t: any) => t.botId === f.planner.id)).toHaveLength(2);
  const messages = (await f.api(`/api/threads/${f.planner.activeTaskId}/messages`)).messages;
  expect(messages.filter((m: any) => m.text === "Implementation reviewed; complete.")).toHaveLength(1);
  writeFileSync(`${f.session.info.logPath}.communication.json`, JSON.stringify({ rows, turns: f.turns(), messages }, null, 2));
}), 90_000);

it("finishes necessary corrective work beyond twelve assignments and thirty-two turns without an added lifetime cap", () => fixture(async f => {
  const worker = f.workers[0];
  const rounds = 17;
  await f.start({
    [f.planner.id]: { turns: [
      ...Array.from({ length: rounds }, (_, i) => ({
        steps: [{ arguments: { bot_ids: [worker.id], message: `Implement fixture acceptance criterion ${i + 1}.`, ...(i ? { rework: true } : {}) } }],
        reply: `Criterion ${i + 1} assigned with concrete new evidence`,
      })),
      { reply: "All seventeen acceptance criteria verified; complete." },
    ] },
    [worker.id]: { turns: Array.from({ length: rounds }, (_, i) => ({ reply: `Criterion ${i + 1} implemented and verified.` })) },
  });
  await expect.poll(() => f.rows().length === rounds + 1 && f.rows().every((r: any) => r.status === "completed"), { timeout: 90_000 }).toBe(true);
  expect(f.rows().filter((r: any) => r.parentId)).toHaveLength(rounds);
  expect(f.turns()).toHaveLength(35);
  expect(f.rows().some((r: any) => r.outcome === "budget")).toBe(false);
  const messages = (await f.api(`/api/threads/${f.planner.activeTaskId}/messages`)).messages;
  expect(messages.filter((m: any) => m.text === "All seventeen acceptance criteria verified; complete.")).toHaveLength(1);
  writeFileSync(`${f.session.info.logPath}.continued-work.json`, JSON.stringify({ rows: f.rows(), turns: f.turns(), messages }, null, 2));
}), 120_000);
