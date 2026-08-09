import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  executeFixedCommandWithStatus,
  WhatboxConnectionError,
  classifySshConnectionError,
  createDirectoryMapMermaid,
  createHostVerifier,
  isSensitiveDirectoryPath,
  parseDfOutput,
  parseHomeUsageOutput,
  parseQuotaOutput,
  parseNginxBinaryAvailability,
  parseNginxConfigurationTest,
  parseServiceProcesses,
  parseTorrentClientProcesses,
  parseWebsiteHealthProbe,
  resolveAgentSocket,
  resolveAllowedPath,
  reviewWhatboxConfiguration,
  summarizeNginxErrorLog,
  toSafeConnectionDiagnostic,
  toSafeConnectionFailure
} from "./whatbox.js";

test("verifies a pinned SHA-256 host-key fingerprint", () => {
  const hostKey = Buffer.from("test host key");
  const fingerprint = createHash("sha256").update(hostKey).digest("base64");
  const verifier = createHostVerifier(`SHA256:${fingerprint}`);

  assert.equal(verifier(hostKey), true);
  assert.equal(verifier(Buffer.from("different host key")), false);
});

test("resolves the SSH agent socket across platforms", () => {
  assert.equal(
    resolveAgentSocket({ SSH_AUTH_SOCK: "/tmp/agent.sock" }, "darwin"),
    "/tmp/agent.sock"
  );
  assert.equal(
    resolveAgentSocket({ SSH_AUTH_SOCK: "/tmp/agent.sock" }, "win32"),
    "/tmp/agent.sock"
  );
  assert.equal(
    resolveAgentSocket({}, "win32"),
    "\\\\.\\pipe\\openssh-ssh-agent"
  );
  assert.equal(resolveAgentSocket({}, "linux"), undefined);
});

test("allows relative paths contained by a configured root", () => {
  assert.equal(
    resolveAllowedPath("/home/example/files", "media/movies"),
    "/home/example/files/media/movies"
  );
});

test("rejects traversal and absolute paths", () => {
  assert.throws(() =>
    resolveAllowedPath("/home/example/files", "../../private")
  );
  assert.throws(() =>
    resolveAllowedPath("/home/example/files", "/etc")
  );
});

test("parses portable df output into bytes", () => {
  const result = parseDfOutput(
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/test 1000 250 750 25% /home/example/files\n",
    0,
    "/home/example/files"
  );

  assert.deepEqual(result, {
    rootIndex: 0,
    rootPath: "/home/example/files",
    totalBytes: 1_024_000,
    usedBytes: 256_000,
    availableBytes: 768_000,
    usedPercent: 25
  });
});

test("parses account quota output and reports unavailable when unset", () => {
  assert.deepEqual(
    parseQuotaOutput(
      "Disk quotas for user example (uid 1000):\n" +
        "     Filesystem  blocks   quota   limit   grace   files   quota   limit\n" +
        "      /dev/test  1000*    4000    5000            120       0       0\n"
    ),
    {
      source: "quota",
      usedBytes: 1_024_000,
      softLimitBytes: 4_096_000,
      hardLimitBytes: 5_120_000,
      usedPercent: 25
    }
  );

  assert.deepEqual(
    parseQuotaOutput("Disk quotas for user example (uid 1000): none\n"),
    {
      source: "unavailable",
      usedBytes: null,
      softLimitBytes: null,
      hardLimitBytes: null,
      usedPercent: null
    }
  );
});

test("reports only allowlisted torrent-client process states", () => {
  assert.deepEqual(
    parseTorrentClientProcesses(
      "rtorrent main\ndeluged\nunrelated-private-process\nqbittorrent-nox\n"
    ),
    [
      { client: "rtorrent", running: true },
      { client: "deluge", running: true },
      { client: "transmission", running: false },
      { client: "qbittorrent", running: true }
    ]
  );
});

test("parses the fixed Nginx binary probe without accepting arbitrary output", () => {
  assert.equal(parseNginxBinaryAvailability("available\n"), true);
  assert.equal(parseNginxBinaryAvailability("unavailable\n"), false);
  assert.equal(parseNginxBinaryAvailability("available; cat private-file"), false);
});

test("parses fixed Nginx configuration and loopback health results", () => {
  assert.equal(parseNginxConfigurationTest("valid\n"), "valid");
  assert.equal(parseNginxConfigurationTest("invalid\n"), "invalid");
  assert.equal(parseNginxConfigurationTest("valid; private output"), "unavailable");

  assert.deepEqual(parseWebsiteHealthProbe("response 204 0.125\n"), {
    state: "responding",
    statusCode: 204,
    latencyMs: 125
  });
  assert.deepEqual(parseWebsiteHealthProbe("response 503 0.004\n"), {
    state: "server_error",
    statusCode: 503,
    latencyMs: 4
  });
  assert.deepEqual(parseWebsiteHealthProbe("unreachable\n"), {
    state: "unreachable"
  });
});

test("summarizes Nginx error severities without returning log lines", () => {
  const privateLine = "2026/08/07 [error] private request path and client details";
  const summary = summarizeNginxErrorLog(
    `${privateLine}\n2026/08/07 [warn] another private detail\n`
  );

  assert.equal(summary.sampledLineCount, 2);
  assert.equal(summary.severityCounts.error, 1);
  assert.equal(summary.severityCounts.warning, 1);
  assert.equal(JSON.stringify(summary).includes("private request path"), false);
});

test("matches only allowlisted service process names", () => {
  const states = parseServiceProcesses(
    "Sonarr\njellyfin\nnginx\nunrelated-private-process\n"
  );

  assert.equal(states.get("sonarr"), true);
  assert.equal(states.get("jellyfin"), true);
  assert.equal(states.get("nginx"), true);
  assert.equal(states.get("plex"), false);
  assert.equal(states.has("unrelated-private-process"), false);
});

test("produces conservative configuration findings without automatic fixes", () => {
  const review = reviewWhatboxConfiguration(
    [
      {
        service: "rtorrent",
        category: "torrent",
        configured: true,
        running: true,
        state: "running",
        health: "not_checked"
      },
      {
        service: "qbittorrent",
        category: "torrent",
        configured: true,
        running: true,
        state: "running",
        health: "not_checked"
      },
      {
        service: "php-fpm",
        category: "web",
        configured: true,
        running: true,
        state: "running",
        health: "not_checked"
      },
      {
        service: "nginx",
        category: "web",
        configured: false,
        running: false,
        state: "not_configured",
        health: "not_checked"
      }
    ],
    [
      {
        rootIndex: 0,
        rootPath: "/redacted",
        totalBytes: 100,
        usedBytes: 96,
        availableBytes: 4,
        usedPercent: 96
      }
    ]
  );

  assert.equal(review.overall, "critical_attention");
  assert.deepEqual(
    review.findings.map((finding) => finding.id),
    [
      "storage-critical-root-0",
      "multiple-running-torrent-clients",
      "php-fpm-without-detected-nginx"
    ]
  );
  assert.ok(
    review.findings.every((finding) => !finding.automaticFixAvailable)
  );
  assert.equal(review.scope.configurationContentsInspected, false);
});

test("generates Mermaid with stable IDs and sanitized directory labels", () => {
  const mermaid = createDirectoryMapMermaid([
    {
      id: "n0",
      parentId: null,
      name: "root[0]",
      relativePath: ".",
      depth: 0,
      directoryCount: 1,
      fileCount: 2,
      fileBytes: 100
    },
    {
      id: "n1",
      parentId: "n0",
      name: "media\"] --> unsafe",
      relativePath: "media",
      depth: 1,
      directoryCount: 0,
      fileCount: 3,
      fileBytes: 200
    }
  ]);

  assert.equal(
    mermaid,
    "flowchart TD\n"
      + "  n0[\"root_0_ (2 files)\"]\n"
      + "  n1[\"media__ --_ unsafe (3 files)\"]\n"
      + "  n0 --> n1"
  );
});

test("denies sensitive directories as structure-map roots", () => {
  assert.equal(isSensitiveDirectoryPath("/home/example/files"), false);
  assert.equal(isSensitiveDirectoryPath("/home/example/.ssh"), true);
  assert.equal(
    isSensitiveDirectoryPath("/home/example/.config/whatbox-mcp"),
    true
  );
});

test("classifies SSH failures without returning raw error details", () => {
  const authenticationError = Object.assign(
    new Error("sensitive raw authentication message"),
    { level: "client-authentication" }
  );

  assert.equal(
    classifySshConnectionError(authenticationError),
    "authentication_failed"
  );
  assert.equal(
    toSafeConnectionFailure(
      new WhatboxConnectionError("host_verification_failed")
    ),
    "host_verification_failed"
  );

  assert.equal(
    classifySshConnectionError(
      Object.assign(new Error("socket details"), { code: "ECONNRESET" })
    ),
    "connection_reset"
  );

  assert.equal(
    classifySshConnectionError(
      Object.assign(new Error("sensitive agent details"), { level: "agent" })
    ),
    "agent_communication_failed"
  );

  assert.equal(
    classifySshConnectionError(
      Object.assign(new Error("sensitive DNS details"), { level: "client-dns" })
    ),
    "dns_resolution_failed"
  );

  assert.deepEqual(
    toSafeConnectionDiagnostic(
      new WhatboxConnectionError("connection_closed", "authentication")
    ),
    { failure: "connection_closed", stage: "authentication" }
  );

  assert.deepEqual(
    toSafeConnectionDiagnostic(
      new WhatboxConnectionError(
        "connection_failed",
        "tcp_connection",
        "EPERM"
      )
    ),
    {
      failure: "connection_failed",
      stage: "tcp_connection",
      transportCode: "EPERM"
    }
  );
});

test("executeFixedCommandWithStatus times out a command that never closes", async () => {
  // A fake channel that opens but never emits "close" — the hung-command case
  // SSH keepalive cannot catch because the connection stays healthy.
  const hangingClient = {
    exec(_command: string, cb: (error: null, stream: unknown) => void) {
      const stream = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter & { resume: () => void };
        destroy: () => void;
        close: () => void;
      };
      stream.stderr = Object.assign(new EventEmitter(), { resume() {} });
      stream.destroy = () => {};
      stream.close = () => {};
      cb(null, stream);
    }
  };

  await assert.rejects(
    executeFixedCommandWithStatus(
      hangingClient as unknown as Parameters<
        typeof executeFixedCommandWithStatus
      >[0],
      "sleep 999",
      20
    ),
    /timed out/
  );
});

test("parses a du total and rejects garbage", () => {
  assert.equal(parseHomeUsageOutput("1396703940608\t/home/example\n"), 1396703940608);
  assert.equal(parseHomeUsageOutput(""), null);
  assert.equal(parseHomeUsageOutput("du: cannot access"), null);
});
