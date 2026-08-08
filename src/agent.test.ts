import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_GUIDE,
  buildOperationalSnapshot,
  toSafeStorageStatus
} from "./agent.js";

test("builds a sanitized consolidated snapshot for an agent", () => {
  const result = buildOperationalSnapshot(
    [
      {
        service: "nginx",
        category: "web",
        configured: true,
        running: true,
        state: "running",
        health: "not_checked"
      }
    ],
    [
      {
        rootIndex: 0,
        rootPath: "/private/remote/path",
        totalBytes: 100,
        usedBytes: 20,
        availableBytes: 80,
        usedPercent: 20
      }
    ],
    {
      observations: {
        nginxBinaryAvailable: true,
        nginxConfiguration: { directoryExists: true, fileExists: true },
        nginxProcess: { running: true, health: "not_checked" },
        candidateWebsiteRoots: [
          { rootIndex: 0, relativePath: "www", exists: true }
        ],
        storage: [
          { rootIndex: 0, availableBytes: 80, usedPercent: 20, ready: true }
        ]
      },
      recommendations: []
    },
    {
      overall: "no_obvious_issues",
      findings: [],
      scope: {
        serviceProcessAndConfigMetadata: true,
        storageCapacity: true,
        configurationContentsInspected: false
      }
    }
  );

  assert.equal(result.overall, "read_only_ready");
  assert.deepEqual(result.observations.services.running, ["nginx"]);
  assert.equal(result.observations.website.processHealth, "not_checked");
  assert.equal(JSON.stringify(result).includes("/private/remote/path"), false);
  assert.equal(result.safety.remoteMutationsEnabled, false);
});

test("agent guide preserves secret and approval boundaries", () => {
  assert.match(AGENT_GUIDE, /Never ask for or echo local\.env/);
  assert.match(AGENT_GUIDE, /input_required/);
  assert.match(AGENT_GUIDE, /Remote mutation and deployment execution are disabled/);
});

test("removes configured remote paths from storage tool results", () => {
  const result = toSafeStorageStatus([
    {
      rootIndex: 0,
      rootPath: "/home/private-user/files",
      totalBytes: 100,
      usedBytes: 20,
      availableBytes: 80,
      usedPercent: 20
    }
  ]);

  assert.deepEqual(result, [
    {
      rootIndex: 0,
      measures: "shared_filesystem",
      totalBytes: 100,
      usedBytes: 20,
      availableBytes: 80,
      usedPercent: 20
    }
  ]);
});
