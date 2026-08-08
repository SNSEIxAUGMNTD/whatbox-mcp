# Local Configuration

The repository never stores credentials. Do not paste passwords, private keys,
API tokens, cookies, or connection strings into an issue, commit, chat, or
tool argument.

Use the following local directory on the machine that runs the MCP server:

```bash
mkdir -p ~/.config/whatbox-mcp
chmod 700 ~/.config/whatbox-mcp
touch ~/.config/whatbox-mcp/local.env
chmod 600 ~/.config/whatbox-mcp/local.env
```

Copy only the variable names from `.env.example` into that file and fill in
values locally. Never paste the values into chat. The recommended authentication
mode is `agent`, which keeps the private-key passphrase out of this file. Add a
dedicated key to your operating system's SSH agent before starting the MCP host.

On macOS, the key can be saved to Apple Keychain once with:

```bash
ssh-add --apple-use-keychain ~/.ssh/whatbox_mcp_ed25519
```

After a restart, load saved identities and confirm that one is available:

```bash
ssh-add --apple-load-keychain
ssh-add -l
```

If Apple Keychain is not used, run
`ssh-add ~/.ssh/whatbox_mcp_ed25519` after login and enter the passphrase only
at the hidden terminal prompt. See the [Startup Guide](STARTUP.md) for the
complete daily sequence.

`WHATBOX_HOST_FINGERPRINT_SHA256` pins the identity of the remote SSH server.
Obtain and verify the fingerprint locally using your existing OpenSSH
`known_hosts` entry or another trusted Whatbox source. Store it in OpenSSH's
`SHA256:...` format. Do not disable this check.

`WHATBOX_ALLOWED_ROOTS` is a comma-separated list of absolute remote paths. If
left blank, it defaults to `/home/<WHATBOX_USERNAME>/files`. Use the narrowest
roots that cover the data the MCP should inspect. The server rejects `/`.

`WHATBOX_WEBSITE_SOURCE_ROOTS` is an optional comma-separated list of local
directories allowed for static-site planning. Use narrow project directories,
not a home directory or filesystem root. The planner rejects symlinks,
credential-like names, unsupported entries, and files outside these roots. It
does not upload or deploy files.

`WHATBOX_WEBSITE_HEALTH_PORT` is an optional numeric port for userland Nginx.
When configured, the diagnostics tool probes only
`http://127.0.0.1:<port>/` from the Whatbox slot, discards the response body,
and returns a status code and latency. It never accepts a caller-supplied URL.

## Enabling mutations (optional)

Mutations are disabled by default. To allow the mutation tools to run, add these
to `local.env`:

`WHATBOX_MUTATIONS_ENABLED` — set to exactly `true` to enable mutations. Any
other value (or leaving it unset) keeps the server read-only. Even when enabled,
destructive actions still require explicit human approval every time.

`WHATBOX_DOWNLOAD_DIR` — a local directory where `whatbox_download_path` and
`whatbox_backup_configuration` write. It is created if missing. The filesystem
root is rejected. Downloads and backups return counts and sizes only; file
contents never enter the model context.

`WHATBOX_OBSERVE_ROOTS` — comma-separated directories the read-only
observation tools (directory listing, structure map, storage status) may look
at. Defaults to the slot home directory. Mutation tools never use this list;
they stay inside `WHATBOX_ALLOWED_ROOTS`. Sensitive directories (`.ssh`,
rclone and Deluge configuration, and similar credential locations) are always
excluded from observation regardless of this setting.

`WHATBOX_SHELL_ENABLED` — set to exactly `true` to enable the
`whatbox_run_command` tool. This is a separate switch from
`WHATBOX_MUTATIONS_ENABLED` and both must be `true` for the tool to run. Every
command requires human approval of the exact command text, is checked against
a denylist of destructive shapes, is bounded by a timeout, and is recorded in
the audit log — the exact command text and purpose, bound into the signed
plan. The denylist is a backstop, not the boundary: read the command before
approving it.

`WHATBOX_TORRENT_CLIENT` — set the client (`rtorrent`, `transmission`, or
`qbittorrent`) to enable the torrent tools. For `rtorrent` nothing else is
required: the SCGI endpoint is discovered from `~/.rtorrent.rc` and reached
over the existing SSH connection, so no torrent credentials exist at all.
`WHATBOX_TORRENT_RPC_SOCKET` (unix socket path) or `WHATBOX_TORRENT_RPC_PORT`
override discovery when set.

`WHATBOX_TORRENT_RPC_PORT` — required for `transmission` and `qbittorrent`:
their loopback RPC/WebUI port. The MCP reaches the RPC through an SSH loopback
tunnel; it never exposes the port publicly.

`WHATBOX_TORRENT_RPC_USERNAME` and `WHATBOX_TORRENT_RPC_PASSWORD` — optional
credentials for that RPC, if your client requires them. These are the torrent
client's own credentials and are distinct from the SSH identity; keep them in
`local.env` only, never in chat or tool arguments.

The variable names above are also listed in `.env.example`. Copy names only;
never commit real values.

The server loads this file only from the local machine when a Whatbox tool is
called. It does not read a repository `.env` file and does not expose
configuration values in MCP tool responses.

After configuration and connection checks pass, verify the fixed read-only
checks without printing private configuration or raw SSH diagnostics:

```bash
npm run check:storage
npm run check:directory
npm run check:website-diagnostics
npm run check:snapshot
```

`check:snapshot` is the preferred consolidated acceptance check for agent use.
It reports storage pressure, allowlisted service state, website readiness,
recommendations, and explicit mutation safety state without returning configured
remote root paths.

`check:website-diagnostics` runs a fixed Nginx syntax test, the optional
loopback probe, and a bounded error-log severity summary. It does not return
Nginx configuration text, HTTP response bodies, or log lines.
