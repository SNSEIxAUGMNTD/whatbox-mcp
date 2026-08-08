import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";

const APPROVAL_KEY_BYTES = 32;
const DEFAULT_PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_SEALED_PLAN_BYTES = 8 * 1024;

const mutationPlanSchema = z.object({
  version: z.literal(1),
  planId: z.string().uuid(),
  action: z.enum([
    "service_start",
    "service_stop",
    "service_restart",
    "website_deploy",
    "website_rollback",
    "path_quarantine",
    "quarantine_purge",
    "file_upload",
    "path_move",
    "path_create",
    "torrent_add",
    "torrent_control",
    "torrent_remove",
    "run_command"
  ]),
  slotBinding: z.string().regex(/^[a-f0-9]{64}$/),
  targetDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100),
  summary: z.string().min(1).max(500),
  // Optional forensic detail bound into the signed plan (e.g. the exact
  // shell command for run_command). Absent for tools whose targets stay
  // hashed. Recorded verbatim in the local audit log.
  detail: z.string().max(4096).optional(),
  risk: z.enum(["reversible", "destructive"]),
  requiresSecondApproval: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive()
});

export type MutationPlan = z.infer<typeof mutationPlanSchema>;
export type ApprovalAction = MutationPlan["action"];

export function getApprovalStateDirectory(localHome = homedir()) {
  return join(localHome, ".local", "state", "whatbox-mcp");
}

function requireSecurePermissions(path: string) {
  // POSIX permission bits are not meaningful on Windows (NTFS uses ACLs);
  // enforce owner-only bits only on POSIX platforms.
  if (process.platform === "win32") {
    return;
  }
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error("Approval state permissions are too open");
  }
}

function ensurePrivateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  requireSecurePermissions(path);
}

export function getOrCreateApprovalKey(stateDirectory: string) {
  ensurePrivateDirectory(stateDirectory);
  const keyPath = join(stateDirectory, "approval.key");

  try {
    const descriptor = openSync(keyPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, randomBytes(APPROVAL_KEY_BYTES));
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  requireSecurePermissions(keyPath);
  const key = readFileSync(keyPath);
  if (key.length !== APPROVAL_KEY_BYTES) {
    throw new Error("Approval key is invalid");
  }
  return key;
}

export function createSlotBinding(username: string, hostFingerprint: string) {
  return createHash("sha256")
    .update(`${username}\0${hostFingerprint}`)
    .digest("hex");
}

export function createTargetDigest(canonicalTarget: string) {
  return createHash("sha256").update(canonicalTarget).digest("hex");
}

export function createMutationPlan(
  input: {
    action: ApprovalAction;
    slotBinding: string;
    targetDigests: string[];
    summary: string;
    detail?: string;
    risk: MutationPlan["risk"];
    requiresSecondApproval?: boolean;
  },
  now = Date.now(),
  ttlMs = DEFAULT_PLAN_TTL_MS
): MutationPlan {
  if (ttlMs <= 0 || ttlMs > MAX_PLAN_TTL_MS) {
    throw new Error("Approval plan lifetime is invalid");
  }

  return mutationPlanSchema.parse({
    version: 1,
    planId: randomUUID(),
    action: input.action,
    slotBinding: input.slotBinding,
    targetDigests: [...new Set(input.targetDigests)].sort(),
    summary: input.summary,
    ...(input.detail ? { detail: input.detail.slice(0, 4096) } : {}),
    risk: input.risk,
    requiresSecondApproval: input.requiresSecondApproval ?? false,
    createdAt: now,
    expiresAt: now + ttlMs
  });
}

export function sealMutationPlan(plan: MutationPlan, key: Buffer) {
  const payload = Buffer.from(JSON.stringify(mutationPlanSchema.parse(plan)))
    .toString("base64url");
  const signature = createHmac("sha256", key)
    .update(payload)
    .digest("base64url");
  return `v1.${payload}.${signature}`;
}

export function verifyMutationPlan(
  sealedPlan: string,
  key: Buffer,
  now = Date.now()
) {
  if (Buffer.byteLength(sealedPlan) > MAX_SEALED_PLAN_BYTES) {
    throw new Error("Approval plan is invalid");
  }

  const [version, payload, signature, extra] = sealedPlan.split(".");
  if (version !== "v1" || !payload || !signature || extra !== undefined) {
    throw new Error("Approval plan is invalid");
  }

  const expected = createHmac("sha256", key).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Approval plan is invalid");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Approval plan is invalid");
  }

  const plan = mutationPlanSchema.parse(decoded);
  if (plan.createdAt > now + 60_000 || plan.expiresAt <= now) {
    throw new Error("Approval plan has expired");
  }
  return plan;
}

export function consumeMutationPlanOnce(
  plan: MutationPlan,
  stateDirectory: string
) {
  const consumedDirectory = join(stateDirectory, "consumed");
  ensurePrivateDirectory(stateDirectory);
  ensurePrivateDirectory(consumedDirectory);
  const consumedPath = join(consumedDirectory, plan.planId);

  try {
    const descriptor = openSync(consumedPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${Date.now()}\n`);
    } finally {
      closeSync(descriptor);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}
