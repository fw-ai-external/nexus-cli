import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { OWNED_MARKER, installOwnedDir, isNexusOwnedDir, removeOwnedDir } from "../../lib/harness/owned-asset-dir.mjs";
import { withTempHome } from "../helpers.mjs";

describe("Nexus-owned asset folders", () => {
  it("installs with a marker, refreshes its own folder, and removes it", async () => {
    await withTempHome("owned-dir", async (home) => {
      const source = path.join(home, "src");
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "a.txt"), "one");
      const dir = path.join(home, "plugins", "fireworks-nexus");

      assert.equal(await installOwnedDir(dir, source, ["a.txt"]), true);
      assert.ok(isNexusOwnedDir(dir));
      await writeFile(path.join(source, "a.txt"), "two");
      assert.equal(await installOwnedDir(dir, source, ["a.txt"]), true);
      assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "two");

      assert.equal(await removeOwnedDir(dir), true);
      assert.equal(existsSync(dir), false);
      assert.equal(await removeOwnedDir(dir), false, "nothing left to remove");
    });
  });

  it("never replaces or deletes a folder at that path that Nexus did not create", async () => {
    await withTempHome("owned-dir-user", async (home) => {
      const source = path.join(home, "src");
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "a.txt"), "ours");
      const dir = path.join(home, "pets", "fireworks-nexus");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "a.txt"), "theirs");

      assert.equal(await installOwnedDir(dir, source, ["a.txt"]), false);
      assert.equal(await removeOwnedDir(dir), false);
      assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "theirs");
      assert.equal(existsSync(path.join(dir, OWNED_MARKER)), false);
    });
  });

  it("adopts a folder an earlier build installed without the marker, and an empty one", async () => {
    await withTempHome("owned-dir-legacy", async (home) => {
      const source = path.join(home, "src");
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "id.txt"), "nexus");
      const recognize = (dir) => existsSync(path.join(dir, "id.txt"));

      const legacy = path.join(home, "legacy");
      await mkdir(legacy, { recursive: true });
      await writeFile(path.join(legacy, "id.txt"), "nexus");
      assert.equal(await removeOwnedDir(legacy, { recognize }), true);
      assert.equal(existsSync(legacy), false);

      const empty = path.join(home, "empty");
      await mkdir(empty, { recursive: true });
      assert.equal(await installOwnedDir(empty, source, ["id.txt"]), true, "an interrupted install can be retried");
      assert.ok(isNexusOwnedDir(empty));
    });
  });

  it("with NEXUS_DEBUG=1, says why it left a folder alone", async () => {
    await withTempHome("owned-dir-debug", async (home) => {
      const dir = path.join(home, "theirs");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "x"), "user");
      const writes = [];
      const original = process.stderr.write;
      const previous = process.env.NEXUS_DEBUG;
      process.env.NEXUS_DEBUG = "1";
      process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
      try {
        assert.equal(await installOwnedDir(dir, home, []), false);
      } finally {
        process.stderr.write = original;
        if (previous === undefined) delete process.env.NEXUS_DEBUG;
        else process.env.NEXUS_DEBUG = previous;
      }
      assert.match(writes.join(""), /left .* alone/);
    });
  });
});
