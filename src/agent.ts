import type {
  ConfigurationReview,
  ServiceInventoryEntry,
  StorageStatus,
  WebsiteReadiness
} from "./whatbox.js";

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
  safety: {
    remoteMutationsEnabled: false;
    deploymentExecutionEnabled: false;
    configurationContentsInspected: false;
  };
}

export function toSafeStorageStatus(storage: StorageStatus[]) {
  return storage.map(({ rootPath: _rootPath, ...root }) => root);
}

export function buildOperationalSnapshot(
  services: ServiceInventoryEntry[],
  storage: StorageStatus[],
  website: WebsiteReadiness,
  review: ConfigurationReview
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
    safety: {
      remoteMutationsEnabled: false,
      deploymentExecutionEnabled: false,
      configurationContentsInspected: false
    }
  };
}

export const AGENT_GUIDE = `# Whatbox MCP agent guide

Use this server as a security-first, local MCP for one explicitly configured Whatbox slot.

## Safe operating sequence

1. Call server_info and list_capabilities.
2. Call whatbox_configuration_status before any remote tool.
3. Prefer whatbox_operational_snapshot for a consolidated, sanitized assessment.
4. Use focused read-only tools only when more detail is needed.
5. Treat process running state as an observation, never as proof of health.
6. Keep observations separate from recommendations.
7. Never ask for or echo local.env, SSH keys, passphrases, approval keys, cookies, or raw SSH diagnostics.
8. Never infer authorization from a boolean or confirmation phrase.

## Mutation boundary

Remote mutation and deployment execution are disabled. The deployment-plan tool validates and signs a preview only. A future mutation must use negotiated MCP input_required interaction, exact target binding, short expiry, one-time consumption, validation, and rollback.

## External Whatbox steps

Manage Apps, managed links, DNS, domains, billing, and provider account actions are outside this SSH MCP unless a separately authorized provider integration is added.
`;
