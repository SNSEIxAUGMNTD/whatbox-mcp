import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { loadConfig, type WhatboxConfig } from "./config.js";
import {
  auditExecution,
  deniedText,
  gateMutation,
  type MutationContextLike,
  type MutationGateOutcome,
  type MutationRequest
} from "./mutation.js";
import { withWhatboxClient } from "./whatbox.js";
import {
  getAppManifest,
  listAppIds,
  buildInstallScript,
  type InstallContext
} from "./apps.js";
import {
  backupWhatboxConfiguration,
  BACKUP_TARGETS,
  assertShellCommandAllowed,
  installWhatboxApp,
  restartWhatboxApp,
  uninstallWhatboxApp,
  controlWhatboxService,
  runApprovedShellCommand,
  SHELL_MAX_TIMEOUT_SECONDS,
  describeMakeDirectoryTargets,
  describeMoveTargets,
  describePurgeTargets,
  describeQuarantineTargets,
  describeRollbackTargets,
  describeServiceTargets,
  describeUploadTargets,
  downloadFromWhatbox,
  executeWebsiteDeployment,
  listControllableServices,
  listQuarantineOnWhatbox,
  makeDirectoryOnWhatbox,
  movePathOnWhatbox,
  purgeQuarantinePathOnWhatbox,
  quarantinePathOnWhatbox,
  rollbackWebsiteRelease,
  uploadToWhatbox,
  type ServiceOperation
} from "./whatbox-mutations.js";
import {
  addTorrent,
  controlTorrent,
  getTorrentsStatus,
  removeTorrent,
  validateTorrentSource,
  type TorrentControlOperation
} from "./torrent.js";
import {
  validateStaticSiteSource,
  resolveWebsiteReleaseTarget
} from "./website.js";
import {
  createSlotBinding,
  createTargetDigest
} from "./approval.js";

const MUTATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
} as const;

const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
} as const;

function textResult(payload: unknown, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? {} : { structuredContent: payload as Record<string, unknown> })
  };
}

/**
 * Run a mutation behind the approval gate. `execute` runs only after the gate
 * returns `approved`; the input_required and denied states short-circuit.
 */
async function runGated(
  ctx: MutationContextLike,
  buildRequest: (config: WhatboxConfig) => MutationRequest,
  execute: (config: WhatboxConfig) => Promise<unknown>
) {
  let config: WhatboxConfig;
  try {
    config = loadConfig();
  } catch {
    return textResult(
      { failure: "configuration_invalid" },
      true
    );
  }

  let outcome: MutationGateOutcome;
  try {
    outcome = gateMutation(config, ctx, buildRequest(config));
  } catch {
    return textResult({ failure: "mutation_planning_failed" }, true);
  }

  if (outcome.state === "input_required") {
    return outcome.result;
  }
  if (outcome.state === "denied") {
    return textResult(
      { denied: true, reason: outcome.reason, message: deniedText(outcome.reason) },
      true
    );
  }

  try {
    const result = await execute(config);
    auditExecution(outcome.plan, true);
    return textResult({ executed: true, ...(result as object) });
  } catch (error) {
    auditExecution(outcome.plan, false);
    return textResult(
      {
        executed: false,
        failure: error instanceof Error ? error.message : "execution_failed"
      },
      true
    );
  }
}

export function registerMutationTools(server: McpServer) {
  // -- Files ---------------------------------------------------------------

  server.registerTool(
    "whatbox_upload_path",
    {
      title: "Upload a Local Path to Whatbox",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Upload an allowlisted local file or directory into an allowed remote root without overwriting. Reversible; checks remote free space first.",
      inputSchema: z.object({
        localSource: z.string().min(1).max(4096),
        rootIndex: z.number().int().min(0).default(0),
        remoteRelativePath: z.string().min(1).max(1024)
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        () => ({
          action: "file_upload",
          risk: "reversible",
          summary: `Upload into root ${input.rootIndex} at ${input.remoteRelativePath}`,
          canonicalTargets: describeUploadTargets(loadConfig(), input),
          displayTargets: [`root ${input.rootIndex}: ${input.remoteRelativePath}`],
          requiresApproval: false
        }),
        (config) =>
          withWhatboxClient(config, (client) =>
            uploadToWhatbox(client, config, input)
          )
      )
  );

  server.registerTool(
    "whatbox_download_path",
    {
      title: "Download a Whatbox Path Locally",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Download a remote file or directory into the configured local download directory. Skips symlinks; checks local free space first.",
      inputSchema: z.object({
        rootIndex: z.number().int().min(0).default(0),
        remoteRelativePath: z.string().min(1).max(1024)
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        (config) => ({
          action: "file_upload",
          risk: "reversible",
          summary: `Download root ${input.rootIndex} path ${input.remoteRelativePath}`,
          canonicalTargets: [
            `download:${config.allowedRoots[input.rootIndex] ?? "?"}/${input.remoteRelativePath}`
          ],
          displayTargets: [`root ${input.rootIndex}: ${input.remoteRelativePath}`],
          requiresApproval: false
        }),
        (config) =>
          withWhatboxClient(config, (client) =>
            downloadFromWhatbox(client, config, input)
          )
      )
  );

  server.registerTool(
    "whatbox_move_path",
    {
      title: "Move a Whatbox Path",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Move or rename a path between allowed roots without overwriting an existing destination. Reversible.",
      inputSchema: z.object({
        sourceRootIndex: z.number().int().min(0).default(0),
        sourceRelativePath: z.string().min(1).max(1024),
        destinationRootIndex: z.number().int().min(0).default(0),
        destinationRelativePath: z.string().min(1).max(1024)
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        () => ({
          action: "path_move",
          risk: "reversible",
          summary: `Move ${input.sourceRelativePath} to ${input.destinationRelativePath}`,
          canonicalTargets: describeMoveTargets(loadConfig(), input),
          displayTargets: [
            `${input.sourceRelativePath} → ${input.destinationRelativePath}`
          ],
          requiresApproval: false
        }),
        (config) =>
          withWhatboxClient(config, (client) =>
            movePathOnWhatbox(client, config, input)
          )
      )
  );

  server.registerTool(
    "whatbox_make_directory",
    {
      title: "Create a Whatbox Directory",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Create a directory (and missing parents) below an allowed root. Reversible.",
      inputSchema: z.object({
        rootIndex: z.number().int().min(0).default(0),
        relativePath: z.string().min(1).max(1024)
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        () => ({
          action: "path_create",
          risk: "reversible",
          summary: `Create directory ${input.relativePath} in root ${input.rootIndex}`,
          canonicalTargets: describeMakeDirectoryTargets(loadConfig(), input),
          displayTargets: [`root ${input.rootIndex}: ${input.relativePath}`],
          requiresApproval: false
        }),
        (config) =>
          withWhatboxClient(config, (client) =>
            makeDirectoryOnWhatbox(client, config, input)
          )
      )
  );

  // -- Delete = quarantine, purge = second approval -----------------------

  server.registerTool(
    "whatbox_quarantine_path",
    {
      title: "Quarantine (Soft-Delete) a Whatbox Path",
      annotations: DESTRUCTIVE_ANNOTATIONS,
      description:
        "Move a path into a dated quarantine directory instead of deleting it. Requires explicit human approval. Reversible; reports storage headroom (quarantine does not free space).",
      inputSchema: z.object({
        rootIndex: z.number().int().min(0).default(0),
        relativePath: z.string().min(1).max(1024)
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        () => ({
          action: "path_quarantine",
          risk: "destructive",
          summary: `Quarantine ${input.relativePath} in root ${input.rootIndex}`,
          canonicalTargets: describeQuarantineTargets(loadConfig(), input),
          displayTargets: [`root ${input.rootIndex}: ${input.relativePath}`],
          requiresApproval: true
        }),
        (config) =>
          withWhatboxClient(config, (client) =>
            quarantinePathOnWhatbox(client, config, input)
          )
      )
  );

  server.registerTool(
    "whatbox_list_quarantine",
    {
      title: "List Quarantined Whatbox Items",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      description:
        "List items currently in the quarantine directory, so a human can choose what to restore (move) or purge.",
      inputSchema: z.object({
        rootIndex: z.number().int().min(0).default(0)
      })
    },
    async (input) => {
      try {
        const config = loadConfig();
        const result = await withWhatboxClient(config, (client) =>
          listQuarantineOnWhatbox(client, config, input.rootIndex)
        );
        return textResult(result);
      } catch {
        return textResult({ failure: "quarantine_listing_failed" }, true);
      }
    }
  );

  server.registerTool(
    "whatbox_purge_quarantine",
    {
      title: "Permanently Purge a Quarantined Item",
      annotations: DESTRUCTIVE_ANNOTATIONS,
      description:
        "Permanently delete an item that already lives in the quarantine directory. This is the irreversible second step and requires its own explicit human approval.",
      inputSchema: z.object({
        rootIndex: z.number().int().min(0).default(0),
        quarantineRelativePath: z.string().min(1).max(1024)
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        () => ({
          action: "quarantine_purge",
          risk: "destructive",
          summary: `Permanently purge ${input.quarantineRelativePath}`,
          canonicalTargets: describePurgeTargets(loadConfig(), input),
          displayTargets: [input.quarantineRelativePath],
          requiresApproval: true
        }),
        (config) =>
          withWhatboxClient(config, (client) =>
            purgeQuarantinePathOnWhatbox(client, config, input)
          )
      )
  );

  // -- Backup --------------------------------------------------------------

  server.registerTool(
    "whatbox_backup_configuration",
    {
      title: "Back Up Whatbox Service Configuration",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Download allowlisted service configuration directories to the local download directory as a timestamped backup. Returns counts only; checks local free space first.",
      inputSchema: z.object({
        services: z
          .array(z.enum(Object.keys(BACKUP_TARGETS) as [string, ...string[]]))
          .min(1)
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        () => ({
          action: "file_upload",
          risk: "reversible",
          summary: `Back up configuration for: ${input.services.join(", ")}`,
          canonicalTargets: input.services.map((service) => `backup:${service}`),
          displayTargets: input.services,
          requiresApproval: false
        }),
        (config) =>
          withWhatboxClient(config, (client) =>
            backupWhatboxConfiguration(client, config, input.services)
          )
      )
  );

  // -- Service control -----------------------------------------------------

  server.registerTool(
    "whatbox_service_control",
    {
      title: "Start, Stop, or Restart a Whatbox Service",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Control an allowlisted userland service using fixed start scripts and bounded process signals. Stop/restart require explicit human approval.",
      inputSchema: z.object({
        service: z.enum(listControllableServices() as [string, ...string[]]),
        operation: z.enum(["start", "stop", "restart"])
      })
    },
    async (input, ctx) => {
      const operation = input.operation as ServiceOperation;
      const destructive = operation !== "start";
      return runGated(
        ctx as MutationContextLike,
        () => ({
          action:
            operation === "start"
              ? "service_start"
              : operation === "stop"
                ? "service_stop"
                : "service_restart",
          risk: destructive ? "destructive" : "reversible",
          summary: `${operation} ${input.service}`,
          canonicalTargets: describeServiceTargets(input.service, operation),
          displayTargets: [`${input.service} (${operation})`],
          requiresApproval: destructive
        }),
        (config) =>
          withWhatboxClient(config, (client) =>
            controlWhatboxService(client, config, input.service, operation)
          )
      );
    }
  );

  // -- Tier 3: composed shell, human-in-the-loop ---------------------------

  server.registerTool(
    "whatbox_run_command",
    {
      title: "Run an Approved Shell Command",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Run one composed shell command on the slot. Always requires explicit human approval of the exact command text, and is only available when WHATBOX_SHELL_ENABLED=true. Returns bounded stdout, stderr, and the exit code.",
      inputSchema: z.object({
        command: z.string().min(1).max(4096),
        purpose: z.string().min(1).max(500),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(SHELL_MAX_TIMEOUT_SECONDS)
          .default(120)
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        (config) => {
          if (!config.shellEnabled) {
            throw new Error("Shell commands are disabled");
          }
          const command = assertShellCommandAllowed(input.command);
          return {
            action: "run_command",
            risk: "destructive" as const,
            summary: input.purpose,
            // The exact text is the approval target: approving one command
            // must never authorize a different one.
            canonicalTargets: [`command:${command}`],
            displayTargets: [command],
            // Record the verbatim command in the audit log — for a shell
            // tool the command text is the entire forensic value.
            auditDetail: command,
            requiresApproval: true
          };
        },
        (config) =>
          withWhatboxClient(config, (client) =>
            runApprovedShellCommand(
              client,
              assertShellCommandAllowed(input.command),
              input.timeoutSeconds * 1000
            )
          )
      )
  );

  // -- App install templates -----------------------------------------------

  function buildAppInstallContext(
    config: WhatboxConfig,
    port?: number,
    musicFolder?: string
  ): InstallContext {
    const home = `/home/${config.username}`;
    return {
      home,
      port,
      musicFolder: musicFolder ? `${home}/${musicFolder}` : undefined
    };
  }

  server.registerTool(
    "whatbox_app_install",
    {
      title: "Install an App from a Pinned Template",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Install a curated app from a committed, SHA-256-pinned manifest. Downloads the pinned artifact on the slot, verifies its checksum before extracting or running anything, never overwrites an existing install, and registers it (screen + crontab). Requires human approval; the exact install script is recorded in the audit log.",
      inputSchema: z.object({
        appId: z.enum(listAppIds() as [string, ...string[]]),
        port: z.number().int().min(10000).max(32767).optional(),
        musicFolder: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/)
          .optional()
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        (config) => {
          const manifest = getAppManifest(input.appId);
          if (!manifest) {
            throw new Error("Unknown app id");
          }
          if (manifest.service?.port && !input.port) {
            throw new Error(
              "This app runs a service and needs a port (10000-32767)"
            );
          }
          const context = buildAppInstallContext(
            config,
            input.port,
            input.musicFolder
          );
          const artifact = manifest.fetch.artifact;
          return {
            action: "app_install" as const,
            risk: "destructive" as const,
            summary: `install ${manifest.name} ${manifest.version}`,
            canonicalTargets: [
              `app_install:${manifest.id}@${manifest.version}`
            ],
            displayTargets: [
              `${manifest.name} ${manifest.version} — ${artifact.url} (sha256 ${artifact.sha256.slice(0, 12)}…)`
            ],
            // The exact server-authored install script is the forensic record.
            auditDetail: buildInstallScript(manifest, context),
            requiresApproval: true
          };
        },
        (config) =>
          withWhatboxClient(config, (client) =>
            installWhatboxApp(
              client,
              config,
              getAppManifest(input.appId)!,
              buildAppInstallContext(config, input.port, input.musicFolder)
            )
          )
      )
  );

  server.registerTool(
    "whatbox_app_uninstall",
    {
      title: "Uninstall a Template-Installed App",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Reverse a template install: stop the process, remove only this app's cron lines, and move its files into a dated home-level quarantine (not deleted). Requires human approval.",
      inputSchema: z.object({
        appId: z.enum(listAppIds() as [string, ...string[]])
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        (config) => {
          const manifest = getAppManifest(input.appId);
          if (!manifest) {
            throw new Error("Unknown app id");
          }
          return {
            action: "app_uninstall" as const,
            risk: "destructive" as const,
            summary: `uninstall ${manifest.name}`,
            canonicalTargets: [`app_uninstall:${manifest.id}`],
            displayTargets: [`${manifest.name} (stop, de-cron, quarantine files)`],
            requiresApproval: true
          };
        },
        (config) =>
          withWhatboxClient(config, (client) =>
            uninstallWhatboxApp(
              client,
              config,
              getAppManifest(input.appId)!,
              buildAppInstallContext(config)
            )
          )
      )
  );

  server.registerTool(
    "whatbox_app_restart",
    {
      title: "Restart a Template-Installed Service App",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Restart a template-installed service (kill and relaunch; the cron keepalive also respawns it). Only valid for service apps. Requires human approval.",
      inputSchema: z.object({
        appId: z.enum(listAppIds() as [string, ...string[]])
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        (config) => {
          const manifest = getAppManifest(input.appId);
          if (!manifest) {
            throw new Error("Unknown app id");
          }
          if (!manifest.service) {
            throw new Error(
              `${manifest.name} is not a service; there is nothing to restart`
            );
          }
          return {
            action: "app_restart" as const,
            risk: "destructive" as const,
            summary: `restart ${manifest.name}`,
            canonicalTargets: [`app_restart:${manifest.id}`],
            displayTargets: [`${manifest.name} (kill + relaunch)`],
            requiresApproval: true
          };
        },
        (config) =>
          withWhatboxClient(config, (client) =>
            restartWhatboxApp(
              client,
              config,
              getAppManifest(input.appId)!,
              buildAppInstallContext(config)
            )
          )
      )
  );

  // -- Website deployment execution + rollback -----------------------------

  server.registerTool(
    "whatbox_website_deploy_execute",
    {
      title: "Execute a Static Website Deployment",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Stage a validated local static site into a new release, verify the remote manifest by checksum, atomically activate it via the current-release pointer, and health-check. Reversible via rollback. Checks remote free space first.",
      inputSchema: z.object({
        sourceRoot: z.string().min(1).max(4096),
        rootIndex: z.number().int().min(0).default(0),
        releaseId: z.string().uuid()
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        (config) => {
          const validation = validateStaticSiteSource(
            input.sourceRoot,
            config.websiteSourceRoots
          );
          if (!validation.accepted || !validation.manifestDigest) {
            throw new Error("source_validation_failed");
          }
          const root = config.allowedRoots[input.rootIndex];
          if (!root) {
            throw new Error("unknown_root_index");
          }
          const releaseTarget = resolveWebsiteReleaseTarget(
            root,
            input.releaseId
          );
          return {
            action: "website_deploy",
            risk: "reversible",
            summary: `Deploy release ${input.releaseId} to root ${input.rootIndex}`,
            canonicalTargets: [
              createTargetDigest(`release:${releaseTarget}`),
              createTargetDigest(`source:${validation.manifestDigest}`)
            ].map((digest) => `digest:${digest}`),
            displayTargets: [`release ${input.releaseId}`],
            requiresApproval: false,
            expectedManifestDigest: validation.manifestDigest
          } as MutationRequest & { expectedManifestDigest: string };
        },
        (config) => {
          const validation = validateStaticSiteSource(
            input.sourceRoot,
            config.websiteSourceRoots
          );
          if (!validation.manifestDigest) {
            throw new Error("source_validation_failed");
          }
          const expectedManifestDigest = validation.manifestDigest;
          return withWhatboxClient(config, (client) =>
            executeWebsiteDeployment(client, config, {
              sourceRoot: input.sourceRoot,
              rootIndex: input.rootIndex,
              releaseId: input.releaseId,
              expectedManifestDigest
            })
          );
        }
      )
  );

  server.registerTool(
    "whatbox_website_rollback",
    {
      title: "Roll Back to a Previous Website Release",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Atomically repoint the current-release pointer to an existing prior release and health-check it. Requires explicit human approval.",
      inputSchema: z.object({
        rootIndex: z.number().int().min(0).default(0),
        releaseId: z.string().uuid()
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        () => ({
          action: "website_rollback",
          risk: "destructive",
          summary: `Roll back root ${input.rootIndex} to release ${input.releaseId}`,
          canonicalTargets: describeRollbackTargets(loadConfig(), input),
          displayTargets: [`release ${input.releaseId}`],
          requiresApproval: true
        }),
        (config) =>
          withWhatboxClient(config, (client) =>
            rollbackWebsiteRelease(client, config, input)
          )
      )
  );

  // -- Torrent management --------------------------------------------------

  server.registerTool(
    "whatbox_torrents_status",
    {
      title: "List Torrents via Loopback RPC",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      description:
        "Report bounded torrent status (name, state, progress, ratio, uploaded bytes, label, totals) through an SSH tunnel to the configured client RPC. rTorrent results are sorted by total uploaded, most first. Read-only.",
      inputSchema: z.object({})
    },
    async () => {
      try {
        const config = loadConfig();
        const result = await withWhatboxClient(config, (client) =>
          getTorrentsStatus(client, config)
        );
        return textResult(result);
      } catch (error) {
        return textResult(
          {
            failure:
              error instanceof Error ? error.message : "torrent_status_failed"
          },
          true
        );
      }
    }
  );

  server.registerTool(
    "whatbox_torrent_add",
    {
      title: "Add a Torrent",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Add a torrent from a bounded magnet or HTTP(S) URL through the configured client RPC. Reversible.",
      inputSchema: z.object({
        magnetOrUrl: z.string().min(1).max(4096),
        paused: z.boolean().default(false)
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        () => ({
          action: "torrent_add",
          risk: "reversible",
          summary: `Add torrent (${input.paused ? "paused" : "active"})`,
          canonicalTargets: [`torrent-add:${validateTorrentSource(input.magnetOrUrl)}`],
          displayTargets: [input.magnetOrUrl.slice(0, 80)],
          requiresApproval: false
        }),
        (config) =>
          withWhatboxClient(config, (client) => addTorrent(client, config, input))
      )
  );

  server.registerTool(
    "whatbox_torrent_control",
    {
      title: "Pause, Resume, Reannounce, or Label a Torrent",
      annotations: MUTATION_ANNOTATIONS,
      description:
        "Pause, resume, reannounce to trackers, set the label/category, or set the seed-ratio limit of one torrent. Reversible.",
      inputSchema: z.object({
        torrentId: z.string().min(1).max(64),
        operation: z.enum([
          "pause",
          "resume",
          "reannounce",
          "set_label",
          "set_ratio_limit"
        ]),
        label: z.string().max(200).optional(),
        ratioLimit: z.number().min(0).max(1000).optional()
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        () => ({
          action: "torrent_control",
          risk: "reversible",
          summary: `${input.operation} torrent ${input.torrentId}`,
          canonicalTargets: [`torrent:${input.torrentId}:${input.operation}`],
          displayTargets: [`${input.torrentId} (${input.operation})`],
          requiresApproval: false
        }),
        (config) =>
          withWhatboxClient(config, (client) =>
            controlTorrent(client, config, {
              torrentId: input.torrentId,
              operation: input.operation as TorrentControlOperation,
              label: input.label,
              ratioLimit: input.ratioLimit
            })
          )
      )
  );

  server.registerTool(
    "whatbox_torrent_remove",
    {
      title: "Remove a Torrent",
      annotations: DESTRUCTIVE_ANNOTATIONS,
      description:
        "Remove a torrent from the client, optionally deleting its downloaded data. Requires explicit human approval; deleting data is irreversible.",
      inputSchema: z.object({
        torrentId: z.string().min(1).max(64),
        deleteData: z.boolean().default(false)
      })
    },
    async (input, ctx) =>
      runGated(
        ctx as MutationContextLike,
        () => ({
          action: "torrent_remove",
          risk: "destructive",
          summary: `Remove torrent ${input.torrentId}${input.deleteData ? " and delete data" : ""}`,
          canonicalTargets: [
            `torrent-remove:${input.torrentId}:${input.deleteData ? "data" : "keep"}`
          ],
          displayTargets: [
            `${input.torrentId}${input.deleteData ? " + data" : ""}`
          ],
          requiresApproval: true
        }),
        (config) =>
          withWhatboxClient(config, (client) =>
            removeTorrent(client, config, input)
          )
      )
  );
}

export { createSlotBinding };
