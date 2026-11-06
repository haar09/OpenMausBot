import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerArgs, verificationServerEnvironment } from "../../scripts/control-omb.ts";
import { request } from "../../scripts/mcp-server.ts";
import { waitForExit } from "../testing/cleanup.ts";
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

it("lets a monitor routine reach two parallel workers through Senior Planner and Opus at depth three", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path,
    body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const coordination = { depth: 3, totalRequests: 12, totalExecutions: 32 };
  const evidencePath = `${session.info.logPath}.coding-team-depth-three.json`;
  let restarted: ChildProcess | undefined;
  try {
    await api("/api/config", { coordination }, "PATCH");
    await waitForExit(session.child, { signal: "SIGTERM" });
    const env = verificationServerEnvironment(process.env, session.info.dataDir, Number(new URL(session.info.url).port));
    const log = openSync(session.info.logPath, "a", 0o600);
    restarted = spawn(process.execPath, verificationServerArgs(env), {
      cwd: fileURLToPath(new URL("../..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(() => fetch(`${session.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })
      .then(response => response.ok, () => false), { timeout: 30_000 }).toBe(true);
    expect(JSON.parse(readFileSync(join(session.info.dataDir, "config.json"), "utf8")).coordination).toEqual(coordination);
    const monitor = (await cli("new-bot", "--name", "Log Analisti")).bot;
    const senior = (await cli("new-bot", "--name", "Senior Planner")).bot;
    const planner = (await cli("new-bot", "--name", "Kod Geliştirici")).bot;
    const workers = await Promise.all([0, 1].map(async index =>
      (await cli("new-bot", "--name", `Worker ${index + 1}`)).bot));
    await api(`/api/bots/${monitor.id}`, { peers: [senior.id], computer: "off" }, "PATCH");
    await api(`/api/bots/${senior.id}`, { peers: [planner.id], computer: "off" }, "PATCH");
    await api(`/api/bots/${planner.id}`, { ...codingPlannerPatch(workers.map(worker => worker.id)), computer: "off" }, "PATCH");
    for (const [index, worker] of workers.entries()) {
      await api(`/api/bots/${worker.id}`, { ...codingWorkerPatch(index as 0 | 1), computer: "off" }, "PATCH");
    }
    const planPath = join(session.info.dataDir, "room-plan.json");
    const gate = join(session.info.dataDir, "depth-three-workers.gate");
    const ready = workers.map((_worker, index) => join(session.info.dataDir, `depth-three-worker-${index}.ready`));
    writeFileSync(planPath, JSON.stringify({
      [monitor.id]: { steps: [{ arguments: { bot_ids: [senior.id], message: "A new fixture incident needs a scoped code fix." } }],
        reply: "Incident assigned once", resumeReply: "Incident resolved; verified implementation received." },
      [senior.id]: { steps: [{ arguments: { bot_ids: [planner.id], message: "Plan and implement two independent fixture modules." } }],
        reply: "Code plan assigned once", resumeReply: "Scoped implementation verified and returned." },
      [planner.id]: { steps: workers.map((worker, index) => ({ arguments: {
        bot_ids: [worker.id], message: `Implement fixture module ${index + 1} and return its passing checks.`,
      } })), reply: "Two bounded implementation tasks assigned", resumeReply: "Both modules reviewed; checks passed." },
      ...Object.fromEntries(workers.map((worker, index) => [worker.id, {
        readyFile: ready[index], gateFile: gate,
        steps: [{ arguments: { bot_ids: [workers[1 - index].id], message: "Forbidden additional cascade" }, expectError: true }],
        reply: `Fixture module ${index + 1} implemented and verified.`,
      }])),
    }));
    const assignments = (): any[] => {
      const db = new DatabaseSync(join(session.info.dataDir, "runtime.db"), { readOnly: true });
      try { return (db.prepare("SELECT json FROM assignments ORDER BY created_at, id").all() as Array<{ json: string }>).map(row => JSON.parse(row.json)); }
      finally { db.close(); }
    };
    const turns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const { routine } = await api("/api/routines", {
      name: "Fixture incident monitor", prompt: "Check the fixture incident and arrange its bounded code fix.", botId: monitor.id,
      enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    const sent = await api(`/api/routines/${routine.id}/run`, {}, "POST");
    const runId = sent.run.id;
    const run = async () => (await api("/api/routines")).runs.find((candidate: any) => candidate.id === runId);
    await expect.poll(() => ready.every(path => existsSync(path)), { timeout: 30_000 }).toBe(true);
    const running = assignments();
    expect(running).toHaveLength(5);
    expect(new Set(running.map(row => row.rootId)).size).toBe(1);
    expect(running.find(row => row.assignee.botId === monitor.id)?.depth).toBe(0);
    expect(running.find(row => row.assignee.botId === senior.id)?.depth).toBe(1);
    expect(running.find(row => row.assignee.botId === planner.id)?.depth).toBe(2);
    for (const worker of workers) {
      expect(running.find(row => row.assignee.botId === worker.id)).toMatchObject({ depth: 3, status: "running" });
    }
    writeFileSync(gate, "release both depth-three workers");
    await expect.poll(async () => (await run())?.status, { timeout: 30_000 }).toBe("completed");
    await expect.poll(() => assignments().every(row => row.status === "completed"), { timeout: 15_000 }).toBe(true);
    const finished = assignments();
    expect(finished).toHaveLength(5);
    for (const bot of [monitor, senior, planner]) {
      expect(turns().filter(turn => turn.botId === bot.id)).toHaveLength(2);
    }
    for (const worker of workers) {
      const workerTurns = turns().filter(turn => turn.botId === worker.id);
      expect(workerTurns).toHaveLength(1);
      expect(workerTurns[0].model).toBe("claude-sonnet-5-5");
    }
    expect(turns().filter(turn => turn.botId === planner.id).every(turn => turn.model === "claude-opus-5-5")).toBe(true);
    const monitorRoot = finished.find(row => row.assignee.botId === monitor.id)!;
    expect(monitorRoot.origin.kind).toBe("routine");
    const messages = await api(`/api/threads/${monitorRoot.assignee.destination.threadId}/messages`);
    expect(messages.messages.filter((message: any) => message.text === "Incident resolved; verified implementation received.")).toHaveLength(1);
    writeFileSync(evidencePath, JSON.stringify({ logPath: session.info.logPath, url: session.info.url, coordination, sent,
      run: await run(), assignments: finished, messages, parallelWorkers: 2, cascadesRefused: 2,
      turns: turns().map(({ botId, model, threadId, resumed }) => ({ botId, model, threadId, resumed })),
    }, null, 2));
    console.log(`Depth-three coding team fixture evidence: ${evidencePath}`);
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await session.close();
  }
}, 120_000);
