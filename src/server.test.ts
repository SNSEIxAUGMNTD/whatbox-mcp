import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_NAME,
  SERVER_VERSION,
  createServer,
  getCapabilities,
  getServerInfo
} from "./server.js";

test("reports non-sensitive local server metadata", () => {
  assert.deepEqual(getServerInfo(), {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    transport: "stdio",
    mode: "local self-hosted",
    credentialPolicy:
      "Credentials are stored outside the repository and are never accepted as tool arguments.",
    remoteConnection: "configured locally when Whatbox tools are called"
  });
});

test("advertises read-only and gated mutation capabilities", () => {
  const capabilities = getCapabilities();

  for (const tool of [
    "server_info",
    "whatbox_operational_snapshot",
    "whatbox_list_tools",
    "whatbox_upload_path",
    "whatbox_quarantine_path",
    "whatbox_purge_quarantine",
    "whatbox_backup_configuration",
    "whatbox_service_control",
    "whatbox_website_deploy_execute",
    "whatbox_torrent_remove"
  ]) {
    assert.ok(
      capabilities.availableNow.includes(tool),
      `expected ${tool} to be advertised`
    );
  }
  assert.equal(
    capabilities.agentInterfaces.preferredAssessmentTool,
    "whatbox_operational_snapshot"
  );
  assert.deepEqual(capabilities.agentInterfaces.prompts, ["whatbox_safe_audit"]);
  assert.ok(
    capabilities.agentInterfaces.resources.includes("whatbox://guide/tools")
  );
  assert.match(capabilities.safetyModel[0], /No generic remote shell tool/);
  assert.ok(
    capabilities.safetyModel.some((item) =>
      item.includes("Mutations are disabled unless")
    )
  );
  assert.ok(
    capabilities.safetyModel.some((item) => item.includes("quarantines data"))
  );
  assert.ok(
    capabilities.safetyModel.some((item) => item.includes("audit log"))
  );
});

test("constructs the MCP server with its initial tools", () => {
  const server = createServer();

  assert.ok(server);
});
