import { loadConfig } from "./config.js";
import {
  listWhatboxDirectory,
  toSafeConnectionDiagnostic,
  WhatboxConnectionError,
  withWhatboxClient
} from "./whatbox.js";

try {
  const config = loadConfig();
  const result = await withWhatboxClient(config, (client) =>
    listWhatboxDirectory(client, config, 0, ".", 10)
  );

  console.log(
    JSON.stringify(
      {
        connected: true,
        directoryReadable: true,
        sampledEntryCount: result.entries.length,
        truncated: result.truncated
      },
      null,
      2
    )
  );
} catch (error) {
  const result = error instanceof WhatboxConnectionError
    ? { connected: false, ...toSafeConnectionDiagnostic(error) }
    : { connected: true, directoryReadable: false, failure: "directory_query_failed" };

  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
