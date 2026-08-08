# Whatbox MCP — Hotsheet

One-screen lookup for commands, tools, and processes. Full detail in
[GETTING_STARTED.md](GETTING_STARTED.md) and [AGENT_USAGE.md](AGENT_USAGE.md).

## Local commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install pinned dependencies |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the test suite |
| `npm run build` | Compile to `dist/` |
| `npm audit` | Dependency vulnerability check |
| `npm run check:config` | Sanitized local-config readiness |
| `npm run check:connection` | Sanitized SSH connectivity test |
| `npm run check:snapshot` | Consolidated read-only assessment |
| `npm run check:storage` / `:directory` / `:structure` | Storage / listing / map checks |
| `npm run check:services` / `:review` / `:torrent-clients` | Service / advisory / torrent checks |
| `npm run check:website` / `:website-diagnostics` | Website readiness / nginx diagnostics |

## Client / slash

| Action | How |
| --- | --- |
| List all tools + mutation state | `/tools` (or call `whatbox_list_tools`) |
| Read agent operating policy | resource `whatbox://guide/agent-operations` |
| Read tool catalog | resource `whatbox://guide/tools` |
| Guided safe audit | prompt `whatbox_safe_audit` (focus: full/storage/services/website) |
| First assessment | `whatbox_operational_snapshot` |

## Tools by risk

Legend: 🟢 read-only · 🔵 reversible (auto-runs when mutations enabled) ·
🔴 destructive (**always** asks for human approval).

### 🟢 Observe

| Tool | Does |
| --- | --- |
| `server_info` | Server metadata + version |
| `list_capabilities` | Tools, planned work, safety rules |
| `whatbox_list_tools` | This catalog + mutation state |
| `whatbox_configuration_status` | Local config completeness |
| `whatbox_connection_status` | Pinned SSH connectivity |
| `whatbox_operational_snapshot` | Storage + services + website + safety |
| `whatbox_storage_status` | Filesystem capacity per root |
| `whatbox_list_directory` | Bounded entries below a root |
| `whatbox_structure_map` | Directory-only map + Mermaid |
| `whatbox_services_status` | Configured/running services |
| `whatbox_torrent_clients_status` | Torrent client process state |
| `whatbox_torrents_status` | Torrent listing via loopback RPC |
| `whatbox_configuration_review` | Advisory findings |
| `whatbox_website_readiness` | Nginx hosting readiness |
| `whatbox_website_diagnostics` | Nginx syntax, loopback probe, error counts |
| `whatbox_website_deployment_plan` | Validate + sign a plan (no execution) |
| `whatbox_list_quarantine` | Items awaiting restore/purge |

### 🔵 Reversible (needs `WHATBOX_MUTATIONS_ENABLED=true`)

| Tool | Does |
| --- | --- |
| `whatbox_upload_path` | Upload local path; never overwrites |
| `whatbox_download_path` | Download to local download dir |
| `whatbox_move_path` | Move/rename within roots; never overwrites |
| `whatbox_make_directory` | Create directory + parents |
| `whatbox_backup_configuration` | Back up allowlisted service config |
| `whatbox_service_control` (start) | Start a service via its fixed start script |
| `whatbox_website_deploy_execute` | Stage → verify → activate → health-check |
| `whatbox_torrent_add` | Add a magnet/HTTP(S) torrent |
| `whatbox_torrent_control` | Pause/resume/label/ratio one torrent |

### 🔴 Destructive (always prompts, even in auto-mode)

| Tool | Does | Extra guard |
| --- | --- | --- |
| `whatbox_quarantine_path` | Soft-delete → dated quarantine | reversible via move |
| `whatbox_purge_quarantine` | Permanently delete a quarantined item | **second** approval |
| `whatbox_service_control` (stop/restart) | Stop or restart a service | — |
| `whatbox_website_rollback` | Repoint to a prior release | — |
| `whatbox_torrent_remove` | Remove torrent (± data) | — |

## Approval flow (destructive)

1. Tool call → server returns `input_required` with a signed plan + a yes/no prompt.
2. You approve or decline in the client UI (not the model).
3. On approve, the plan's action + exact targets are re-verified, consumed once,
   and executed. Missing / declined / expired / tampered / mismatched / reused
   approval all deny.
4. Every step is written to a redacted local audit log
   (`~/.local/state/whatbox-mcp/audit.log`).

## Boundaries (browser-only, not in this MCP)

Billing · Manage Apps · managed links / box.ca SSL · DNS & custom domains ·
another customer's files · anything needing root.

## Never share

`local.env` · private keys · passphrases · `approval.key` · raw SSH output.
