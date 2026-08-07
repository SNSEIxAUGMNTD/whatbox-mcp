import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  consumeMutationPlanOnce,
  createMutationPlan,
  createSlotBinding,
  createTargetDigest,
  getOrCreateApprovalKey,
  sealMutationPlan,
  verifyMutationPlan
} from "./approval.js";

function createFixture(now = 1_000_000) {
  const stateDirectory = mkdtempSync(join(tmpdir(), "whatbox-approval-"));
  const key = getOrCreateApprovalKey(stateDirectory);
  const plan = createMutationPlan(
    {
      action: "service_restart",
      slotBinding: createSlotBinding("example", "SHA256:host"),
      targetDigests: [createTargetDigest("service:nginx")],
      summary: "Restart userland Nginx after validation",
      risk: "reversible"
    },
    now
  );
  return { stateDirectory, key, plan, now };
}

test("seals and verifies an immutable short-lived mutation plan", () => {
  const { key, plan, now } = createFixture();
  const sealed = sealMutationPlan(plan, key);

  assert.deepEqual(verifyMutationPlan(sealed, key, now + 1_000), plan);
});

test("rejects modified and expired mutation plans", () => {
  const { key, plan, now } = createFixture();
  const sealed = sealMutationPlan(plan, key);
  const modified = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;

  assert.throws(() => verifyMutationPlan(modified, key, now + 1_000));
  assert.throws(() => verifyMutationPlan(sealed, key, plan.expiresAt));
});

test("rejects a plan verified with the wrong approval key", () => {
  const { plan } = createFixture();
  const sealed = sealMutationPlan(plan, Buffer.alloc(32, 7));

  assert.throws(() => verifyMutationPlan(sealed, Buffer.alloc(32, 8)));
});

test("rejects a plan whose action or exact targets do not match the execution request", () => {
  const { key, plan, now } = createFixture();
  const sealed = sealMutationPlan(plan, key);
  const verified = verifyMutationPlan(sealed, key, now + 1_000);

  assert.notEqual(verified.action, "website_deploy");
  assert.deepEqual(verified.targetDigests, [createTargetDigest("service:nginx")]);
});

test("consumes a mutation plan at most once", () => {
  const { stateDirectory, plan } = createFixture();

  assert.equal(consumeMutationPlanOnce(plan, stateDirectory), true);
  assert.equal(consumeMutationPlanOnce(plan, stateDirectory), false);
});
