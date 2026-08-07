import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createWebsiteDeploymentPlan,
  resolveWebsiteReleaseTarget,
  validateStaticSiteSource
} from "./website.js";

function createSiteFixture() {
  const directory = mkdtempSync(join(tmpdir(), "whatbox-site-"));
  const source = join(directory, "source");
  mkdirSync(join(source, "assets"), { recursive: true });
  writeFileSync(join(source, "index.html"), "<h1>safe</h1>\n");
  writeFileSync(join(source, "assets", "app.css"), "body { color: black; }\n");
  return { directory, source };
}

test("accepts an allowlisted static site and creates a stable manifest digest", () => {
  const { directory, source } = createSiteFixture();
  const first = validateStaticSiteSource(source, [directory]);
  const second = validateStaticSiteSource(source, [directory]);

  assert.equal(first.accepted, true);
  assert.equal(first.fileCount, 2);
  assert.equal(first.totalBytes > 0, true);
  assert.equal(first.manifestDigest, second.manifestDigest);
  assert.deepEqual(first.rejectionReasons, []);
});

test("rejects sources outside the explicit local allowlist before traversal", () => {
  const { directory, source } = createSiteFixture();
  const outside = mkdtempSync(join(tmpdir(), "whatbox-outside-"));
  writeFileSync(join(source, ".env"), "SECRET=redacted\n");

  const result = validateStaticSiteSource(source, [outside]);

  assert.equal(result.accepted, false);
  assert.deepEqual(result.rejectionReasons, ["source_not_allowlisted"]);
});

test("rejects credential-like names inside an allowlisted source", () => {
  const { directory, source } = createSiteFixture();
  writeFileSync(join(source, ".env"), "SECRET=redacted\n");

  const result = validateStaticSiteSource(source, [directory]);

  assert.deepEqual(result.rejectionReasons, ["source_contains_sensitive_name"]);
});

test("rejects symlinks and refuses traversal-shaped release identifiers", () => {
  const { directory, source } = createSiteFixture();
  symlinkSync(join(directory, "outside"), join(source, "linked"));
  const result = validateStaticSiteSource(source, [directory]);

  assert.equal(result.accepted, false);
  assert.deepEqual(result.rejectionReasons, ["source_contains_symlink"]);
  assert.throws(() => resolveWebsiteReleaseTarget(directory, "../escape"));
});

test("binds a validated source and exact release target into a reversible plan", () => {
  const { directory, source } = createSiteFixture();
  const validation = validateStaticSiteSource(source, [directory]);
  const result = createWebsiteDeploymentPlan({
    source: validation,
    slotBinding: "a".repeat(64),
    rootIndex: 0,
    remoteWebsiteRoot: "/home/example/sites",
    releaseId: "123e4567-e89b-12d3-a456-426614174000"
  }, 1_000_000);

  assert.equal(result.plan.action, "website_deploy");
  assert.equal(result.plan.risk, "reversible");
  assert.equal(result.plan.targetDigests.length, 2);
  assert.equal(
    result.target.releaseRelativePath,
    ".whatbox-releases/123e4567-e89b-12d3-a456-426614174000"
  );
  assert.equal(result.plan.createdAt, 1_000_000);
});

test("does not create a deployment plan for rejected source validation", () => {
  const rejected = validateStaticSiteSource("/does/not/exist", ["/tmp"]);

  assert.throws(() => createWebsiteDeploymentPlan({
    source: rejected,
    slotBinding: "a".repeat(64),
    rootIndex: 0,
    remoteWebsiteRoot: "/home/example/sites"
  }));
});
