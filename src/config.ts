import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { parse } from "dotenv";
import * as z from "zod/v4";

const CONFIG_DIRECTORY = ".config/whatbox-mcp";
const CONFIG_FILENAME = "local.env";

const optionalPortSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce.number().int().min(1).max(65535).optional()
);

const rawConfigSchema = z
  .object({
    WHATBOX_HOST: z.string().trim().min(1),
    WHATBOX_USERNAME: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
    WHATBOX_SSH_PORT: z.coerce.number().int().min(1).max(65535).default(22),
    WHATBOX_SSH_AUTH_MODE: z.enum(["agent", "key"]).default("agent"),
    WHATBOX_SSH_KEY_PATH: z.string().trim().optional(),
    WHATBOX_SSH_KEY_PASSPHRASE: z.string().optional(),
    WHATBOX_HOST_FINGERPRINT_SHA256: z
      .string()
      .trim()
      .regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/),
    WHATBOX_ALLOWED_ROOTS: z.string().trim().optional(),
    WHATBOX_OBSERVE_ROOTS: z.string().trim().optional(),
    WHATBOX_WEBSITE_SOURCE_ROOTS: z.string().trim().optional(),
    WHATBOX_WEBSITE_HEALTH_PORT: optionalPortSchema,
    WHATBOX_MUTATIONS_ENABLED: z
      .string()
      .trim()
      .optional()
      .transform((value) => value === "true"),
    WHATBOX_SHELL_ENABLED: z
      .string()
      .trim()
      .optional()
      .transform((value) => value === "true"),
    WHATBOX_DOWNLOAD_DIR: z.string().trim().optional(),
    WHATBOX_TORRENT_CLIENT: z
      .preprocess(
        (value) =>
          typeof value === "string" && value.trim() === "" ? undefined : value,
        z.enum(["transmission", "qbittorrent", "rtorrent"]).optional()
      ),
    WHATBOX_TORRENT_RPC_PORT: optionalPortSchema,
    WHATBOX_TORRENT_RPC_SOCKET: z.string().trim().optional(),
    WHATBOX_TORRENT_RPC_USERNAME: z.string().optional(),
    WHATBOX_TORRENT_RPC_PASSWORD: z.string().optional()
  })
  .superRefine((values, context) => {
    if (values.WHATBOX_SSH_AUTH_MODE === "key" && !values.WHATBOX_SSH_KEY_PATH) {
      context.addIssue({
        code: "custom",
        path: ["WHATBOX_SSH_KEY_PATH"],
        message: "is required when WHATBOX_SSH_AUTH_MODE is key"
      });
    }
  });

export interface TorrentRpcConfig {
  client: "transmission" | "qbittorrent" | "rtorrent";
  // transmission/qbittorrent require a WebUI port. rtorrent uses a local SCGI
  // endpoint, discovered from ~/.rtorrent.rc when not configured explicitly.
  port?: number;
  socketPath?: string;
  username?: string;
  password?: string;
}

export interface WhatboxConfig {
  host: string;
  username: string;
  port: number;
  authMode: "agent" | "key";
  sshKeyPath?: string;
  sshKeyPassphrase?: string;
  hostFingerprintSha256: string;
  allowedRoots: string[];
  observeRoots: string[];
  websiteSourceRoots: string[];
  websiteHealthPort?: number;
  mutationsEnabled: boolean;
  shellEnabled: boolean;
  downloadDirectory?: string;
  torrentRpc?: TorrentRpcConfig;
}

export interface ConfigurationStatus {
  configured: boolean;
  configFileExists: boolean;
  configFilePermissionsSecure: boolean | null;
  authMode: "agent" | "key" | "not configured";
  checks: {
    host: boolean;
    username: boolean;
    hostFingerprint: boolean;
    authentication: boolean;
    allowedRoots: boolean;
  };
  issues: string[];
}

export function getDefaultConfigPath(localHome = homedir()) {
  return join(localHome, CONFIG_DIRECTORY, CONFIG_FILENAME);
}

export function expandLocalPath(value: string, localHome = homedir()) {
  if (value === "~") {
    return localHome;
  }

  if (value.startsWith("~/")) {
    return resolve(localHome, value.slice(2));
  }

  return resolve(value);
}

function parseAllowedRoots(
  rawValue: string | undefined,
  username: string,
  defaultRoot = `/home/${username}/files`
) {
  const values = rawValue
    ? rawValue.split(",").map((value) => value.trim()).filter(Boolean)
    : [defaultRoot];

  const roots = values.map((value) => {
    const expanded = value === "~" || value.startsWith("~/")
      ? `/home/${username}${value.slice(1)}`
      : value;
    const normalized = posix.normalize(expanded);

    if (!normalized.startsWith("/") || normalized === "/") {
      throw new Error("Configured roots must contain absolute non-root paths");
    }

    return normalized.replace(/\/$/, "");
  });

  return [...new Set(roots)];
}

function parseWebsiteSourceRoots(rawValue: string | undefined, localHome: string) {
  if (!rawValue) {
    return [];
  }

  const roots = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => expandLocalPath(value, localHome));

  if (roots.some((root) => root === "/")) {
    throw new Error("WHATBOX_WEBSITE_SOURCE_ROOTS must contain non-root paths");
  }

  return [...new Set(roots)];
}

export function parseConfigValues(
  values: NodeJS.ProcessEnv | Record<string, string | undefined>,
  localHome = homedir()
): WhatboxConfig {
  const parsed = rawConfigSchema.parse(values);

  return {
    host: parsed.WHATBOX_HOST,
    username: parsed.WHATBOX_USERNAME,
    port: parsed.WHATBOX_SSH_PORT,
    authMode: parsed.WHATBOX_SSH_AUTH_MODE,
    sshKeyPath: parsed.WHATBOX_SSH_KEY_PATH
      ? expandLocalPath(parsed.WHATBOX_SSH_KEY_PATH, localHome)
      : undefined,
    sshKeyPassphrase: parsed.WHATBOX_SSH_KEY_PASSPHRASE || undefined,
    hostFingerprintSha256: parsed.WHATBOX_HOST_FINGERPRINT_SHA256,
    allowedRoots: parseAllowedRoots(
      parsed.WHATBOX_ALLOWED_ROOTS,
      parsed.WHATBOX_USERNAME
    ),
    // Read-only tools observe the whole slot; mutations stay inside allowedRoots.
    observeRoots: parseAllowedRoots(
      parsed.WHATBOX_OBSERVE_ROOTS,
      parsed.WHATBOX_USERNAME,
      `/home/${parsed.WHATBOX_USERNAME}`
    ),
    websiteSourceRoots: parseWebsiteSourceRoots(
      parsed.WHATBOX_WEBSITE_SOURCE_ROOTS,
      localHome
    ),
    websiteHealthPort: parsed.WHATBOX_WEBSITE_HEALTH_PORT,
    mutationsEnabled: parsed.WHATBOX_MUTATIONS_ENABLED,
    shellEnabled: parsed.WHATBOX_SHELL_ENABLED,
    downloadDirectory: parseDownloadDirectory(
      parsed.WHATBOX_DOWNLOAD_DIR,
      localHome
    ),
    torrentRpc: parseTorrentRpc(parsed)
  };
}

function parseDownloadDirectory(
  rawValue: string | undefined,
  localHome: string
) {
  if (!rawValue) {
    return undefined;
  }

  const expanded = expandLocalPath(rawValue, localHome);
  if (expanded === "/") {
    throw new Error("WHATBOX_DOWNLOAD_DIR must not be the filesystem root");
  }
  return expanded;
}

function parseTorrentRpc(parsed: {
  WHATBOX_TORRENT_CLIENT?: "transmission" | "qbittorrent" | "rtorrent";
  WHATBOX_TORRENT_RPC_PORT?: number;
  WHATBOX_TORRENT_RPC_SOCKET?: string;
  WHATBOX_TORRENT_RPC_USERNAME?: string;
  WHATBOX_TORRENT_RPC_PASSWORD?: string;
}): TorrentRpcConfig | undefined {
  if (!parsed.WHATBOX_TORRENT_CLIENT) {
    return undefined;
  }
  if (
    parsed.WHATBOX_TORRENT_CLIENT !== "rtorrent"
    && !parsed.WHATBOX_TORRENT_RPC_PORT
  ) {
    throw new Error(
      "WHATBOX_TORRENT_RPC_PORT is required when WHATBOX_TORRENT_CLIENT is set to transmission or qbittorrent"
    );
  }

  return {
    client: parsed.WHATBOX_TORRENT_CLIENT,
    port: parsed.WHATBOX_TORRENT_RPC_PORT,
    socketPath: parsed.WHATBOX_TORRENT_RPC_SOCKET || undefined,
    username: parsed.WHATBOX_TORRENT_RPC_USERNAME || undefined,
    password: parsed.WHATBOX_TORRENT_RPC_PASSWORD || undefined
  };
}

function hasSecurePermissions(configPath: string) {
  // POSIX permission bits are not meaningful on Windows (NTFS uses ACLs, and
  // Node reports an emulated mode), so only enforce owner-only bits on POSIX.
  if (process.platform === "win32") {
    return true;
  }
  return (statSync(configPath).mode & 0o077) === 0;
}

function readConfigurationValues(
  environment: NodeJS.ProcessEnv = process.env,
  configPath = environment.WHATBOX_MCP_CONFIG_FILE || getDefaultConfigPath()
) {
  const fileExists = existsSync(configPath);

  if (fileExists && !hasSecurePermissions(configPath)) {
    throw new Error(
      "Local configuration permissions are too open; run chmod 600 on the configured file"
    );
  }

  const fileValues = fileExists ? parse(readFileSync(configPath)) : {};
  return { values: { ...fileValues, ...environment }, fileExists, configPath };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const { values } = readConfigurationValues(environment);
  return parseConfigValues(values);
}

export function inspectConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): ConfigurationStatus {
  const configPath = environment.WHATBOX_MCP_CONFIG_FILE || getDefaultConfigPath();
  const configFileExists = existsSync(configPath);
  const configFilePermissionsSecure = configFileExists
    ? hasSecurePermissions(configPath)
    : null;

  try {
    const config = loadConfig(environment);
    const authentication = config.authMode === "agent"
      ? Boolean(environment.SSH_AUTH_SOCK)
      : Boolean(config.sshKeyPath && existsSync(config.sshKeyPath));

    return {
      configured: authentication,
      configFileExists,
      configFilePermissionsSecure,
      authMode: config.authMode,
      checks: {
        host: true,
        username: true,
        hostFingerprint: true,
        authentication,
        allowedRoots: config.allowedRoots.length > 0
      },
      issues: authentication
        ? []
        : [
            config.authMode === "agent"
              ? "SSH agent is unavailable in the MCP process"
              : "Configured SSH private key file is unavailable"
          ]
    };
  } catch (error) {
    const issues = error instanceof z.ZodError
      ? Object.keys(z.flattenError(error).fieldErrors).map(
          (field) => `${field} is missing or invalid`
        )
      : [error instanceof Error ? error.message : "Configuration is invalid"];

    return {
      configured: false,
      configFileExists,
      configFilePermissionsSecure,
      authMode: "not configured",
      checks: {
        host: false,
        username: false,
        hostFingerprint: false,
        authentication: false,
        allowedRoots: false
      },
      issues
    };
  }
}
