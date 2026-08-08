import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getOrCreateApprovalKey,
  sealMutationPlan,
  verifyMutationPlan,
  type MutationPlan
} from "./approval.js";
import { gateMutation, type MutationContextLike } from "./mutation.js";
import type { WhatboxConfig } from "./config.js";

function baseConfig(overrides: Partial<WhatboxConfig> = {}): WhatboxConfig {
  return {
    host: "example.whatbox.test",
    username: "example",
    port: 22,
    authMode: "agent",
    hostFingerprintSha256: "SHA256:abcd",
    allowedRoots: ["/home/example/files"],
    websiteSourceRoots: [],
    mutationsEnabled: true,
    ...overrides
  };
}

function ctx(
  inputResponses?: Record<string, unknown>,
  state?: string
): MutationContextLike {
  return {
    mcpReq: {
      inputResponses,
      requestState: <T,>() => state as T | undefined
    }
  };
}

const reversible = {
  action: "file_upload" as const,
  risk: "reversible" as const,
  summary: "Upload a file",
  canonicalTargets: ["upload:/home/example/files/a"],
  displayTargets: ["files/a"],
  requiresApproval: false
};

const destructive = {
  action: "path_quarantine" as const,
  risk: "destructive" as const,
  summary: "Quarantine a path",
  canonicalTargets: ["quarantine:/home/example/files/junk"],
  displayTargets: ["files/junk"],
  requiresApproval: true
};

test("denies every mutation when mutations are disabled", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "wb-mut-"));
  const outcome = gateMutation(
    baseConfig({ mutationsEnabled: false }),
    ctx(),
    reversible,
    stateDirectory
  );
  assert.deepEqual(outcome, { state: "denied", reason: "mutations_disabled" });
});

test("reversible mutations are approved without an elicitation round", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "wb-mut-"));
  const outcome = gateMutation(baseConfig(), ctx(), reversible, stateDirectory);
  assert.equal(outcome.state, "approved");
});

test("destructive mutations require an elicitation round first", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "wb-mut-"));
  const outcome = gateMutation(baseConfig(), ctx(), destructive, stateDirectory);
  assert.equal(outcome.state, "input_required");
  if (outcome.state === "input_required") {
    assert.ok(outcome.result.requestState);
    assert.ok(outcome.result.inputRequests?.approval);
  }
});

test("destructive mutation is approved only with a valid sealed plan and accept", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "wb-mut-"));
  const first = gateMutation(baseConfig(), ctx(), destructive, stateDirectory);
  assert.equal(first.state, "input_required");
  const sealed =
    first.state === "input_required" ? first.result.requestState! : "";

  const approved = gateMutation(
    baseConfig(),
    ctx({ approval: { action: "accept", content: { approve: true } } }, sealed),
    destructive,
    stateDirectory
  );
  assert.equal(approved.state, "approved");
});

test("a declined elicitation denies the mutation", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "wb-mut-"));
  const first = gateMutation(baseConfig(), ctx(), destructive, stateDirectory);
  const sealed =
    first.state === "input_required" ? first.result.requestState! : "";

  const outcome = gateMutation(
    baseConfig(),
    ctx({ approval: { action: "decline" } }, sealed),
    destructive,
    stateDirectory
  );
  assert.deepEqual(outcome, { state: "denied", reason: "approval_declined" });
});

test("a model-supplied approve boolean without an accept action is denied", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "wb-mut-"));
  const first = gateMutation(baseConfig(), ctx(), destructive, stateDirectory);
  const sealed =
    first.state === "input_required" ? first.result.requestState! : "";

  // No elicitation response entry at all — model cannot fake human approval.
  const outcome = gateMutation(baseConfig(), ctx({}, sealed), destructive, stateDirectory);
  assert.deepEqual(outcome, { state: "denied", reason: "approval_missing" });
});

test("a tampered sealed plan is denied", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "wb-mut-"));
  const first = gateMutation(baseConfig(), ctx(), destructive, stateDirectory);
  const sealed =
    first.state === "input_required" ? first.result.requestState! : "";
  const tampered = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;

  const outcome = gateMutation(
    baseConfig(),
    ctx({ approval: { action: "accept", content: { approve: true } } }, tampered),
    destructive,
    stateDirectory
  );
  assert.deepEqual(outcome, {
    state: "denied",
    reason: "approval_expired_or_tampered"
  });
});

test("a plan approved for other targets does not authorize this request", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "wb-mut-"));
  const first = gateMutation(baseConfig(), ctx(), destructive, stateDirectory);
  const sealed =
    first.state === "input_required" ? first.result.requestState! : "";

  const differentTargets = {
    ...destructive,
    canonicalTargets: ["quarantine:/home/example/files/other"]
  };
  const outcome = gateMutation(
    baseConfig(),
    ctx({ approval: { action: "accept", content: { approve: true } } }, sealed),
    differentTargets,
    stateDirectory
  );
  assert.deepEqual(outcome, { state: "denied", reason: "approval_mismatch" });
});

test("an approval plan cannot be reused for a second execution", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "wb-mut-"));
  const first = gateMutation(baseConfig(), ctx(), destructive, stateDirectory);
  const sealed =
    first.state === "input_required" ? first.result.requestState! : "";
  const accept = ctx(
    { approval: { action: "accept", content: { approve: true } } },
    sealed
  );

  assert.equal(gateMutation(baseConfig(), accept, destructive, stateDirectory).state, "approved");
  assert.deepEqual(
    gateMutation(baseConfig(), accept, destructive, stateDirectory),
    { state: "denied", reason: "approval_reused" }
  );
});

test("an expired sealed plan is denied", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "wb-mut-"));
  const key = getOrCreateApprovalKey(stateDirectory);
  const plan: MutationPlan = verifyMutationPlan(
    (() => {
      const first = gateMutation(baseConfig(), ctx(), destructive, stateDirectory, 1_000_000);
      return first.state === "input_required" ? first.result.requestState! : "";
    })(),
    key,
    1_000_000
  );
  const sealed = sealMutationPlan(plan, key);

  const outcome = gateMutation(
    baseConfig(),
    ctx({ approval: { action: "accept", content: { approve: true } } }, sealed),
    destructive,
    stateDirectory,
    plan.expiresAt + 1
  );
  assert.deepEqual(outcome, {
    state: "denied",
    reason: "approval_expired_or_tampered"
  });
});

test("writes a redacted audit log without target contents", () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "wb-mut-"));
  gateMutation(baseConfig(), ctx(), reversible, stateDirectory);
  const audit = readFileSync(join(stateDirectory, "audit.log"), "utf8");

  assert.match(audit, /"outcome":"approved"/);
  assert.match(audit, /"action":"file_upload"/);
  assert.equal(audit.includes("/home/example/files/a"), false);
});
