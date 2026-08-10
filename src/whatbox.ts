import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import type { WhatboxConfig } from "./config.js";
import {
  APP_MANIFESTS,
  buildRunningProbeScript,
  parseAppRunningStates
} from "./apps.js";
import { getTorrentBasePaths } from "./torrent.js";

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
// A fixed read-only query is fast; this bounds a command that hangs while the
// SSH connection stays healthy (keepalive only catches a dead connection, not
// a command that never exits). The account-quota du walk passes a larger budget.
const FIXED_COMMAND_TIMEOUT_MS = 60_000;
const ACCOUNT_QUOTA_TIMEOUT_MS = 180_000;
const MAX_ERROR_LOG_SAMPLE_BYTES = 32 * 1024;

export type ConnectionFailure =
  | "agent_unavailable"
  | "agent_communication_failed"
  | "authentication_failed"
  | "host_verification_failed"
  | "connection_refused"
  | "connection_reset"
  | "dns_resolution_failed"
  | "network_unreachable"
  | "connection_timed_out"
  | "connection_closed"
  | "ssh_handshake_failed"
  | "key_unavailable"
  | "configuration_invalid"
  | "connection_failed";

export type ConnectionStage =
  | "configuration"
  | "dns_resolution"
  | "tcp_connection"
  | "ssh_handshake"
  | "authentication";

const SAFE_TRANSPORT_CODES = new Set([
  "EACCES",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOBUFS",
  "ENOTFOUND",
  "EPERM",
  "EPIPE",
  "ETIMEDOUT"
] as const);

type SafeTransportCode = typeof SAFE_TRANSPORT_CODES extends Set<infer Code>
  ? Code
  : never;

export class WhatboxConnectionError extends Error {
  constructor(
    public readonly failure: ConnectionFailure,
    public readonly stage: ConnectionStage = "configuration",
    public readonly transportCode?: SafeTransportCode
  ) {
    super("Whatbox SSH connection failed");
    this.name = "WhatboxConnectionError";
  }
}

interface SshConnectionError extends Error {
  code?: string | number;
  level?: string;
}

function getSafeTransportCode(error: unknown): SafeTransportCode | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const code = (error as SshConnectionError).code;
  return typeof code === "string" && SAFE_TRANSPORT_CODES.has(code as SafeTransportCode)
    ? code as SafeTransportCode
    : undefined;
}

export function classifySshConnectionError(error: unknown): ConnectionFailure {
  if (!(error instanceof Error)) {
    return "connection_failed";
  }

  const sshError = error as SshConnectionError;
  const message = sshError.message.toLowerCase();

  if (message.includes("verification") || message.includes("host denied")) {
    return "host_verification_failed";
  }

  if (sshError.level === "client-authentication") {
    return "authentication_failed";
  }

  if (sshError.level === "agent") {
    return "agent_communication_failed";
  }

  if (sshError.level === "client-timeout") {
    return "connection_timed_out";
  }

  if (sshError.level === "client-dns") {
    return "dns_resolution_failed";
  }

  if (sshError.code === "ENOTFOUND" || sshError.code === "EAI_AGAIN") {
    return "dns_resolution_failed";
  }

  if (sshError.code === "ECONNREFUSED") {
    return "connection_refused";
  }

  if (sshError.code === "ECONNRESET" || sshError.code === "EPIPE") {
    return "connection_reset";
  }

  if (
    sshError.code === "EHOSTUNREACH"
    || sshError.code === "ENETUNREACH"
  ) {
    return "network_unreachable";
  }

  if (sshError.code === "ETIMEDOUT") {
    return "connection_timed_out";
  }

  if (sshError.level === "handshake" || sshError.level === "client-ssh") {
    return "ssh_handshake_failed";
  }

  return "connection_failed";
}

export function toSafeConnectionFailure(error: unknown): ConnectionFailure {
  if (error instanceof WhatboxConnectionError) {
    return error.failure;
  }

  if (error instanceof Error && error.name === "ZodError") {
    return "configuration_invalid";
  }

  return "connection_failed";
}

export function toSafeConnectionDiagnostic(error: unknown) {
  if (error instanceof WhatboxConnectionError) {
    return {
      failure: error.failure,
      stage: error.stage,
      ...(error.transportCode ? { transportCode: error.transportCode } : {})
    };
  }

  return {
    failure: toSafeConnectionFailure(error),
    stage: "configuration" as ConnectionStage
  };
}

export interface DirectoryEntry {
  name: string;
  type: "directory" | "file" | "symlink" | "other";
  sizeBytes: number;
  modifiedAt: string;
}

export interface StorageStatus {
  rootIndex: number;
  rootPath: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

export interface AccountQuotaStatus {
  source: "quota" | "du" | "unavailable";
  usedBytes: number | null;
  softLimitBytes: number | null;
  hardLimitBytes: number | null;
  usedPercent: number | null;
}

export type TorrentClientName =
  | "rtorrent"
  | "deluge"
  | "transmission"
  | "qbittorrent";

export interface TorrentClientStatus {
  client: TorrentClientName;
  running: boolean;
}

export interface DirectoryMapNode {
  id: string;
  parentId: string | null;
  name: string;
  relativePath: string;
  depth: number;
  directoryCount: number;
  fileCount: number;
  fileBytes: number;
}

export interface DirectoryMap {
  rootIndex: number;
  nodes: DirectoryMapNode[];
  excludedSensitiveDirectoryCount: number;
  truncated: boolean;
  mermaid: string;
}

export type ServiceState =
  | "running"
  | "configured_not_detected"
  | "not_configured";

export interface ServiceInventoryEntry {
  service: string;
  category: "torrent" | "media" | "automation" | "web" | "sync";
  configured: boolean;
  running: boolean;
  state: ServiceState;
  health: "not_checked";
}

export interface ConfigurationFinding {
  id: string;
  severity: "info" | "warning" | "critical";
  confidence: "low" | "medium" | "high";
  observation: string;
  recommendation: string;
  automaticFixAvailable: false;
}

export interface ConfigurationReview {
  overall: "no_obvious_issues" | "attention_recommended" | "critical_attention";
  findings: ConfigurationFinding[];
  scope: {
    serviceProcessAndConfigMetadata: true;
    storageCapacity: true;
    configurationContentsInspected: false;
  };
}

export interface WebsiteReadiness {
  observations: {
    nginxBinaryAvailable: boolean;
    nginxConfiguration: {
      directoryExists: boolean;
      fileExists: boolean;
    };
    nginxProcess: {
      running: boolean;
      health: "not_checked";
    };
    candidateWebsiteRoots: Array<{
      rootIndex: number;
      relativePath: string;
      exists: boolean;
    }>;
    storage: Array<{
      rootIndex: number;
      availableBytes: number;
      usedPercent: number;
      ready: boolean;
    }>;
  };
  recommendations: Array<{
    id:
      | "nginx-binary-unavailable"
      | "nginx-configuration-not-detected"
      | "nginx-process-not-detected"
      | "website-root-not-detected"
      | "storage-needs-attention";
    recommendation: string;
  }>;
}

export type NginxConfigurationTestState =
  | "valid"
  | "invalid"
  | "unavailable"
  | "symlink_rejected";

export type WebsiteHealthProbeState =
  | "responding"
  | "server_error"
  | "unreachable"
  | "probe_unavailable"
  | "not_configured";

export interface WebsiteDiagnostics {
  observations: {
    nginxConfigurationTest: NginxConfigurationTestState;
    healthProbe: {
      state: WebsiteHealthProbeState;
      statusCode?: number;
      latencyMs?: number;
    };
    recentErrorLog: {
      state: "available" | "unavailable" | "symlink_rejected";
      sizeBytes?: number;
      modifiedAt?: string;
      sampledBytes: number;
      sampledLineCount: number;
      severityCounts: {
        emergency: number;
        alert: number;
        critical: number;
        error: number;
        warning: number;
        notice: number;
        info: number;
        debug: number;
      };
    };
  };
  recommendations: Array<{
    id: string;
    recommendation: string;
  }>;
  contentReturned: {
    nginxConfiguration: false;
    responseBody: false;
    logLines: false;
  };
}

export function createHostVerifier(expectedFingerprint: string) {
  const expected = expectedFingerprint
    .replace(/^SHA256:/, "")
    .replace(/=+$/, "");

  return (hostKey: Buffer) => {
    const actual = createHash("sha256")
      .update(hostKey)
      .digest("base64")
      .replace(/=+$/, "");
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);

    return expectedBuffer.length === actualBuffer.length
      && timingSafeEqual(expectedBuffer, actualBuffer);
  };
}

/**
 * Resolve the SSH agent endpoint. Honors SSH_AUTH_SOCK when set (macOS, Linux,
 * WSL, and Windows setups that export it); otherwise falls back to the Windows
 * OpenSSH Agent named pipe so native Windows works without extra configuration.
 */
export function resolveAgentSocket(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (env.SSH_AUTH_SOCK) {
    return env.SSH_AUTH_SOCK;
  }
  if (platform === "win32") {
    return "\\\\.\\pipe\\openssh-ssh-agent";
  }
  return undefined;
}

function buildConnectConfig(config: WhatboxConfig): ConnectConfig {
  const connection: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    forceIPv4: true,
    readyTimeout: 15_000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 2,
    hostVerifier: createHostVerifier(config.hostFingerprintSha256),
    algorithms: {
      serverHostKey: ["ssh-ed25519"]
    }
  };

  if (config.authMode === "agent") {
    const agentSocket = resolveAgentSocket();
    if (!agentSocket) {
      throw new WhatboxConnectionError("agent_unavailable");
    }
    connection.agent = agentSocket;
  } else {
    if (!config.sshKeyPath) {
      throw new WhatboxConnectionError("key_unavailable");
    }
    try {
      connection.privateKey = readFileSync(config.sshKeyPath);
    } catch {
      throw new WhatboxConnectionError("key_unavailable");
    }
    connection.passphrase = config.sshKeyPassphrase;
  }

  return connection;
}

export function connectWhatbox(config: WhatboxConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let stage: ConnectionStage = "configuration";

    const rejectOnce = (
      failure: ConnectionFailure,
      transportCode?: SafeTransportCode
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new WhatboxConnectionError(failure, stage, transportCode));
    };

    client.once("ready", () => {
      settled = true;
      resolve(client);
    });
    client.once("connect", () => {
      stage = "ssh_handshake";
    });
    client.once("handshake", () => {
      stage = "authentication";
    });
    client.once("error", (error) => {
      const errorLevel = (error as SshConnectionError).level;
      if (errorLevel === "client-dns") {
        stage = "dns_resolution";
      } else if (errorLevel === "client-socket") {
        stage = "tcp_connection";
      }
      rejectOnce(
        classifySshConnectionError(error),
        getSafeTransportCode(error)
      );
    });
    client.once("close", () => {
      rejectOnce("connection_closed");
    });

    try {
      client.connect(buildConnectConfig(config));
      stage = "dns_resolution";
    } catch (error) {
      client.end();
      if (settled) {
        return;
      }
      settled = true;
      reject(error instanceof WhatboxConnectionError
        ? error
        : new WhatboxConnectionError("connection_failed", stage));
    }
  });
}

export function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(new Error("Unable to open the SFTP subsystem"));
        return;
      }
      resolve(sftp);
    });
  });
}

export function realpath(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(remotePath, (error, resolvedPath) => {
      if (error) {
        reject(new Error("The requested remote path does not exist"));
        return;
      }
      resolve(resolvedPath);
    });
  });
}

export function isWithinRoot(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function resolveAllowedPath(root: string, relativePath: string) {
  if (relativePath.includes("\0") || posix.isAbsolute(relativePath)) {
    throw new Error("Directory path must be relative to an allowed root");
  }

  const candidate = posix.resolve(root, relativePath || ".");
  if (!isWithinRoot(root, candidate)) {
    throw new Error("Directory path escapes its allowed root");
  }

  return candidate;
}

function readDirectory(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<DirectoryEntry[]>((resolve, reject) => {
    sftp.readdir(remotePath, (error, entries) => {
      if (error) {
        reject(new Error("Unable to read the requested directory"));
        return;
      }

      resolve(
        entries.map((entry) => ({
          name: entry.filename,
          type: entry.attrs.isDirectory()
            ? "directory"
            : entry.attrs.isFile()
              ? "file"
              : entry.attrs.isSymbolicLink()
                ? "symlink"
                : "other",
          sizeBytes: entry.attrs.size,
          modifiedAt: new Date(entry.attrs.mtime * 1000).toISOString()
        }))
      );
    });
  });
}

export async function listWhatboxDirectory(
  client: Client,
  config: WhatboxConfig,
  rootIndex: number,
  relativePath: string,
  limit: number
) {
  const root = config.observeRoots[rootIndex];
  if (!root) {
    throw new Error("Unknown observe-root index");
  }

  const candidate = resolveAllowedPath(root, relativePath);
  if (isSensitiveDirectoryPath(candidate)) {
    throw new Error("Sensitive directories cannot be listed");
  }
  const sftp = await openSftp(client);

  try {
    const canonicalRoot = await realpath(sftp, root);
    const canonicalCandidate = await realpath(sftp, candidate);

    if (!isWithinRoot(canonicalRoot, canonicalCandidate)) {
      throw new Error("Resolved directory path escapes its allowed root");
    }
    if (isSensitiveDirectoryPath(canonicalCandidate)) {
      throw new Error("Sensitive directories cannot be listed");
    }

    const entries = await readDirectory(sftp, canonicalCandidate);
    return {
      rootIndex,
      relativePath: relativePath || ".",
      entries: entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, limit),
      truncated: entries.length > limit
    };
  } finally {
    sftp.end();
  }
}

const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".aws",
  ".gnupg",
  ".kube",
  ".password-store",
  ".pki",
  ".ssh",
  "credentials",
  "keyrings",
  "secrets",
  "whatbox-mcp",
  // Observation covers the whole slot, so exclude the app directories that
  // hold plaintext or recoverable credentials on a Whatbox slot.
  ".irssi",
  ".znc",
  "autodl-irssi",
  "deluge",
  "rclone",
  "znc"
]);

function isSensitiveDirectoryName(name: string) {
  return SENSITIVE_DIRECTORY_NAMES.has(name.toLowerCase());
}

export function isSensitiveDirectoryPath(remotePath: string) {
  return remotePath
    .split("/")
    .filter(Boolean)
    .some(isSensitiveDirectoryName);
}

function sanitizeMermaidLabel(value: string) {
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9 ._@+()-]/g, "_")
    .trim()
    .slice(0, 80);
  return sanitized || "directory";
}

export function createDirectoryMapMermaid(nodes: DirectoryMapNode[]) {
  const lines = ["flowchart TD"];

  for (const node of nodes) {
    const label = sanitizeMermaidLabel(
      `${node.name} (${node.fileCount} files)`
    );
    lines.push(`  ${node.id}["${label}"]`);
    if (node.parentId) {
      lines.push(`  ${node.parentId} --> ${node.id}`);
    }
  }

  return lines.join("\n");
}

export async function mapWhatboxDirectory(
  client: Client,
  config: WhatboxConfig,
  rootIndex: number,
  maxDepth: number,
  maxNodes: number
): Promise<DirectoryMap> {
  const root = config.observeRoots[rootIndex];
  if (!root) {
    throw new Error("Unknown observe-root index");
  }
  if (isSensitiveDirectoryPath(root)) {
    throw new Error("Sensitive directories cannot be mapped");
  }

  const sftp = await openSftp(client);
  const nodes: DirectoryMapNode[] = [];
  let excludedSensitiveDirectoryCount = 0;
  let truncated = false;

  const queue: Array<{
    id: string;
    parentId: string | null;
    name: string;
    relativePath: string;
    depth: number;
  }> = [{
    id: "n0",
    parentId: null,
    name: `root[${rootIndex}]`,
    relativePath: ".",
    depth: 0
  }];

  try {
    const canonicalRoot = await realpath(sftp, root);

    while (queue.length > 0 && nodes.length < maxNodes) {
      const current = queue.shift();
      if (!current) {
        break;
      }

      const candidate = resolveAllowedPath(root, current.relativePath);
      const canonicalCandidate = await realpath(sftp, candidate);
      if (!isWithinRoot(canonicalRoot, canonicalCandidate)) {
        throw new Error("Resolved directory path escapes its allowed root");
      }

      const entries = await readDirectory(sftp, canonicalCandidate);
      const directories = entries
        .filter((entry) =>
          entry.type === "directory"
          && entry.name !== "."
          && entry.name !== ".."
        )
        .sort((left, right) => left.name.localeCompare(right.name));
      const files = entries.filter((entry) => entry.type === "file");

      nodes.push({
        ...current,
        directoryCount: directories.length,
        fileCount: files.length,
        fileBytes: files.reduce((total, file) => total + file.sizeBytes, 0)
      });

      for (const directory of directories) {
        if (isSensitiveDirectoryName(directory.name)) {
          excludedSensitiveDirectoryCount += 1;
          continue;
        }

        if (current.depth >= maxDepth || nodes.length + queue.length >= maxNodes) {
          truncated = true;
          continue;
        }

        const relativePath = current.relativePath === "."
          ? directory.name
          : posix.join(current.relativePath, directory.name);
        queue.push({
          id: `n${nodes.length + queue.length}`,
          parentId: current.id,
          name: directory.name,
          relativePath,
          depth: current.depth + 1
        });
      }
    }

    if (queue.length > 0) {
      truncated = true;
    }

    return {
      rootIndex,
      nodes,
      excludedSensitiveDirectoryCount,
      truncated,
      mermaid: createDirectoryMapMermaid(nodes)
    };
  } finally {
    sftp.end();
  }
}

export function quotePosixShell(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Run a fixed, server-authored command and return bounded output plus the
 * exit code. Callers never supply command strings; every caller passes a
 * fixed template with `quotePosixShell`-escaped configured values.
 */
export function executeFixedCommandWithStatus(
  client: Client,
  command: string,
  timeoutMs = FIXED_COMMAND_TIMEOUT_MS
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(new Error("Unable to run the fixed command"));
        return;
      }

      const output: Buffer[] = [];
      let outputBytes = 0;
      let failed = false;
      let settled = false;

      const finish = (action: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        action();
      };

      const timer = setTimeout(() => {
        finish(() => {
          stream.destroy();
          reject(new Error("The fixed command timed out"));
        });
      }, timeoutMs);

      stream.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          failed = true;
          stream.close();
          return;
        }
        output.push(chunk);
      });
      stream.on("close", (code: number | undefined) => {
        finish(() => {
          if (failed) {
            reject(new Error("The fixed command produced excessive output"));
            return;
          }
          resolve({
            code: typeof code === "number" ? code : -1,
            output: Buffer.concat(output).toString("utf8")
          });
        });
      });
      stream.stderr.resume();
    });
  });
}

function executeFixedReadOnlyQuery(
  client: Client,
  command: string
): Promise<string> {
  return executeFixedCommandWithStatus(client, command).then(
    ({ code, output }) => {
      if (code !== 0) {
        throw new Error("The fixed read-only query failed");
      }
      return output;
    }
  );
}

export function parseDfOutput(output: string, rootIndex: number, rootPath: string) {
  const lines = output.trim().split(/\r?\n/);
  const fields = lines.at(-1)?.trim().split(/\s+/) ?? [];
  if (fields.length < 6) {
    throw new Error("Storage query returned an unexpected response");
  }

  const numericFields = fields.slice(-5, -1);
  const [totalKiB, usedKiB, availableKiB] = numericFields
    .slice(0, 3)
    .map((value) => Number.parseInt(value, 10));
  const usedPercent = Number.parseInt(numericFields[3].replace("%", ""), 10);

  if ([totalKiB, usedKiB, availableKiB, usedPercent].some(Number.isNaN)) {
    throw new Error("Storage query returned invalid numeric values");
  }

  return {
    rootIndex,
    rootPath,
    totalBytes: totalKiB * 1024,
    usedBytes: usedKiB * 1024,
    availableBytes: availableKiB * 1024,
    usedPercent
  } satisfies StorageStatus;
}

export async function getWhatboxStorageStatus(
  client: Client,
  config: WhatboxConfig
) {
  const statuses: StorageStatus[] = [];

  for (const [rootIndex, rootPath] of config.observeRoots.entries()) {
    const output = await executeFixedReadOnlyQuery(
      client,
      `LC_ALL=C df -Pk -- ${quotePosixShell(rootPath)}`
    );
    statuses.push(parseDfOutput(output, rootIndex, rootPath));
  }

  return statuses;
}

export function parseQuotaOutput(output: string): AccountQuotaStatus {
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || !fields[0].startsWith("/")) {
      continue;
    }

    // blocks carries a trailing "*" when the soft limit is already exceeded.
    const blockKiB = Number.parseInt(fields[1].replace("*", ""), 10);
    const softKiB = Number.parseInt(fields[2], 10);
    const hardKiB = Number.parseInt(fields[3], 10);
    if ([blockKiB, softKiB, hardKiB].some(Number.isNaN)) {
      continue;
    }

    const limitKiB = softKiB > 0 ? softKiB : hardKiB;
    return {
      source: "quota",
      usedBytes: blockKiB * 1024,
      softLimitBytes: softKiB * 1024,
      hardLimitBytes: hardKiB * 1024,
      usedPercent:
        limitKiB > 0 ? Math.round((blockKiB / limitKiB) * 100) : null
    };
  }

  return {
    source: "unavailable",
    usedBytes: null,
    softLimitBytes: null,
    hardLimitBytes: null,
    usedPercent: null
  };
}

export function parseHomeUsageOutput(output: string): number | null {
  const total = Number.parseInt(output.trim().split(/\s+/)[0] ?? "", 10);
  return Number.isNaN(total) ? null : total;
}

export async function catalogWhatboxApps(
  client: Client,
  config: WhatboxConfig
) {
  const home = `/home/${config.username}`;
  const installed = new Map<string, boolean>();
  const sftp = await openSftp(client);
  try {
    for (const manifest of APP_MANIFESTS) {
      installed.set(
        manifest.id,
        await remotePathExists(sftp, `${home}/${manifest.marker}`)
      );
    }
  } finally {
    sftp.end();
  }

  // One command reports process state for every service app; utilities have no
  // service, so their `running` is null (nothing to run).
  const serviceManifests = APP_MANIFESTS.filter((manifest) => manifest.service);
  let running = new Map<string, boolean>();
  if (serviceManifests.length > 0) {
    const { output } = await executeFixedCommandWithStatus(
      client,
      buildRunningProbeScript(serviceManifests)
    );
    running = parseAppRunningStates(output);
  }

  const apps = APP_MANIFESTS.map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    category: manifest.category,
    summary: manifest.summary,
    version: manifest.version,
    installed: installed.get(manifest.id) ?? false,
    running: manifest.service ? (running.get(manifest.id) ?? false) : null,
    needsPort: manifest.service?.port ?? false
  }));
  return { apps };
}

// -- Directory usage breakdown ----------------------------------------------

export interface DirectoryUsageEntry {
  name: string;
  sizeBytes: number;
}

/**
 * Parse `du -d1 -B1` output into immediate children (sorted largest-first)
 * plus the directory total. The line whose path equals the target is the
 * total; the rest are immediate subdirectories. Top-level files are counted
 * in the total but not listed individually (a `du -d1` property).
 */
export function parseDuDepth1(
  output: string,
  canonicalTarget: string
): { entries: DirectoryUsageEntry[]; totalBytes: number } {
  const entries: DirectoryUsageEntry[] = [];
  let totalBytes = 0;
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const bytes = Number.parseInt(match[1], 10);
    const path = match[2];
    if (path === canonicalTarget) {
      totalBytes = bytes;
    } else {
      const name = path.slice(path.lastIndexOf("/") + 1);
      entries.push({ name, sizeBytes: bytes });
    }
  }
  entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { entries, totalBytes };
}

export async function getWhatboxDirectoryUsage(
  client: Client,
  config: WhatboxConfig,
  observeRootIndex: number,
  relativePath: string
) {
  const root = config.observeRoots[observeRootIndex];
  if (!root) {
    throw new Error("Unknown observe-root index");
  }
  const candidate = resolveAllowedPath(root, relativePath);
  if (isSensitiveDirectoryPath(candidate)) {
    throw new Error("Sensitive directories cannot be measured");
  }
  const sftp = await openSftp(client);
  let canonicalCandidate: string;
  try {
    const canonicalRoot = await realpath(sftp, root);
    canonicalCandidate = await realpath(sftp, candidate);
    if (!isWithinRoot(canonicalRoot, canonicalCandidate)) {
      throw new Error("Resolved path escapes its observe root");
    }
    if (isSensitiveDirectoryPath(canonicalCandidate)) {
      throw new Error("Sensitive directories cannot be measured");
    }
  } finally {
    sftp.end();
  }

  const quoted = quotePosixShell(canonicalCandidate);
  const { output } = await executeFixedCommandWithStatus(
    client,
    `LC_ALL=C nice -n 19 sh -c 'command -v ionice >/dev/null 2>&1 && exec ionice -c3 du -xH -d1 -B1 -- "$0"; exec du -xH -d1 -B1 -- "$0"' ${quoted} 2>/dev/null`,
    ACCOUNT_QUOTA_TIMEOUT_MS
  );
  const { entries, totalBytes } = parseDuDepth1(output, canonicalCandidate);
  return { relativePath: relativePath || ".", totalBytes, entries };
}

// -- Orphaned data ----------------------------------------------------------

/**
 * A top-level entry is orphaned when no torrent's data path is that entry or
 * lives inside it — i.e. no loaded torrent references it.
 */
export function computeOrphans(
  entryNames: string[],
  basePaths: string[],
  canonicalRoot: string
): string[] {
  return entryNames.filter((name) => {
    const abs = `${canonicalRoot}/${name}`;
    return !basePaths.some(
      (basePath) => basePath === abs || basePath.startsWith(`${abs}/`)
    );
  });
}

export async function findWhatboxOrphanedData(
  client: Client,
  config: WhatboxConfig,
  observeRootIndex: number,
  relativePath: string
) {
  const root = config.observeRoots[observeRootIndex];
  if (!root) {
    throw new Error("Unknown observe-root index");
  }
  const basePaths = await getTorrentBasePaths(client, config);

  const candidate = resolveAllowedPath(root, relativePath);
  if (isSensitiveDirectoryPath(candidate)) {
    throw new Error("Sensitive directories cannot be scanned");
  }
  const sftp = await openSftp(client);
  let canonicalCandidate: string;
  let entryNames: string[];
  try {
    const canonicalRoot = await realpath(sftp, root);
    canonicalCandidate = await realpath(sftp, candidate);
    if (!isWithinRoot(canonicalRoot, canonicalCandidate)) {
      throw new Error("Resolved path escapes its observe root");
    }
    const entries = await readDirectory(sftp, canonicalCandidate);
    entryNames = entries
      .map((entry) => entry.name)
      // Exclude sensitive dirs and the quarantine area (literal avoids a
      // cycle with whatbox-mutations, which owns the QUARANTINE_DIRECTORY const).
      .filter(
        (name) =>
          !isSensitiveDirectoryPath(name) && name !== ".whatbox-quarantine"
      );
  } finally {
    sftp.end();
  }

  const orphanNames = computeOrphans(
    entryNames,
    basePaths,
    canonicalCandidate
  ).slice(0, 100);

  // Size the orphans in one bounded du call.
  const orphans: DirectoryUsageEntry[] = [];
  if (orphanNames.length > 0) {
    const quotedPaths = orphanNames
      .map((name) => quotePosixShell(`${canonicalCandidate}/${name}`))
      .join(" ");
    const { output } = await executeFixedCommandWithStatus(
      client,
      `LC_ALL=C nice -n 19 du -sxH -B1 -- ${quotedPaths} 2>/dev/null`,
      ACCOUNT_QUOTA_TIMEOUT_MS
    );
    const sizes = new Map<string, number>();
    for (const line of output.split(/\r?\n/)) {
      const match = /^(\d+)\s+(.+)$/.exec(line.trim());
      if (match) {
        const path = match[2];
        sizes.set(path.slice(path.lastIndexOf("/") + 1), Number.parseInt(match[1], 10));
      }
    }
    for (const name of orphanNames) {
      orphans.push({ name, sizeBytes: sizes.get(name) ?? 0 });
    }
    orphans.sort((a, b) => b.sizeBytes - a.sizeBytes);
  }

  return {
    relativePath: relativePath || ".",
    torrentCount: basePaths.length,
    orphanCount: orphans.length,
    orphans
  };
}

export async function getWhatboxAccountQuota(
  client: Client,
  config: WhatboxConfig
) {
  const quota = parseQuotaOutput(
    await executeFixedReadOnlyQuery(
      client,
      "LC_ALL=C quota -w 2>/dev/null || true"
    )
  );
  if (quota.source === "quota") {
    return { ...quota, measuredMs: null };
  }

  // Whatbox does not enforce filesystem quotas, so fall back to the disk walk
  // their own wiki recommends. Idle I/O and lowest CPU priority keep this
  // courteous on shared storage; ionice is not guaranteed to exist. A single
  // walk only: `du A || du B` would rewalk everything whenever an actively
  // seeding file vanished mid-scan.
  const home = quotePosixShell(`/home/${config.username}`);
  const startedAt = Date.now();
  const { code, output } = await executeFixedCommandWithStatus(
    client,
    // -H dereferences the argument itself: on Whatbox /home/<user> can be a
    // symlink into the storage array, and without -H du measures the link (0
    // bytes, instantly) instead of the account's data.
    `LC_ALL=C nice -n 19 sh -c 'command -v ionice >/dev/null 2>&1 && exec ionice -c3 du -sxH -B1 -- "$0"; exec du -sxH -B1 -- "$0"' ${home} 2>/dev/null`,
    // A full-slot walk under idle I/O priority can take far longer than a
    // normal fixed query, so give it a generous ceiling rather than the default.
    ACCOUNT_QUOTA_TIMEOUT_MS
  );
  // Exit 1 means files changed or were unreadable during the walk — routine
  // on a box that is actively seeding — and the total is still printed.
  const usedBytes =
    code === 0 || code === 1 ? parseHomeUsageOutput(output) : null;
  const measuredMs = Date.now() - startedAt;

  if (usedBytes === null) {
    return { ...quota, measuredMs };
  }

  return {
    source: "du" as const,
    usedBytes,
    softLimitBytes: null,
    hardLimitBytes: null,
    usedPercent: null,
    measuredMs
  };
}

const TORRENT_CLIENT_PROCESS_NAMES: Record<TorrentClientName, Set<string>> = {
  rtorrent: new Set(["rtorrent", "rtorrent main"]),
  deluge: new Set(["deluged"]),
  transmission: new Set(["transmission-da", "transmission-daemon"]),
  qbittorrent: new Set(["qbittorrent", "qbittorrent-nox"])
};

export function parseTorrentClientProcesses(
  output: string
): TorrentClientStatus[] {
  const processes = new Set(
    output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
  );

  return (Object.entries(TORRENT_CLIENT_PROCESS_NAMES) as Array<
    [TorrentClientName, Set<string>]
  >).map(([client, processNames]) => ({
    client,
    running: [...processNames].some((name) => processes.has(name))
  }));
}

export async function getWhatboxTorrentClientStatus(
  client: Client,
  config: WhatboxConfig
) {
  const output = await executeFixedReadOnlyQuery(
    client,
    `LC_ALL=C ps -u ${quotePosixShell(config.username)} -o comm=`
  );
  return parseTorrentClientProcesses(output);
}

interface ServiceDefinition {
  service: string;
  category: ServiceInventoryEntry["category"];
  processNames: string[];
  configPaths: string[];
}

const SERVICE_DEFINITIONS: ServiceDefinition[] = [
  {
    service: "rtorrent",
    category: "torrent",
    processNames: ["rtorrent", "rtorrent main"],
    configPaths: [".config/rtorrent"]
  },
  {
    service: "deluge",
    category: "torrent",
    processNames: ["deluged"],
    configPaths: [".config/deluge"]
  },
  {
    service: "transmission",
    category: "torrent",
    processNames: ["transmission-da", "transmission-daemon"],
    configPaths: [".config/transmission-daemon"]
  },
  {
    service: "qbittorrent",
    category: "torrent",
    processNames: ["qbittorrent", "qbittorrent-nox"],
    configPaths: [".config/qBittorrent", ".config/qbittorrent"]
  },
  {
    service: "plex",
    category: "media",
    processNames: ["plex media serv", "plex media server"],
    configPaths: ["Library/Application Support/Plex Media Server"]
  },
  {
    service: "jellyfin",
    category: "media",
    processNames: ["jellyfin"],
    configPaths: [".config/jellyfin"]
  },
  {
    service: "sonarr",
    category: "automation",
    processNames: ["sonarr"],
    configPaths: [".config/Sonarr", ".config/sonarr"]
  },
  {
    service: "radarr",
    category: "automation",
    processNames: ["radarr"],
    configPaths: [".config/Radarr", ".config/radarr"]
  },
  {
    service: "prowlarr",
    category: "automation",
    processNames: ["prowlarr"],
    configPaths: [".config/Prowlarr", ".config/prowlarr"]
  },
  {
    service: "jackett",
    category: "automation",
    processNames: ["jackett"],
    configPaths: [".config/Jackett", ".config/cardigann"]
  },
  {
    service: "sabnzbd",
    category: "automation",
    processNames: ["sabnzbd", "sabnzbd.py"],
    configPaths: [".sabnzbd", ".config/sabnzbd"]
  },
  {
    service: "autobrr",
    category: "automation",
    processNames: ["autobrr"],
    configPaths: [".config/autobrr"]
  },
  {
    service: "bazarr",
    category: "automation",
    processNames: ["bazarr"],
    configPaths: [".config/bazarr"]
  },
  {
    service: "syncthing",
    category: "sync",
    processNames: ["syncthing"],
    configPaths: [".config/syncthing"]
  },
  {
    service: "nginx",
    category: "web",
    processNames: ["nginx"],
    configPaths: [".config/nginx"]
  },
  {
    service: "php-fpm",
    category: "web",
    processNames: ["php-fpm", "php-fpm8.2", "php-fpm8.3", "php-fpm8.4"],
    configPaths: [".config/php-fpm2", ".config/php", ".config/php-fpm"]
  }
];

function remotePathExists(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<boolean>((resolve) => {
    sftp.lstat(remotePath, (error) => resolve(!error));
  });
}

function remoteDirectoryExists(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<boolean>((resolve) => {
    sftp.lstat(remotePath, (error, attributes) =>
      resolve(!error && Boolean(attributes?.isDirectory()))
    );
  });
}

type RemoteFileState = "available" | "unavailable" | "symlink_rejected";

function remoteRegularFileState(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<RemoteFileState> {
  return new Promise((resolve) => {
    sftp.lstat(remotePath, (error, attributes) => {
      if (error || !attributes) {
        resolve("unavailable");
        return;
      }
      if (attributes.isSymbolicLink()) {
        resolve("symlink_rejected");
        return;
      }
      resolve(attributes.isFile() ? "available" : "unavailable");
    });
  });
}

interface RemoteFileTail {
  state: RemoteFileState;
  sizeBytes?: number;
  modifiedAt?: string;
  content: string;
}

function readRemoteRegularFileTail(
  sftp: SFTPWrapper,
  remotePath: string,
  maxBytes: number
): Promise<RemoteFileTail> {
  return new Promise((resolve) => {
    sftp.lstat(remotePath, (lstatError, attributes) => {
      if (lstatError || !attributes) {
        resolve({ state: "unavailable", content: "" });
        return;
      }
      if (attributes.isSymbolicLink()) {
        resolve({ state: "symlink_rejected", content: "" });
        return;
      }
      if (!attributes.isFile()) {
        resolve({ state: "unavailable", content: "" });
        return;
      }

      sftp.open(remotePath, "r", (openError, handle) => {
        if (openError) {
          resolve({ state: "unavailable", content: "" });
          return;
        }

        const finish = (result: RemoteFileTail) => {
          sftp.close(handle, () => resolve(result));
        };

        sftp.fstat(handle, (statError, stats) => {
          if (statError || !stats?.isFile()) {
            finish({ state: "unavailable", content: "" });
            return;
          }

          const length = Math.min(stats.size, maxBytes);
          const baseResult = {
            state: "available" as const,
            sizeBytes: stats.size,
            modifiedAt: new Date(stats.mtime * 1000).toISOString()
          };
          if (length === 0) {
            finish({ ...baseResult, content: "" });
            return;
          }

          const buffer = Buffer.alloc(length);
          sftp.read(
            handle,
            buffer,
            0,
            length,
            Math.max(0, stats.size - length),
            (readError, bytesRead) => {
              if (readError) {
                finish({ state: "unavailable", content: "" });
                return;
              }
              finish({
                ...baseResult,
                content: buffer.subarray(0, bytesRead).toString("utf8")
              });
            }
          );
        });
      });
    });
  });
}

export function parseServiceProcesses(output: string) {
  const processes = new Set(
    output
      .split(/\r?\n/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );

  return new Map(
    SERVICE_DEFINITIONS.map((definition) => [
      definition.service,
      definition.processNames.some((name) => processes.has(name.toLowerCase()))
    ])
  );
}

export async function getWhatboxServiceInventory(
  client: Client,
  config: WhatboxConfig
): Promise<ServiceInventoryEntry[]> {
  const processOutput = await executeFixedReadOnlyQuery(
    client,
    `LC_ALL=C ps -u ${quotePosixShell(config.username)} -o comm=`
  );
  const runningStates = parseServiceProcesses(processOutput);
  const sftp = await openSftp(client);
  const home = `/home/${config.username}`;

  try {
    return await Promise.all(
      SERVICE_DEFINITIONS.map(async (definition) => {
        const configured = (
          await Promise.all(
            definition.configPaths.map((configPath) =>
              remotePathExists(sftp, posix.join(home, configPath))
            )
          )
        ).some(Boolean);
        const running = runningStates.get(definition.service) ?? false;

        return {
          service: definition.service,
          category: definition.category,
          configured,
          running,
          state: running
            ? "running"
            : configured
              ? "configured_not_detected"
              : "not_configured",
          health: "not_checked"
        };
      })
    );
  } finally {
    sftp.end();
  }
}

export function parseNginxBinaryAvailability(output: string) {
  return output.trim() === "available";
}

export function parseNginxConfigurationTest(
  output: string
): Exclude<NginxConfigurationTestState, "symlink_rejected"> {
  const value = output.trim();
  return value === "valid" || value === "invalid" ? value : "unavailable";
}

export function parseWebsiteHealthProbe(output: string): {
  state: WebsiteHealthProbeState;
  statusCode?: number;
  latencyMs?: number;
} {
  const value = output.trim();
  if (value === "unreachable") {
    return { state: "unreachable" };
  }
  if (value === "unavailable") {
    return { state: "probe_unavailable" };
  }

  const match = /^response (\d{3}) (\d+(?:\.\d+)?)$/.exec(value);
  if (!match) {
    return { state: "probe_unavailable" };
  }

  const statusCode = Number.parseInt(match[1], 10);
  const latencyMs = Math.round(Number.parseFloat(match[2]) * 1000);
  if (statusCode < 100 || statusCode > 599 || !Number.isFinite(latencyMs)) {
    return { state: "probe_unavailable" };
  }

  return {
    state: statusCode >= 500 ? "server_error" : "responding",
    statusCode,
    latencyMs
  };
}

export function summarizeNginxErrorLog(content: string) {
  const severityCounts = {
    emergency: 0,
    alert: 0,
    critical: 0,
    error: 0,
    warning: 0,
    notice: 0,
    info: 0,
    debug: 0
  };
  const severityNames = {
    emerg: "emergency",
    alert: "alert",
    crit: "critical",
    error: "error",
    warn: "warning",
    notice: "notice",
    info: "info",
    debug: "debug"
  } as const;
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines) {
    const match = /\[(emerg|alert|crit|error|warn|notice|info|debug)\]/i.exec(
      line
    );
    if (!match) {
      continue;
    }
    const severity = severityNames[
      match[1].toLowerCase() as keyof typeof severityNames
    ];
    severityCounts[severity] += 1;
  }

  return {
    sampledBytes: Buffer.byteLength(content),
    sampledLineCount: lines.length,
    severityCounts
  };
}

const WEBSITE_ROOT_CANDIDATES = [
  "public_html",
  "www",
  "site",
  "sites",
  "web",
  "htdocs"
] as const;

export async function getWhatboxWebsiteReadiness(
  client: Client,
  config: WhatboxConfig
): Promise<WebsiteReadiness> {
  const [binaryOutput, processOutput, storage] = await Promise.all([
    executeFixedReadOnlyQuery(
      client,
      "if command -v nginx >/dev/null 2>&1; then printf 'available\\n'; else printf 'unavailable\\n'; fi"
    ),
    executeFixedReadOnlyQuery(
      client,
      `LC_ALL=C ps -u ${quotePosixShell(config.username)} -o comm=`
    ),
    getWhatboxStorageStatus(client, config)
  ]);

  const sftp = await openSftp(client);
  const home = `/home/${config.username}`;

  try {
    const [nginxDirectoryExists, nginxFileExists, candidateWebsiteRoots] =
      await Promise.all([
        remoteDirectoryExists(sftp, posix.join(home, ".config/nginx")),
        remotePathExists(sftp, posix.join(home, ".config/nginx/nginx.conf")),
        Promise.all(
          config.allowedRoots.flatMap((root, rootIndex) =>
            WEBSITE_ROOT_CANDIDATES.map(async (relativePath) => ({
              rootIndex,
              relativePath,
              exists: await remoteDirectoryExists(
                sftp,
                resolveAllowedPath(root, relativePath)
              )
            }))
          )
        )
      ]);

    const nginxProcessRunning = parseServiceProcesses(processOutput).get("nginx") ?? false;
    const storageObservations = storage.map((root) => ({
      rootIndex: root.rootIndex,
      availableBytes: root.availableBytes,
      usedPercent: root.usedPercent,
      ready: root.availableBytes > 0 && root.usedPercent < 95
    }));

    const recommendations: WebsiteReadiness["recommendations"] = [];
    if (!parseNginxBinaryAvailability(binaryOutput)) {
      recommendations.push({
        id: "nginx-binary-unavailable",
        recommendation: "Confirm that a userland Nginx binary is available before planning deployment."
      });
    }
    if (!nginxDirectoryExists && !nginxFileExists) {
      recommendations.push({
        id: "nginx-configuration-not-detected",
        recommendation: "Create or select a bounded userland Nginx configuration during a separately approved deployment design."
      });
    }
    if (!nginxProcessRunning) {
      recommendations.push({
        id: "nginx-process-not-detected",
        recommendation: "Validate the intended Nginx service state before enabling a future start or restart operation."
      });
    }
    if (!candidateWebsiteRoots.some((candidate) => candidate.exists)) {
      recommendations.push({
        id: "website-root-not-detected",
        recommendation: "Choose a local source allowlist and bounded remote release root before planning static deployment."
      });
    }
    if (storageObservations.some((root) => !root.ready)) {
      recommendations.push({
        id: "storage-needs-attention",
        recommendation: "Review available capacity before planning a website release."
      });
    }

    return {
      observations: {
        nginxBinaryAvailable: parseNginxBinaryAvailability(binaryOutput),
        nginxConfiguration: {
          directoryExists: nginxDirectoryExists,
          fileExists: nginxFileExists
        },
        nginxProcess: {
          running: nginxProcessRunning,
          health: "not_checked"
        },
        candidateWebsiteRoots,
        storage: storageObservations
      },
      recommendations
    };
  } finally {
    sftp.end();
  }
}

export async function getWhatboxWebsiteDiagnostics(
  client: Client,
  config: WhatboxConfig
): Promise<WebsiteDiagnostics> {
  const home = `/home/${config.username}`;
  const nginxConfigPath = posix.join(home, ".config/nginx/nginx.conf");
  const nginxErrorLogPath = posix.join(home, ".config/nginx/error.log");
  const sftp = await openSftp(client);
  let configFileState: RemoteFileState;
  let errorLogTail: RemoteFileTail;

  try {
    [configFileState, errorLogTail] = await Promise.all([
      remoteRegularFileState(sftp, nginxConfigPath),
      readRemoteRegularFileTail(
        sftp,
        nginxErrorLogPath,
        MAX_ERROR_LOG_SAMPLE_BYTES
      )
    ]);
  } finally {
    sftp.end();
  }

  let nginxConfigurationTest: NginxConfigurationTestState;
  if (configFileState === "symlink_rejected") {
    nginxConfigurationTest = "symlink_rejected";
  } else if (configFileState === "available") {
    const output = await executeFixedReadOnlyQuery(
      client,
      `if [ ! -x /usr/sbin/nginx ]; then printf 'unavailable\\n'; elif /usr/sbin/nginx -t -q -c ${quotePosixShell(nginxConfigPath)} >/dev/null 2>&1; then printf 'valid\\n'; else printf 'invalid\\n'; fi`
    );
    nginxConfigurationTest = parseNginxConfigurationTest(output);
  } else {
    nginxConfigurationTest = "unavailable";
  }

  const healthProbe = config.websiteHealthPort
    ? parseWebsiteHealthProbe(
        await executeFixedReadOnlyQuery(
          client,
          `if [ ! -x /usr/bin/curl ]; then printf 'unavailable\\n'; else result=$(/usr/bin/curl --silent --show-error --output /dev/null --max-time 5 --write-out '%{http_code} %{time_total}' ${quotePosixShell(`http://127.0.0.1:${config.websiteHealthPort}/`)} 2>/dev/null) && printf 'response %s\\n' "$result" || printf 'unreachable\\n'; fi`
        )
      )
    : { state: "not_configured" as const };

  const errorSummary = summarizeNginxErrorLog(errorLogTail.content);
  const recentErrorLog = {
    state: errorLogTail.state,
    ...(errorLogTail.sizeBytes === undefined
      ? {}
      : { sizeBytes: errorLogTail.sizeBytes }),
    ...(errorLogTail.modifiedAt === undefined
      ? {}
      : { modifiedAt: errorLogTail.modifiedAt }),
    ...errorSummary
  };
  const recommendations: WebsiteDiagnostics["recommendations"] = [];

  if (nginxConfigurationTest === "invalid") {
    recommendations.push({
      id: "nginx-configuration-invalid",
      recommendation:
        "Correct the userland Nginx configuration before staging or activating a website release."
    });
  } else if (nginxConfigurationTest === "unavailable") {
    recommendations.push({
      id: "nginx-configuration-test-unavailable",
      recommendation:
        "Confirm the fixed userland Nginx binary and regular configuration file before deployment."
    });
  } else if (nginxConfigurationTest === "symlink_rejected") {
    recommendations.push({
      id: "nginx-configuration-symlink-rejected",
      recommendation:
        "Replace the Nginx configuration symlink with an explicitly reviewed regular file before diagnostics or deployment."
    });
  }

  if (healthProbe.state === "not_configured") {
    recommendations.push({
      id: "website-health-probe-not-configured",
      recommendation:
        "Configure a loopback-only website health port before enabling deployment execution."
    });
  } else if (healthProbe.state === "unreachable") {
    recommendations.push({
      id: "website-health-probe-unreachable",
      recommendation:
        "Confirm the Nginx process and configured loopback port before treating the website as reachable."
    });
  } else if (healthProbe.state === "server_error") {
    recommendations.push({
      id: "website-health-probe-server-error",
      recommendation:
        "Investigate the HTTP 5xx response before deployment activation."
    });
  } else if (healthProbe.state === "probe_unavailable") {
    recommendations.push({
      id: "website-health-probe-unavailable",
      recommendation:
        "Confirm the fixed loopback probe is available before enabling deployment execution."
    });
  }

  const highSeverityCount = errorSummary.severityCounts.emergency
    + errorSummary.severityCounts.alert
    + errorSummary.severityCounts.critical
    + errorSummary.severityCounts.error;
  if (highSeverityCount > 0) {
    recommendations.push({
      id: "nginx-recent-errors-detected",
      recommendation:
        "Review the Nginx error log locally before deployment; the MCP intentionally returns counts, not log lines."
    });
  }

  return {
    observations: {
      nginxConfigurationTest,
      healthProbe,
      recentErrorLog
    },
    recommendations,
    contentReturned: {
      nginxConfiguration: false,
      responseBody: false,
      logLines: false
    }
  };
}

export function reviewWhatboxConfiguration(
  services: ServiceInventoryEntry[],
  storage: StorageStatus[]
): ConfigurationReview {
  const findings: ConfigurationFinding[] = [];

  for (const root of storage) {
    if (root.usedPercent >= 95) {
      findings.push({
        id: `storage-critical-root-${root.rootIndex}`,
        severity: "critical",
        confidence: "high",
        observation:
          `Allowed storage root ${root.rootIndex} is ${root.usedPercent}% used.`,
        recommendation:
          "Review large data and application write paths before services run out of space.",
        automaticFixAvailable: false
      });
    } else if (root.usedPercent >= 85) {
      findings.push({
        id: `storage-warning-root-${root.rootIndex}`,
        severity: "warning",
        confidence: "high",
        observation:
          `Allowed storage root ${root.rootIndex} is ${root.usedPercent}% used.`,
        recommendation:
          "Plan capacity cleanup or expansion before storage pressure becomes critical.",
        automaticFixAvailable: false
      });
    }
  }

  for (const service of services) {
    if (service.state === "configured_not_detected") {
      findings.push({
        id: `configured-not-detected-${service.service}`,
        severity: "warning",
        confidence: "medium",
        observation:
          `${service.service} has known configuration metadata but no allowlisted process was detected.`,
        recommendation:
          "Confirm whether the service is intentionally stopped or uses an unrecognized process name.",
        automaticFixAvailable: false
      });
    }
  }

  const runningTorrentClients = services.filter(
    (service) => service.category === "torrent" && service.running
  );
  if (runningTorrentClients.length > 1) {
    findings.push({
      id: "multiple-running-torrent-clients",
      severity: "info",
      confidence: "high",
      observation:
        `${runningTorrentClients.length} torrent clients are running concurrently.`,
      recommendation:
        "Confirm that each client is intentional and that their watch paths and resource use do not overlap.",
      automaticFixAvailable: false
    });
  }

  const phpFpm = services.find((service) => service.service === "php-fpm");
  const nginx = services.find((service) => service.service === "nginx");
  if (phpFpm?.running && !nginx?.running) {
    findings.push({
      id: "php-fpm-without-detected-nginx",
      severity: "info",
      confidence: "low",
      observation:
        "PHP-FPM is running while userland Nginx was not detected.",
      recommendation:
        "Verify that PHP-FPM is used by another frontend or stop it later through an approved service action if it is unnecessary.",
      automaticFixAvailable: false
    });
  }

  const hasCritical = findings.some((finding) => finding.severity === "critical");
  const hasWarning = findings.some((finding) => finding.severity === "warning");

  return {
    overall: hasCritical
      ? "critical_attention"
      : hasWarning
        ? "attention_recommended"
        : "no_obvious_issues",
    findings,
    scope: {
      serviceProcessAndConfigMetadata: true,
      storageCapacity: true,
      configurationContentsInspected: false
    }
  };
}

export async function withWhatboxClient<T>(
  config: WhatboxConfig,
  operation: (client: Client) => Promise<T>
) {
  const client = await connectWhatbox(config);
  try {
    return await operation(client);
  } finally {
    client.end();
  }
}
