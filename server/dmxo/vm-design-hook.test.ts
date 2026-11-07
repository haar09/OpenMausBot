import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { containerExecWithDesignHook } from "./vm-design-hook.ts";
import type { LocalVmTarget } from "../container-computer.ts";
let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  root = mkdtempSync(join(tmpdir(), "omb-design-hook-"));
  const project = join(root, "project");mkdirSync(join(project, "src"), { recursive: true });mkdirSync(join(project, ".impeccable"));
  mkdirSync(join(project, ".agents/skills/impeccable/scripts"), { recursive: true });
  writeFileSync(join(project, ".impeccable/config.json"), JSON.stringify({ hook: { enabled: true } }));
  writeFileSync(join(project, ".agents/skills/impeccable/scripts/impeccable"), "fixture launcher");
  writeFileSync(join(project, "src/page.css"), ".plain { color: black }");
  const target: LocalVmTarget = { key: "fixture", containerName: "isolated-fixture", workspaceDir: root, viewerPort: null, label: "fixture" };
  return { project, target };
}
it("returns detector findings from a VM edit without changing its successful command outcome", async () => {
  const { project, target } = fixture();const commands: string[] = [];
  const exec = async (_runtime: string, args: string[]) => {
    const cmd = args.at(-1)!;commands.push(cmd);
    if (cmd === "edit fixture") { writeFileSync(join(project, "src/page.css"), ".bad { background-clip: text; color: transparent; }");return { code: 0, stdout: "saved", stderr: "" }; }
    expect(cmd).toContain("cd '/home/cua/workspace/project'");expect(cmd).toContain("detect --json 'src/page.css'");
    return { code: 2, stdout: JSON.stringify([{ antipattern: "gradient-text", file: "src/page.css" }]), stderr: "" };
  };
  const result = await containerExecWithDesignHook(target, "edit fixture", { runtime: "docker", exec });
  expect(commands).toHaveLength(2);expect(result.exitCode).toBe(0);expect(result.stdout).toContain("gradient-text");expect(result.stdout).toContain("saved");
});
it("does not scan reads, disabled hooks, symlink escapes, or dependency output", async () => {
  const { project, target } = fixture();writeFileSync(join(project, ".impeccable/config.local.json"), JSON.stringify({ hook: { enabled: false } }));
  symlinkSync(tmpdir(), join(project, "src/external"), "dir");const calls: string[] = [];
  await containerExecWithDesignHook(target, "edit fixture", { runtime: "docker", exec: async (_r, args) => {
    calls.push(args.at(-1)!);writeFileSync(join(project, "src/page.css"), ".changed { color: red }");return { code: 0, stdout: "done", stderr: "" };
  } });expect(calls).toEqual(["edit fixture"]);
});
it("preserves a failed original command and surfaces a detector operational failure independently", async () => {
  const { project, target } = fixture();let calls = 0;
  const result = await containerExecWithDesignHook(target, "partial edit", { runtime: "docker", exec: async () => {
    if (!calls++) { writeFileSync(join(project, "src/page.css"), ".changed { color: blue }");return { code: 1, stdout: "partially saved", stderr: "original failure" }; }
    return { code: 1, stdout: "", stderr: "detector missing" };
  } });expect(result.exitCode).toBe(1);expect(result.stderr).toBe("original failure");expect(result.stdout).toContain("detector missing");
});

it("checks the first UI file added to an already-enabled empty project", async () => {
  const { project, target } = fixture();unlinkSync(join(project, "src/page.css"));let calls = 0;
  const result = await containerExecWithDesignHook(target, "create first UI file", { runtime: "docker", exec: async () => {
    if (!calls++) { writeFileSync(join(project, "src/first.tsx"), "export const View = () => <div/>;");return { code: 0, stdout: "created", stderr: "" }; }
    return { code: 0, stdout: "[]", stderr: "" };
  } });expect(calls).toBe(2);expect(result.stdout).toContain("No design findings");
});
