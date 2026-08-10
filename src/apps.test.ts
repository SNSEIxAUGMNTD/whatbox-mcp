import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_MANIFESTS,
  buildHealthProbeScript,
  buildInstallScript,
  buildRestartScript,
  buildUninstallScript,
  buildUpgradeScript,
  getAppManifest,
  listAppIds,
  parseAppState,
  parseHealthStates,
  shellQuote
} from "./apps.js";

const HOME = "/home/example";

test("every manifest carries a real 64-hex SHA-256 and a valid id", () => {
  assert.ok(APP_MANIFESTS.length >= 3);
  for (const manifest of APP_MANIFESTS) {
    assert.match(manifest.fetch.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.match(manifest.fetch.artifact.url, /^https:\/\//);
  }
  assert.deepEqual(listAppIds().sort(), [
    "navidrome",
    "radarr",
    "rclone",
    "sonarr",
    "yt-dlp"
  ]);
});

test("shellQuote neutralizes embedded single quotes", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote("plain"), "'plain'");
});

test("Navidrome install script verifies the hash before extracting and templates the config", () => {
  const manifest = getAppManifest("navidrome")!;
  const script = buildInstallScript(manifest, {
    home: HOME,
    port: 21847,
    musicFolder: `${HOME}/music`
  });

  // Fails closed and never overwrites.
  assert.match(script, /^set -eu/);
  assert.match(script, /already-installed/);
  // The pinned hash is checked, and the check precedes extraction.
  const hash = manifest.fetch.artifact.sha256;
  assert.ok(script.includes(`${hash}  artifact`));
  assert.ok(
    script.indexOf("sha256sum -c -") < script.indexOf("tar xzf"),
    "verification must run before extraction"
  );
  // Service registration.
  assert.match(script, /crontab -/);
  assert.match(script, /# whatbox-mcp:navidrome/);
  assert.match(script, /screen -dmS navidrome/);
  assert.match(script, /echo INSTALL_OK/);

  // The config is written via base64; decode it and confirm substitution.
  const encoded = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script);
  assert.ok(encoded, "config should be written via base64");
  const config = Buffer.from(encoded![1], "base64").toString("utf8");
  assert.match(config, /Port = '21847'/);
  assert.match(config, /MusicFolder = '\/home\/example\/music'/);
  assert.match(config, /Address = '127\.0\.0\.1'/);
});

test("Navidrome music folder defaults to ~/files when unset", () => {
  const script = buildInstallScript(getAppManifest("navidrome")!, {
    home: HOME,
    port: 21847
  });
  const encoded = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script)!;
  const config = Buffer.from(encoded[1], "base64").toString("utf8");
  assert.match(config, /MusicFolder = '\/home\/example\/files'/);
});

test("rclone install pulls the versioned binary and adds no service", () => {
  const script = buildInstallScript(getAppManifest("rclone")!, { home: HOME });
  assert.match(script, /unzip -q artifact/);
  assert.match(
    script,
    /install -m 755 "\$TMP\/x"\/rclone-v1\.75\.0-linux-amd64\/rclone '\/home\/example\/bin\/rclone'/
  );
  assert.doesNotMatch(script, /crontab/);
  assert.doesNotMatch(script, /screen -dmS/);
});

test("yt-dlp install places the raw binary directly", () => {
  const script = buildInstallScript(getAppManifest("yt-dlp")!, { home: HOME });
  assert.match(script, /install -m 755 artifact '\/home\/example\/bin\/yt-dlp'/);
  assert.doesNotMatch(script, /tar |unzip /);
  assert.doesNotMatch(script, /crontab/);
});

test("health probe checks process and (when a port is known) loopback response", () => {
  const script = buildHealthProbeScript([
    { id: "navidrome", processMatch: "navidrome/navidrome", port: 21847 },
    { id: "beets", processMatch: "beets/beet" } // no port
  ]);
  assert.match(script, /pgrep -f 'navidrome\/navidrome'/);
  assert.match(script, /curl .* 'http:\/\/127\.0\.0\.1:21847\/'/);
  assert.match(script, /H=na/); // the port-less entry

  const states = parseHealthStates(
    ["navidrome|running|responding", "x|stopped|unreachable", "y|running|na", "junk"].join(
      "\n"
    )
  );
  assert.deepEqual(states.get("navidrome"), { running: true, responding: true });
  assert.deepEqual(states.get("x"), { running: false, responding: false });
  assert.deepEqual(states.get("y"), { running: true, responding: null });
  assert.equal(states.has("junk"), false);
});

test("install records a state file with version and port; parseAppState reads it", () => {
  const script = buildInstallScript(getAppManifest("navidrome")!, {
    home: HOME,
    port: 21847
  });
  assert.match(script, /\.config\/whatbox-mcp\/apps/);
  // The last base64 blob is the state file; decode and check it.
  const blobs = [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/g)];
  const stateJson = Buffer.from(blobs.at(-1)![1], "base64").toString("utf8");
  const state = parseAppState(stateJson);
  assert.equal(state.version, "0.63.2");
  assert.equal(state.port, 21847);

  assert.deepEqual(parseAppState("not json"), {});
  assert.deepEqual(parseAppState('{"version":"1.0"}'), { version: "1.0", port: undefined });
});

test("upgrade requires an existing install, verifies, and preserves data", () => {
  const script = buildUpgradeScript(getAppManifest("navidrome")!, {
    home: HOME,
    port: 21847
  });
  assert.match(script, /not-installed/);
  assert.ok(
    script.indexOf("sha256sum -c -") < script.indexOf("tar xzf"),
    "verify before re-extracting"
  );
  // Re-extracts over the install dir (data/config not in the archive → kept).
  assert.match(script, /tar xzf artifact -C '\/home\/example\/navidrome'/);
  assert.match(script, /echo UPGRADE_OK/);
});

test("restart kills then relaunches a service; refuses a non-service", () => {
  const script = buildRestartScript(getAppManifest("navidrome")!, {
    home: HOME
  });
  assert.match(script, /pkill -f 'navidrome\/navidrome'/);
  assert.ok(
    script.indexOf("pkill") < script.indexOf("screen -dmS navidrome"),
    "must kill before relaunching"
  );
  assert.match(script, /echo RESTART_OK/);

  assert.throws(
    () => buildRestartScript(getAppManifest("rclone")!, { home: HOME }),
    /no service/
  );
});

test("Sonarr install creates the config subdirectory and templates the port", () => {
  const script = buildInstallScript(getAppManifest("sonarr")!, {
    home: HOME,
    port: 28989
  });
  assert.ok(script.includes(getAppManifest("sonarr")!.fetch.artifact.sha256));
  // The data/ subdir must be created before the config is written into it.
  assert.match(script, /mkdir -p '\/home\/example\/sonarr\/data'/);
  const encoded = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(script)!;
  const config = Buffer.from(encoded[1], "base64").toString("utf8");
  assert.match(config, /<Port>28989<\/Port>/);
  assert.match(config, /<BindAddress>127\.0\.0\.1<\/BindAddress>/);
  assert.match(script, /screen -dmS sonarr .*Sonarr\/Sonarr -nobrowser/);
});

test("uninstall stops, de-crons, and quarantines rather than deleting", () => {
  const script = buildUninstallScript(getAppManifest("navidrome")!, {
    home: HOME
  });
  assert.match(script, /pkill -f 'navidrome\/navidrome'/);
  assert.match(script, /grep -vF '# whatbox-mcp:navidrome' \| crontab -/);
  assert.match(script, /\.whatbox-quarantine\/apps/);
  assert.match(script, /mv '\/home\/example\/navidrome'/);
  assert.doesNotMatch(script, /\brm\b/);
  assert.match(script, /echo UNINSTALL_OK/);
});
