# Full Impeccable and VM edits

Pixel uses the verified `.agents/skills/impeccable` package from
`pbakaus/impeccable` revision `687bc381bc9091bf252c0a05303640561014a425`.
Its SKILL.md is version 4.8.0, SHA-256
`fab04b31f946573b00a8559db1fc070f8ea5825254d491c2b13156e5661a86d7`.
The 0.1.18 Linux engine is verified against the package checksum manifest:
`736ed785e74ae2344d3036127f614ddde5ab520a527d8bc82a891612ef71f648`.
The previous import omitted agents/, reference/ and scripts/; the complete
package includes those resources and the native engine.

Run the official launcher with `hooks on` in a project to preserve existing
settings and install its native Codex PostToolUse and Stop manifests. Project
`hook.enabled` controls the extra VM integration as well; a local false override
wins. The unmodified native hooks cover native edit tools. VM shell edits are
MCP calls, so OpenMausBot also snapshots enabled project source files around
its authorized vm_exec operation and runs the official detector on changed
files inside the same VM. Findings return in the tool output. Detector failure
does not change the original command's exit code or cancel the task.

Only installed, enabled project packages participate. Symlink directories and
build/dependency/skill output are skipped. Skill code never runs in the host
application process. Existing VM ownership and capability checks still happen
before execution.

Verification uses isolated data:

```sh
node node_modules/vitest/vitest.mjs run server/dmxo/vm-design-hook.test.ts
node node_modules/vitest/vitest.mjs run server/group-local-vm.e2e.test.ts -t 'executes and attaches only for the current VM owner|claims an Auto VM on its first shell command'
```

An additional isolated real-engine fixture writes a CSS gradient-text issue,
runs it through the wrapper and confirms the real detector's finding appears
in the successful command output. Production setup verification reads manifests,
package hashes and readiness; it does not create test edits in user projects.
