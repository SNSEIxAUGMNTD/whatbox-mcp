import { inspectConfiguration } from "./config.js";

const status = inspectConfiguration();
console.log(JSON.stringify(status, null, 2));

if (!status.configured) {
  process.exitCode = 1;
}
