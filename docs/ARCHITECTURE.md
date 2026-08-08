# Architecture and Product Scope

## Authorization boundary

Whatbox MCP can operate any Whatbox slot that its owner explicitly configures.
Each slot will use a separate local connection profile and SSH identity. The
server cannot access provider administration, billing, another customer's
files, or operations that require root privileges.

Public releases must remain self-hosted. Credentials stay on the MCP host and
are never accepted as tool arguments, returned in results, or stored in Git.

## Agent interface

The server exposes tools with descriptive titles, strict input schemas,
declared output schemas, structured content, read-only annotations, and JSON
text fallbacks for older clients. `whatbox_operational_snapshot` is the
preferred low-round-trip assessment tool. A static MCP resource provides the
agent operating policy, and `whatbox_safe_audit` provides a reusable read-only
workflow prompt.

Agent-facing output must omit credentials, configured host/user values,
approval-key material, raw connection errors, and configured remote root
paths. Tool annotations improve planning but never grant authority.

## Inventory and diagrams

Discovery will be bounded to the configured user's home directory and explicit
allowed roots. It will collect metadata, not file contents, with configurable
depth, entry, output-size, and execution-time limits.

The scanner will deny sensitive locations and file classes by default,
including SSH/GPG material, shell history, environment files, credentials,
cookies, certificates, private keys, and application authentication databases.
Service-specific readers must parse known formats and redact sensitive fields.

Inventory tools will return a normalized tree and a Mermaid diagram generated
from sanitized node identifiers and labels. They may include:

- top-level folder purpose, size, and item counts;
- known application configuration and data locations;
- allowlisted running services and listening-port metadata;
- warnings about duplicate data, unsafe permissions, missing expected folders,
  invalid configuration, and storage pressure.

Efficiency findings are advisory. They must distinguish observed evidence from
recommendations and must not modify the slot automatically.

## Service management

The supported service catalog will begin with Whatbox-provided torrent and
media applications, then userland Nginx and explicitly supported home-directory
applications. Every service adapter must define fixed inspect, validate, start,
stop, and restart operations. The MCP will never expose arbitrary shell
execution or accept a command string from a tool caller.

Whatbox Manage-page operations, managed links, and one-click app installation
are separate from SSH. They require a supported provider interface or an
explicit user-driven browser workflow; the MCP must not scrape or store the
user's Whatbox account password.

## Website and domain hosting

Website support will provide bounded project directories, deployment previews,
atomic releases, userland Nginx configuration generation, `nginx -t`
validation, health checks, logs with redaction, rollback, and start/restart
operations. DNS records and Whatbox managed links remain explicit external
steps unless a separately authorized provider integration is configured.

The website observation phase is read-only. Its fixed probes check Nginx binary
availability, known userland configuration-location existence, allowlisted
process state, candidate website-root directory existence below configured
allowed roots, and storage headroom. It returns observations separately from
recommendations, does not read configuration contents, and does not infer
health from process state. Static deployment remains disabled until its local
source allowlist, atomic release, validation, health-check, rollback, and
approval design are implemented and live-validated.

The bounded diagnostics adapter adds a fixed `/usr/sbin/nginx -t` syntax test,
an optional `/usr/bin/curl` probe to a locally configured loopback port, and a
32 KiB tail sample used only to count Nginx error severities. It rejects
symlinked configuration and log files and never returns configuration text,
HTTP response bodies, or log lines. The same primitives can support future
pre-activation and post-activation checks, but they grant no mutation authority.

The static deployment design is:

1. Accept only a local source directory selected from an explicit allowlist;
   reject symlinks, traversal, secrets, and unsupported file classes before
   transfer.
2. Map it to an exact remote release directory below an allowed website root;
   never accept wildcards or expand targets implicitly.
3. Transfer into a new temporary release, validate the bounded file manifest,
   generate only known Nginx configuration fragments, and run the fixed
   `nginx -t` validation query.
4. Publish by an atomic release-pointer change, then perform a bounded health
   check against the selected site and retain the prior release for rollback.
5. On failed validation or health checking, leave the active release intact;
   rollback is an exact, reversible mutation and requires the same signed
   external approval path as deployment.

No write, start, stop, restart, or deployment operation is enabled by the
readiness tool. DNS, domains, and Whatbox managed links remain user-driven
external steps.

## Approval model

Read-only operations do not need approval. Every mutation must first create an
immutable plan containing the action, exact targets, expected changes, risk,
and rollback strategy.

Deletion has a stronger fail-closed rule:

1. A delete tool can only create a plan; it cannot delete during planning.
2. Approval must come from a human-controlled channel outside the model's tool
   arguments. A boolean or confirmation phrase supplied by the model is never
   sufficient.
3. Approval is one-time, short-lived, and bound to the plan digest, slot
   profile, operation, and exact canonical targets.
4. Execution revalidates target identity, path containment, and plan expiry.
5. Wildcards, implicit target expansion, filesystem root, and recursive delete
   are denied by default.
6. Initial removal operations move items into a dated quarantine directory.
   Permanent purge is a separate operation requiring a second explicit human
   approval.
7. Every planned, approved, rejected, expired, and executed action is recorded
   in a local redacted audit log.

Approval state is integrity-protected with a locally generated HMAC key stored
at `~/.local/state/whatbox-mcp/approval.key` with mode `0600`. Plans expire
after five minutes by default and are consumed atomically at most once. Never
copy, publish, or paste this key into chat. Modern MCP clients receive the
approval request through the protocol's multi-round-trip `input_required`
flow. A client that cannot present this interaction must be denied mutation.

No mutating or destructive tool will ship until this approval mechanism has
tests proving that execution fails without valid external approval.

## Delivery stages

1. Bounded folder and service inventory with diagrams.
2. Read-only health, configuration, and efficiency checks.
3. Plan and external-approval infrastructure.
4. Reversible service controls and atomic website deployment.
5. Quarantine-based removal, then separately approved permanent purge.
6. Optional multi-profile support for several owner-authorized Whatbox slots.
