import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";

import type { SavedBotAttachment } from "../bot-attachment.ts";
import { containerRuntimeStatus, localVmWorkspaceExists, perBotLocalVmTarget, VM_WORKSPACE_GUEST, type LocalVmTarget } from "../container-computer.ts";
import type { HandoffView } from "../coordinator.ts";

export const INCOMING_FILE_SCRIPT = `import os,sys,hashlib,json
root,assignment,name,expected=sys.argv[1:]
data=sys.stdin.buffer.read(25*1024*1024+1)
if len(data)>25*1024*1024 or hashlib.sha256(data).hexdigest()!=expected: raise ValueError('Artifact checksum or size mismatch')
if any('/' in part or part in ('','..','.') for part in [assignment,name]): raise ValueError('Invalid artifact name')
fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in ['.openmausbot-incoming',assignment]:
  try: os.mkdir(part,0o700,dir_fd=fd)
  except FileExistsError: pass
  child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  os.close(fd);fd=child
 try:
  file=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
 except FileExistsError:
  file=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
  with os.fdopen(file,'rb') as source:
   if hashlib.sha256(source.read()).hexdigest()!=expected: raise ValueError('An existing artifact differs; nothing overwritten')
 else:
  with os.fdopen(file,'wb') as target: target.write(data)
 print(json.dumps({'sha256':expected,'bytes':len(data)}))
finally: os.close(fd)
`;

interface CopyInput {
  target: LocalVmTarget;
  runtime: string;
  assignment: string;
  name: string;
  sha256: string;
  data: Buffer;
}

async function copyIntoVm(input: CopyInput): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.runtime, ["exec", "-i", "-u", "cua", input.target.containerName, "python3", "-c", INCOMING_FILE_SCRIPT,
      VM_WORKSPACE_GUEST, input.assignment, input.name, input.sha256], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Requester file delivery timed out")); }, 20_000);
    child.stdout.on("data", (chunk) => { output = (output + String(chunk)).slice(-4_000); });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("Requester VM could not accept the file; no existing file was overwritten"));
      try {
        const receipt = JSON.parse(output) as { sha256: string; bytes: number };
        if (receipt.sha256 !== input.sha256 || receipt.bytes !== input.data.length) throw new Error("Requester file receipt did not match");
        resolve();
      } catch (error) { reject(error); }
    });
    child.stdin.end(input.data);
  });
}

export interface FileHandoffDeps {
  turn: { botId: string; threadId: string; generation: string; roomHandoffId?: string };
  node(id: string): HandoffView | undefined;
  computer(botId: string): string | undefined;
  mayDeliver(child: HandoffView, parent: HandoffView): boolean;
  perBotVm: boolean;
  runtime?: string;
  active(): boolean;
  provisioned?: (target: LocalVmTarget) => boolean;
  copy?: (input: CopyInput) => Promise<void>;
}

/** Only a live assignment's actual requester receives a private copy. The VM, not the host, resolves its destination. */
export async function handoffAttachedFile(saved: SavedBotAttachment, deps: FileHandoffDeps) {
  const file = await open(saved.attachment.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let data: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== saved.bytes || stat.size > 25 * 1024 * 1024) throw new Error("Attachment changed before delivery");
    data = await file.readFile();
  } finally { await file.close(); }
  const attachmentId = basename(saved.attachment.path);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const metadata = { attachmentId, sha256 };
  const node = deps.node(deps.turn.roomHandoffId ?? deps.turn.generation);
  if (!node || node.botId !== deps.turn.botId || node.threadId !== deps.turn.threadId || !node.parentId ||
      !["running", "source"].includes(node.status) || !deps.active()) return metadata;
  const parent = deps.node(node.parentId);
  if (!parent || parent.groupId || ["completed", "failed", "cancelled"].includes(parent.status) ||
      !deps.mayDeliver(node, parent) || !deps.perBotVm || deps.computer(parent.botId) !== "vm") return metadata;
  const target = perBotLocalVmTarget(parent.botId);
  if (!(deps.provisioned ?? localVmWorkspaceExists)(target)) return metadata;
  if (![node.id, attachmentId].every((value) => /^[\w.-]+$/.test(value)) || !deps.active()) return metadata;
  try {
    const runtime = deps.runtime ?? (await containerRuntimeStatus()).runtime;
    if (!runtime || !deps.active()) throw new Error("Requester file delivery is unavailable");
    await (deps.copy ?? copyIntoVm)({ target, runtime, assignment: node.id, name: attachmentId, sha256, data });
    return { ...metadata, requesterCopy: { botId: parent.botId, threadId: parent.threadId,
      path: `${VM_WORKSPACE_GUEST}/.openmausbot-incoming/${node.id}/${attachmentId}`, sha256, bytes: data.length } };
  } catch {
    return { ...metadata, requesterCopyError: "Attached in this chat, but the requester's VM could not receive its private copy. Report this delivery failure in the existing assignment." };
  }
}
