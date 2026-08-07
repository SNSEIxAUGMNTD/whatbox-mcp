# Security Policy

## Secret-handling policy

- Never provide passwords, private keys, API tokens, session cookies, or full
  connection strings in chat, GitHub issues, commits, pull requests, logs, or
  MCP tool arguments.
- Keep local credentials in `~/.config/whatbox-mcp/local.env` with `0600`
  permissions. Keep private SSH keys in your normal SSH key directory.
- Commit `.env.example` with variable names only. Never commit `.env` files,
  `secrets/`, `.whatbox-mcp/`, or private keys.
- Use a dedicated SSH key for this integration and revoke it if the machine or
  key may have been exposed.

## Operation policy

- The server will not expose a generic shell-execution tool.
- Remote actions will be explicit, path-restricted, and validated.
- Agent-facing storage results omit configured remote root paths; directory
  tools return only the selected root index and bounded relative paths.
- Every mutation will require an immutable plan before execution.
- A model-supplied boolean or confirmation phrase is never sufficient to
  authorize deletion. Approval must come from a human-controlled channel, be
  one-time and short-lived, and be bound to the exact slot, action, and targets.
- Initial removal operations will quarantine data. Permanent purge will be a
  separate action requiring a second explicit human approval.
- Approval request state must be HMAC-protected, expire quickly, bind exact
  target digests, and be consumed atomically at most once.
- Wildcards, filesystem root targets, implicit target expansion, and recursive
  deletion are denied by default.
- Public HTTP transport is out of scope until authentication, authorization,
  audit logging, and threat modeling are implemented.

The full design is documented in `docs/ARCHITECTURE.md`. No destructive tool
may be released without automated denial-path tests for missing, expired,
mismatched, reused, or model-supplied approval.

The local approval key is generated at
`~/.local/state/whatbox-mcp/approval.key`. It is a secret and must never be
committed, logged, pasted into chat, or accepted as a tool argument.

## Reporting a vulnerability

Do not open a public issue for a suspected credential exposure or security
vulnerability. Contact the repository owner privately and revoke affected
credentials immediately.
