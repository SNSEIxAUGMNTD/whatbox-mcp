# Installation Guide

This guide installs Whatbox MCP as a local stdio server. The MCP client starts
the process on your computer; credentials stay outside the repository and are
used only for the owner-authorized Whatbox slot you configure.

After installation, use the [Startup Guide](STARTUP.md) for the exact commands
to run after restarting the computer or opening a new terminal.

## Requirements

- macOS, Linux, or Windows with WSL;
- Node.js 20 or newer;
- Git;
- an active Whatbox slot with SSH access;
- a dedicated SSH key loaded into a local SSH agent;
- a locally verified Whatbox SSH host-key fingerprint.

Check the local prerequisites:

```bash
node --version
npm --version
git --version
ssh-add -l
```

Do not paste the output of `ssh-add -l`, private keys, passphrases, or Whatbox
connection values into chat, issues, or support requests.

## Install from GitHub

Source installation is the supported installation method until the package is
published to npm.

```bash
git clone https://github.com/SNSEIxAUGMNTD/whatbox-mcp.git
cd whatbox-mcp
npm ci
npm run typecheck
npm test
npm run build
```

The built MCP entry point is the absolute path to `dist/index.js` inside the
clone. Obtain the path without copying configuration values:

```bash
pwd
```

Append `/dist/index.js` to that path when configuring an MCP client.

## npm installation status

The package name is `whatbox-mcp`, but it is not documented as npm-installable
until a release is actually published. After publication, this section can be
updated to support:

```bash
npm install --global whatbox-mcp
```

Do not assume the registry package exists solely because `package.json`
contains a package name.

## Configure secrets locally

Create the private configuration directory and file:

```bash
mkdir -p ~/.config/whatbox-mcp
chmod 700 ~/.config/whatbox-mcp
touch ~/.config/whatbox-mcp/local.env
chmod 600 ~/.config/whatbox-mcp/local.env
```

Copy the variable names from `.env.example` into that file and fill them in
locally. Never put real values in the repository or paste them into an AI chat.

The recommended authentication mode is `agent`. Add the dedicated private key
to the operating system's SSH agent before starting the MCP client. The server
does not accept credentials as tool arguments.

Configuration variables:

| Variable | Purpose |
| --- | --- |
| `WHATBOX_HOST` | Whatbox SSH host, stored locally |
| `WHATBOX_USERNAME` | Slot username, stored locally |
| `WHATBOX_SSH_PORT` | SSH port; defaults to `22` |
| `WHATBOX_SSH_AUTH_MODE` | `agent` recommended; `key` supported |
| `WHATBOX_SSH_KEY_PATH` | Required only for `key` mode |
| `WHATBOX_SSH_KEY_PASSPHRASE` | Optional; prefer the SSH agent instead |
| `WHATBOX_HOST_FINGERPRINT_SHA256` | Pinned verified host fingerprint |
| `WHATBOX_ALLOWED_ROOTS` | Comma-separated absolute remote roots |
| `WHATBOX_WEBSITE_SOURCE_ROOTS` | Optional comma-separated local static-site roots |
| `WHATBOX_WEBSITE_HEALTH_PORT` | Optional userland Nginx port; probed only through `127.0.0.1` without a response body |

Use the narrowest allowed roots possible. Filesystem root `/` is rejected.
See [Local Configuration](LOCAL_CONFIGURATION.md) for the full policy.

## Run sanitized acceptance checks

These scripts are designed not to print private connection values or raw SSH
diagnostics:

```bash
npm run check:config
npm run check:connection
npm run check:storage
npm run check:directory
npm run check:services
npm run check:website
npm run check:website-diagnostics
npm run check:snapshot
```

Share only the JSON emitted by these scripts. Do not enable shell tracing and
do not substitute raw `ssh -vvv` output.

## Connect Codex or ChatGPT desktop

The ChatGPT desktop app, Codex CLI, and Codex IDE extension share MCP
configuration on the same Codex host.

Using the Codex CLI, replace the example path with the absolute built path:

```bash
codex mcp add whatbox -- node /absolute/path/to/whatbox-mcp/dist/index.js
codex mcp get whatbox
```

Run `codex mcp add` once. During normal use, Codex launches the registered
`stdio` process automatically; do not run `npm start` in a separate terminal.

In the ChatGPT desktop app, open **Settings → MCP servers → Add server**,
choose **STDIO**, and use:

- name: `whatbox`;
- command: `node`;
- arguments: `/absolute/path/to/whatbox-mcp/dist/index.js`.

Save, restart the client, and use `/mcp` to inspect the connection. Local
configuration remains in `~/.config/whatbox-mcp/local.env`; do not copy it into
the MCP client configuration.

Continue with [Start after restarting a Mac](STARTUP.md#start-after-restarting-a-mac).

Official reference: [OpenAI MCP documentation](https://developers.openai.com/codex/mcp/).

## Connect Claude Code

Replace the example path with the absolute built path:

```bash
claude mcp add --scope user whatbox -- node /absolute/path/to/whatbox-mcp/dist/index.js
claude mcp get whatbox
claude mcp list
```

Use `--scope local` instead of `--scope user` if the server should be available
only in the current project. Claude Code may ask for approval before using a
project-scoped MCP server.

Official reference: [Claude Code MCP documentation](https://docs.anthropic.com/en/docs/claude-code/mcp).

## Connect another stdio MCP client

Clients that accept the common `mcpServers` JSON shape can use:

```json
{
  "mcpServers": {
    "whatbox": {
      "command": "node",
      "args": ["/absolute/path/to/whatbox-mcp/dist/index.js"]
    }
  }
}
```

Do not place secrets in the `env` object. The server loads its private local
configuration itself and checks its file permissions.

## Verify agent behavior

After connecting, ask the client to:

1. read `whatbox://guide/agent-operations`;
2. call `server_info` and confirm version `0.10.0`;
3. call `list_capabilities`;
4. call `whatbox_configuration_status`;
5. call `whatbox_operational_snapshot` if configuration is ready.

The server also provides the `whatbox_safe_audit` prompt. Remote mutations and
deployment execution remain disabled.

## Update

From the cloned repository:

```bash
git pull --ff-only
npm ci
npm run typecheck
npm test
npm run build
```

Restart the MCP client after rebuilding.

## Remove

Remove the MCP registration from the client. For example:

```bash
codex mcp remove whatbox
claude mcp remove whatbox
```

Removing the registration does not delete the clone or private local
configuration. Review those separately and remove them manually only when you
intend to revoke the integration. Revoke the dedicated SSH key on Whatbox if
the machine or key might have been exposed.

## Troubleshooting

### Server disconnects immediately

Run `npm run build`, verify Node.js 20+, and confirm the configured entry point
is the absolute path to `dist/index.js`.

### Configuration reports unavailable

Check file permissions locally with `ls -ld ~/.config/whatbox-mcp` and
`ls -l ~/.config/whatbox-mcp/local.env`. Do not share the file contents.

### SSH agent unavailable

Load the dedicated key into the same user session that launches the MCP client,
then restart the client. Do not move the private key into the repository.

### Safe check reports a connection failure

Use only the emitted `failure`, `stage`, and optional safe transport code for
troubleshooting. DNS, network, agent, authentication, host-verification, and
timeout failures are intentionally reported without raw error text.

### A write operation is requested

Mutations are disabled unless `WHATBOX_MUTATIONS_ENABLED=true` is set in the
private local configuration. When enabled, reversible actions run after a signed
plan is created and destructive actions (delete, purge, service stop/restart,
website rollback, torrent remove) additionally require explicit human approval
through the MCP client — a model-supplied confirmation is never sufficient. See
[Getting Started](GETTING_STARTED.md) and [HOTSHEET.md](HOTSHEET.md).
