import type {
  ConfigurationReview,
  ServiceInventoryEntry,
  StorageStatus,
  WebsiteReadiness
} from "./whatbox.js";

export interface SnapshotSafetyState {
  remoteMutationsEnabled: boolean;
  deploymentExecutionEnabled: boolean;
  configurationContentsInspected: false;
}

export interface OperationalSnapshot {
  overall: "read_only_ready" | "attention_recommended" | "critical_attention";
  observations: {
    connected: true;
    storage: {
      rootCount: number;
      warningRootCount: number;
      criticalRootCount: number;
    };
    services: {
      configured: string[];
      running: string[];
      healthChecked: false;
    };
    website: {
      nginxBinaryAvailable: boolean;
      nginxConfigurationDetected: boolean;
      nginxProcessRunning: boolean;
      processHealth: "not_checked";
      candidateRootCount: number;
      storageReady: boolean;
    };
  };
  recommendations: Array<{
    id: string;
    recommendation: string;
  }>;
  safety: SnapshotSafetyState;
}

export function toSafeStorageStatus(storage: StorageStatus[]) {
  return storage.map(({ rootPath: _rootPath, ...root }) => root);
}

export function buildOperationalSnapshot(
  services: ServiceInventoryEntry[],
  storage: StorageStatus[],
  website: WebsiteReadiness,
  review: ConfigurationReview,
  safety: SnapshotSafetyState = {
    remoteMutationsEnabled: false,
    deploymentExecutionEnabled: false,
    configurationContentsInspected: false
  }
): OperationalSnapshot {
  const recommendations = new Map<string, string>();
  for (const finding of review.findings) {
    recommendations.set(finding.id, finding.recommendation);
  }
  for (const recommendation of website.recommendations) {
    recommendations.set(recommendation.id, recommendation.recommendation);
  }

  const criticalRootCount = storage.filter((root) => root.usedPercent >= 95).length;
  const warningRootCount = storage.filter(
    (root) => root.usedPercent >= 85 && root.usedPercent < 95
  ).length;
  const websiteConfiguration = website.observations.nginxConfiguration;

  return {
    overall: criticalRootCount > 0 || review.overall === "critical_attention"
      ? "critical_attention"
      : recommendations.size > 0
        ? "attention_recommended"
        : "read_only_ready",
    observations: {
      connected: true,
      storage: {
        rootCount: storage.length,
        warningRootCount,
        criticalRootCount
      },
      services: {
        configured: services
          .filter((service) => service.configured)
          .map((service) => service.service)
          .sort(),
        running: services
          .filter((service) => service.running)
          .map((service) => service.service)
          .sort(),
        healthChecked: false
      },
      website: {
        nginxBinaryAvailable: website.observations.nginxBinaryAvailable,
        nginxConfigurationDetected:
          websiteConfiguration.directoryExists || websiteConfiguration.fileExists,
        nginxProcessRunning: website.observations.nginxProcess.running,
        processHealth: "not_checked",
        candidateRootCount: website.observations.candidateWebsiteRoots.filter(
          (candidate) => candidate.exists
        ).length,
        storageReady: website.observations.storage.every((root) => root.ready)
      }
    },
    recommendations: [...recommendations.entries()].map(([id, recommendation]) => ({
      id,
      recommendation
    })),
    safety
  };
}

export const AGENT_GUIDE = `# Whatbox MCP agent guide

Use this server as a security-first, local MCP for one explicitly configured Whatbox slot.

## Safe operating sequence

1. Call server_info and list_capabilities.
2. Call whatbox_configuration_status before any remote tool.
3. Prefer whatbox_operational_snapshot for a consolidated, sanitized assessment.
4. Use focused read-only tools only when more detail is needed. For website work, use whatbox_website_diagnostics before relying on process state.
5. Treat process running state as an observation, never as proof of health.
6. Keep observations separate from recommendations.
7. Never ask for or echo local.env, SSH keys, passphrases, approval keys, cookies, or raw SSH diagnostics.
8. Never infer authorization from a boolean or confirmation phrase.
9. Never request Nginx configuration text, HTTP response bodies, or raw log lines when the diagnostics tool can return bounded facts.

## Mutation boundary

Remote mutation and deployment execution are disabled. The deployment-plan tool validates and signs a preview only. A future mutation must use negotiated MCP input_required interaction, exact target binding, short expiry, one-time consumption, validation, and rollback.

## External Whatbox steps

Manage Apps, managed links, DNS, domains, billing, and provider account actions are outside this SSH MCP unless a separately authorized provider integration is added.
`;

export interface ToolCatalogEntry {
  name: string;
  title: string;
  category:
    | "meta"
    | "observe"
    | "files"
    | "delete"
    | "backup"
    | "services"
    | "website"
    | "torrents";
  mutating: boolean;
  risk: "read_only" | "reversible" | "destructive";
  summary: string;
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  { name: "server_info", title: "Server information", category: "meta", mutating: false, risk: "read_only", summary: "Non-sensitive server metadata and version." },
  { name: "list_capabilities", title: "List capabilities", category: "meta", mutating: false, risk: "read_only", summary: "Implemented tools, planned work, and safety rules." },
  { name: "whatbox_configuration_status", title: "Configuration status", category: "meta", mutating: false, risk: "read_only", summary: "Local configuration completeness without values." },
  { name: "whatbox_connection_status", title: "Connection status", category: "observe", mutating: false, risk: "read_only", summary: "Pinned SSH connectivity check." },
  { name: "whatbox_operational_snapshot", title: "Operational snapshot", category: "observe", mutating: false, risk: "read_only", summary: "Consolidated storage, services, website, and safety state." },
  { name: "whatbox_storage_status", title: "Storage capacity", category: "observe", mutating: false, risk: "read_only", summary: "Filesystem capacity by allowed root." },
  { name: "whatbox_list_directory", title: "List directory", category: "observe", mutating: false, risk: "read_only", summary: "Bounded entries below an allowed root." },
  { name: "whatbox_structure_map", title: "Structure map", category: "observe", mutating: false, risk: "read_only", summary: "Directory-only map and Mermaid diagram." },
  { name: "whatbox_torrent_clients_status", title: "Torrent client processes", category: "observe", mutating: false, risk: "read_only", summary: "Running state of supported torrent clients." },
  { name: "whatbox_services_status", title: "Service inventory", category: "observe", mutating: false, risk: "read_only", summary: "Configured/running state of allowlisted services." },
  { name: "whatbox_configuration_review", title: "Configuration review", category: "observe", mutating: false, risk: "read_only", summary: "Conservative advisory findings." },
  { name: "whatbox_website_readiness", title: "Website readiness", category: "observe", mutating: false, risk: "read_only", summary: "Fixed nginx/website hosting readiness facts." },
  { name: "whatbox_website_diagnostics", title: "Website diagnostics", category: "observe", mutating: false, risk: "read_only", summary: "nginx syntax test, loopback probe, redacted error counts." },
  { name: "whatbox_website_deployment_plan", title: "Deployment plan (preview)", category: "website", mutating: false, risk: "read_only", summary: "Validate a local site and sign a plan; no execution." },
  { name: "whatbox_torrents_status", title: "Torrent status", category: "torrents", mutating: false, risk: "read_only", summary: "Bounded torrent listing via loopback RPC." },
  { name: "whatbox_list_quarantine", title: "List quarantine", category: "delete", mutating: false, risk: "read_only", summary: "Items awaiting restore or purge." },
  { name: "whatbox_upload_path", title: "Upload path", category: "files", mutating: true, risk: "reversible", summary: "Upload an allowlisted local path; never overwrites." },
  { name: "whatbox_download_path", title: "Download path", category: "files", mutating: true, risk: "reversible", summary: "Download to the local download directory." },
  { name: "whatbox_move_path", title: "Move path", category: "files", mutating: true, risk: "reversible", summary: "Move/rename within allowed roots; never overwrites." },
  { name: "whatbox_make_directory", title: "Make directory", category: "files", mutating: true, risk: "reversible", summary: "Create a directory and missing parents." },
  { name: "whatbox_backup_configuration", title: "Back up configuration", category: "backup", mutating: true, risk: "reversible", summary: "Download allowlisted service config as a timestamped backup." },
  { name: "whatbox_quarantine_path", title: "Quarantine (soft-delete)", category: "delete", mutating: true, risk: "destructive", summary: "Move a path to dated quarantine. Approval required." },
  { name: "whatbox_purge_quarantine", title: "Purge quarantine", category: "delete", mutating: true, risk: "destructive", summary: "Permanently delete a quarantined item. Second approval." },
  { name: "whatbox_service_control", title: "Service control", category: "services", mutating: true, risk: "destructive", summary: "Start (reversible) / stop / restart a service. Stop/restart need approval." },
  { name: "whatbox_website_deploy_execute", title: "Deploy website", category: "website", mutating: true, risk: "reversible", summary: "Stage, verify, atomically activate, health-check a release." },
  { name: "whatbox_website_rollback", title: "Roll back website", category: "website", mutating: true, risk: "destructive", summary: "Repoint to a prior release. Approval required." },
  { name: "whatbox_torrent_add", title: "Add torrent", category: "torrents", mutating: true, risk: "reversible", summary: "Add a magnet/HTTP(S) torrent." },
  { name: "whatbox_torrent_control", title: "Control torrent", category: "torrents", mutating: true, risk: "reversible", summary: "Pause/resume/label/ratio-limit one torrent." },
  { name: "whatbox_torrent_remove", title: "Remove torrent", category: "torrents", mutating: true, risk: "destructive", summary: "Remove a torrent, optionally deleting data. Approval required." }
];

export function renderToolCatalogMarkdown(mutationsEnabled: boolean) {
  const categories: Array<[ToolCatalogEntry["category"], string]> = [
    ["meta", "Meta"],
    ["observe", "Observe (read-only)"],
    ["files", "Files (reversible)"],
    ["backup", "Backup"],
    ["delete", "Delete (quarantine → purge)"],
    ["services", "Service control"],
    ["website", "Website"],
    ["torrents", "Torrents"]
  ];
  const riskBadge = {
    read_only: "read-only",
    reversible: "reversible · auto-runs when mutations enabled",
    destructive: "DESTRUCTIVE · always asks for human approval"
  } as const;

  const lines = [
    "# Whatbox MCP — tools & processes",
    "",
    `Remote mutations are currently **${mutationsEnabled ? "ENABLED" : "DISABLED"}**` +
      `${mutationsEnabled ? "" : " (set WHATBOX_MUTATIONS_ENABLED=true to enable)"}.`,
    "",
    "Destructive tools always require an explicit human approval round via MCP",
    "elicitation, even when the agent is in auto-mode. Deletion quarantines first;",
    "permanent purge is a separate second approval.",
    ""
  ];
  for (const [category, label] of categories) {
    const entries = TOOL_CATALOG.filter((tool) => tool.category === category);
    if (entries.length === 0) {
      continue;
    }
    lines.push(`## ${label}`, "");
    for (const tool of entries) {
      lines.push(`- \`${tool.name}\` — ${tool.summary} _(${riskBadge[tool.risk]})_`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
