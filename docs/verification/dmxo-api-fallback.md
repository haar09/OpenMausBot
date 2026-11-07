# API continuation after subscription limits

A saved API key does not make every API driver an eligible backup for a native
coding engine. `recoveryCapabilityError` refuses an automatic transition from
Claude or Codex to `openai-compat`: that driver cannot directly use the pinned
workspace. Keep that check and the existing tool and approval checks.

For an operator-owned Responses endpoint, use the existing native Codex managed
endpoint configuration in a separate instance with `access: "api"`, the deployed
model IDs, and a private `CODEX_HOME`. Its endpoint and billing key belong in
the private runtime configuration, never this repository. The native driver
reads its key from `OPENMAUSBOT_COMPANY_API_KEY`; it does not need the personal
Codex login to be replaced. Keep the original subscription instances intact.

Codex CLI 0.166.0 was qualified against the operator's Azure v1 endpoint with
`tool_search = false` and `supports_websockets = false` for its managed provider
in that instance's private `config.toml`. Hosted tool search and WebSocket
transport are not required for the app's MCP tools.

Choose the new instance in each coding bot's backup list and in app-wide
Automatic recovery. A metered engine is used only when explicitly chosen as a
backup. Preserve bot defaults, thread workspaces, existing backup choices,
approval modes, computer identities, and provider-limit reset records. A
conversation that failed before this configuration needs an explicit
continuation; resume its current root request and reuse completed child work.
Do not replay historical monitoring runs or completed requests.

```sh
node node_modules/vitest/vitest.mjs run server/limit-reset.e2e.test.ts server/host/limit-takeover.test.ts server/limit-failover.test.ts --maxWorkers=2
node node_modules/typescript/bin/tsc -p tsconfig.server.json
node node_modules/oxlint/bin/oxlint --deny-warnings server/limit-reset.e2e.test.ts
```

The API fixture uses a fake native Codex instance with a synthetic billing key.
It proves that exhausted Claude and Codex subscriptions continue on the chosen
API, with the original pinned workspace and permissions, without changing bot
defaults or sibling selections. A runtime refusal remains visible in history;
the quota continuation may repeat the original user message. It is not proof
of a real provider's availability.

Separate real-provider qualification used disposable application containers,
synthetic conversations, and the existing CLI directory mounted read-only.
Both Sol and Terra executed a local `printf` and returned its marker through
the app's native driver. The fixture mounted no production conversations or
project workspaces, and removed its temporary key-bearing configuration after
each run. Private evidence is retained with the operator's deployment records.
