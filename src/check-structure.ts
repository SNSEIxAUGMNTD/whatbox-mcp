import { loadConfig } from "./config.js";
import {
  mapWhatboxDirectory,
  toSafeConnectionDiagnostic,
  WhatboxConnectionError,
  withWhatboxClient
} from "./whatbox.js";

try {
  const config = loadConfig();
  const result = await withWhatboxClient(config, (client) =>
    mapWhatboxDirectory(client, config, 0, 2, 100)
  );

  console.log(
    JSON.stringify(
      {
        connected: true,
        structureReadable: true,
        directoryNodeCount: result.nodes.length,
        excludedSensitiveDirectoryCount:
          result.excludedSensitiveDirectoryCount,
        truncated: result.truncated,
        diagramGenerated: result.mermaid.startsWith("flowchart TD")
      },
      null,
      2
    )
  );
} catch (error) {
  const result = error instanceof WhatboxConnectionError
    ? { connected: false, ...toSafeConnectionDiagnostic(error) }
    : {
        connected: true,
        structureReadable: false,
        failure: "structure_query_failed"
      };

  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
