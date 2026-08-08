# Agent Usage Guide

Whatbox MCP is designed for local AI agents that need structured, bounded
access to one owner-authorized Whatbox slot. It uses stdio transport and never
accepts credentials in tool arguments.

For human operator setup, SSH-agent loading, and reboot-to-launch commands, use
the [Startup Guide](STARTUP.md). Codex starts the registered `stdio` process;
the operator should not run a second manual server process during normal use.

## Recommended agent workflow

1. Read the `whatbox://guide/agent-operations` MCP resource.
2. Call `server_info` and `list_capabilities` to confirm version, available
   tools, safety state, and planned features.
3. Call `whatbox_configuration_status`. If it is not configured, stop and ask
   the user to follow `docs/LOCAL_CONFIGURATION.md`; never ask for values.
4. Call `whatbox_operational_snapshot` for the preferred consolidated view.
5. Use focused tools only when the task requires more detail.
6. Report observed facts separately from recommendations. A running process is
   not proof of health.
7. Treat `executionEnabled: false` as authoritative. Deployment plans are
   previews, not permission or execution capability.

Agents may also invoke the `whatbox_safe_audit` prompt with a `focus` of
`full`, `storage`, `services`, or `website`.

## Tool selection

| Need | Preferred tool |
| --- | --- |
| One consolidated assessment | `whatbox_operational_snapshot` |
| Configuration readiness | `whatbox_configuration_status` |
| SSH reachability | `whatbox_connection_status` |
| Storage capacity | `whatbox_storage_status` |
| Bounded directory entries | `whatbox_list_directory` |
| Directory-only topology | `whatbox_structure_map` |
| Supported torrent process state | `whatbox_torrent_clients_status` |
| Allowlisted service metadata | `whatbox_services_status` |
| Advisory findings | `whatbox_configuration_review` |
| Website-hosting facts | `whatbox_website_readiness` |
| Nginx syntax, loopback response, and redacted error counts | `whatbox_website_diagnostics` |
| Static-site plan preview | `whatbox_website_deployment_plan` |

Tool results include `structuredContent` and declared output schemas for agent
validation. JSON is also returned in a text block for older MCP clients.

## Agent safety policy

- Never request, display, summarize, or copy `local.env`, SSH keys, agent
  socket values, passwords, passphrases, cookies, connection strings, or the
  approval key.
- Never ask the user to paste raw SSH output. Use repository check scripts and
  share only their sanitized JSON.
- Never construct or request a generic shell command.
- Never treat tool annotations as authorization.
- Never treat a boolean, typed confirmation phrase, or model-generated text as
  human approval.
- Never infer service health from process state alone.
- Never request Nginx configuration text, HTTP response bodies, or raw log
  lines when `whatbox_website_diagnostics` can return bounded facts.
- Never traverse a path outside configured roots or follow a symlink escape.

## Mutation status

Remote mutations are disabled unless the operator sets
`WHATBOX_MUTATIONS_ENABLED=true` in the private local configuration. When
disabled, every mutation tool returns a `mutations_disabled` denial and only the
read-only and planning tools do anything.

When enabled, each mutation tool enforces:

1. exact canonical target digests and no wildcard expansion;
2. an immutable HMAC-signed plan carried as MCP `requestState`;
3. slot/action/target matching and short expiry checks;
4. atomic one-time plan consumption;
5. a redacted local audit log of every planned, requested, approved, denied,
   executed, and failed step.

Reversible actions run once the plan is created. Destructive actions
(`whatbox_quarantine_path`, `whatbox_purge_quarantine`, stop/restart via
`whatbox_service_control`, `whatbox_website_rollback`, `whatbox_torrent_remove`)
additionally require negotiated MCP `input_required` elicitation with an
explicit accepted human response. A boolean, typed phrase, or model-generated
text is never sufficient. Deletion quarantines first; permanent purge is a
separate second approval.

Agents should call `whatbox_list_tools` (or read `whatbox://guide/tools`) to see
the current catalog and whether mutations are enabled before attempting a change.

## External provider boundaries

Whatbox Manage Apps, managed links, DNS, domains, billing, plan details, and
provider account settings are not SSH operations. An agent must present them as
explicit user/provider steps unless a separate authorized integration exists.

Official Whatbox documentation confirms that userland Nginx is configured and
started within the user's account, while managed links are configured through
the Whatbox Manage interface. Torrent-client APIs also have distinct
authentication and should not be inferred from the SSH identity.

## Sanitized local validation

```bash
npm run typecheck
npm test
npm run build
npm run check:config
npm run check:connection
npm run check:snapshot
npm run check:website-diagnostics
```

Do not enable shell tracing around live checks. If a live check fails, retain
only its safe failure category and stage.
