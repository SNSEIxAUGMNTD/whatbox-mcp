import {
  appendFileSync,
  closeSync,
  openSync
} from "node:fs";
import { join } from "node:path";
import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type InputRequiredResult
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  consumeMutationPlanOnce,
  createMutationPlan,
  createSlotBinding,
  createTargetDigest,
  getApprovalStateDirectory,
  getOrCreateApprovalKey,
  sealMutationPlan,
  verifyMutationPlan,
  type ApprovalAction,
  type MutationPlan
} from "./approval.js";
import type { WhatboxConfig } from "./config.js";

const APPROVAL_INPUT_KEY = "approval";

const approvalContentSchema = z.object({ approve: z.boolean() });

/**
 * The structural slice of the SDK tool-handler context this gate reads.
 * Kept minimal so the gate is unit-testable with hand-built contexts.
 */
export interface MutationContextLike {
  mcpReq: {
    inputResponses?: Record<string, unknown>;
    requestState: <T = unknown>() => T | undefined;
  };
}

export interface MutationRequest {
  action: ApprovalAction;
  risk: MutationPlan["risk"];
  /** Redacted human-facing summary shown in the approval dialog. */
  summary: string;
  /** Canonical target strings; digested into the plan, never returned. */
  canonicalTargets: string[];
  /** Safe display strings (relative paths, service names) for the dialog. */
  displayTargets: string[];
  /**
   * Optional verbatim detail recorded in the audit log and bound into the
   * signed plan — used by run_command to record the exact command, whose
   * text is the whole forensic value. Omit for tools whose targets should
   * stay hashed.
   */
  auditDetail?: string;
  /** Destructive actions always require an explicit human approval round. */
  requiresApproval: boolean;
}

export type DeniedReason =
  | "mutations_disabled"
  | "approval_missing"
  | "approval_declined"
  | "approval_cancelled"
  | "approval_invalid"
  | "approval_expired_or_tampered"
  | "approval_mismatch"
  | "approval_reused";

export type MutationGateOutcome =
  | { state: "approved"; plan: MutationPlan }
  | { state: "denied"; reason: DeniedReason }
  | { state: "input_required"; result: InputRequiredResult };

export interface AuditEvent {
  at: string;
  planId: string;
  action: ApprovalAction;
  risk: MutationPlan["risk"];
  outcome:
    | "approval_requested"
    | "approved"
    | "denied"
    | "executed"
    | "execution_failed";
  reason?: DeniedReason;
  /** Redacted human summary (purpose) — safe by construction. */
  summary?: string;
  /** Verbatim detail for run_command; absent for path-hashed tools. */
  detail?: string;
  targetDigests: string[];
}

export function appendAuditEvent(
  event: AuditEvent,
  stateDirectory = getApprovalStateDirectory()
) {
  const auditPath = join(stateDirectory, "audit.log");
  const descriptor = openSync(auditPath, "a", 0o600);
  try {
    appendFileSync(descriptor, `${JSON.stringify(event)}\n`);
  } finally {
    closeSync(descriptor);
  }
}

function audit(
  plan: MutationPlan,
  outcome: AuditEvent["outcome"],
  reason?: DeniedReason,
  stateDirectory?: string
) {
  appendAuditEvent(
    {
      at: new Date().toISOString(),
      planId: plan.planId,
      action: plan.action,
      risk: plan.risk,
      outcome,
      ...(reason ? { reason } : {}),
      summary: plan.summary,
      ...(plan.detail ? { detail: plan.detail } : {}),
      targetDigests: plan.targetDigests
    },
    stateDirectory
  );
}

function buildApprovalMessage(request: MutationRequest, plan: MutationPlan) {
  const targets = request.displayTargets.join(", ");
  return (
    `Whatbox MCP requests approval for a ${request.risk} mutation.\n`
    + `Action: ${request.action}\n`
    + `Summary: ${request.summary}\n`
    + `Targets: ${targets}\n`
    + `Plan ${plan.planId} expires ${new Date(plan.expiresAt).toISOString()}.\n`
    + "Approve only if you intend exactly this operation."
  );
}

/**
 * Gate a mutation behind the signed-plan + human-elicitation flow.
 *
 * Reversible mutations create, seal, and immediately consume a plan (for the
 * audit trail) and return approved. Destructive mutations require a
 * multi-round-trip elicitation: round one returns `input_required` carrying
 * the sealed plan as signed request state; the retry must carry an accepted
 * elicitation response and the untampered sealed plan, whose action, slot,
 * and exact target digests are revalidated before one-time consumption.
 */
export function gateMutation(
  config: WhatboxConfig,
  ctx: MutationContextLike,
  request: MutationRequest,
  stateDirectory = getApprovalStateDirectory(),
  now = Date.now()
): MutationGateOutcome {
  if (!config.mutationsEnabled) {
    return { state: "denied", reason: "mutations_disabled" };
  }

  const key = getOrCreateApprovalKey(stateDirectory);
  const slotBinding = createSlotBinding(
    config.username,
    config.hostFingerprintSha256
  );
  const targetDigests = [
    ...new Set(request.canonicalTargets.map(createTargetDigest))
  ].sort();

  if (!request.requiresApproval) {
    const plan = createMutationPlan(
      {
        action: request.action,
        slotBinding,
        targetDigests,
        summary: request.summary,
        detail: request.auditDetail,
        risk: request.risk
      },
      now
    );
    if (!consumeMutationPlanOnce(plan, stateDirectory)) {
      return { state: "denied", reason: "approval_reused" };
    }
    audit(plan, "approved", undefined, stateDirectory);
    return { state: "approved", plan };
  }

  const sealedPlan = ctx.mcpReq.requestState<string>();

  if (typeof sealedPlan !== "string") {
    const plan = createMutationPlan(
      {
        action: request.action,
        slotBinding,
        targetDigests,
        summary: request.summary,
        detail: request.auditDetail,
        risk: request.risk
      },
      now
    );
    audit(plan, "approval_requested", undefined, stateDirectory);
    return {
      state: "input_required",
      result: inputRequired({
        requestState: sealMutationPlan(plan, key),
        inputRequests: {
          [APPROVAL_INPUT_KEY]: inputRequired.elicit({
            message: buildApprovalMessage(request, plan),
            requestedSchema: approvalContentSchema
          })
        }
      })
    };
  }

  let plan: MutationPlan;
  try {
    plan = verifyMutationPlan(sealedPlan, key, now);
  } catch {
    return { state: "denied", reason: "approval_expired_or_tampered" };
  }

  const digestsMatch =
    plan.targetDigests.length === targetDigests.length
    && plan.targetDigests.every((digest, index) => digest === targetDigests[index]);
  if (
    plan.action !== request.action
    || plan.slotBinding !== slotBinding
    || !digestsMatch
  ) {
    audit(plan, "denied", "approval_mismatch", stateDirectory);
    return { state: "denied", reason: "approval_mismatch" };
  }

  const view = inputResponse(ctx.mcpReq.inputResponses, APPROVAL_INPUT_KEY);
  if (view.kind !== "elicit") {
    audit(plan, "denied", "approval_missing", stateDirectory);
    return { state: "denied", reason: "approval_missing" };
  }
  if (view.action === "decline") {
    audit(plan, "denied", "approval_declined", stateDirectory);
    return { state: "denied", reason: "approval_declined" };
  }
  if (view.action === "cancel") {
    audit(plan, "denied", "approval_cancelled", stateDirectory);
    return { state: "denied", reason: "approval_cancelled" };
  }

  const content = acceptedContent(
    ctx.mcpReq.inputResponses,
    APPROVAL_INPUT_KEY,
    approvalContentSchema
  );
  if (!content || content.approve !== true) {
    audit(plan, "denied", "approval_invalid", stateDirectory);
    return { state: "denied", reason: "approval_invalid" };
  }

  if (!consumeMutationPlanOnce(plan, stateDirectory)) {
    audit(plan, "denied", "approval_reused", stateDirectory);
    return { state: "denied", reason: "approval_reused" };
  }

  audit(plan, "approved", undefined, stateDirectory);
  return { state: "approved", plan };
}

export function auditExecution(
  plan: MutationPlan,
  succeeded: boolean,
  stateDirectory?: string
) {
  audit(plan, succeeded ? "executed" : "execution_failed", undefined, stateDirectory);
}

export function deniedText(reason: DeniedReason) {
  const messages: Record<DeniedReason, string> = {
    mutations_disabled:
      "Remote mutations are disabled. Set WHATBOX_MUTATIONS_ENABLED=true in the private local configuration to enable them.",
    approval_missing:
      "The mutation was denied because no human approval response was presented.",
    approval_declined: "The human operator declined this mutation.",
    approval_cancelled: "The approval interaction was cancelled.",
    approval_invalid:
      "The approval response was invalid; the mutation was denied.",
    approval_expired_or_tampered:
      "The approval plan is expired or failed integrity verification; the mutation was denied.",
    approval_mismatch:
      "The request no longer matches the approved plan's action or exact targets; the mutation was denied.",
    approval_reused:
      "This approval plan was already consumed; each approval authorizes at most one execution."
  };
  return messages[reason];
}
