import { loadConfig } from "./config.js";
import {
  getWhatboxServiceInventory,
  getWhatboxStorageStatus,
  reviewWhatboxConfiguration,
  toSafeConnectionDiagnostic,
  WhatboxConnectionError,
  withWhatboxClient
} from "./whatbox.js";

try {
  const config = loadConfig();
  const review = await withWhatboxClient(config, async (client) => {
    const services = await getWhatboxServiceInventory(client, config);
    const storage = await getWhatboxStorageStatus(client, config);
    return reviewWhatboxConfiguration(services, storage);
  });

  console.log(
    JSON.stringify(
      {
        connected: true,
        reviewReadable: true,
        review
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
        reviewReadable: false,
        failure: "configuration_review_failed"
      };

  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
