import { randomUUID } from "node:crypto";
import {
  buildInstallScript,
  buildUninstallScript,
  type AppManifest,
  type InstallContext
} from "./apps.js";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statfsSync
} from "node:fs";
import { join } from "node:path";
import { posix } from "node:path";
import type { Client, SFTPWrapper } from "ssh2";
import type { WhatboxConfig } from "./config.js";
import {
  executeFixedCommandWithStatus,
  getWhatboxStorageStatus,
  isSensitiveDirectoryPath,
  isWithinRoot,
  openSftp,
  parseWebsiteHealthProbe,
  quotePosixShell,
  realpath,
  resolveAllowedPath,
  type WebsiteHealthProbeState
} from "./whatbox.js";
import {
  isSensitiveName,
  resolveWebsiteReleaseTarget,
  validateStaticSiteSource,
  type WebsiteManifestEntry
} from "./website.js";

export const QUARANTINE_DIRECTORY = ".whatbox-quarantine";

const MAX_TRANSFER_FILES = 20_000;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PURGE_ENTRIES = 20_000;
const MAX_PURGE_DEPTH = 32;
const REMOTE_SPACE_MARGIN_BYTES = 100 * 1024 * 1024;
const LOCAL_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;

// Promisified SFTP helpers -------------------------------------------------

type RemoteAttrs = {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mode: number;
  mtime: number;
};

function lstatRemote(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<RemoteAttrs | null>((resolve) => {
    sftp.lstat(remotePath, (error, attributes) =>
      resolve(error || !attributes ? null : (attributes as RemoteAttrs))
    );
  });
}

function readdirRemote(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<Array<{ filename: string; attrs: RemoteAttrs }>>(
    (resolve, reject) => {
      sftp.readdir(remotePath, (error, entries) => {
        if (error) {
          reject(new Error("Unable to read a remote directory"));
          return;
        }
        resolve(
          entries.map((entry) => ({
            filename: entry.filename,
            attrs: entry.attrs as RemoteAttrs
          }))
        );
      });
    }
  );
}

function mkdirRemote(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.mkdir(remotePath, (error) => {
      if (error) {
        reject(new Error("Unable to create a remote directory"));
        return;
      }
      resolve();
    });
  });
}

function renameRemote(sftp: SFTPWrapper, fromPath: string, toPath: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.rename(fromPath, toPath, (error) => {
      if (error) {
        reject(new Error("Unable to rename the remote path"));
        return;
      }
      resolve();
    });
  });
}

/** Atomic overwrite rename via posix-rename@openssh.com, with fallback. */
function renameRemoteOverwrite(
  sftp: SFTPWrapper,
  fromPath: string,
  toPath: string
) {
  return new Promise<void>((resolve, reject) => {
    const extended = sftp as SFTPWrapper & {
      ext_openssh_rename?: (
        from: string,
        to: string,
        callback: (error: Error | undefined) => void
      ) => void;
    };
    if (typeof extended.ext_openssh_rename === "function") {
      extended.ext_openssh_rename(fromPath, toPath, (error) => {
        if (error) {
          reject(new Error("Unable to activate the remote pointer"));
          return;
        }
        resolve();
      });
      return;
    }
    sftp.unlink(toPath, () => {
      sftp.rename(fromPath, toPath, (error) => {
        if (error) {
          reject(new Error("Unable to activate the remote pointer"));
          return;
        }
        resolve();
      });
    });
  });
}

function unlinkRemote(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.unlink(remotePath, (error) => {
      if (error) {
        reject(new Error("Unable to remove a remote file"));
        return;
      }
      resolve();
    });
  });
}

function rmdirRemote(sftp: SFTPWrapper, remotePath: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.rmdir(remotePath, (error) => {
      if (error) {
        reject(new Error("Unable to remove a remote directory"));
        return;
      }
      resolve();
    });
  });
}

function symlinkRemote(sftp: SFTPWrapper, target: string, linkPath: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.symlink(target, linkPath, (error) => {
      if (error) {
        reject(new Error("Unable to create the remote pointer"));
        return;
      }
      resolve();
    });
  });
}

function readlinkRemote(sftp: SFTPWrapper, linkPath: string) {
  return new Promise<string | null>((resolve) => {
    sftp.readlink(linkPath, (error, target) =>
      resolve(error ? null : target)
    );
  });
}

function fastPutRemote(sftp: SFTPWrapper, localPath: string, remotePath: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => {
      if (error) {
        reject(new Error("Unable to upload a file"));
        return;
      }
      resolve();
    });
  });
}

function fastGetRemote(sftp: SFTPWrapper, remotePath: string, localPath: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (error) => {
      if (error) {
        reject(new Error("Unable to download a file"));
        return;
      }
      resolve();
    });
  });
}

function writeRemoteFile(
  sftp: SFTPWrapper,
  remotePath: string,
  content: Buffer
) {
  return new Promise<void>((resolve, reject) => {
    sftp.open(remotePath, "wx", 0o600, (openError, handle) => {
      if (openError) {
        reject(new Error("Unable to create a remote file"));
        return;
      }
      sftp.write(handle, content, 0, content.length, 0, (writeError) => {
        sftp.close(handle, () => {
          if (writeError) {
            reject(new Error("Unable to write a remote file"));
            return;
          }
          resolve();
        });
      });
    });
  });
}

// Path resolution ----------------------------------------------------------

function requireRoot(config: WhatboxConfig, rootIndex: number) {
  const root = config.allowedRoots[rootIndex];
  if (!root) {
    throw new Error("Unknown allowed-root index");
  }
  return root;
}

async function resolveExistingRemote(
  sftp: SFTPWrapper,
  root: string,
  relativePath: string
) {
  const candidate = resolveAllowedPath(root, relativePath);
  if (isSensitiveDirectoryPath(candidate)) {
    throw new Error("Sensitive directories cannot be touched");
  }
  const canonicalRoot = await realpath(sftp, root);
  const canonicalPath = await realpath(sftp, candidate);
  if (!isWithinRoot(canonicalRoot, canonicalPath)) {
    throw new Error("Resolved path escapes its allowed root");
  }
  if (isSensitiveDirectoryPath(canonicalPath)) {
    throw new Error("Sensitive directories cannot be touched");
  }
  return { canonicalRoot, canonicalPath };
}

async function resolveCreateRemote(
  sftp: SFTPWrapper,
  root: string,
  relativePath: string
) {
  const candidate = resolveAllowedPath(root, relativePath);
  if (isSensitiveDirectoryPath(candidate)) {
    throw new Error("Sensitive directories cannot be touched");
  }
  const canonicalRoot = await realpath(sftp, root);
  const canonicalParent = await realpath(sftp, posix.dirname(candidate));
  if (!isWithinRoot(canonicalRoot, canonicalParent)) {
    throw new Error("Resolved path escapes its allowed root");
  }
  const canonicalPath = posix.join(
    canonicalParent,
    posix.basename(candidate)
  );
  return { canonicalRoot, canonicalPath };
}

/** Create every missing directory of `relativePath` below the root. */
async function ensureRemoteDirectories(
  sftp: SFTPWrapper,
  root: string,
  relativePath: string
) {
  const segments = relativePath
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  let current = root;
  for (const segment of segments) {
    if (isSensitiveName(segment) || isSensitiveDirectoryPath(segment)) {
      throw new Error("Sensitive directory names cannot be created");
    }
    current = posix.join(current, segment);
    const existing = await lstatRemote(sftp, current);
    if (existing === null) {
      await mkdirRemote(sftp, current);
    } else if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("A remote path component is not a real directory");
    }
  }
  return current;
}

// Space checks -------------------------------------------------------------

async function requireRemoteHeadroom(
  client: Client,
  config: WhatboxConfig,
  rootIndex: number,
  incomingBytes: number
) {
  const storage = await getWhatboxStorageStatus(client, config);
  const root = storage.find((entry) => entry.rootIndex === rootIndex);
  if (!root) {
    throw new Error("Unable to verify remote storage headroom");
  }
  if (root.availableBytes < incomingBytes + REMOTE_SPACE_MARGIN_BYTES) {
    throw new Error("Insufficient remote storage for this transfer");
  }
  return {
    availableBytes: root.availableBytes,
    usedPercent: root.usedPercent
  };
}

function requireLocalHeadroom(localDirectory: string, incomingBytes: number) {
  const stats = statfsSync(localDirectory);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  if (availableBytes < incomingBytes + LOCAL_SPACE_RESERVE_BYTES) {
    throw new Error("Insufficient local storage for this transfer");
  }
  return availableBytes;
}

// Local source validation for uploads --------------------------------------

interface LocalTransferPlan {
  files: Array<{ localPath: string; relativePath: string; size: number }>;
  totalBytes: number;
  kind: "file" | "directory";
}

function planLocalUpload(
  localSource: string,
  allowedLocalRoots: string[]
): LocalTransferPlan {
  if (allowedLocalRoots.length === 0) {
    throw new Error(
      "No local upload roots are configured; set WHATBOX_WEBSITE_SOURCE_ROOTS or WHATBOX_DOWNLOAD_DIR"
    );
  }

  const canonicalSource = realpathSync(localSource);
  const canonicalRoots = allowedLocalRoots.map((root) => realpathSync(root));
  const contained = canonicalRoots.some(
    (root) =>
      canonicalSource === root || canonicalSource.startsWith(`${root}/`)
  );
  if (!contained) {
    throw new Error("The local source is outside every allowed local root");
  }

  const sourceStat = lstatSync(canonicalSource);
  const files: LocalTransferPlan["files"] = [];
  let totalBytes = 0;

  const addFile = (localPath: string, relativePath: string, size: number) => {
    if (files.length >= MAX_TRANSFER_FILES) {
      throw new Error("The upload exceeds the bounded file count");
    }
    totalBytes += size;
    if (totalBytes > MAX_UPLOAD_BYTES) {
      throw new Error("The upload exceeds the bounded byte size");
    }
    files.push({ localPath, relativePath, size });
  };

  if (sourceStat.isFile()) {
    const name = posix.basename(canonicalSource.split("\\").join("/"));
    if (isSensitiveName(name)) {
      throw new Error("Credential-like local files cannot be uploaded");
    }
    addFile(canonicalSource, name, sourceStat.size);
    return { files, totalBytes, kind: "file" };
  }

  if (!sourceStat.isDirectory()) {
    throw new Error("The local source must be a regular file or directory");
  }

  const visit = (directory: string, relativeDirectory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      if (isSensitiveName(entry.name)) {
        throw new Error("Credential-like local files cannot be uploaded");
      }
      const entryPath = join(directory, entry.name);
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error("Symlinked local entries cannot be uploaded");
      }
      if (entry.isDirectory()) {
        visit(entryPath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("Unsupported local entries cannot be uploaded");
      }
      addFile(entryPath, relativePath, lstatSync(entryPath).size);
    }
  };
  visit(canonicalSource, "");

  return { files, totalBytes, kind: "directory" };
}

// File operations ----------------------------------------------------------

export interface UploadInput {
  localSource: string;
  rootIndex: number;
  remoteRelativePath: string;
}

export interface UploadResult {
  fileCount: number;
  totalBytes: number;
  rootIndex: number;
  remoteRelativePath: string;
  remoteStorage: { availableBytes: number; usedPercent: number };
}

export function describeUploadTargets(
  config: WhatboxConfig,
  input: UploadInput
) {
  const root = requireRoot(config, input.rootIndex);
  const candidate = resolveAllowedPath(root, input.remoteRelativePath);
  return [`upload:${candidate}`];
}

export async function uploadToWhatbox(
  client: Client,
  config: WhatboxConfig,
  input: UploadInput
): Promise<UploadResult> {
  const root = requireRoot(config, input.rootIndex);
  const allowedLocalRoots = [
    ...config.websiteSourceRoots,
    ...(config.downloadDirectory ? [config.downloadDirectory] : [])
  ];
  const plan = planLocalUpload(input.localSource, allowedLocalRoots);
  const remoteStorage = await requireRemoteHeadroom(
    client,
    config,
    input.rootIndex,
    plan.totalBytes
  );

  const sftp = await openSftp(client);
  try {
    const { canonicalPath } = await resolveCreateRemote(
      sftp,
      root,
      input.remoteRelativePath
    );
    if ((await lstatRemote(sftp, canonicalPath)) !== null) {
      throw new Error("The remote target already exists; uploads never overwrite");
    }

    if (plan.kind === "file") {
      await fastPutRemote(sftp, plan.files[0].localPath, canonicalPath);
    } else {
      const canonicalRoot = await realpath(sftp, root);
      const baseRelative = canonicalPath.slice(canonicalRoot.length + 1);
      await ensureRemoteDirectories(sftp, canonicalRoot, baseRelative);
      const createdDirectories = new Set<string>([""]);
      for (const file of plan.files) {
        const parent = posix.dirname(file.relativePath);
        if (parent !== "." && !createdDirectories.has(parent)) {
          await ensureRemoteDirectories(
            sftp,
            canonicalPath,
            parent
          );
          createdDirectories.add(parent);
        }
        await fastPutRemote(
          sftp,
          file.localPath,
          posix.join(canonicalPath, file.relativePath)
        );
      }
    }

    return {
      fileCount: plan.files.length,
      totalBytes: plan.totalBytes,
      rootIndex: input.rootIndex,
      remoteRelativePath: input.remoteRelativePath,
      remoteStorage
    };
  } finally {
    sftp.end();
  }
}

export interface DownloadInput {
  rootIndex: number;
  remoteRelativePath: string;
}

export interface DownloadResult {
  fileCount: number;
  totalBytes: number;
  skippedSymlinkCount: number;
  localRelativePath: string;
}

async function downloadRemoteTree(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  counters: { fileCount: number; totalBytes: number; skippedSymlinkCount: number },
  budget: { remainingBytes: number }
) {
  mkdirSync(localPath, { recursive: true, mode: 0o700 });
  const entries = await readdirRemote(sftp, remotePath);
  for (const entry of entries.sort((left, right) =>
    left.filename.localeCompare(right.filename)
  )) {
    const remoteChild = posix.join(remotePath, entry.filename);
    const localChild = join(localPath, entry.filename);
    if (entry.attrs.isSymbolicLink()) {
      counters.skippedSymlinkCount += 1;
      continue;
    }
    if (entry.attrs.isDirectory()) {
      await downloadRemoteTree(sftp, remoteChild, localChild, counters, budget);
      continue;
    }
    if (!entry.attrs.isFile()) {
      continue;
    }
    if (counters.fileCount >= MAX_TRANSFER_FILES) {
      throw new Error("The download exceeds the bounded file count");
    }
    budget.remainingBytes -= entry.attrs.size;
    if (budget.remainingBytes < 0) {
      throw new Error("The download exceeds the available local space budget");
    }
    counters.totalBytes += entry.attrs.size;
    if (counters.totalBytes > MAX_DOWNLOAD_BYTES) {
      throw new Error("The download exceeds the bounded byte size");
    }
    await fastGetRemote(sftp, remoteChild, localChild);
    counters.fileCount += 1;
  }
}

export async function downloadFromWhatbox(
  client: Client,
  config: WhatboxConfig,
  input: DownloadInput
): Promise<DownloadResult> {
  if (!config.downloadDirectory) {
    throw new Error(
      "WHATBOX_DOWNLOAD_DIR is not configured; downloads are disabled"
    );
  }
  const root = requireRoot(config, input.rootIndex);
  mkdirSync(config.downloadDirectory, { recursive: true, mode: 0o700 });

  const sftp = await openSftp(client);
  try {
    const { canonicalPath } = await resolveExistingRemote(
      sftp,
      root,
      input.remoteRelativePath
    );
    const attrs = await lstatRemote(sftp, canonicalPath);
    if (!attrs) {
      throw new Error("The remote path does not exist");
    }

    const stampName = `whatbox-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}`;
    const destinationBase = join(config.downloadDirectory, stampName);
    const baseName = posix.basename(canonicalPath) || "root";
    const counters = { fileCount: 0, totalBytes: 0, skippedSymlinkCount: 0 };

    if (attrs.isFile()) {
      const availableBytes = requireLocalHeadroom(
        config.downloadDirectory,
        attrs.size
      );
      void availableBytes;
      mkdirSync(destinationBase, { recursive: true, mode: 0o700 });
      await fastGetRemote(sftp, canonicalPath, join(destinationBase, baseName));
      counters.fileCount = 1;
      counters.totalBytes = attrs.size;
    } else if (attrs.isDirectory()) {
      const availableBytes = requireLocalHeadroom(config.downloadDirectory, 0);
      const budget = {
        remainingBytes: Math.min(
          MAX_DOWNLOAD_BYTES,
          availableBytes - LOCAL_SPACE_RESERVE_BYTES
        )
      };
      await downloadRemoteTree(
        sftp,
        canonicalPath,
        join(destinationBase, baseName),
        counters,
        budget
      );
    } else {
      throw new Error("Only regular files and directories can be downloaded");
    }

    return {
      ...counters,
      localRelativePath: join(stampName, baseName)
    };
  } finally {
    sftp.end();
  }
}

export interface MoveInput {
  sourceRootIndex: number;
  sourceRelativePath: string;
  destinationRootIndex: number;
  destinationRelativePath: string;
}

export function describeMoveTargets(config: WhatboxConfig, input: MoveInput) {
  const sourceRoot = requireRoot(config, input.sourceRootIndex);
  const destinationRoot = requireRoot(config, input.destinationRootIndex);
  return [
    `move-from:${resolveAllowedPath(sourceRoot, input.sourceRelativePath)}`,
    `move-to:${resolveAllowedPath(destinationRoot, input.destinationRelativePath)}`
  ];
}

export async function movePathOnWhatbox(
  client: Client,
  config: WhatboxConfig,
  input: MoveInput
) {
  const sourceRoot = requireRoot(config, input.sourceRootIndex);
  const destinationRoot = requireRoot(config, input.destinationRootIndex);
  const sftp = await openSftp(client);
  try {
    const source = await resolveExistingRemote(
      sftp,
      sourceRoot,
      input.sourceRelativePath
    );
    const destination = await resolveCreateRemote(
      sftp,
      destinationRoot,
      input.destinationRelativePath
    );
    if ((await lstatRemote(sftp, destination.canonicalPath)) !== null) {
      throw new Error("The move destination already exists; moves never overwrite");
    }
    await renameRemote(sftp, source.canonicalPath, destination.canonicalPath);
    return {
      moved: true,
      sourceRootIndex: input.sourceRootIndex,
      sourceRelativePath: input.sourceRelativePath,
      destinationRootIndex: input.destinationRootIndex,
      destinationRelativePath: input.destinationRelativePath
    };
  } finally {
    sftp.end();
  }
}

export interface MakeDirectoryInput {
  rootIndex: number;
  relativePath: string;
}

export function describeMakeDirectoryTargets(
  config: WhatboxConfig,
  input: MakeDirectoryInput
) {
  const root = requireRoot(config, input.rootIndex);
  return [`mkdir:${resolveAllowedPath(root, input.relativePath)}`];
}

export async function makeDirectoryOnWhatbox(
  client: Client,
  config: WhatboxConfig,
  input: MakeDirectoryInput
) {
  const root = requireRoot(config, input.rootIndex);
  const relative = resolveAllowedPath(root, input.relativePath).slice(
    root.length + 1
  );
  if (!relative) {
    throw new Error("The directory to create must be below the allowed root");
  }
  const sftp = await openSftp(client);
  try {
    const canonicalRoot = await realpath(sftp, root);
    await ensureRemoteDirectories(sftp, canonicalRoot, relative);
    return {
      created: true,
      rootIndex: input.rootIndex,
      relativePath: input.relativePath
    };
  } finally {
    sftp.end();
  }
}

// Quarantine ---------------------------------------------------------------

export interface QuarantineInput {
  rootIndex: number;
  relativePath: string;
}

export function describeQuarantineTargets(
  config: WhatboxConfig,
  input: QuarantineInput
) {
  const root = requireRoot(config, input.rootIndex);
  return [`quarantine:${resolveAllowedPath(root, input.relativePath)}`];
}

export async function quarantinePathOnWhatbox(
  client: Client,
  config: WhatboxConfig,
  input: QuarantineInput
) {
  const root = requireRoot(config, input.rootIndex);
  const sftp = await openSftp(client);
  try {
    const { canonicalRoot, canonicalPath } = await resolveExistingRemote(
      sftp,
      root,
      input.relativePath
    );
    const quarantineBase = posix.join(canonicalRoot, QUARANTINE_DIRECTORY);
    if (isWithinRoot(quarantineBase, canonicalPath)) {
      throw new Error("The path is already quarantined");
    }
    if (canonicalPath === canonicalRoot) {
      throw new Error("An allowed root cannot be quarantined");
    }

    const dateDirectory = new Date().toISOString().slice(0, 10);
    await ensureRemoteDirectories(
      sftp,
      canonicalRoot,
      `${QUARANTINE_DIRECTORY}/${dateDirectory}`
    );
    const safeBaseName = posix
      .basename(canonicalPath)
      .slice(0, 100);
    const quarantineRelativePath = `${QUARANTINE_DIRECTORY}/${dateDirectory}/${randomUUID()}-${safeBaseName}`;
    await renameRemote(
      sftp,
      canonicalPath,
      posix.join(canonicalRoot, quarantineRelativePath)
    );

    const storage = await getWhatboxStorageStatus(client, config);
    const rootStorage = storage.find(
      (entry) => entry.rootIndex === input.rootIndex
    );

    return {
      quarantined: true,
      rootIndex: input.rootIndex,
      relativePath: input.relativePath,
      quarantineRelativePath,
      spaceNeutral: true,
      remoteStorage: rootStorage
        ? {
            availableBytes: rootStorage.availableBytes,
            usedPercent: rootStorage.usedPercent
          }
        : null,
      note:
        rootStorage && rootStorage.usedPercent >= 85
          ? "Quarantine keeps the data on disk; purge quarantined items to reclaim space."
          : undefined
    };
  } finally {
    sftp.end();
  }
}

export async function listQuarantineOnWhatbox(
  client: Client,
  config: WhatboxConfig,
  rootIndex: number
) {
  const root = requireRoot(config, rootIndex);
  const sftp = await openSftp(client);
  try {
    const canonicalRoot = await realpath(sftp, root);
    const quarantineBase = posix.join(canonicalRoot, QUARANTINE_DIRECTORY);
    if ((await lstatRemote(sftp, quarantineBase)) === null) {
      return { rootIndex, entries: [], truncated: false };
    }

    const entries: Array<{
      relativePath: string;
      type: "directory" | "file" | "other";
      sizeBytes: number;
      quarantinedDate: string;
    }> = [];
    let truncated = false;
    const dates = await readdirRemote(sftp, quarantineBase);
    for (const date of dates.sort((a, b) =>
      a.filename.localeCompare(b.filename)
    )) {
      if (!date.attrs.isDirectory()) {
        continue;
      }
      const items = await readdirRemote(
        sftp,
        posix.join(quarantineBase, date.filename)
      );
      for (const item of items.sort((a, b) =>
        a.filename.localeCompare(b.filename)
      )) {
        if (entries.length >= 500) {
          truncated = true;
          break;
        }
        entries.push({
          relativePath: `${QUARANTINE_DIRECTORY}/${date.filename}/${item.filename}`,
          type: item.attrs.isDirectory()
            ? "directory"
            : item.attrs.isFile()
              ? "file"
              : "other",
          sizeBytes: item.attrs.size,
          quarantinedDate: date.filename
        });
      }
      if (truncated) {
        break;
      }
    }
    return { rootIndex, entries, truncated };
  } finally {
    sftp.end();
  }
}

export interface PurgeInput {
  rootIndex: number;
  quarantineRelativePath: string;
}

export function describePurgeTargets(config: WhatboxConfig, input: PurgeInput) {
  const root = requireRoot(config, input.rootIndex);
  return [`purge:${resolveAllowedPath(root, input.quarantineRelativePath)}`];
}

async function removeRemoteTree(
  sftp: SFTPWrapper,
  remotePath: string,
  counters: { removed: number },
  depth: number
) {
  if (depth > MAX_PURGE_DEPTH) {
    throw new Error("The purge exceeds the bounded directory depth");
  }
  const attrs = await lstatRemote(sftp, remotePath);
  if (!attrs) {
    return;
  }
  if (counters.removed >= MAX_PURGE_ENTRIES) {
    throw new Error("The purge exceeds the bounded entry count");
  }
  if (attrs.isDirectory() && !attrs.isSymbolicLink()) {
    const entries = await readdirRemote(sftp, remotePath);
    for (const entry of entries) {
      await removeRemoteTree(
        sftp,
        posix.join(remotePath, entry.filename),
        counters,
        depth + 1
      );
    }
    await rmdirRemote(sftp, remotePath);
    counters.removed += 1;
    return;
  }
  await unlinkRemote(sftp, remotePath);
  counters.removed += 1;
}

export async function purgeQuarantinePathOnWhatbox(
  client: Client,
  config: WhatboxConfig,
  input: PurgeInput
) {
  const root = requireRoot(config, input.rootIndex);
  const sftp = await openSftp(client);
  try {
    const canonicalRoot = await realpath(sftp, root);
    const quarantineBase = posix.join(canonicalRoot, QUARANTINE_DIRECTORY);
    const candidate = resolveAllowedPath(root, input.quarantineRelativePath);
    const canonicalParent = await realpath(sftp, posix.dirname(candidate));
    const canonicalPath = posix.join(
      canonicalParent,
      posix.basename(candidate)
    );

    if (
      !isWithinRoot(quarantineBase, canonicalPath)
      || canonicalPath === quarantineBase
    ) {
      throw new Error("Only paths inside the quarantine directory can be purged");
    }

    const counters = { removed: 0 };
    await removeRemoteTree(sftp, canonicalPath, counters, 0);
    return {
      purged: true,
      rootIndex: input.rootIndex,
      quarantineRelativePath: input.quarantineRelativePath,
      removedEntryCount: counters.removed
    };
  } finally {
    sftp.end();
  }
}

// Backup -------------------------------------------------------------------

/**
 * Home-relative locations eligible for configuration backup. Fixed allowlist;
 * callers select by name and can never supply a path.
 */
export const BACKUP_TARGETS: Record<string, string[]> = {
  rtorrent: [".rtorrent.rc", ".session", ".config/rtorrent"],
  deluge: [".config/deluge"],
  transmission: [".config/transmission-daemon"],
  qbittorrent: [".config/qBittorrent", ".config/qbittorrent"],
  nginx: [".config/nginx"],
  "php-fpm": [".config/php-fpm2"],
  sonarr: [".config/Sonarr", ".config/sonarr"],
  radarr: [".config/Radarr", ".config/radarr"],
  prowlarr: [".config/Prowlarr", ".config/prowlarr"],
  jackett: [".config/Jackett"],
  sabnzbd: [".sabnzbd", ".config/sabnzbd"],
  autobrr: [".config/autobrr"],
  bazarr: [".config/bazarr"],
  syncthing: [".config/syncthing"]
};

export interface BackupResult {
  backedUp: string[];
  missing: string[];
  fileCount: number;
  totalBytes: number;
  skippedSymlinkCount: number;
  localRelativePath: string;
}

export async function backupWhatboxConfiguration(
  client: Client,
  config: WhatboxConfig,
  services: string[]
): Promise<BackupResult> {
  if (!config.downloadDirectory) {
    throw new Error(
      "WHATBOX_DOWNLOAD_DIR is not configured; backups are disabled"
    );
  }
  const unknown = services.filter((service) => !BACKUP_TARGETS[service]);
  if (unknown.length > 0) {
    throw new Error("Unknown backup service selection");
  }

  mkdirSync(config.downloadDirectory, { recursive: true, mode: 0o700 });
  const availableBytes = requireLocalHeadroom(config.downloadDirectory, 0);
  const budget = {
    remainingBytes: Math.min(
      MAX_DOWNLOAD_BYTES,
      availableBytes - LOCAL_SPACE_RESERVE_BYTES
    )
  };

  const home = `/home/${config.username}`;
  const stampName = `whatbox-backup-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}`;
  const destinationBase = join(config.downloadDirectory, stampName);
  const counters = { fileCount: 0, totalBytes: 0, skippedSymlinkCount: 0 };
  const backedUp: string[] = [];
  const missing: string[] = [];

  const sftp = await openSftp(client);
  try {
    for (const service of services) {
      let found = false;
      for (const relativeTarget of BACKUP_TARGETS[service]) {
        const remotePath = posix.join(home, relativeTarget);
        const attrs = await lstatRemote(sftp, remotePath);
        if (!attrs || attrs.isSymbolicLink()) {
          continue;
        }
        found = true;
        const localTarget = join(
          destinationBase,
          service,
          relativeTarget.split("/").join("__")
        );
        if (attrs.isFile()) {
          if (counters.fileCount >= MAX_TRANSFER_FILES) {
            throw new Error("The backup exceeds the bounded file count");
          }
          budget.remainingBytes -= attrs.size;
          if (budget.remainingBytes < 0) {
            throw new Error("The backup exceeds the available local space budget");
          }
          mkdirSync(join(destinationBase, service), {
            recursive: true,
            mode: 0o700
          });
          await fastGetRemote(sftp, remotePath, localTarget);
          counters.fileCount += 1;
          counters.totalBytes += attrs.size;
        } else if (attrs.isDirectory()) {
          await downloadRemoteTree(
            sftp,
            remotePath,
            localTarget,
            counters,
            budget
          );
        }
      }
      (found ? backedUp : missing).push(service);
    }

    return {
      backedUp,
      missing,
      ...counters,
      localRelativePath: stampName
    };
  } finally {
    sftp.end();
  }
}

// Service control ----------------------------------------------------------

export type ServiceOperation = "start" | "stop" | "restart";

interface ControllableService {
  processNames: string[];
  startScript?: string;
}

const CONTROLLABLE_SERVICES: Record<string, ControllableService> = {
  nginx: { processNames: ["nginx"], startScript: ".config/nginx/start" },
  rtorrent: { processNames: ["rtorrent", "rtorrent main"] },
  deluge: { processNames: ["deluged"] },
  transmission: { processNames: ["transmission-da", "transmission-daemon"] },
  qbittorrent: { processNames: ["qbittorrent", "qbittorrent-nox"] },
  jellyfin: { processNames: ["jellyfin"] },
  sonarr: { processNames: ["sonarr"] },
  radarr: { processNames: ["radarr"] },
  prowlarr: { processNames: ["prowlarr"] },
  jackett: { processNames: ["jackett"] },
  sabnzbd: { processNames: ["sabnzbd", "sabnzbd.py"] },
  autobrr: { processNames: ["autobrr"] },
  bazarr: { processNames: ["bazarr"] },
  syncthing: { processNames: ["syncthing"] },
  "php-fpm": { processNames: ["php-fpm", "php-fpm8.2", "php-fpm8.3", "php-fpm8.4"] }
};

export function listControllableServices() {
  return Object.keys(CONTROLLABLE_SERVICES).sort();
}

export interface ServiceControlResult {
  service: string;
  operation: ServiceOperation;
  state:
    | "completed"
    | "was_not_running"
    | "start_not_supported"
    | "start_script_missing"
    | "failed";
}

async function stopService(
  client: Client,
  config: WhatboxConfig,
  definition: ControllableService
): Promise<"completed" | "was_not_running"> {
  let matchedAny = false;
  for (const processName of definition.processNames) {
    const { code } = await executeFixedCommandWithStatus(
      client,
      `pkill -u ${quotePosixShell(config.username)} -x -- ${quotePosixShell(processName)}`
    );
    if (code === 0) {
      matchedAny = true;
    }
  }
  return matchedAny ? "completed" : "was_not_running";
}

async function startService(
  client: Client,
  config: WhatboxConfig,
  definition: ControllableService
): Promise<"completed" | "start_not_supported" | "start_script_missing" | "failed"> {
  if (!definition.startScript) {
    return "start_not_supported";
  }
  const scriptPath = `/home/${config.username}/${definition.startScript}`;
  const sftp = await openSftp(client);
  try {
    const attrs = await lstatRemote(sftp, scriptPath);
    if (!attrs || !attrs.isFile() || attrs.isSymbolicLink()) {
      return "start_script_missing";
    }
    if ((attrs.mode & 0o100) === 0) {
      return "start_script_missing";
    }
  } finally {
    sftp.end();
  }
  const { code } = await executeFixedCommandWithStatus(
    client,
    quotePosixShell(scriptPath)
  );
  return code === 0 ? "completed" : "failed";
}

export function describeServiceTargets(service: string, operation: ServiceOperation) {
  return [`service:${service}:${operation}`];
}

export async function controlWhatboxService(
  client: Client,
  config: WhatboxConfig,
  service: string,
  operation: ServiceOperation
): Promise<ServiceControlResult> {
  const definition = CONTROLLABLE_SERVICES[service];
  if (!definition) {
    throw new Error("Unknown controllable service");
  }

  if (operation === "stop") {
    const state = await stopService(client, config, definition);
    return { service, operation, state };
  }
  if (operation === "start") {
    const state = await startService(client, config, definition);
    return { service, operation, state };
  }
  await stopService(client, config, definition);
  const state = await startService(client, config, definition);
  return { service, operation, state };
}

// Website deployment execution ---------------------------------------------

export interface DeploymentExecutionInput {
  sourceRoot: string;
  rootIndex: number;
  releaseId: string;
  expectedManifestDigest: string;
}

export interface DeploymentExecutionResult {
  releaseId: string;
  uploadedFileCount: number;
  uploadedBytes: number;
  remoteManifestVerified: boolean;
  activated: boolean;
  previousReleaseId: string | null;
  healthProbe: { state: WebsiteHealthProbeState | "not_configured"; statusCode?: number };
}

function buildManifestFileContent(manifest: WebsiteManifestEntry[]) {
  return Buffer.from(
    manifest
      .map((entry) => `${entry.digest}  ${entry.relativePath}`)
      .join("\n") + "\n",
    "utf8"
  );
}

function extractReleaseId(linkTarget: string | null) {
  if (!linkTarget) {
    return null;
  }
  const match = /\.whatbox-releases\/([a-f0-9-]+)\/?$/.exec(linkTarget);
  return match ? match[1] : null;
}

async function activateRelease(
  sftp: SFTPWrapper,
  canonicalRoot: string,
  releaseId: string
) {
  const currentPath = posix.join(canonicalRoot, "current");
  const previous = extractReleaseId(await readlinkRemote(sftp, currentPath));
  const temporaryLink = posix.join(
    canonicalRoot,
    `.current-staging-${randomUUID()}`
  );
  await symlinkRemote(sftp, `.whatbox-releases/${releaseId}`, temporaryLink);
  await renameRemoteOverwrite(sftp, temporaryLink, currentPath);
  return previous;
}

async function probeConfiguredHealthPort(
  client: Client,
  config: WhatboxConfig
): Promise<DeploymentExecutionResult["healthProbe"]> {
  if (!config.websiteHealthPort) {
    return { state: "not_configured" };
  }
  const { output } = await executeFixedCommandWithStatus(
    client,
    `if [ ! -x /usr/bin/curl ]; then printf 'unavailable\\n'; else result=$(/usr/bin/curl --silent --show-error --output /dev/null --max-time 5 --write-out '%{http_code} %{time_total}' ${quotePosixShell(`http://127.0.0.1:${config.websiteHealthPort}/`)} 2>/dev/null) && printf 'response %s\\n' "$result" || printf 'unreachable\\n'; fi`
  );
  const probe = parseWebsiteHealthProbe(output);
  return {
    state: probe.state,
    ...(probe.statusCode === undefined ? {} : { statusCode: probe.statusCode })
  };
}

export async function executeWebsiteDeployment(
  client: Client,
  config: WhatboxConfig,
  input: DeploymentExecutionInput
): Promise<DeploymentExecutionResult> {
  const validation = validateStaticSiteSource(
    input.sourceRoot,
    config.websiteSourceRoots
  );
  if (!validation.accepted || !validation.manifestDigest) {
    throw new Error("The local source no longer passes validation");
  }
  if (validation.manifestDigest !== input.expectedManifestDigest) {
    throw new Error("The local source changed after the plan was approved");
  }

  const root = requireRoot(config, input.rootIndex);
  resolveWebsiteReleaseTarget(root, input.releaseId);
  await requireRemoteHeadroom(
    client,
    config,
    input.rootIndex,
    validation.totalBytes
  );

  const canonicalSource = realpathSync(input.sourceRoot);
  const sftp = await openSftp(client);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(sftp, root);
    const releaseRelative = `.whatbox-releases/${input.releaseId}`;
    const releaseDirectory = posix.join(canonicalRoot, releaseRelative);
    if ((await lstatRemote(sftp, releaseDirectory)) !== null) {
      throw new Error("The release directory already exists");
    }
    await ensureRemoteDirectories(sftp, canonicalRoot, releaseRelative);

    const createdDirectories = new Set<string>([""]);
    for (const entry of validation.manifest) {
      const parent = posix.dirname(entry.relativePath);
      if (parent !== "." && !createdDirectories.has(parent)) {
        await ensureRemoteDirectories(sftp, releaseDirectory, parent);
        createdDirectories.add(parent);
      }
      await fastPutRemote(
        sftp,
        join(canonicalSource, ...entry.relativePath.split("/")),
        posix.join(releaseDirectory, entry.relativePath)
      );
    }
    await writeRemoteFile(
      sftp,
      posix.join(releaseDirectory, "._whatbox-manifest.sha256"),
      buildManifestFileContent(validation.manifest)
    );

    const verification = await executeFixedCommandWithStatus(
      client,
      `cd ${quotePosixShell(releaseDirectory)} && LC_ALL=C sha256sum -c --quiet ._whatbox-manifest.sha256 >/dev/null 2>&1 && printf 'verified\\n' || printf 'mismatch\\n'`
    );
    if (verification.output.trim() !== "verified") {
      throw new Error("Remote manifest verification failed; release not activated");
    }

    const previousReleaseId = await activateRelease(
      sftp,
      canonicalRoot,
      input.releaseId
    );
    const healthProbe = await probeConfiguredHealthPort(client, config);

    return {
      releaseId: input.releaseId,
      uploadedFileCount: validation.manifest.length,
      uploadedBytes: validation.totalBytes,
      remoteManifestVerified: true,
      activated: true,
      previousReleaseId,
      healthProbe
    };
  } finally {
    sftp.end();
  }
}

export interface RollbackInput {
  rootIndex: number;
  releaseId: string;
}

export function describeRollbackTargets(config: WhatboxConfig, input: RollbackInput) {
  const root = requireRoot(config, input.rootIndex);
  return [`rollback:${resolveWebsiteReleaseTarget(root, input.releaseId)}`];
}

export async function rollbackWebsiteRelease(
  client: Client,
  config: WhatboxConfig,
  input: RollbackInput
) {
  const root = requireRoot(config, input.rootIndex);
  resolveWebsiteReleaseTarget(root, input.releaseId);
  const sftp = await openSftp(client);
  try {
    const canonicalRoot = await realpath(sftp, root);
    const releaseDirectory = posix.join(
      canonicalRoot,
      `.whatbox-releases/${input.releaseId}`
    );
    const attrs = await lstatRemote(sftp, releaseDirectory);
    if (!attrs || !attrs.isDirectory()) {
      throw new Error("The rollback release does not exist");
    }
    const previousReleaseId = await activateRelease(
      sftp,
      canonicalRoot,
      input.releaseId
    );
    const healthProbe = await probeConfiguredHealthPort(client, config);
    return {
      activated: true,
      releaseId: input.releaseId,
      previousReleaseId,
      healthProbe
    };
  } finally {
    sftp.end();
  }
}

// -- Tier 3: composed shell, human-in-the-loop -------------------------------

const SHELL_MAX_OUTPUT_BYTES = 64 * 1024;

// The safety property of this tool is that a human reads exactly what runs.
// Each pattern below either breaks that property or is destructive enough that
// no novice should be able to approve it from a single prompt.
const SHELL_DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    // Bare shells, pathed shells (/bin/sh), and env-invoked shells alike.
    pattern: /\|\s*(\S*\/)?(env\s+)?(ba|k|z|da)?sh\b/,
    reason: "pipes fetched content into a shell, so the approved text is not what executes"
  },
  {
    pattern: /<\(/,
    reason: "process substitution executes fetched content that was never reviewed"
  },
  {
    pattern: /\beval\b/,
    reason: "eval obscures what actually executes"
  },
  {
    pattern: /\brm\b[^\n]*(\s-[a-zA-Z]*[rf]|--recursive\b|--force\b)/,
    reason: "recursive or forced deletion; use the quarantine tool instead"
  },
  {
    pattern: /\bfind\b[^\n]*-delete\b/,
    reason: "bulk deletion; use the quarantine tool instead"
  },
  {
    pattern: /\bxargs\b[^\n]*\brm\b/,
    reason: "bulk deletion; use the quarantine tool instead"
  },
  { pattern: /\b(mkfs|dd|shred)\b/, reason: "raw or unrecoverable write" },
  { pattern: /:\s*\(\s*\)\s*\{/, reason: "fork bomb shape" },
  { pattern: /\bcrontab\b[^\n]*\s-r\b/, reason: "wipes all scheduled jobs" },
  { pattern: /\bchmod\b[^\n]*-R[^\n]*777/, reason: "recursive world-writable permissions" },
  { pattern: /\b(reboot|shutdown|halt|poweroff)\b/, reason: "host-level power action" },
  {
    pattern: /(\.ssh|\.gnupg|\.password-store|authorized_keys|rclone\.conf|deluge\/auth)/,
    reason: "touches credential material"
  }
];

export function assertShellCommandAllowed(command: string) {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("Command must not be empty");
  }
  for (const { pattern, reason } of SHELL_DENY_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new Error(`Refused: the command ${reason}.`);
    }
  }
  return trimmed;
}

const SHELL_DEFAULT_TIMEOUT_MS = 120_000;
export const SHELL_MAX_TIMEOUT_SECONDS = 600;

export function runApprovedShellCommand(
  client: Client,
  command: string,
  timeoutMs = SHELL_DEFAULT_TIMEOUT_MS
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(new Error("Unable to run the approved command"));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      // Arbitrary shell can block forever (a command waiting on stdin, a
      // walk over a busy disk). The fixed-query executor gets away without a
      // timeout because its commands are bounded by construction; this one
      // must enforce the bound itself.
      const timer = setTimeout(() => {
        timedOut = true;
        stream.close();
      }, timeoutMs);

      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > SHELL_MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        target.push(chunk);
      };

      stream.on("data", collect(stdout));
      stream.stderr.on("data", collect(stderr));
      stream.on("close", (code: number | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: typeof code === "number" ? code : -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          truncated,
          timedOut
        });
      });
    });
  });
}

// -- App install templates ---------------------------------------------------

const APP_INSTALL_TIMEOUT_MS = 300_000;

function mapInstallFailure(output: string, code: number): string {
  if (output.includes("already-installed")) {
    return "The app is already installed; remove it first to reinstall.";
  }
  if (output.includes("FAILED") || output.includes("sha256sum")) {
    return "The downloaded artifact failed SHA-256 verification; install aborted before extraction.";
  }
  return `The install did not complete (exit ${code}).`;
}

export async function installWhatboxApp(
  client: Client,
  config: WhatboxConfig,
  manifest: AppManifest,
  context: InstallContext
) {
  // Never-overwrite pre-check, for a clean error before the script runs. The
  // script re-checks the marker under `set -e`, so this is belt-and-braces.
  const sftp = await openSftp(client);
  let markerExists: unknown;
  try {
    markerExists = await lstatRemote(sftp, `${context.home}/${manifest.marker}`);
  } finally {
    sftp.end();
  }
  if (markerExists) {
    throw new Error(`${manifest.name} is already installed`);
  }

  const { code, output } = await executeFixedCommandWithStatus(
    client,
    buildInstallScript(manifest, context),
    APP_INSTALL_TIMEOUT_MS
  );
  if (code !== 0 || !output.includes("INSTALL_OK")) {
    throw new Error(mapInstallFailure(output, code));
  }
  return { installed: true, id: manifest.id, version: manifest.version };
}

export async function uninstallWhatboxApp(
  client: Client,
  config: WhatboxConfig,
  manifest: AppManifest,
  context: InstallContext
) {
  const { code, output } = await executeFixedCommandWithStatus(
    client,
    buildUninstallScript(manifest, context),
    APP_INSTALL_TIMEOUT_MS
  );
  if (code !== 0 || !output.includes("UNINSTALL_OK")) {
    throw new Error(`The uninstall did not complete cleanly (exit ${code}).`);
  }
  return { removed: true, id: manifest.id };
}
