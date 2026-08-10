# Coding-Agent Handoff

## Repository

- Working directory: the repository root containing this document
- Package: `whatbox-mcp`
- Current version: `0.15.0`
- Runtime: Node.js 20 or newer, TypeScript, ESM
- Transport: local MCP stdio
- Baseline commit: `f0c95db` on `main`. Inspect `git status` before editing and
  preserve all working-tree changes made after that commit.

## 0.15.0 update

- Finishes the two open criticalNext items: app health beyond process-state,
  and in-place upgrades. Shared foundation: an MCP-owned per-app state file at
  ~/.config/whatbox-mcp/apps/<id>.json recording {version, port}, written at
  install/upgrade (APP_STATE_DIR, stateWriteLines, parseAppState).
- whatbox_app_catalog now reports installedVersion, running (pgrep),
  responding (reuses the tested loopback curl probe against the state-file
  port), and upgradeAvailable (installedVersion != manifest.version).
  buildRunningProbeScript/parseAppRunningStates replaced by
  buildHealthProbeScript/parseHealthStates.
- whatbox_app_upgrade (destructive, gated): verify the manifest's pinned
  artifact, re-extract app files over the install dir (config/data are not in
  the archive, so preserved), rewrite state, restart. Reads the installed port
  first so it is preserved. buildUpgradeScript in apps.ts.
- Capability planned/criticalNext refreshed (both items now shipped).
- Tests: +3 (health probe+parse, state file+parseAppState, upgrade ordering).
  83 passing.

## 0.14.0 update

- Torrent health: `d.message` added to the rTorrent multicall and a `message`
  field to TorrentSummary (all clients) — surfaces "unregistered torrent" /
  tracker errors. New `reannounce` op on whatbox_torrent_control (rTorrent
  d.tracker_announce; transmission torrent-reannounce; qbit reannounce).
- whatbox_orphaned_data (read-only): cross-references rTorrent d.base_path
  (getTorrentBasePaths) against top-level on-disk entries to find data no
  torrent references; sizes the orphans with one bounded du. rTorrent only.
- whatbox_directory_usage (read-only): du -d1 breakdown per subdirectory,
  largest first (parseDuDepth1). Answers "what is using my quota".
- M1 fixed: observe tools' input renamed rootIndex -> observeRootIndex
  (list_directory, structure_map, + the two new tools) so it can't be
  conflated with the mutation tools' rootIndex (different root set).
- App templates: Sonarr 4.0.19.2979 + Radarr 6.3.0.10514 (self-hashed, no
  upstream checksums published; both reconfirmed by re-download). Manifest
  config now supports a subdir (data/config.xml) — buildInstallScript mkdir's
  the parent. New "automation" category.
- Traffic quota: investigated and NOT built — the wiki confirms monthly
  traffic is web-panel / Skynet-IRC only, with no on-slot source. Recorded
  as a finding rather than shipping a tool that reads nothing.
- Test-quality: made the tamper test deterministic (was flaky — flipping the
  final base64url char could decode identically).
- Tests: 81 passing.

## 0.13.0 update

- Lifecycle + health for templated service apps, driven by manifest data
  (no per-app code):
  - `whatbox_app_catalog` now reports `running` for service apps (pgrep on
    the manifest processMatch, one batched command; utilities report null).
  - `whatbox_app_restart` (destructive, gated): kill + relaunch a service
    app; refuses non-service apps. The cron keepalive also respawns it.
  - Pure builders in apps.ts: buildRunningProbeScript, parseAppRunningStates,
    buildRestartScript. Restart's start command references the app's own
    config, so no runtime-only values need re-substituting.
- rclone/yt-dlp (utilities) are driven through whatbox_run_command, not
  dedicated tools; only the Navidrome-style service needed lifecycle/health.
- Tests: +2 (running probe + parse; restart ordering + non-service refusal).
  78 passing.

## 0.12.0 update

- App install templates (`src/apps.ts`): committed, SHA-256-pinned manifests
  + pure script builders. New tools: `whatbox_app_catalog` (read-only),
  `whatbox_app_install` and `whatbox_app_uninstall` (destructive, gated).
  Install downloads the pinned artifact on the slot, runs `sha256sum -c`
  BEFORE extraction, refuses to overwrite an existing install (marker check),
  and registers services the wiki way (screen + `@reboot`/`*/5` crontab tagged
  `# whatbox-mcp:<id>`). Uninstall stops the process, strips only this app's
  cron lines, and moves files to `~/.whatbox-quarantine/apps/<date>` (never rm).
  The exact install script is recorded via the S2 `auditDetail` field.
- Archetype scope: binary-tarball / zip / raw-binary only (linux-amd64).
  Python-venv, Node, and compile-from-source deferred (compile burns shared
  CPU; the others need different, riskier machinery).
- Initial manifests (real pinned hashes): Navidrome 0.63.2 (media server),
  rclone 1.75.0 (backup CLI), yt-dlp 2026.07.04 (utility). Adding an app is a
  pure data addition to RAW_MANIFESTS with its upstream-published SHA-256.
- Tests: +7 (schema/hash integrity, install-before-extract ordering, config
  templating, per-archetype extraction, reversible uninstall). 76 passing.

## 0.11.2 update

- Timeout sweep across every remote wait that SSH keepalive cannot cover
  (a command/app that hangs while the connection stays healthy):
  - `executeFixedCommandWithStatus` now enforces a duration timeout
    (default 60s) — this backs every fixed read-only query; the account
    -quota du walk passes a larger 180s budget.
  - The transmission/qBittorrent HTTP path gained a timeout in
    `httpRequestOverTunnel` and a `withTimeout` around its loopback tunnel
    open, matching the rTorrent SCGI path. The shared constant is now
    `RPC_TIMEOUT_MS` (was `RTORRENT_TIMEOUT_MS`).
  - Connection-level `readyTimeout` (15s) + keepalive (10s x2) already
    bound connect and dead-connection detection for SFTP/exec.
  - Known residual: a bulk SFTP transfer that stalls while the connection
    stays alive is not stall-detected (bounded only by size/free-space
    checks + keepalive). Left as-is; documented here.
- Tests: +1 (executor times out a command that never closes). 69 passing.

## 0.11.1 update

- S1: the rTorrent SCGI path now enforces a 20s timeout (`withTimeout` +
  an internal timer in `scgiRequest` that destroys the stream), matching
  the shell tool's timeout. A wedged rTorrent no longer hangs the torrent
  tools; the enclosing per-call SSH client teardown reaps any leftover stream.
- S2: `run_command` records the verbatim command and purpose in the audit
  log. The command is bound into the signed plan via a new optional
  `detail` field (≤4096, HMAC-covered), so it appears on the requested,
  approved, and executed lines correlated by planId. Other tools leave
  `detail` unset and keep their targets hashed. `AuditEvent` also now logs
  `summary` for every action.

## 0.11.0 update

- rTorrent adapter in `src/torrent.ts`: XML-RPC over SCGI through the existing
  SSH connection (unix socket via `openssh_forwardOutStreamLocal`, or loopback
  TCP). Endpoint auto-discovered from `~/.config/rtorrent/rtorrent.rc` (the
  Whatbox managed location) falling back to `~/.rtorrent.rc`; overrides:
  `WHATBOX_TORRENT_RPC_SOCKET` / `WHATBOX_TORRENT_RPC_PORT`. Zero stored
  torrent credentials; status sorted by `d.up.total`. Per-torrent ratio limits
  and delete-data-on-remove intentionally error for rtorrent.
- `uploadedBytes` added to `TorrentSummary` for all clients.
- `whatbox_account_quota` in `src/whatbox.ts`: `quota -w` first, then
  `nice -n 19` + `ionice -c3` `du -sxH -B1` on the slot home (single walk,
  exit code 1 tolerated, `-H` because `/home/<user>` can be a symlink into the
  array). Storage results now carry `measures: "shared_filesystem"`.
- Observe/mutate scope split in `src/config.ts`: `WHATBOX_OBSERVE_ROOTS`
  (default: slot home) drives `list_directory` / `structure_map` /
  `storage_status`; mutations remain bound to `WHATBOX_ALLOWED_ROOTS`.
  Sensitive-name exclusions extended (rclone, deluge, znc, irssi, pki,
  password-store). Known gap: `rootIndex` indexes observe roots in read tools
  but allowed roots in mutation tools (M1, open).
- `whatbox_run_command` in `src/server-mutations.ts` behind
  `WHATBOX_SHELL_ENABLED` + mutations + per-call exact-text approval:
  denylist of destructive shapes (`assertShellCommandAllowed`), bounded
  stdout+stderr, enforced timeout, audit-logged as `run_command`.
- Server instructions render live mutation/shell state
  (`describeMutationState` in `src/server.ts`).

## 0.10.0 update

The approval-gated mutation phase is now implemented and registered. The gate
(`src/mutation.ts`) uses the SDK `inputRequired`/`acceptedContent` flow with the
sealed plan carried as `requestState`; mutation primitives live in
`src/whatbox-mutations.ts` (files, quarantine/purge, backup, service control,
website deploy/rollback) and `src/torrent.ts` (loopback RPC). All are gated
behind `WHATBOX_MUTATIONS_ENABLED` and registered in `src/server-mutations.ts`.
Destructive actions require human elicitation; denial-path tests are in
`src/mutation.test.ts`. The sections below describe the original read-only
baseline and remain accurate for those tools.

## Transfer status

The read-only website-readiness and diagnostics phases are implemented. The
current continuation also adds local-only static-site source validation and
deployment-plan primitives in `src/website.ts`; these do not connect to
Whatbox, transfer files, change remote state, or register a deployment tool.

The current branch also adds agent-facing output schemas, readable tool titles,
a consolidated operational snapshot, an MCP agent-guide resource, a safe-audit
prompt, and path-redacted storage results. Re-run the validation commands after
any further edits.

Version `0.9.0` also adds `whatbox_website_diagnostics`: a fixed Nginx syntax
test, optional body-free loopback probe, and bounded recent-error severity
summary. It never returns Nginx configuration text, HTTP response bodies, or
log lines.

## Secret policy

Never request, read aloud, print, log, or paste values from the user's local
configuration, SSH keys, agent socket, approval key, passwords, passphrases,
tokens, cookies, or connection strings.

- Public template: `.env.example`
- Private configuration: `~/.config/whatbox-mcp/local.env` (`0600`)
- Authentication: dedicated key through the local SSH agent
- Approval key: `~/.local/state/whatbox-mcp/approval.key` (`0600`)
- Do not open or display either private file. Run only sanitized checks.

The private Whatbox connection previously passed configuration, connection,
storage, SFTP directory, structure-map, torrent-client, service-inventory, and
configuration-review acceptance checks in the user's earlier shell session.
Do not infer that the receiving agent currently has the same SSH-agent state.
For operator startup, use `docs/STARTUP.md`; do not request private values or
replace its sanitized workflow with raw SSH debugging.

## Implemented tools

- `server_info`
- `list_capabilities`
- `whatbox_configuration_status`
- `whatbox_connection_status`
- `whatbox_storage_status`
- `whatbox_list_directory`
- `whatbox_torrent_clients_status`
- `whatbox_structure_map`
- `whatbox_services_status`
- `whatbox_configuration_review`
- `whatbox_website_readiness`
- `whatbox_website_diagnostics`
- `whatbox_website_deployment_plan`
- `whatbox_operational_snapshot`

All current tools are read-only and carry read-only MCP annotations.

Agent interfaces:

- resource: `whatbox://guide/agent-operations`;
- prompt: `whatbox_safe_audit` with `full`, `storage`, `services`, or `website` focus;
- preferred first assessment: `whatbox_operational_snapshot`;
- public guide: `docs/AGENT_USAGE.md`.

All tools return structured content on success and declare output schemas. The
same JSON is returned in a text block for compatibility with older clients.

`src/website.ts` is not an MCP tool. It currently provides local-only
validation and plan construction for the future static deployment flow:

- explicit local source-root allowlist containment;
- rejection of symlinks, sensitive names, unsupported entries, and excessive
  file count/bytes;
- stable source manifest digest without exposing file contents;
- exact `.whatbox-releases/<release-id>` target containment;
- reversible `website_deploy` mutation plan binding source and release digests.

No remote upload, release activation, Nginx configuration write, health-check
mutation, rollback, start, stop, or restart operation is enabled.

`whatbox_website_deployment_plan` is read-only. It validates a local source
against `WHATBOX_WEBSITE_SOURCE_ROOTS`, returns redacted counts and rejection
reasons, creates a short-lived signed `website_deploy` plan, and always reports
that execution is disabled. It does not return local absolute paths or file
contents.

## Implemented safety boundaries

- Pinned ED25519 host fingerprint and SSH-agent authentication
- No generic shell tool or caller-supplied command strings
- Fixed read-only remote commands with bounded output
- SFTP allowed-root, canonical-path, traversal, and symlink containment
- Bounded structure maps with no file-content reads
- Sensitive-directory exclusions and Mermaid-safe diagram labels
- Service inventory reads allowlisted process names and known path existence;
  it does not read process arguments or configuration contents
- Raw connection errors and configuration values are never returned
- Configured remote storage-root paths are removed from agent-facing storage
  results
- Nginx diagnostics reject symlinked config/log files, use fixed executable
  paths, and return no configuration text, HTTP body, or log lines
- Architecture and deletion policy are in `docs/ARCHITECTURE.md` and
  `SECURITY.md`

## Approval foundation

`src/approval.ts` implements:

- HMAC-protected immutable mutation plans
- Slot and exact-target digests
- Five-minute default expiry, ten-minute hard maximum
- Secure local key creation and permission checks
- Atomic one-time plan consumption
- Tests for valid, modified, expired, and reused plans

No mutation tool is registered yet. Do not add deletion until the complete
human-approval path is implemented and denial cases are tested. A tool input
such as `confirm: true` is never sufficient.

The installed MCP SDK supports the 2026 multi-round-trip `input_required`
pattern through `inputRequired`, `acceptedContent`, and signed `requestState`.
Use negotiated protocol interaction and fail closed when the client cannot
present confirmation. Tool annotations are hints, not authorization.

Deletion requirements:

1. Plan only before execution.
2. Explicit client-presented human approval bound to the signed plan.
3. Exact canonical targets, no wildcards or implicit expansion.
4. Initial removal means quarantine, not permanent deletion.
5. Permanent purge requires a separate second approval.
6. Missing, declined, cancelled, expired, modified, mismatched, or reused
   approval must deny execution.

## Current next objective

Finish the static-site mutation phase conservatively, in this order:

1. Implement fixed remote staging and manifest validation through SFTP only;
   no generic shell or caller-supplied command strings.
2. Reuse the read-only diagnostics primitives for pre-activation Nginx
   validation and post-activation loopback checking; add atomic release
   activation and rollback while keeping all writes behind an unregistered
   internal adapter until approval is complete.
3. Integrate the installed SDK's negotiated `input_required` flow using
   signed request state, `acceptedContent`, and fail-closed client capability
   handling. Do not substitute `confirm: true` or a confirmation phrase.
4. Add redacted audit logging for planned, denied, expired, approved, executed,
   failed, and rolled-back mutations.
5. Live-validate only with sanitized repository check scripts. Enable a write
   tool only after denial-path tests and a safe staging/rollback validation
   pass.
6. Keep Whatbox Manage Apps, managed links, DNS, and domains as explicit
   external steps unless a separately authorized provider integration exists.
7. After static deployment is live-validated, add read-only torrent summaries
   through a separately configured supported client API; never reuse or infer
   provider web credentials from SSH configuration.

Do not implement PHP application deployment until static deployment and
rollback are live-validated.

## Validation

Run after each increment:

```bash
npm run typecheck
npm test
npm run build
```

Current local validation: typecheck passes, 38 tests pass, and production
build passes after the website-diagnostics increment. Re-run all three checks
before treating any further continuation as validated.
Use `node --import tsx` for local TypeScript scripts, matching existing npm
scripts.

For live checks, never print private configuration or raw SSH debug output.
The user may share only the sanitized JSON emitted by repository check scripts.
The latest `npm run check:website-diagnostics` attempt from the Codex execution
environment returned `authentication_failed` at `authentication`. This proves
neither that the Nginx diagnostics passed nor that the private configuration is
wrong; the receiving agent must re-establish its own authorized SSH-agent
session and rerun the sanitized check.

## Receiving-agent checklist

First confirm that the human operator has loaded the dedicated identity as
described in `docs/STARTUP.md`. Do not ask for the key, passphrase, agent socket,
or configuration values.

```bash
npm run typecheck
npm test
npm run build
npm run check:website
npm run check:website-diagnostics
npm run check:snapshot
```

If the live check fails, report only the JSON fields emitted by the script.
Never inspect or print `~/.config/whatbox-mcp/local.env` or
`~/.local/state/whatbox-mcp/approval.key`.

## Claude Code continuation prompt

Use this document as the source of truth. Start by running `git status`, then
read `README.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`, and the relevant source
and tests. Preserve the read-only boundary and all existing working-tree
changes. Implement only the next bounded internal deployment primitive, keep
it unregistered until negotiated approval and denial-path coverage exist, and
finish by running the validation checklist above without opening either
private local file.
