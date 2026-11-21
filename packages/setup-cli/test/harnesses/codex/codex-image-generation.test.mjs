import assert from "node:assert/strict";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";
import {
  codexBackupPath,
  codexConfigPath,
  codexDataDir,
  disableCodexFireworks,
  enableCodexFireworks,
} from "../../../lib/harnesses/codex/core.mjs";
import { patchCodexImageGenerationRaw, stripCodexImageGenerationRaw } from "../../../lib/harnesses/codex/feature-patch.mjs";
import { patchFireconnectRoutingRaw, stripFireconnectRoutingRaw } from "../../../lib/harnesses/codex/toml-patch.mjs";
import { parseToml } from "../../../lib/harnesses/codex/toml.mjs";
import { withTempHome } from "../../helpers.mjs";

const ROUTING = {
  providerId: "fireworks-ai",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  modelId: "auto",
};

describe("Codex image generation default", () => {
  for (const [name, raw] of [
    ["fresh config", ""],
    ["existing features", "[features]\nweb_search = true # keep\n"],
    ["quoted features", "[ 'features' ] # keep\nother = false\n[tui]\nanimations = false\n"],
    ["dotted features", "features.other = true\n[tui]\nanimations = false\n"],
    ["inline features", "features = { other = true } # keep\n"],
    ["empty inline features", '"features" = {}\n'],
    ["multiline inline features", "features = {\nother = true, # keep\n}\n"],
    ["nested features", "[features.other]\nenabled = true\n"],
  ]) {
    it(`disables image generation for ${name}, idempotently`, () => {
      const patched = patchCodexImageGenerationRaw(raw);
      assert.equal(parseToml(patched).tables.features.image_generation, false);
      assert.equal(patchCodexImageGenerationRaw(patched), patched);
      const routed = patchFireconnectRoutingRaw(raw, ROUTING);
      assert.equal(patchFireconnectRoutingRaw(routed, ROUTING), routed);
      const stripped = stripFireconnectRoutingRaw(routed, { stripRootRouting: true });
      assert.equal(parseToml(stripped).tables.features?.image_generation, undefined);
      assert.equal(stripped.includes("# nexus:"), false);
      assert.deepEqual(parseToml(stripped), parseToml(raw));
      if (raw.includes("# keep")) assert.ok(stripped.includes("# keep"));
    });
  }

  for (const raw of [
    "[features]\nimage_generation = true\n",
    "[features]\nimage_generation = false\n",
    "features.image_generation = true\n",
    "features = { image_generation = false, other = true }\n",
    "['features']\n'image_generation' = true\n",
    'features = { "image_generation" = "user-value" }\n',
  ]) {
    it(`preserves the explicit preference ${JSON.stringify(raw)}`, () => {
      assert.equal(patchCodexImageGenerationRaw(raw), raw);
      assert.equal(stripCodexImageGenerationRaw(raw), raw);
      const routed = patchFireconnectRoutingRaw(raw, ROUTING);
      assert.ok(stripFireconnectRoutingRaw(routed, { stripRootRouting: true }).endsWith(raw));
    });
  }

  it("keeps the existing table when its only added key is removed", () => {
    assert.equal(stripCodexImageGenerationRaw(patchCodexImageGenerationRaw("[features]\n")), "[features]\n");
  });

  it("keeps user edits to a marked value and other keys in a created table", () => {
    const patched = patchCodexImageGenerationRaw("");
    assert.equal(parseToml(stripCodexImageGenerationRaw(patched.replace("= false", "= true"))).tables.features.image_generation, true);
    const edited = stripCodexImageGenerationRaw(`${patched}other = true\n`);
    assert.deepEqual(parseToml(edited).tables.features, { other: true });
  });

  it("leaves no marker on a kept table or an edited value", () => {
    for (const raw of ["", "features = { other = true }\n", "features.other = true\n"]) {
      const patched = patchCodexImageGenerationRaw(raw);
      const trailing = patched.replace(/# nexus: image_generation\n/g, "# nexus: image_generation  \t\n");
      for (const edited of [patched.replace("= false", "= true"), trailing.replace("= false", "= true"), `${patched}other2 = true\n`]) {
        const stripped = stripCodexImageGenerationRaw(edited);
        assert.ok(!stripped.includes("# nexus: image_generation"), JSON.stringify(stripped));
        const expected = parseToml(edited);
        if (expected.tables.features.image_generation === false) delete expected.tables.features.image_generation;
        assert.deepEqual(parseToml(stripped), expected);
      }
    }
  });

  it("does not interpret multiline string contents as feature markers", () => {
    const raw = 'note = """\n[features] # nexus: image_generation\nimage_generation = false # nexus: image_generation\n"""\n';
    const patched = patchCodexImageGenerationRaw(raw);
    assert.equal(parseToml(patched).root.note, parseToml(raw).root.note);
    assert.equal(parseToml(stripCodexImageGenerationRaw(patched)).root.note, parseToml(raw).root.note);
  });

  it("rejects invalid TOML without returning a partial patch", () => {
    assert.throws(() => patchCodexImageGenerationRaw("[features\n"));
  });

  it("leaves a non-table features value untouched", () => {
    assert.equal(patchCodexImageGenerationRaw("features = false\n"), "features = false\n");
  });

  for (const fallback of [false, true]) {
    it(`${fallback ? "fallback off removes only owned defaults" : "snapshot off restores bytes"}`, async () => {
      await withTempHome("codex-image-generation-", async (home) => {
        const previousHome = process.env.HOME;
        process.env.HOME = home;
        try {
          const configPath = codexConfigPath(home);
          const dataDir = codexDataDir(home);
          for (const original of [
            "# user config\n[features]\nother = true # keep\n",
            "[features]\nimage_generation = true\n",
            "[features]\nimage_generation = false\n",
            'features = { other = true } # keep\n',
            "# no features\n[tui]\nanimations = false\n",
          ]) {
            await mkdir(path.dirname(configPath), { recursive: true });
            await writeFile(configPath, original);
            const options = { configPath, dataDir, apiKey: "example-api-key", modelId: "auto" };
            await enableCodexFireworks(options);
            const first = await readFile(configPath, "utf8");
            await enableCodexFireworks(options);
            assert.equal(await readFile(configPath, "utf8"), first);
            if (fallback) await unlink(codexBackupPath(dataDir, configPath));
            await disableCodexFireworks({ configPath, dataDir });
            const restored = await readFile(configPath, "utf8");
            if (fallback) assert.deepEqual(parseToml(restored), parseToml(original));
            else assert.equal(restored, original);
          }
        } finally {
          if (previousHome === undefined) delete process.env.HOME;
          else process.env.HOME = previousHome;
        }
      });
    });
  }
});
