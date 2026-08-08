import { loadConfig } from "./config.js";
import {
  getWhatboxWebsiteDiagnostics,
  toSafeConnectionDiagnostic,
  WhatboxConnectionError,
  withWhatboxClient
} from "./whatbox.js";

try {
  const config = loadConfig();
  const diagnostics = await withWhatboxClient(config, (client) =>
    getWhatboxWebsiteDiagnostics(client, config)
  );

  console.log(
    JSON.stringify({ websiteDiagnosticsReadable: true, ...diagnostics }, null, 2)
  );
} catch (error) {
  const result = error instanceof WhatboxConnectionError
    ? {
        websiteDiagnosticsReadable: false,
        connected: false,
        ...toSafeConnectionDiagnostic(error)
      }
    : {
        websiteDiagnosticsReadable: false,
        connected: true,
        failure: "website_diagnostics_query_failed"
      };

  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
