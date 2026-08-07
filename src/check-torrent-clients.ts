import { loadConfig } from "./config.js";
import {
  getWhatboxTorrentClientStatus,
  toSafeConnectionDiagnostic,
  WhatboxConnectionError,
  withWhatboxClient
} from "./whatbox.js";

try {
  const config = loadConfig();
  const clients = await withWhatboxClient(config, (client) =>
    getWhatboxTorrentClientStatus(client, config)
  );

  console.log(
    JSON.stringify(
      {
        connected: true,
        torrentClientsReadable: true,
        clients
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
        torrentClientsReadable: false,
        failure: "torrent_client_query_failed"
      };

  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
