import { buildOperationalSnapshot } from "./agent.js";
import { loadConfig } from "./config.js";
import {
  getWhatboxServiceInventory,
  getWhatboxStorageStatus,
  getWhatboxWebsiteReadiness,
  reviewWhatboxConfiguration,
  toSafeConnectionDiagnostic,
  withWhatboxClient
} from "./whatbox.js";

try {
  const config = loadConfig();
  const snapshot = await withWhatboxClient(config, async (client) => {
    const [services, storage, website] = await Promise.all([
      getWhatboxServiceInventory(client, config),
      getWhatboxStorageStatus(client, config),
      getWhatboxWebsiteReadiness(client, config)
    ]);
    return buildOperationalSnapshot(
      services,
      storage,
      website,
      reviewWhatboxConfiguration(services, storage)
    );
  });

  console.log(JSON.stringify(snapshot, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      { connected: false, ...toSafeConnectionDiagnostic(error) },
      null,
      2
    )
  );
  process.exitCode = 1;
}
