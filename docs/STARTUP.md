# Startup Guide

This guide explains how to start Whatbox MCP after installation, after opening
a new terminal, and after restarting the computer. It uses Codex CLI as the
main example.

## Understand what starts what

Whatbox MCP is a local `stdio` server. After it is registered, Codex starts the
server process when it needs it. You do not normally keep `npm start` running
in a second terminal.

There are three separate pieces:

1. The repository contains the source code and compiled `dist/index.js` file.
2. The SSH agent holds an unlocked SSH identity for the current login session.
3. Codex stores the command that launches `dist/index.js`.

The SSH agent in this guide is the operating system process that manages SSH
keys. It is separate from the AI agent using the MCP.

## One-time setup

Complete these steps once after cloning the repository.

### 1. Install and build

```bash
cd /absolute/path/to/whatbox-mcp
npm ci
npm run typecheck
npm test
npm run build
```

The build creates `dist/index.js`. Codex runs this compiled file.

### 2. Verify private configuration

Create `~/.config/whatbox-mcp/local.env` as described in
[Local Configuration](LOCAL_CONFIGURATION.md), then run:

```bash
npm run check:config
```

The check reports only safe status fields. Do not print or paste the private
configuration file.

### 3. Choose how macOS loads the SSH key

The recommended macOS option stores the key's passphrase in Apple Keychain.
Run this locally once:

```bash
ssh-add --apple-use-keychain ~/.ssh/whatbox_mcp_ed25519
```

Type the passphrase only into the hidden terminal prompt. Do not place it in
the command, an environment file, Git, an issue, or a chat.

If Apple Keychain should not store the passphrase, use this instead whenever
the key needs to be loaded:

```bash
ssh-add ~/.ssh/whatbox_mcp_ed25519
```

### 4. Register the server with Codex

Use the absolute path to the compiled entry point:

```bash
codex mcp add whatbox -- node /absolute/path/to/whatbox-mcp/dist/index.js
codex mcp get whatbox
```

This is a one-time registration. It contains a local program path, not
credentials. Do not add `local.env`, key contents, or passphrases to the MCP
command.

If the repository is later moved, replace the old registration:

```bash
codex mcp remove whatbox
codex mcp add whatbox -- node /new/absolute/path/to/whatbox-mcp/dist/index.js
```

## Start after restarting a Mac

### Apple Keychain workflow

Open Terminal and run:

```bash
ssh-add --apple-load-keychain
ssh-add -l
cd /absolute/path/to/whatbox-mcp
npm run check:connection
codex
```

What each command does:

1. `ssh-add --apple-load-keychain` loads identities previously saved in Apple
   Keychain into the current SSH agent.
2. `ssh-add -l` confirms that an identity is loaded. It prints fingerprints,
   not private-key material.
3. `cd` opens the repository so Codex has the project context.
4. `npm run check:connection` performs an optional sanitized connection test.
5. `codex` starts Codex CLI. Codex starts the registered MCP automatically
   when it connects to or invokes it.

If the first command says that the agent has no identities, the key was not
saved in Apple Keychain. Load and save it once:

```bash
ssh-add --apple-use-keychain ~/.ssh/whatbox_mcp_ed25519
```

Then confirm with `ssh-add -l` and continue. Never share that output when
support only needs to know whether a key is present.

### Manual-passphrase workflow

If the key is not stored in Apple Keychain, run:

```bash
ssh-add ~/.ssh/whatbox_mcp_ed25519
ssh-add -l
cd /absolute/path/to/whatbox-mcp
npm run check:connection
codex
```

The first command asks for the key passphrase locally. Terminal intentionally
shows no characters while it is typed.

## Start in a new terminal without restarting

The loaded identity normally remains available for the current macOS login
session. Check before adding it again:

```bash
ssh-add -l
```

If the expected identity is listed, start Codex directly:

```bash
cd /absolute/path/to/whatbox-mcp
codex
```

If the agent has no identities, use the Keychain or manual loading command
from the previous section first.

## Linux or WSL startup

Apple Keychain commands are macOS-specific. On Linux or WSL, start or reuse an
SSH agent, load the dedicated key, and then launch Codex:

```bash
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/whatbox_mcp_ed25519
ssh-add -l
cd /absolute/path/to/whatbox-mcp
npm run check:connection
codex
```

Desktop environments may already provide an SSH agent. If `ssh-add -l` works,
do not start a second one.

## Confirm the MCP is ready

Before opening Codex, inspect the saved registration if needed:

```bash
codex mcp get whatbox
```

Inside Codex, ask it to call `server_info` or
`whatbox_configuration_status`. A successful `server_info` call proves that
Codex started the MCP process. A successful `whatbox_connection_status` call
also proves that the MCP can use the loaded SSH identity.

## After changing or updating the code

Codex runs `dist/index.js`, so source changes do not take effect until the
project is rebuilt:

```bash
cd /absolute/path/to/whatbox-mcp
npm run typecheck
npm test
npm run build
```

Exit and reopen Codex after rebuilding so it starts the new process. A normal
computer restart does not require `npm ci` or a rebuild unless dependencies or
source code changed.

## Manual server commands

These commands are for development and protocol debugging:

```bash
npm run dev
npm start
```

Both commands start a `stdio` server and wait for an MCP client. A blank or
apparently idle terminal is expected. Press `Control-C` to stop it. Do not run
either command separately during ordinary Codex use.

## Troubleshooting

### `The agent has no identities`

Load the key with `ssh-add --apple-load-keychain`,
`ssh-add --apple-use-keychain ~/.ssh/whatbox_mcp_ed25519`, or the manual
`ssh-add` command, depending on the chosen workflow.

### `Could not open a connection to your authentication agent`

Open a new Terminal window in the signed-in desktop session and retry
`ssh-add -l`. On Linux or WSL, start an agent with `eval "$(ssh-agent -s)"`.

### The connection check fails

Use only the sanitized result from:

```bash
npm run check:config
npm run check:connection
```

An authentication-stage failure commonly means the identity is not loaded. A
DNS- or TCP-stage failure is separate from the key. Do not use shell tracing
or paste raw SSH debug output.

### Codex cannot find the MCP

Check the registration and build output:

```bash
codex mcp get whatbox
test -f /absolute/path/to/whatbox-mcp/dist/index.js && echo "build present"
```

If the build is missing, run `npm run build`. If the repository moved, remove
and add the registration again using the new absolute path.

## Security reminders

- The private key and its passphrase are secrets; a public-key fingerprint is
  an identifier, not the private key.
- Never paste `local.env`, private keys, passphrases, raw SSH diagnostics, or
  approval-state files into chat, issues, or commits.
- Do not put credentials in `codex mcp add --env` options. This server loads
  its protected local configuration itself.
- The current server is read-only. A deployment plan is a preview and cannot
  execute remote changes.
