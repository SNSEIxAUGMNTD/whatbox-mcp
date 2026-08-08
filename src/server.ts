import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { inspectConfiguration, loadConfig } from "./config.js";
import {
  createSlotBinding,
  getApprovalStateDirectory,
  getOrCreateApprovalKey,
  sealMutationPlan
} from "./approval.js";
import {
  createWebsiteDeploymentPlan,
  validateStaticSiteSource
} from "./website.js";
import {
  AGENT_GUIDE,
  buildOperationalSnapshot,
  renderToolCatalogMarkdown,
  toSafeStorageStatus,
  TOOL_CATALOG
} from "./agent.js";
import { registerMutationTools } from "./server-mutations.js";
import {
  getWhatboxStorageStatus,
  getWhatboxServiceInventory,
  getWhatboxTorrentClientStatus,
  getWhatboxWebsiteDiagnostics,
  getWhatboxWebsiteReadiness,
  listWhatboxDirectory,
  mapWhatboxDirectory,
  reviewWhatboxConfiguration,
  toSafeConnectionDiagnostic,
  withWhatboxClient
} from "./whatbox.js";

export const SERVER_NAME = "whatbox-mcp";
export const SERVER_VERSION = "0.10.0";

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

const serverInfoOutputSchema = z.object({
  name: z.string(),
  version: z.string(),
  transport: z.literal("stdio"),
  mode: z.string(),
  credentialPolicy: z.string(),
  remoteConnection: z.string()
});

const connectionOutputSchema = z.object({
  connected: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  failure: z.string().optional(),
  stage: z.string().optional(),
  transportCode: z.string().optional()
});

const storageRootOutputSchema = z.object({
  rootIndex: z.number().int().nonnegative(),
  totalBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
  availableBytes: z.number().nonnegative(),
  usedPercent: z.number().nonnegative()
});

const serviceOutputSchema = z.object({
  service: z.string(),
  category: z.enum(["torrent", "media", "automation", "web", "sync"]),
  configured: z.boolean(),
  running: z.boolean(),
  state: z.enum(["running", "configured_not_detected", "not_configured"]),
  health: z.literal("not_checked")
});

const websiteReadinessOutputSchema = z.object({
  observations: z.object({
    nginxBinaryAvailable: z.boolean(),
    nginxConfiguration: z.object({
      directoryExists: z.boolean(),
      fileExists: z.boolean()
    }),
    nginxProcess: z.object({
      running: z.boolean(),
      health: z.literal("not_checked")
    }),
    candidateWebsiteRoots: z.array(z.object({
      rootIndex: z.number().int().nonnegative(),
      relativePath: z.string(),
      exists: z.boolean()
    })),
    storage: z.array(z.object({
      rootIndex: z.number().int().nonnegative(),
      availableBytes: z.number().nonnegative(),
      usedPercent: z.number().nonnegative(),
      ready: z.boolean()
    }))
  }),
  recommendations: z.array(z.object({
    id: z.string(),
    recommendation: z.string()
  }))
});

const websiteDiagnosticsOutputSchema = z.object({
  observations: z.object({
    nginxConfigurationTest: z.enum([
      "valid",
      "invalid",
      "unavailable",
      "symlink_rejected"
    ]),
    healthProbe: z.object({
      state: z.enum([
        "responding",
        "server_error",
        "unreachable",
        "probe_unavailable",
        "not_configured"
      ]),
      statusCode: z.number().int().min(100).max(599).optional(),
      latencyMs: z.number().int().nonnegative().optional()
    }),
    recentErrorLog: z.object({
      state: z.enum(["available", "unavailable", "symlink_rejected"]),
      sizeBytes: z.number().nonnegative().optional(),
      modifiedAt: z.string().optional(),
      sampledBytes: z.number().int().nonnegative(),
      sampledLineCount: z.number().int().nonnegative(),
      severityCounts: z.object({
        emergency: z.number().int().nonnegative(),
        alert: z.number().int().nonnegative(),
        critical: z.number().int().nonnegative(),
        error: z.number().int().nonnegative(),
        warning: z.number().int().nonnegative(),
        notice: z.number().int().nonnegative(),
        info: z.number().int().nonnegative(),
        debug: z.number().int().nonnegative()
      })
    })
  }),
  recommendations: z.array(z.object({
    id: z.string(),
    recommendation: z.string()
  })),
  contentReturned: z.object({
    nginxConfiguration: z.literal(false),
    responseBody: z.literal(false),
    logLines: z.literal(false)
  })
});

export function getServerInfo() {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    transport: "stdio",
    mode: "local self-hosted",
    credentialPolicy:
      "Credentials are stored outside the repository and are never accepted as tool arguments.",
    remoteConnection: "configured locally when Whatbox tools are called"
  };
}

export function getCapabilities() {
  return {
    availableNow: [
      "server_info",
      "list_capabilities",
      "whatbox_list_tools",
      "whatbox_configuration_status",
      "whatbox_connection_status",
      "whatbox_storage_status",
      "whatbox_list_directory",
      "whatbox_torrent_clients_status",
      "whatbox_structure_map",
      "whatbox_services_status",
      "whatbox_configuration_review",
      "whatbox_website_readiness",
      "whatbox_website_diagnostics",
      "whatbox_website_deployment_plan",
      "whatbox_operational_snapshot",
      "whatbox_upload_path",
      "whatbox_download_path",
      "whatbox_move_path",
      "whatbox_make_directory",
      "whatbox_quarantine_path",
      "whatbox_list_quarantine",
      "whatbox_purge_quarantine",
      "whatbox_backup_configuration",
      "whatbox_service_control",
      "whatbox_website_deploy_execute",
      "whatbox_website_rollback",
      "whatbox_torrents_status",
      "whatbox_torrent_add",
      "whatbox_torrent_control",
      "whatbox_torrent_remove"
    ],
    planned: [
      "approval-gated atomic static website deployment with validation, health checking, and rollback",
      "read-only torrent summaries through separately configured supported client APIs",
      "service-specific health adapters beyond userland Nginx",
      "approval-gated service lifecycle actions",
      "multiple locally authorized Whatbox connection profiles",
      "optional authorized provider integration for Manage Apps and managed links"
    ],
    criticalNext: [
      "fixed SFTP release staging and remote manifest validation",
      "signed input_required approval handshake and denial-path tests",
      "atomic activation, bounded health checking, rollback, and redacted audit logging"
    ],
    safetyModel: [
      "No generic remote shell tool; every command is a fixed server-authored template",
      "Mutations are disabled unless WHATBOX_MUTATIONS_ENABLED=true in local configuration",
      "Every mutation requires an immutable HMAC-signed plan before execution",
      "Destructive mutations always require one-time human approval via MCP elicitation, even in auto-mode; a model-supplied boolean is never sufficient",
      "Deletion quarantines data; permanent purge requires a separate second approval",
      "Uploads, moves, and directory creation never overwrite existing paths",
      "Remote and local free space are checked before transfers and deployments",
      "Remote paths are restricted to configured allow-lists with canonical-path and symlink containment",
      "Sensitive locations and credential-like files are excluded from discovery, listing, upload, and backup",
      "Every planned, requested, approved, denied, executed, and failed mutation is recorded in a local redacted audit log"
    ],
    agentInterfaces: {
      resources: [
        "whatbox://guide/agent-operations",
        "whatbox://guide/tools"
      ],
      prompts: ["whatbox_safe_audit"],
      preferredAssessmentTool: "whatbox_operational_snapshot"
    }
  };
}

export function createServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "This server is security-first. Read whatbox://guide/agent-operations and prefer whatbox_operational_snapshot for assessment. Never request, accept, display, or persist secrets in tool arguments. Keep observations separate from recommendations and never infer health from process state. Every mutation requires a prior immutable plan and negotiated external human approval bound to exact targets; model-provided confirmation is insufficient. Remote mutations are currently disabled."
    }
  );

  server.registerResource(
    "whatbox-agent-guide",
    "whatbox://guide/agent-operations",
    {
      title: "Whatbox MCP Agent Operations Guide",
      description:
        "Safe operating sequence, secret policy, mutation boundary, and external-provider boundaries for AI agents.",
      mimeType: "text/markdown",
      annotations: { audience: ["assistant", "user"], priority: 1 }
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: AGENT_GUIDE }]
    })
  );

  server.registerResource(
    "whatbox-tools-catalog",
    "whatbox://guide/tools",
    {
      title: "Whatbox MCP Tools and Processes",
      description:
        "The full catalog of tools grouped by category and risk, and the current mutation-enabled state.",
      mimeType: "text/markdown",
      annotations: { audience: ["assistant", "user"], priority: 1 }
    },
    async (uri) => {
      let mutationsEnabled = false;
      try {
        mutationsEnabled = loadConfig().mutationsEnabled;
      } catch {
        mutationsEnabled = false;
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: renderToolCatalogMarkdown(mutationsEnabled)
          }
        ]
      };
    }
  );

  server.registerTool(
    "whatbox_list_tools",
    {
      title: "List Whatbox MCP Tools and Processes",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Return the full tool catalog grouped by category and risk, plus whether remote mutations are currently enabled. Back the /tools command with this.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        mutationsEnabled: z.boolean(),
        tools: z.array(z.object({
          name: z.string(),
          title: z.string(),
          category: z.string(),
          mutating: z.boolean(),
          risk: z.enum(["read_only", "reversible", "destructive"]),
          summary: z.string()
        }))
      })
    },
    async () => {
      let mutationsEnabled = false;
      try {
        mutationsEnabled = loadConfig().mutationsEnabled;
      } catch {
        mutationsEnabled = false;
      }
      const result = { mutationsEnabled, tools: TOOL_CATALOG };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      };
    }
  );

  server.registerPrompt(
    "whatbox_safe_audit",
    {
      title: "Safely Audit a Whatbox Slot",
      description:
        "Guide an agent through a sanitized read-only Whatbox assessment without requesting secrets or implying mutation authority.",
      argsSchema: z.object({
        focus: z.enum(["full", "storage", "services", "website"]).default("full")
      })
    },
    ({ focus }) => ({
      description: "A fail-closed read-only Whatbox audit workflow.",
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Perform a ${focus} read-only Whatbox audit. Read whatbox://guide/agent-operations first. `
              + "Check configuration status, then prefer whatbox_operational_snapshot. "
              + "Use focused tools only if needed. Separate observations from recommendations, "
              + "do not request secrets, and do not attempt any mutation."
          }
        }
      ]
    })
  );

  server.registerTool(
    "server_info",
    {
      title: "Whatbox MCP Server Information",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Return non-sensitive metadata about this local Whatbox MCP server.",
      inputSchema: z.object({}),
      outputSchema: serverInfoOutputSchema
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(getServerInfo(), null, 2) }],
      structuredContent: getServerInfo()
    })
  );

  server.registerTool(
    "list_capabilities",
    {
      title: "List Whatbox MCP Capabilities",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "List implemented capabilities, planned Whatbox integrations, and safety boundaries.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        availableNow: z.array(z.string()),
        planned: z.array(z.string()),
        safetyModel: z.array(z.string()),
        agentInterfaces: z.object({
          resources: z.array(z.string()),
          prompts: z.array(z.string()),
          preferredAssessmentTool: z.string()
        }),
        criticalNext: z.array(z.string())
      })
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(getCapabilities(), null, 2) }],
      structuredContent: getCapabilities()
    })
  );

  server.registerTool(
    "whatbox_website_readiness",
    {
      title: "Check Website Hosting Readiness",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Inspect fixed website-hosting readiness facts without reading Nginx configuration contents, process arguments, or private connection values.",
      inputSchema: z.object({}),
      outputSchema: websiteReadinessOutputSchema
    },
    async () => {
      try {
        const config = loadConfig();
        const result = await withWhatboxClient(config, (client) =>
          getWhatboxWebsiteReadiness(client, config)
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Unable to read website-hosting readiness. Check the local connection and allowed storage roots."
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "whatbox_website_diagnostics",
    {
      title: "Diagnose Userland Nginx Safely",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Test fixed userland Nginx configuration syntax, optionally probe a configured loopback port without a response body, and summarize recent error severities without returning configuration or log contents.",
      inputSchema: z.object({}),
      outputSchema: websiteDiagnosticsOutputSchema
    },
    async () => {
      try {
        const config = loadConfig();
        const result = await withWhatboxClient(config, (client) =>
          getWhatboxWebsiteDiagnostics(client, config)
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Unable to run website diagnostics. Check the local connection, fixed Nginx setup, and optional loopback health port."
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "whatbox_website_deployment_plan",
    {
      title: "Plan a Static Website Deployment",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Validate an explicitly allowlisted local static-site source and create a redacted, signed deployment plan. This tool never uploads files or changes Whatbox state.",
      inputSchema: z.object({
        sourceRoot: z.string().min(1).max(4096),
        rootIndex: z.number().int().min(0).default(0),
        releaseId: z.string().uuid().optional()
      }),
      outputSchema: z.object({
        planning: z.boolean(),
        source: z.object({
          accepted: z.boolean(),
          fileCount: z.number().int().nonnegative(),
          totalBytes: z.number().nonnegative(),
          manifestDigestPresent: z.boolean(),
          rejectionReasons: z.array(z.string())
        }),
        target: z.object({
          rootIndex: z.number().int().nonnegative(),
          releaseId: z.string(),
          releaseRelativePath: z.string()
        }).optional(),
        approval: z.object({
          planId: z.string(),
          action: z.literal("website_deploy"),
          risk: z.literal("reversible"),
          expiresAt: z.number(),
          sealedPlan: z.string()
        }).optional(),
        executionEnabled: z.literal(false).optional()
      })
    },
    async ({ sourceRoot, rootIndex, releaseId }) => {
      try {
        const config = loadConfig();
        if (config.websiteSourceRoots.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "No local website source roots are configured. Add WHATBOX_WEBSITE_SOURCE_ROOTS locally before planning."
              }
            ]
          };
        }

        const source = validateStaticSiteSource(
          sourceRoot,
          config.websiteSourceRoots
        );
        if (!source.accepted) {
          const result = {
            planning: false,
            source: {
              accepted: false,
              fileCount: source.fileCount,
              totalBytes: source.totalBytes,
              manifestDigestPresent: false,
              rejectionReasons: source.rejectionReasons
            }
          };
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result
          };
        }

        const remoteWebsiteRoot = config.allowedRoots[rootIndex];
        if (!remoteWebsiteRoot) {
          throw new Error("Unknown allowed-root index");
        }

        const planned = createWebsiteDeploymentPlan({
          source,
          slotBinding: createSlotBinding(
            config.username,
            config.hostFingerprintSha256
          ),
          rootIndex,
          remoteWebsiteRoot,
          releaseId
        });
        const sealedPlan = sealMutationPlan(
          planned.plan,
          getOrCreateApprovalKey(getApprovalStateDirectory())
        );
        const result = {
          planning: true,
          source: {
            accepted: true,
            fileCount: source.fileCount,
            totalBytes: source.totalBytes,
            manifestDigestPresent: true,
            rejectionReasons: []
          },
          target: planned.target,
          approval: {
            planId: planned.plan.planId,
            action: planned.plan.action,
            risk: planned.plan.risk,
            expiresAt: planned.plan.expiresAt,
            sealedPlan
          },
          executionEnabled: false
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Unable to create the website deployment plan. Check local source allowlists and the selected remote root index."
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "whatbox_operational_snapshot",
    {
      title: "Get Consolidated Whatbox Operational Snapshot",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Return one sanitized read-only assessment covering storage pressure, allowlisted services, website readiness, recommendations, and mutation safety state.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        overall: z.enum([
          "read_only_ready",
          "attention_recommended",
          "critical_attention"
        ]),
        observations: z.object({
          connected: z.literal(true),
          storage: z.object({
            rootCount: z.number().int().nonnegative(),
            warningRootCount: z.number().int().nonnegative(),
            criticalRootCount: z.number().int().nonnegative()
          }),
          services: z.object({
            configured: z.array(z.string()),
            running: z.array(z.string()),
            healthChecked: z.literal(false)
          }),
          website: z.object({
            nginxBinaryAvailable: z.boolean(),
            nginxConfigurationDetected: z.boolean(),
            nginxProcessRunning: z.boolean(),
            processHealth: z.literal("not_checked"),
            candidateRootCount: z.number().int().nonnegative(),
            storageReady: z.boolean()
          })
        }),
        recommendations: z.array(z.object({
          id: z.string(),
          recommendation: z.string()
        })),
        safety: z.object({
          remoteMutationsEnabled: z.boolean(),
          deploymentExecutionEnabled: z.boolean(),
          configurationContentsInspected: z.literal(false)
        })
      })
    },
    async () => {
      try {
        const config = loadConfig();
        const result = await withWhatboxClient(config, async (client) => {
          const [services, storage, website] = await Promise.all([
            getWhatboxServiceInventory(client, config),
            getWhatboxStorageStatus(client, config),
            getWhatboxWebsiteReadiness(client, config)
          ]);
          const review = reviewWhatboxConfiguration(services, storage);
          return buildOperationalSnapshot(services, storage, website, review, {
            remoteMutationsEnabled: config.mutationsEnabled,
            deploymentExecutionEnabled: config.mutationsEnabled,
            configurationContentsInspected: false
          });
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (error) {
        const result = {
          connected: false,
          ...toSafeConnectionDiagnostic(error)
        };
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }
    }
  );

  server.registerTool(
    "whatbox_configuration_status",
    {
      title: "Check Local Whatbox Configuration",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Check whether local Whatbox configuration is complete without returning configuration values or secrets.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        configured: z.boolean(),
        configFileExists: z.boolean(),
        configFilePermissionsSecure: z.boolean().nullable(),
        authMode: z.enum(["agent", "key", "not configured"]),
        checks: z.object({
          host: z.boolean(),
          username: z.boolean(),
          hostFingerprint: z.boolean(),
          authentication: z.boolean(),
          allowedRoots: z.boolean()
        }),
        issues: z.array(z.string())
      })
    },
    async () => {
      const status = inspectConfiguration();
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        structuredContent: status
      };
    }
  );

  server.registerTool(
    "whatbox_connection_status",
    {
      title: "Check Whatbox SSH Connection",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Test a verified read-only SSH connection using local credentials without returning their values.",
      inputSchema: z.object({}),
      outputSchema: connectionOutputSchema
    },
    async () => {
      try {
        const startedAt = Date.now();
        await withWhatboxClient(loadConfig(), async () => undefined);
        const result = { connected: true, latencyMs: Date.now() - startedAt };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (error) {
        const result = {
          connected: false,
          ...toSafeConnectionDiagnostic(error)
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ],
          structuredContent: result
        };
      }
    }
  );

  server.registerTool(
    "whatbox_configuration_review",
    {
      title: "Review Whatbox Configuration Metadata",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Return conservative advisory findings from service metadata and storage capacity without reading configuration contents or making changes.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        overall: z.enum([
          "no_obvious_issues",
          "attention_recommended",
          "critical_attention"
        ]),
        findings: z.array(z.object({
          id: z.string(),
          severity: z.enum(["info", "warning", "critical"]),
          confidence: z.enum(["low", "medium", "high"]),
          observation: z.string(),
          recommendation: z.string(),
          automaticFixAvailable: z.literal(false)
        })),
        scope: z.object({
          serviceProcessAndConfigMetadata: z.literal(true),
          storageCapacity: z.literal(true),
          configurationContentsInspected: z.literal(false)
        })
      })
    },
    async () => {
      try {
        const config = loadConfig();
        const review = await withWhatboxClient(config, async (client) => {
          const services = await getWhatboxServiceInventory(client, config);
          const storage = await getWhatboxStorageStatus(client, config);
          return reviewWhatboxConfiguration(services, storage);
        });
        return {
          content: [{ type: "text", text: JSON.stringify(review, null, 2) }],
          structuredContent: review
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Unable to perform the configuration review. Check the local connection and allowed storage roots."
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "whatbox_services_status",
    {
      title: "Inspect Allowlisted Whatbox Services",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Report conservative configured and running states for an allowlisted Whatbox service catalog without reading configuration contents or process arguments.",
      inputSchema: z.object({}),
      outputSchema: z.object({ services: z.array(serviceOutputSchema) })
    },
    async () => {
      try {
        const config = loadConfig();
        const services = await withWhatboxClient(config, (client) =>
          getWhatboxServiceInventory(client, config)
        );
        const result = { services };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Unable to read the service inventory. Check the local connection configuration."
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "whatbox_structure_map",
    {
      title: "Map an Allowed Whatbox Directory",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Create a bounded directory-only map and Mermaid diagram below an allowed root without reading file contents or traversing sensitive directories or symlinks.",
      inputSchema: z.object({
        rootIndex: z.number().int().min(0).default(0),
        maxDepth: z.number().int().min(0).max(5).default(2),
        maxNodes: z.number().int().min(1).max(1000).default(200)
      }),
      outputSchema: z.object({
        rootIndex: z.number().int().nonnegative(),
        nodes: z.array(z.object({
          id: z.string(),
          parentId: z.string().nullable(),
          name: z.string(),
          relativePath: z.string(),
          depth: z.number().int().nonnegative(),
          directoryCount: z.number().int().nonnegative(),
          fileCount: z.number().int().nonnegative(),
          fileBytes: z.number().nonnegative()
        })),
        excludedSensitiveDirectoryCount: z.number().int().nonnegative(),
        truncated: z.boolean(),
        mermaid: z.string()
      })
    },
    async ({ rootIndex, maxDepth, maxNodes }) => {
      try {
        const config = loadConfig();
        const result = await withWhatboxClient(config, (client) =>
          mapWhatboxDirectory(
            client,
            config,
            rootIndex,
            maxDepth,
            maxNodes
          )
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Unable to map the directory structure. Check the configured root and requested limits."
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "whatbox_torrent_clients_status",
    {
      title: "Inspect Supported Torrent Clients",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Report whether allowlisted Whatbox torrent clients are running without returning torrent or unrelated process details.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        clients: z.array(z.object({
          client: z.enum(["rtorrent", "deluge", "transmission", "qbittorrent"]),
          running: z.boolean()
        }))
      })
    },
    async () => {
      try {
        const config = loadConfig();
        const clients = await withWhatboxClient(config, (client) =>
          getWhatboxTorrentClientStatus(client, config)
        );
        const result = { clients };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Unable to read torrent-client status. Check the local connection configuration."
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "whatbox_storage_status",
    {
      title: "Inspect Whatbox Storage Capacity",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "Report capacity and usage for configured Whatbox storage roots using a fixed read-only query.",
      inputSchema: z.object({}),
      outputSchema: z.object({ roots: z.array(storageRootOutputSchema) })
    },
    async () => {
      try {
        const config = loadConfig();
        const roots = await withWhatboxClient(config, (client) =>
          getWhatboxStorageStatus(client, config)
        );
        const result = { roots: toSafeStorageStatus(roots) };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Unable to read storage status. Check local configuration and the allowed roots."
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "whatbox_list_directory",
    {
      title: "List an Allowed Whatbox Directory",
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      description:
        "List a directory below an explicitly allowed Whatbox storage root. Absolute paths and path escapes are rejected.",
      inputSchema: z.object({
        rootIndex: z.number().int().min(0).default(0),
        relativePath: z.string().max(1024).default("."),
        limit: z.number().int().min(1).max(500).default(100)
      }),
      outputSchema: z.object({
        rootIndex: z.number().int().nonnegative(),
        relativePath: z.string(),
        entries: z.array(z.object({
          name: z.string(),
          type: z.enum(["directory", "file", "symlink", "other"]),
          sizeBytes: z.number().nonnegative(),
          modifiedAt: z.string()
        })),
        truncated: z.boolean()
      })
    },
    async ({ rootIndex, relativePath, limit }) => {
      try {
        const config = loadConfig();
        const result = await withWhatboxClient(config, (client) =>
          listWhatboxDirectory(
            client,
            config,
            rootIndex,
            relativePath,
            limit
          )
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Unable to list the directory. Check the configured root and use a relative path that stays inside it."
            }
          ]
        };
      }
    }
  );

  registerMutationTools(server);

  return server;
}
