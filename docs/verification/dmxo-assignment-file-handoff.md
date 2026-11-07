# Questions and files in delegated coding work

At Full access, technical questions from work the person started go back to the
requester. A guarded, relayed API message is deliberately outside-origin work;
it does not acquire the original request's authority merely by saying
"continue". Recovery must preserve the recorded human request, rather than
silently replace its origin. Never change the classification of unrelated
webhooks, guests, relay requests, or questions that only the person can answer.

For an operator correction of a known recovery, stop only an idle application,
back up its runtime and message databases, and validate the original root's
person-origin record and matching conversation. Restore only the affected live
tree's origin, retaining the previous values and the anchor root in a private
maintenance record. Reclassify the technical question as its bot's to decide;
do not supply an invented answer. The existing requester routing still applies.

`attach_file` in an active assignment now also delivers the saved immutable
attachment to its actual requester's provisioned per-bot Local VM. It returns
the attachment ID, SHA256, and `requester_copy` with the recipient's own VM path.
Include this receipt in the assignment result. No model-provided recipient or
destination is accepted, and private-thread and outside-lineage checks run
before delivery. Non-VM, shared-VM, ended, private, or unprovisioned destinations
are not copied automatically.

The receiver uses a private `.openmausbot-incoming/<assignment>/` directory.
Only a fixed writer runs inside the destination VM; it accepts bytes on stdin,
checks their checksum and size, walks directories with `dir_fd` and
`O_NOFOLLOW`, and creates a new file with `O_EXCL`. An identical retry is safe;
an existing different file is never overwritten. Transport failure is returned
separately from the original successful chat attachment. The source workspace
and the recipient's project files are unchanged.

```sh
node node_modules/vitest/vitest.mjs run server/dmxo/assignment-file-handoff.test.ts server/runtime/questions.test.ts server/host/ask-cards.test.ts server/host/question-routing.test.ts --maxWorkers=2
node node_modules/vitest/vitest.mjs run server/question-routing.e2e.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run server/index.test.ts -t 'delivers a file a host engine' --maxWorkers=1
```

The real Python writer runs against disposable directories in the tests,
including traversal, symlink, corruption, and retry cases. The HTTP fixture
checks attachment identity and checksum without using production data. The
question-routing fixture exercises requester decisions, private questions,
human-only sign-ins, restart recovery, and questions below Full access against
fake engines. Real coding work is resumed only after these isolated checks.
