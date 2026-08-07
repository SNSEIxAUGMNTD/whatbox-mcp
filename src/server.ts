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
  toSafeStorageStatus
} from "./agent.js";
import {
  getWhatboxStorageStatus,
  getWhatboxServiceInventory,
  getWhatboxTorrentClientStatus,
  getWhatboxWebsiteReadiness,
  listWhatboxDirectory,
  mapWhatboxDirectory,
  reviewWhatboxConfiguration,
  toSafeConnectionDiagnostic,
  withWhatboxClient
} from "./whatbox.js";

export const SERVER_NAME = "whatbox-mcp";
export const SERVER_VERSION = "0.8.0";

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
      "whatbox_configuration_status",
      "whatbox_connection_status",
      "whatbox_storage_status",
      "whatbox_list_directory",
      "whatbox_torrent_clients_status",
      "whatbox_structure_map",
      "whatbox_services_status",
      "whatbox_configuration_review",
      "whatbox_website_readiness",
      "whatbox_website_deployment_plan",
      "whatbox_operational_snapshot"
    ],
    planned: [
      "approval-gated atomic static website deployment with validation, health checking, and rollback",
      "read-only torrent summaries through separately configured supported client APIs",
      "redacted recent-error and service-health adapters",
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
      "No generic remote shell tool",
      "Every mutation requires an immutable plan before execution",
      "Deletion requires one-time external human approval bound to exact canonical targets",
      "Initial removal quarantines data; permanent purge requires a second approval",
      "Remote paths are restricted to configured allow-lists",
      "Sensitive locations and credential-like files are excluded from discovery"
    ],
    agentInterfaces: {
      resources: ["whatbox://guide/agent-operations"],
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
          remoteMutationsEnabled: z.literal(false),
          deploymentExecutionEnabled: z.literal(false),
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
          return buildOperationalSnapshot(services, storage, website, review);
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

  return server;
}
