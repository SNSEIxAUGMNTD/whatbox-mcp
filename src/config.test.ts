import assert from "node:assert/strict";
import test from "node:test";
import { parseConfigValues } from "./config.js";

const baseValues = {
  WHATBOX_HOST: "example.whatbox.test",
  WHATBOX_USERNAME: "example-user",
  WHATBOX_SSH_AUTH_MODE: "key",
  WHATBOX_SSH_KEY_PATH: "~/.ssh/whatbox-mcp",
  WHATBOX_HOST_FINGERPRINT_SHA256: "SHA256:YWJjZA=="
};

test("parses local configuration without placing values in the repository", () => {
  const config = parseConfigValues(baseValues, "/Users/example");

  assert.equal(config.port, 22);
  assert.equal(config.sshKeyPath, "/Users/example/.ssh/whatbox-mcp");
  assert.deepEqual(config.allowedRoots, ["/home/example-user/files"]);
});

test("normalizes configured roots and removes duplicates", () => {
  const config = parseConfigValues(
    {
      ...baseValues,
      WHATBOX_ALLOWED_ROOTS: "~/files/,/home/example-user/sites,/home/example-user/sites"
    },
    "/Users/example"
  );

  assert.deepEqual(config.allowedRoots, [
    "/home/example-user/files",
    "/home/example-user/sites"
  ]);
});

test("requires an SSH key path for key authentication", () => {
  assert.throws(() =>
    parseConfigValues({
      ...baseValues,
      WHATBOX_SSH_KEY_PATH: undefined
    })
  );
});

test("rejects the remote filesystem root", () => {
  assert.throws(() =>
    parseConfigValues({ ...baseValues, WHATBOX_ALLOWED_ROOTS: "/" })
  );
});

test("parses local website source roots without exposing them", () => {
  const config = parseConfigValues(
    {
      ...baseValues,
      WHATBOX_WEBSITE_SOURCE_ROOTS: "~/Sites, /Users/example/Sites"
    },
    "/Users/example"
  );

  assert.deepEqual(config.websiteSourceRoots, ["/Users/example/Sites"]);
});

test("rejects a filesystem root website source allowlist", () => {
  assert.throws(() =>
    parseConfigValues({
      ...baseValues,
      WHATBOX_WEBSITE_SOURCE_ROOTS: "/"
    })
  );
});
