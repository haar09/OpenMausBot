import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { HandoffView } from "../coordinator.ts";
import { handoffAttachedFile, INCOMING_FILE_SCRIPT, type FileHandoffDeps } from "./assignment-file-handoff.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "omb-file-handoff-")); dirs.push(dir); return dir; };
const data = Buffer.from("A complete private patch\n".repeat(10_000));
const digest = createHash("sha256").update(data).digest("hex");

function fixture() {
  const source = join(directory(), "artifact.txt");
  writeFileSync(source, data);
  const child = { id: "child", parentId: "parent", botId: "worker", threadId: "work", status: "running" } as HandoffView;
  const parent = { id: "parent", botId: "reviewer", threadId: "review", status: "waiting" } as HandoffView;
  const copy = vi.fn<(input: unknown) => Promise<void>>(async () => {});
  const deps: FileHandoffDeps = { turn: { botId: "worker", threadId: "work", generation: "turn", roomHandoffId: "child" },
    node: (id) => id === "child" ? child : id === "parent" ? parent : undefined, computer: () => "vm", perBotVm: true,
    runtime: "docker", mayDeliver: () => true, active: () => true, provisioned: () => true, copy };
  return { saved: { attachment: { kind: "file" as const, path: source, name: "patch.txt", mime: "text/plain" }, bytes: data.length }, deps, child, parent, copy };
}

it("delivers a complete large attachment only to its real requester's private VM and returns its path and checksum", async () => {
  const f = fixture();
  const result = await handoffAttachedFile(f.saved, f.deps);
  expect(f.copy).toHaveBeenCalledOnce();
  expect(f.copy.mock.calls[0]![0]).toMatchObject({ assignment: "child", name: "artifact.txt", sha256: digest, data });
  expect(result).toMatchObject({ attachmentId: "artifact.txt", sha256: digest, requesterCopy: {
    botId: "reviewer", threadId: "review", path: "/home/cua/workspace/.openmausbot-incoming/child/artifact.txt", sha256: digest, bytes: data.length } });
  expect(JSON.stringify(result)).not.toContain(f.saved.attachment.path);
});

it("does not copy from a stale capability, another bot's assignment, or a completed requester's work", async () => {
  for (const mode of ["stale", "other-bot", "completed", "not-vm", "shared-vm", "missing-vm", "private"] as const) {
    const f = fixture();
    if (mode === "stale") f.deps.active = () => false;
    if (mode === "other-bot") f.child.botId = "someone-else";
    if (mode === "completed") f.parent.status = "completed";
    if (mode === "not-vm") f.deps.computer = () => "local";
    if (mode === "shared-vm") f.deps.perBotVm = false;
    if (mode === "private") f.deps.mayDeliver = () => false;
    if (mode === "missing-vm") f.deps.provisioned = () => false;
    expect(await handoffAttachedFile(f.saved, f.deps)).toEqual({ attachmentId: "artifact.txt", sha256: digest });
    expect(f.copy, mode).not.toHaveBeenCalled();
  }
});

it("keeps the chat attachment when delivery fails and reports that the requester has no copy", async () => {
  const f = fixture(); f.copy.mockRejectedValueOnce(new Error("private runtime diagnostic"));
  const result = await handoffAttachedFile(f.saved, f.deps);
  expect(result).toHaveProperty("requesterCopyError");
  expect(result).not.toHaveProperty("requesterCopy");
  expect(JSON.stringify(result)).not.toContain("private runtime diagnostic");
  expect(readFileSync(f.saved.attachment.path)).toEqual(data);
});

it("streams the full artifact through the real transport into an isolated VM substitute", async () => {
  const f = fixture(), root = directory(), runtime = join(directory(), "runtime");
  writeFileSync(runtime, `#!/usr/bin/env python3\nimport os,sys\na=sys.argv[1:]\nassert a[:4]==['exec','-i','-u','cua']\ni=a.index('-c')\na[i+2]=${JSON.stringify(root)}\nos.execv(sys.executable,[sys.executable]+a[i:])\n`);
  chmodSync(runtime, 0o700);
  f.deps.copy = undefined; f.deps.runtime = runtime;
  const result = await handoffAttachedFile(f.saved, f.deps);
  expect(result).toHaveProperty("requesterCopy.sha256", digest);
  expect(readFileSync(join(root, ".openmausbot-incoming", "child", "artifact.txt"))).toEqual(data);
});

const write = (root: string, options: { name?: string; hash?: string; body?: Buffer } = {}) => spawnSync("python3", ["-c", INCOMING_FILE_SCRIPT,
  root, "assignment", options.name ?? "artifact.txt", options.hash ?? digest], { input: options.body ?? data, encoding: "utf8" });

it("the real VM writer preserves bytes and supports an identical retry without overwriting a different file", () => {
  const root = directory();
  expect(write(root).status).toBe(0);
  const target = join(root, ".openmausbot-incoming", "assignment", "artifact.txt");
  expect(readFileSync(target)).toEqual(data);
  expect(write(root).status).toBe(0);
  writeFileSync(target, "keep this existing file");
  expect(write(root).status).not.toBe(0);
  expect(readFileSync(target, "utf8")).toBe("keep this existing file");
});

it("the real VM writer rejects traversal, incorrect checksums and symlinked inboxes or destination files", () => {
  const root = directory();
  expect(write(root, { name: "../outside.txt" }).status).not.toBe(0);
  expect(write(root, { hash: "incorrect" }).status).not.toBe(0);
  expect(existsSync(join(root, ".openmausbot-incoming"))).toBe(false);
  const outside = directory();
  symlinkSync(outside, join(root, ".openmausbot-incoming"));
  expect(write(root).status).not.toBe(0);
  expect(existsSync(join(outside, "assignment"))).toBe(false);
  const safe = directory();
  mkdirSync(join(safe, ".openmausbot-incoming", "assignment"), { recursive: true });
  const protectedFile = join(outside, "protected"); writeFileSync(protectedFile, "unchanged");
  symlinkSync(protectedFile, join(safe, ".openmausbot-incoming", "assignment", "artifact.txt"));
  expect(write(safe).status).not.toBe(0);
  expect(readFileSync(protectedFile, "utf8")).toBe("unchanged");
});
