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

The server loads this file only from the local machine when a Whatbox tool is
called. It does not read a repository `.env` file and does not expose
configuration values in MCP tool responses.

After configuration and connection checks pass, verify the fixed read-only
checks without printing private configuration or raw SSH diagnostics:

```bash
npm run check:storage
npm run check:directory
npm run check:snapshot
```

`check:snapshot` is the preferred consolidated acceptance check for agent use.
It reports storage pressure, allowlisted service state, website readiness,
recommendations, and explicit mutation safety state without returning configured
remote root paths.
