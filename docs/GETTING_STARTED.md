# Getting Started — Whatbox MCP

A bullet-point walkthrough, install first. For narrative detail see
[INSTALL.md](INSTALL.md), [STARTUP.md](STARTUP.md), and
[LOCAL_CONFIGURATION.md](LOCAL_CONFIGURATION.md). For a one-screen command
reference see [HOTSHEET.md](HOTSHEET.md).

## 1. Install

- Confirm prerequisites:
  - `node --version` → 20 or newer
  - `git --version`
  - an active Whatbox slot with SSH access
- Clone and build:
  - `git clone https://github.com/SNSEIxAUGMNTD/whatbox-mcp.git`
  - `cd whatbox-mcp`
  - `npm ci`
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
- Note the absolute path to `dist/index.js` (run `pwd`, append `/dist/index.js`).

## Platform support

The server is plain Node.js 20+ and runs on **macOS, Linux, and Windows**. What
differs per OS is how you load the SSH key and where the private config lives.

| Platform | Status | SSH agent | Config path |
| --- | --- | --- | --- |
| macOS | ✅ native | `ssh-add --apple-use-keychain` | `~/.config/whatbox-mcp/local.env` |
| Linux | ✅ native | `eval "$(ssh-agent -s)"` then `ssh-add` | `~/.config/whatbox-mcp/local.env` |
| Windows (native) | ✅ native | OpenSSH Agent service (auto-detected) | `C:\Users\<you>\.config\whatbox-mcp\local.env` |
| Windows (WSL2) | ✅ native | same as Linux, inside WSL | `~/.config/whatbox-mcp/local.env` (inside WSL) |

**Windows — native.** Works out of the box: the server auto-detects the Windows
OpenSSH Agent named pipe (no `SSH_AUTH_SOCK` needed), and the owner-only config
check is skipped on Windows, where NTFS ACLs govern access instead of POSIX
bits. In PowerShell, enable the agent once and add your key:
```powershell
Get-Service ssh-agent | Set-Service -StartupType Automatic
Start-Service ssh-agent
ssh-add $env:USERPROFILE\.ssh\whatbox_mcp_ed25519
```
Optional hardening — lock the config to just your account:
```powershell
icacls "$env:USERPROFILE\.config\whatbox-mcp\local.env" /inheritance:r /grant:r "$($env:USERNAME):F"
```

**Windows — WSL2.** If you prefer a Unix environment, install WSL2 and follow
the Linux steps inside your distro; run your MCP client from inside WSL too.

**Linux/WSL launch** (each new shell, if the agent isn't already running):
`eval "$(ssh-agent -s)" && ssh-add ~/.ssh/whatbox_mcp_ed25519 && ssh-add -l`.

## 2. Create a dedicated SSH key

- `ssh-keygen -t ed25519 -f ~/.ssh/whatbox_mcp_ed25519`
- Add the **public** key to your slot: paste `~/.ssh/whatbox_mcp_ed25519.pub`
  into `~/.ssh/authorized_keys` on Whatbox (via the Manage file browser or an
  existing SSH session).
- Load the private key into your local agent:
  - macOS: `ssh-add --apple-use-keychain ~/.ssh/whatbox_mcp_ed25519`
  - Linux/WSL: `eval "$(ssh-agent -s)" && ssh-add ~/.ssh/whatbox_mcp_ed25519`
- Confirm it is loaded: `ssh-add -l` (prints a fingerprint, never the key).

## 3. Pin the host fingerprint

- Get Whatbox's SHA-256 host-key fingerprint from a trusted source (your
  existing `~/.ssh/known_hosts`, or Whatbox support).
- Keep it in `SHA256:...` form for the next step. Never disable this check.

## 4. Configure locally (never in the repo)

- Create the private config:
  - `mkdir -p ~/.config/whatbox-mcp && chmod 700 ~/.config/whatbox-mcp`
  - `touch ~/.config/whatbox-mcp/local.env && chmod 600 ~/.config/whatbox-mcp/local.env`
- Fill in these variable **names** (values stay local, never pasted into chat):
  - Required: `WHATBOX_HOST`, `WHATBOX_USERNAME`, `WHATBOX_HOST_FINGERPRINT_SHA256`
  - Auth: `WHATBOX_SSH_AUTH_MODE=agent` (recommended)
  - Optional scope: `WHATBOX_ALLOWED_ROOTS`, `WHATBOX_WEBSITE_SOURCE_ROOTS`,
    `WHATBOX_WEBSITE_HEALTH_PORT`
- Verify without printing secrets:
  - `npm run check:config`
  - `npm run check:connection`
  - `npm run check:snapshot`

## 5. Connect an AI client

- Codex CLI:
  - `codex mcp add whatbox -- node /absolute/path/to/whatbox-mcp/dist/index.js`
  - `codex mcp get whatbox`
- Claude Code:
  - `claude mcp add --scope user whatbox -- node /absolute/path/to/whatbox-mcp/dist/index.js`
- Ask the client to read `whatbox://guide/agent-operations`, then call
  `whatbox_operational_snapshot`.
- List every capability any time with the `/tools` command (backed by
  `whatbox_list_tools`) or by reading `whatbox://guide/tools`.

## 6. Stay read-only, or enable mutations

- **Default: read-only.** Every inspection tool works with no extra config.
- To allow changes, add to `local.env`:
  - `WHATBOX_MUTATIONS_ENABLED=true` — master switch (omit it to stay read-only)
  - `WHATBOX_DOWNLOAD_DIR=~/Downloads/whatbox` — where downloads/backups land
  - For torrents: `WHATBOX_TORRENT_CLIENT` (`transmission` or `qbittorrent`)
    and `WHATBOX_TORRENT_RPC_PORT` (plus `..._USERNAME` / `..._PASSWORD` if set)
- Safety that always holds, even in agent auto-mode:
  - Reversible actions (upload, move, mkdir, backup, deploy, torrent add/control)
    run once a signed plan is created.
  - **Destructive actions always stop and ask you** — deletion, purge, service
    stop/restart, website rollback, torrent remove. A model cannot self-approve.
  - Deletion **quarantines** first; permanent purge is a separate second approval.
  - Free space is checked before every upload, download, backup, and deploy.

## 7. Everyday launch (after a reboot)

- Load the key: `ssh-add --apple-load-keychain` (macOS) or re-run `ssh-add`.
- Confirm: `ssh-add -l`
- Start your client (`codex` / Claude Code). It launches the MCP for you.

## Golden rules

- Never paste `local.env`, private keys, passphrases, the approval key, or raw
  SSH output into chat, issues, or commits.
- The MCP cannot reach Whatbox billing, Manage Apps, managed links, DNS, or
  another customer's files — those stay manual, browser-only steps.
- Keep allowed roots as narrow as possible.
