import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  createMutationPlan,
  createTargetDigest,
  type MutationPlan
} from "./approval.js";

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MAX_RELEASE_ID_BYTES = 64;

const FORBIDDEN_NAMES = new Set([
  ".git",
  ".gnupg",
  ".ssh",
  "credentials",
  "node_modules",
  "secrets"
]);

const FORBIDDEN_SUFFIXES = [
  ".key",
  ".pem",
  ".p12",
  ".pfx"
];

export interface WebsiteSourceValidation {
  accepted: boolean;
  fileCount: number;
  totalBytes: number;
  manifestDigest: string | null;
  rejectionReasons: Array<
    | "source_not_directory"
    | "source_not_allowlisted"
    | "source_contains_symlink"
    | "source_contains_sensitive_name"
    | "source_contains_unsupported_entry"
    | "source_file_limit_exceeded"
    | "source_byte_limit_exceeded"
    | "source_unreadable"
  >;
}

export interface WebsiteDeploymentPlan {
  plan: MutationPlan;
  source: WebsiteSourceValidation;
  target: {
    rootIndex: number;
    releaseId: string;
    releaseRelativePath: string;
  };
}

function isWithinRoot(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function isSensitiveName(name: string) {
  const lowerName = name.toLowerCase();
  return (
    FORBIDDEN_NAMES.has(lowerName)
    || lowerName === ".env"
    || lowerName.startsWith(".env.")
    || lowerName.startsWith("id_")
    || FORBIDDEN_SUFFIXES.some((suffix) => lowerName.endsWith(suffix))
  );
}

function hashManifest(entries: Array<{ relativePath: string; size: number; digest: string }>) {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.relativePath}\0${entry.size}\0${entry.digest}\n`);
  }
  return hash.digest("hex");
}

export function validateStaticSiteSource(
  sourceRoot: string,
  allowedSourceRoots: string[],
  options: { maxFiles?: number; maxBytes?: number } = {}
): WebsiteSourceValidation {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const rejectionReasons = new Set<WebsiteSourceValidation["rejectionReasons"][number]>();
  const manifest: Array<{ relativePath: string; size: number; digest: string }> = [];
  let totalBytes = 0;

  try {
    const sourceStat = lstatSync(sourceRoot);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      rejectionReasons.add("source_not_directory");
    }

    const canonicalSource = realpathSync(sourceRoot);
    const canonicalAllowlistedRoots = allowedSourceRoots.map((root) => {
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error("Source allowlist entry is not a directory");
      }
      return realpathSync(root);
    });

    if (!canonicalAllowlistedRoots.some((root) => isWithinRoot(root, canonicalSource))) {
      rejectionReasons.add("source_not_allowlisted");
    }

    const visit = (directory: string, relativeDirectory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
      )) {
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        const entryPath = resolve(directory, entry.name);

        if (isSensitiveName(entry.name)) {
          rejectionReasons.add("source_contains_sensitive_name");
          continue;
        }
        if (entry.isSymbolicLink()) {
          rejectionReasons.add("source_contains_symlink");
          continue;
        }
        if (entry.isDirectory()) {
          visit(entryPath, relativePath);
          continue;
        }
        if (!entry.isFile()) {
          rejectionReasons.add("source_contains_unsupported_entry");
          continue;
        }

        const size = statSync(entryPath).size;
        totalBytes += size;
        if (manifest.length >= maxFiles) {
          rejectionReasons.add("source_file_limit_exceeded");
          continue;
        }
        if (totalBytes > maxBytes) {
          rejectionReasons.add("source_byte_limit_exceeded");
          continue;
        }

        const digest = createHash("sha256").update(readFileSync(entryPath)).digest("hex");
        manifest.push({ relativePath, size, digest });
      }
    };

    if (
      !rejectionReasons.has("source_not_directory")
      && !rejectionReasons.has("source_not_allowlisted")
    ) {
      visit(canonicalSource, "");
    }
  } catch {
    rejectionReasons.add("source_unreadable");
  }

  const reasons = [...rejectionReasons].sort();
  return {
    accepted: reasons.length === 0,
    fileCount: manifest.length,
    totalBytes,
    manifestDigest: reasons.length === 0 ? hashManifest(manifest) : null,
    rejectionReasons: reasons
  };
}

export function resolveWebsiteReleaseTarget(remoteWebsiteRoot: string, releaseId: string) {
  if (
    !releaseId
    || Buffer.byteLength(releaseId) > MAX_RELEASE_ID_BYTES
    || !/^[a-f0-9-]+$/.test(releaseId)
  ) {
    throw new Error("Website release identifier is invalid");
  }

  const root = resolve(remoteWebsiteRoot);
  const target = resolve(root, ".whatbox-releases", releaseId);
  if (!isWithinRoot(root, target)) {
    throw new Error("Website release target escapes its allowed root");
  }
  return target;
}

export function createWebsiteDeploymentPlan(input: {
  source: WebsiteSourceValidation;
  slotBinding: string;
  rootIndex: number;
  remoteWebsiteRoot: string;
  releaseId?: string;
}, now = Date.now()): WebsiteDeploymentPlan {
  if (!input.source.accepted || !input.source.manifestDigest) {
    throw new Error("Website source has not passed validation");
  }

  const releaseId = input.releaseId ?? randomUUID();
  const releaseTarget = resolveWebsiteReleaseTarget(input.remoteWebsiteRoot, releaseId);
  const releaseRelativePath = `.whatbox-releases/${releaseId}`;
  const plan = createMutationPlan(
    {
      action: "website_deploy",
      slotBinding: input.slotBinding,
      targetDigests: [
        createTargetDigest(`release:${releaseTarget}`),
        createTargetDigest(`source:${input.source.manifestDigest}`)
      ],
      summary: "Deploy a validated static-site release after external approval",
      risk: "reversible"
    },
    now
  );

  return {
    plan,
    source: input.source,
    target: {
      rootIndex: input.rootIndex,
      releaseId,
      releaseRelativePath
    }
  };
}
