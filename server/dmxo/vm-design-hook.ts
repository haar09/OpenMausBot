import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { containerExec as execute, type ContainerExecResult, type LocalVmTarget } from "../container-computer.ts";

const EXTENSIONS = /\.(?:tsx?|jsx?|html|css|scss|sass|less|vue|svelte|astro)$/iu;
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".agents", ".claude", ".impeccable", ".desktop-apps"]);
const quote = (s: string) => `'${s.replace(/'/gu, "'\\''")}'`;
type Snapshot = { files: Map<string, { stamp: string; project: string }>; projects: Set<string> };

function objectFile(path: string): any {
  try { return lstatSync(path).isFile() ? JSON.parse(readFileSync(path, "utf8")) : null; } catch { return null; }
}

function snapshot(root: string): Snapshot {
  const files: Snapshot["files"] = new Map();
  const projects = new Set<string>();
  const walk = (directory: string, project: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || SKIP.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, project);
      else if (entry.isFile() && EXTENSIONS.test(entry.name)) {
        const stat = lstatSync(path);
        files.set(path, { stamp: `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`, project });
      }
    }
  };
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
      const project = join(root, entry.name);
      const shared = objectFile(join(project, ".impeccable", "config.json"));
      const local = objectFile(join(project, ".impeccable", "config.local.json"));
      if ((local?.hook?.enabled ?? shared?.hook?.enabled) !== true) continue;
      const launcher = join(project, ".agents", "skills", "impeccable", "scripts", "impeccable");
      try { if (!lstatSync(launcher).isFile()) continue; } catch { continue; }
      projects.add(project);walk(project, project);
    }
  } catch { return { files, projects }; }
  return { files, projects };
}

/** VM shell edits are MCP calls, so native Edit/Write hook matchers never see their file changes. */
export async function containerExecWithDesignHook(
  target: LocalVmTarget, command: string, options: Parameters<typeof execute>[2] = {},
): Promise<ContainerExecResult> {
  const before = snapshot(target.workspaceDir);
  const result = await execute(target, command, options);
  const changed = new Map<string, string[]>();
  for (const [path, state] of snapshot(target.workspaceDir).files) {
    if (before.files.get(path)?.stamp === state.stamp || !before.projects.has(state.project)) continue;
    const paths = changed.get(state.project) ?? [];
    paths.push(relative(state.project, path));changed.set(state.project, paths);
  }
  const notes: string[] = [];
  for (const [project, paths] of changed) {
    const guest = `/home/cua/workspace/${relative(target.workspaceDir, project)}`;
    // Skill executables remain inside the bot's VM; workspace content never executes in the host process.
    const scan = `cd ${quote(guest)} && ./.agents/skills/impeccable/scripts/impeccable detect --json ${paths.map(quote).join(" ")}`;
    try {
      const checked = await execute(target, scan, { ...options, timeoutSeconds: 20 });
      if (checked.timedOut || ![0, 2].includes(checked.exitCode)) {
        notes.push(`Impeccable could not finish checking ${paths.length} changed file(s): ${checked.stderr || checked.stdout || "detector timeout"}`);
        continue;
      }
      const findings = JSON.parse(checked.stdout);
      notes.push(`Impeccable checked ${paths.length} changed file(s). ${Array.isArray(findings) && findings.length ? JSON.stringify(findings) : "No design findings."}`);
    } catch (error) { notes.push(`Impeccable check unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return notes.length ? { ...result, stdout: `${result.stdout}\n\n[Impeccable post-edit check]\n${notes.join("\n").slice(0, 8000)}` } : result;
}
