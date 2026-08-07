import { loadConfig } from "./config.js";
import {
  toSafeConnectionDiagnostic,
  withWhatboxClient
} from "./whatbox.js";

try {
  const startedAt = Date.now();
  await withWhatboxClient(loadConfig(), async () => undefined);
  console.log(
    JSON.stringify(
      { connected: true, latencyMs: Date.now() - startedAt },
      null,
      2
    )
  );
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
