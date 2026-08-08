#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

async function main() {
  await serveStdio(() => createServer());
}

main().catch((error: unknown) => {
  console.error("whatbox-mcp failed to start", error);
  process.exitCode = 1;
});
