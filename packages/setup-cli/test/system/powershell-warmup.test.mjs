import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { it } from "node:test";
import { warmPowerShell, withTempHome } from "../helpers.mjs";

it("warms PowerShell in a temp home, never the real one", { skip: process.platform === "win32" && "uses a shell-script stand-in for pwsh" }, async () => {
  await withTempHome("pwsh-warmup-record", async (dir) => {
    // A stand-in pwsh that records the environment it was started with.
    const record = path.join(dir, "env.json");
    const fake = path.join(dir, "pwsh");
    await writeFile(fake, `#!/bin/sh
node -e 'const e = process.env; require("fs").writeFileSync(process.argv[1], JSON.stringify({
  home: e.HOME, userProfile: e.USERPROFILE, cache: e.XDG_CACHE_HOME, config: e.XDG_CONFIG_HOME,
  data: e.XDG_DATA_HOME, appData: e.APPDATA, localAppData: e.LOCALAPPDATA, telemetry: e.POWERSHELL_TELEMETRY_OPTOUT, homeExists: require("fs").existsSync(e.HOME),
  args: process.argv.slice(2) }))' ${JSON.stringify(record)} "$@"
`);
    await chmod(fake, 0o755);

    await warmPowerShell(fake);

    const seen = JSON.parse(await readFile(record, "utf8"));
    for (const realHome of [os.homedir(), process.env.HOME, process.env.USERPROFILE].filter(Boolean)) {
      assert.notEqual(seen.home, realHome);
      assert.notEqual(seen.userProfile, realHome);
    }
    assert.equal(seen.userProfile, seen.home);
    assert.ok(seen.home.startsWith(os.tmpdir()), seen.home);
    assert.equal(seen.homeExists, true);
    for (const dirName of [seen.cache, seen.config, seen.data, seen.appData, seen.localAppData]) {
      assert.ok(dirName.startsWith(`${seen.home}${path.sep}`), dirName);
    }
    assert.equal(seen.telemetry, "1");
    assert.deepEqual(seen.args, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]);
    // The temp home is removed once the warm-up is done.
    assert.equal(existsSync(seen.home), false);
  });
});

it("tolerates a missing pwsh", async () => {
  await warmPowerShell(path.join(os.tmpdir(), "no-such-pwsh-for-nexus-tests"));
});
