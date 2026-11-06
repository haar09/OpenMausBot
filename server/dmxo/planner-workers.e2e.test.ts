import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../../scripts/control-omb.ts";
import { request } from "../../scripts/mcp-server.ts";
import { readHandoffs } from "../testing/handoff-rows.ts";
import { codingPlannerPatch, codingWorkerPatch } from "./coding-team.ts";

it("runs two Sonnet workers concurrently for one Opus plan, forbids cascading, and resumes the planner once", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path,
    body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const evidencePath = `${session.info.logPath}.coding-team.json`;
  try {
    const planner = (await cli("new-bot", "--name", "Kod Geliştirici")).bot;
    const workers = await Promise.all([0, 1].map(async index =>
      (await cli("new-bot", "--name", `Worker ${index + 1}`)).bot));
    for (const [index, worker] of workers.entries()) {
      await api(`/api/bots/${worker.id}`, { ...codingWorkerPatch(index as 0 | 1), computer: "off" }, "PATCH");
    }
    await api(`/api/bots/${planner.id}`, { ...codingPlannerPatch(workers.map(worker => worker.id)), computer: "off" }, "PATCH");
    const planPath = join(session.info.dataDir, "room-plan.json");
    const gates = workers.map((_worker, index) => join(session.info.dataDir, `worker-${index}.gate`));
    const ready = workers.map((_worker, index) => join(session.info.dataDir, `worker-${index}.ready`));
    const dispatch = workers.map((worker, index) => ({ arguments: {
      bot_ids: [worker.id], message: `Implement independent fixture module ${index + 1}; return the passing checks.`,
    } }));
    writeFileSync(planPath, JSON.stringify({
      [planner.id]: { steps: [...dispatch, dispatch[0]], reply: "Two implementation tasks assigned", resumeReply: "Both modules reviewed; checks passed" },
      ...Object.fromEntries(workers.map((worker, index) => [worker.id, {
        steps: [{ arguments: { bot_ids: [workers[1 - index].id], message: "Unwanted worker cascade" }, expectError: true }],
        readyFile: ready[index], gateFile: gates[index], writeFiles: { "worker-output.txt": `module-${index + 1}` },
        reply: `Module ${index + 1} implemented; fixture checks passed`,
      }])),
    }));
    const nodes = () => readHandoffs(session.info.dataDir);
    const evidence = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const sent = await cli("send", "--bot", planner.id, "--task", planner.activeTaskId, "--text", "Plan and implement two independent fixture modules.");
    await expect.poll(() => ready.every(path => existsSync(path)), { timeout: 25_000 }).toBe(true);
    const children = nodes().filter(node => node.parentId);
    expect(children).toHaveLength(2);
    expect(children.every(node => node.status === "running")).toBe(true);
    expect(new Set(children.map(node => node.threadId)).size).toBe(2);
    await expect.poll(() => evidence().filter(turn => turn.botId === planner.id).length, { timeout: 10_000 }).toBe(1);
    const runningBots = (await api("/api/bots")).bots;
    const folders = workers.map(worker => {
      const child = children.find(node => node.botId === worker.id)!;
      return runningBots.find((bot: any) => bot.id === worker.id).tasks.find((task: any) => task.threadId === child.threadId).cwd;
    });
    expect(folders.every(folder => typeof folder === "string" && folder.startsWith(session.info.dataDir))).toBe(true);
    expect(new Set(folders).size).toBe(2);
    expect(folders.map(folder => readFileSync(join(folder, "worker-output.txt"), "utf8"))).toEqual(["module-1", "module-2"]);
    writeFileSync(gates[0]!, "complete first worker");
    await expect.poll(() => nodes().find(node => node.botId === workers[0].id)?.status, { timeout: 15_000 }).toBe("completed");
    expect(evidence().filter(turn => turn.botId === planner.id)).toHaveLength(1);
    writeFileSync(gates[1]!, "complete second worker");
    const waited = await cli("wait", "--bot", planner.id, "--task", planner.activeTaskId, "--timeout", "30");
    expect(waited.status).toBe("settled");
    const messages = await api(`/api/threads/${planner.activeTaskId}/messages`);
    expect(messages.messages.filter((message: any) => message.text === "Both modules reviewed; checks passed")).toHaveLength(1);
    const turns = evidence();
    expect(turns.filter(turn => turn.botId === planner.id)).toHaveLength(2);
    for (const worker of workers) {
      expect(turns.filter(turn => turn.botId === worker.id)).toHaveLength(1);
      expect(turns.find(turn => turn.botId === worker.id).model).toBe("claude-sonnet-5-5");
    }
    expect(turns.filter(turn => turn.botId === planner.id).every(turn => turn.model === "claude-opus-5-5")).toBe(true);
    expect(nodes().filter(node => node.parentId)).toHaveLength(2);
    writeFileSync(evidencePath, JSON.stringify({ logPath: session.info.logPath, url: session.info.url, sent, waited,
      messages, nodes: nodes(), models: turns.map(({ botId, model, threadId }) => ({ botId, model, threadId })),
      parallelWorkers: 2, isolatedWorkspaces: folders, duplicateDispatchesSuppressed: 1, cascadesRefused: 2,
    }, null, 2));
    console.log(`Coding team fixture evidence: ${evidencePath}`);
  } finally {
    await session.close();
  }
}, 90_000);
