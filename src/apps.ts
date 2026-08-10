// Approval-gated, SHA-256-pinned application install templates.
//
// Every manifest is committed, server-authored data — never model-authored and
// never a caller-supplied URL. Installing downloads a pinned artifact on the
// slot, verifies its SHA-256 before anything is extracted or executed, refuses
// to overwrite an existing install, and registers the app the way the Whatbox
// wiki documents (screen + crontab keepalive). Uninstall is reversible: it
// stops the process, removes only this app's cron lines, and moves the files
// into a dated home-level quarantine rather than deleting them.
//
// Artifacts are pinned for linux-amd64 (Whatbox slots are x86_64). Hashes are
// the upstream-published SHA-256 for the exact pinned version.

import { z } from "zod";

const artifactSchema = z.object({
  url: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
});

const appManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  name: z.string().min(1),
  category: z.enum(["media-server", "backup", "utility", "automation"]),
  summary: z.string().min(1),
  version: z.string().min(1),
  fetch: z.object({
    kind: z.enum(["tar.gz", "tar.xz", "zip", "raw"]),
    artifact: artifactSchema
  }),
  // Home-relative path whose existence means "installed" — the never-overwrite
  // guard checks it. Directory for service apps, binary path for utilities.
  marker: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/),
  // Service apps extract into this home-relative directory.
  installDir: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,64}$/).optional(),
  // Utilities place a single binary; archivePath is relative to the extracted
  // archive (omit for a raw single-binary download).
  binary: z
    .object({
      archivePath: z.string().optional(),
      target: z.string().regex(/^bin\/[A-Za-z0-9._-]{1,64}$/)
    })
    .optional(),
  config: z
    .object({
      // May include one subdirectory (e.g. data/config.xml); committed data,
      // so no traversal guard beyond the character class is needed.
      path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,128}$/),
      content: z.string()
    })
    .optional(),
  service: z
    .object({
      start: z.string().min(1),
      processMatch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,128}$/),
      cron: z.boolean(),
      port: z.boolean()
    })
    .optional(),
  manualStep: z.string().optional(),
  notes: z.string().optional()
});

export type AppManifest = z.infer<typeof appManifestSchema>;

// -- The committed registry --------------------------------------------------

const RAW_MANIFESTS: AppManifest[] = [
  {
    id: "navidrome",
    name: "Navidrome",
    category: "media-server",
    summary: "Self-hosted music streamer; serves your library over the web.",
    version: "0.63.2",
    fetch: {
      kind: "tar.gz",
      artifact: {
        url: "https://github.com/navidrome/navidrome/releases/download/v0.63.2/navidrome_0.63.2_linux_amd64.tar.gz",
        sha256:
          "224c6d6fe5cc11a9c9387b97988666423de38bb5ef2e2f43ecc43d0a3dded4f0"
      }
    },
    marker: "navidrome",
    installDir: "navidrome",
    config: {
      path: "navidrome.toml",
      content: [
        "DataFolder = '{{HOME}}/navidrome'",
        "MusicFolder = '{{MUSIC}}'",
        "LogLevel = 'INFO'",
        "Port = '{{PORT}}'",
        "Address = '127.0.0.1'",
        ""
      ].join("\n")
    },
    service: {
      start:
        "screen -dmS navidrome {{HOME}}/navidrome/navidrome -c {{HOME}}/navidrome/navidrome.toml",
      processMatch: "navidrome/navidrome",
      cron: true,
      port: true
    },
    manualStep:
      "Add port {{PORT}} as a custom app on the Whatbox Manage Links page to reach Navidrome over HTTPS.",
    notes: "MusicFolder defaults to ~/files; override with the musicFolder input."
  },
  {
    id: "rclone",
    name: "rclone",
    category: "backup",
    summary: "Encrypted sync/copy of your slot to any cloud. CLI, no daemon.",
    version: "1.75.0",
    fetch: {
      kind: "zip",
      artifact: {
        url: "https://github.com/rclone/rclone/releases/download/v1.75.0/rclone-v1.75.0-linux-amd64.zip",
        sha256:
          "aa2804e08f48250e71009c727124b6341cd0288465804a9a09d14663cabafbaa"
      }
    },
    marker: "bin/rclone",
    binary: {
      archivePath: "rclone-v1.75.0-linux-amd64/rclone",
      target: "bin/rclone"
    },
    manualStep:
      "Ensure ~/bin is on your PATH, then run `rclone config` over SSH to add a remote. Use `rclone copy`/`sync` — do not mount.",
    notes: "No daemon, port, or cron: rclone is a command-line tool."
  },
  {
    id: "yt-dlp",
    name: "yt-dlp",
    category: "utility",
    summary: "Media downloader. Standalone binary, no Python dependency.",
    version: "2026.07.04",
    fetch: {
      kind: "raw",
      artifact: {
        url: "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_linux",
        sha256:
          "6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae"
      }
    },
    marker: "bin/yt-dlp",
    binary: { target: "bin/yt-dlp" },
    manualStep: "Ensure ~/bin is on your PATH, then run `yt-dlp <url>` over SSH.",
    notes: "Pairs with ffmpeg for merging/transcoding."
  },
  {
    id: "sonarr",
    name: "Sonarr",
    category: "automation",
    summary: "TV series library manager and PVR for Usenet/torrents.",
    version: "4.0.19.2979",
    fetch: {
      kind: "tar.gz",
      artifact: {
        url: "https://github.com/Sonarr/Sonarr/releases/download/v4.0.19.2979/Sonarr.main.4.0.19.2979.linux-x64.tar.gz",
        sha256:
          "b691b3584c31c0b5514058dee81071c923f63d59a37d19e32f92fa13eaa153db"
      }
    },
    marker: "sonarr",
    installDir: "sonarr",
    config: {
      path: "data/config.xml",
      content: [
        "<Config>",
        "  <Port>{{PORT}}</Port>",
        "  <BindAddress>127.0.0.1</BindAddress>",
        "  <UrlBase></UrlBase>",
        "  <LaunchBrowser>False</LaunchBrowser>",
        "  <AnalyticsEnabled>False</AnalyticsEnabled>",
        "</Config>",
        ""
      ].join("\n")
    },
    service: {
      start:
        "screen -dmS sonarr {{HOME}}/sonarr/Sonarr/Sonarr -nobrowser -data={{HOME}}/sonarr/data",
      processMatch: "sonarr/Sonarr/Sonarr",
      cron: true,
      port: true
    },
    manualStep:
      "Add port {{PORT}} as a custom app on the Manage Links page, then finish setup (indexers, auth) in Sonarr's web UI.",
    notes: "Self-contained .NET build; no external runtime. Data + DB live in ~/sonarr/data."
  },
  {
    id: "radarr",
    name: "Radarr",
    category: "automation",
    summary: "Movie library manager and PVR for Usenet/torrents.",
    version: "6.3.0.10514",
    fetch: {
      kind: "tar.gz",
      artifact: {
        url: "https://github.com/Radarr/Radarr/releases/download/v6.3.0.10514/Radarr.master.6.3.0.10514.linux-core-x64.tar.gz",
        sha256:
          "41d6455c037ff267c5ad5a0f0de4502cebe8f89ec3d051da97851933d48a4047"
      }
    },
    marker: "radarr",
    installDir: "radarr",
    config: {
      path: "data/config.xml",
      content: [
        "<Config>",
        "  <Port>{{PORT}}</Port>",
        "  <BindAddress>127.0.0.1</BindAddress>",
        "  <UrlBase></UrlBase>",
        "  <LaunchBrowser>False</LaunchBrowser>",
        "  <AnalyticsEnabled>False</AnalyticsEnabled>",
        "</Config>",
        ""
      ].join("\n")
    },
    service: {
      start:
        "screen -dmS radarr {{HOME}}/radarr/Radarr/Radarr -nobrowser -data={{HOME}}/radarr/data",
      processMatch: "radarr/Radarr/Radarr",
      cron: true,
      port: true
    },
    manualStep:
      "Add port {{PORT}} as a custom app on the Manage Links page, then finish setup (indexers, auth) in Radarr's web UI.",
    notes: "Self-contained .NET build; no external runtime. Data + DB live in ~/radarr/data."
  }
];

export const APP_MANIFESTS: AppManifest[] = RAW_MANIFESTS.map((manifest) =>
  appManifestSchema.parse(manifest)
);

export function getAppManifest(id: string): AppManifest | undefined {
  return APP_MANIFESTS.find((manifest) => manifest.id === id);
}

export function listAppIds(): string[] {
  return APP_MANIFESTS.map((manifest) => manifest.id);
}

// -- Pure helpers ------------------------------------------------------------

/** POSIX single-quote a value for safe embedding in a shell command. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface InstallContext {
  home: string;
  port?: number;
  musicFolder?: string;
}

function substitute(template: string, context: InstallContext): string {
  return template
    .replaceAll("{{HOME}}", context.home)
    .replaceAll("{{PORT}}", String(context.port ?? ""))
    .replaceAll("{{MUSIC}}", context.musicFolder ?? `${context.home}/files`);
}

const CRON_MARKER = (id: string) => `# whatbox-mcp:${id}`;

/**
 * Assemble the server-authored install script for a manifest. The script
 * fails closed: `set -eu` plus an up-front marker check and a `sha256sum -c`
 * gate mean a hash mismatch or an existing install aborts before anything is
 * extracted or run.
 */
export function buildInstallScript(
  manifest: AppManifest,
  context: InstallContext
): string {
  const home = context.home;
  const marker = `${home}/${manifest.marker}`;
  const { url, sha256 } = manifest.fetch.artifact;

  const lines = [
    "set -eu",
    `MARKER=${shellQuote(marker)}`,
    'if [ -e "$MARKER" ]; then echo "already-installed"; exit 3; fi',
    `mkdir -p ${shellQuote(`${home}/bin`)}`,
    'TMP="$(mktemp -d)"',
    "trap 'rm -rf \"$TMP\"' EXIT",
    'cd "$TMP"',
    `wget -q -O artifact ${shellQuote(url)}`,
    `echo ${shellQuote(`${sha256}  artifact`)} | sha256sum -c -`
  ];

  const installDir = manifest.installDir
    ? `${home}/${manifest.installDir}`
    : undefined;
  if (installDir) {
    lines.push(`mkdir -p ${shellQuote(installDir)}`);
  }

  // Extract to the install directory, or to the temp dir when we only need to
  // pull a single binary out of the archive.
  const extractTarget = installDir ? shellQuote(installDir) : '"$TMP/x"';
  if (!installDir) {
    lines.push('mkdir -p "$TMP/x"');
  }
  if (manifest.fetch.kind === "tar.gz") {
    lines.push(`tar xzf artifact -C ${extractTarget}`);
  } else if (manifest.fetch.kind === "tar.xz") {
    lines.push(`tar xJf artifact -C ${extractTarget}`);
  } else if (manifest.fetch.kind === "zip") {
    lines.push(`unzip -q artifact -d ${extractTarget}`);
  }

  if (manifest.binary) {
    const source =
      manifest.fetch.kind === "raw"
        ? "artifact"
        : `"$TMP/x"/${substitute(manifest.binary.archivePath ?? "", context)}`;
    lines.push(
      `install -m 755 ${source} ${shellQuote(`${home}/${manifest.binary.target}`)}`
    );
  }

  if (manifest.config && installDir) {
    const target = `${installDir}/${manifest.config.path}`;
    const parent = target.slice(0, target.lastIndexOf("/"));
    lines.push(`mkdir -p ${shellQuote(parent)}`);
    const content = substitute(manifest.config.content, context);
    const encoded = Buffer.from(content, "utf8").toString("base64");
    lines.push(
      `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(target)}`
    );
  }

  if (manifest.service) {
    const start = substitute(manifest.service.start, context);
    if (manifest.service.cron) {
      const marker = CRON_MARKER(manifest.id);
      const boot = `@reboot ${start} ${marker}`;
      const keepalive = `*/5 * * * * pgrep -f ${manifest.service.processMatch} >/dev/null || ${start} ${marker}`;
      lines.push(
        `(crontab -l 2>/dev/null | grep -vF ${shellQuote(marker)}; echo ${shellQuote(boot)}; echo ${shellQuote(keepalive)}) | crontab -`
      );
    }
    lines.push(start);
  }

  lines.push("echo INSTALL_OK");
  return lines.join("\n");
}

/**
 * One read-only command that reports each service app's process state as
 * "<id> running" / "<id> stopped". Utilities have no service and are omitted.
 */
export function buildRunningProbeScript(manifests: AppManifest[]): string {
  const lines = ["set -u"];
  for (const manifest of manifests) {
    if (!manifest.service) {
      continue;
    }
    lines.push(
      `if pgrep -f ${shellQuote(manifest.service.processMatch)} >/dev/null 2>&1; then echo ${shellQuote(`${manifest.id} running`)}; else echo ${shellQuote(`${manifest.id} stopped`)}; fi`
    );
  }
  return lines.join("\n");
}

export function parseAppRunningStates(output: string): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const line of output.split(/\r?\n/)) {
    const [id, state] = line.trim().split(/\s+/);
    if (id && (state === "running" || state === "stopped")) {
      states.set(id, state === "running");
    }
  }
  return states;
}

/**
 * Restart a service app: kill the process and relaunch it. The cron keepalive
 * would also respawn it within the interval; restarting makes that immediate
 * (e.g. after a config change). The start command references the app's own
 * config file, so no runtime-only values need re-substituting.
 */
export function buildRestartScript(
  manifest: AppManifest,
  context: InstallContext
): string {
  if (!manifest.service) {
    throw new Error("This app has no service to restart");
  }
  return [
    "set -u",
    `pkill -f ${shellQuote(manifest.service.processMatch)} || true`,
    "sleep 1",
    substitute(manifest.service.start, context),
    "echo RESTART_OK"
  ].join("\n");
}

/**
 * Assemble the reversible uninstall script: stop the process, strip only this
 * app's cron lines, and move its files into a dated home-level quarantine.
 */
export function buildUninstallScript(
  manifest: AppManifest,
  context: InstallContext
): string {
  const home = context.home;
  const marker = CRON_MARKER(manifest.id);
  const quarantine = `${home}/.whatbox-quarantine/apps`;
  const paths: string[] = [];
  if (manifest.installDir) {
    paths.push(`${home}/${manifest.installDir}`);
  }
  if (manifest.binary) {
    paths.push(`${home}/${manifest.binary.target}`);
  }

  const lines = ["set -u"];
  if (manifest.service) {
    lines.push(`pkill -f ${shellQuote(manifest.service.processMatch)} || true`);
    if (manifest.service.cron) {
      lines.push(
        `crontab -l 2>/dev/null | grep -vF ${shellQuote(marker)} | crontab - || true`
      );
    }
  }
  lines.push(`DEST=${shellQuote(quarantine)}/"$(date +%Y-%m-%d_%H%M%S)"`);
  lines.push('mkdir -p "$DEST"');
  for (const path of paths) {
    lines.push(`[ -e ${shellQuote(path)} ] && mv ${shellQuote(path)} "$DEST"/ || true`);
  }
  lines.push("echo UNINSTALL_OK");
  return lines.join("\n");
}
