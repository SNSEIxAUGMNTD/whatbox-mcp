import { loadConfig } from "./config.js";
import {
  getWhatboxStorageStatus,
  toSafeConnectionDiagnostic,
  WhatboxConnectionError,
  withWhatboxClient
} from "./whatbox.js";

try {
  const config = loadConfig();
  const roots = await withWhatboxClient(config, (client) =>
    getWhatboxStorageStatus(client, config)
  );

  console.log(
    JSON.stringify(
      {
        connected: true,
        storageReadable: true,
        rootCount: roots.length
      },
      null,
      2
    )
  );
} catch (error) {
  const result = error instanceof WhatboxConnectionError
    ? { connected: false, ...toSafeConnectionDiagnostic(error) }
    : { connected: true, storageReadable: false, failure: "storage_query_failed" };

  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
