import { loadConfig } from "./config.js";
import {
  getWhatboxServiceInventory,
  toSafeConnectionDiagnostic,
  WhatboxConnectionError,
  withWhatboxClient
} from "./whatbox.js";

try {
  const config = loadConfig();
  const services = await withWhatboxClient(config, (client) =>
    getWhatboxServiceInventory(client, config)
  );

  console.log(
    JSON.stringify(
      {
        connected: true,
        servicesReadable: true,
        services
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
        servicesReadable: false,
        failure: "service_inventory_failed"
      };

  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}
