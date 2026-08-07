import { loadConfig } from "./config.js";
import {
  getWhatboxWebsiteReadiness,
  toSafeConnectionDiagnostic,
  WhatboxConnectionError,
  withWhatboxClient
} from "./whatbox.js";

try {
  const config = loadConfig();
  const readiness = await withWhatboxClient(config, (client) =>
    getWhatboxWebsiteReadiness(client, config)
  );

  console.log(JSON.stringify({ websiteReadinessReadable: true, ...readiness }, null, 2));
} catch (error) {
  const result = error instanceof WhatboxConnectionError
    ? { websiteReadinessReadable: false, connected: false, ...toSafeConnectionDiagnostic(error) }
    : {
        websiteReadinessReadable: false,
        connected: true,
        failure: "website_readiness_query_failed"
      };

  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
