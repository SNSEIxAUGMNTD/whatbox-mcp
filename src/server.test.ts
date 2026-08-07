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

test("starts with no remote mutation capabilities", () => {
  const capabilities = getCapabilities();

  assert.deepEqual(capabilities.availableNow, [
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
  ]);
  assert.equal(
    capabilities.agentInterfaces.preferredAssessmentTool,
    "whatbox_operational_snapshot"
  );
  assert.deepEqual(capabilities.agentInterfaces.prompts, ["whatbox_safe_audit"]);
  assert.ok(capabilities.criticalNext.some((item) => item.includes("input_required")));
  assert.match(capabilities.safetyModel[0], /No generic remote shell tool/);
  assert.ok(
    capabilities.safetyModel.some((item) =>
      item.includes("external human approval")
    )
  );
  assert.ok(
    capabilities.safetyModel.some((item) => item.includes("quarantines data"))
  );
});

test("constructs the MCP server with its initial tools", () => {
  const server = createServer();

  assert.ok(server);
});
