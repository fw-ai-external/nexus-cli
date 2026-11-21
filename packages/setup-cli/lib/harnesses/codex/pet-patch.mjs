/**
 * The Fireworks symbol as Codex's terminal pet: `[tui] pet = "custom:<id>"`,
 * pointing at the sprite sheet Nexus installs under `$CODEX_HOME/pets/<id>/`.
 *
 * Same contract as the image-generation patch: every line Nexus adds carries a
 * `# nexus: pet` marker so `off` removes exactly those lines, and a user's own
 * pet choice (any `tui.pet`, or a `tui` inline table we can't extend safely) is
 * left alone.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canInstallOwnedDir, installOwnedDir, removeOwnedDir } from "../../harness/owned-asset-dir.mjs";
import { statements } from "./feature-patch.mjs";
import { parseToml } from "./toml.mjs";

export const CODEX_PET_ID = "fireworks-nexus";
export const CODEX_PET_SELECTOR = `custom:${CODEX_PET_ID}`;

const MARKER = "# nexus: pet";
const VALUE = `pet = "${CODEX_PET_SELECTOR}" ${MARKER}`;
const DOTTED_VALUE = `tui.${VALUE}`;
const TABLE_HEADER = `[tui] ${MARKER}`;
const INLINE_TUI = /^\s*tui\s*=\s*\{/;

const PET_ASSET_DIR = fileURLToPath(new URL("../../ui/brand/codex-pet/", import.meta.url));
const PET_ASSET_FILES = ["pet.json", "spritesheet.png"];


/** `$CODEX_HOME/pets/<id>` for the config at `configPath`. */
export function codexPetDir(configPath) {
  return path.join(path.dirname(configPath), "pets", CODEX_PET_ID);
}

/**
 * Copy the pet manifest and sprite sheet next to the config. Runs after the
 * config write, so a pet folder only exists while Nexus routes Codex (`off`
 * and `uninstall` find it). Codex hides a selected pet whose files are missing
 * or invalid (no error), so a failed copy degrades to "no pet" and the next
 * `on` retries. Best effort: never fails `on`.
 * @param {string} configPath
 */
export async function installCodexPet(configPath) {
  return installOwnedDir(codexPetDir(configPath), PET_ASSET_DIR, PET_ASSET_FILES, { recognize: isNexusPetDir });
}

/**
 * Whether Nexus may put its pet at `pets/fireworks-nexus` (nothing there, or
 * it's Nexus's own). A folder of the user's at that path means no pet: the
 * config must not select a folder Nexus didn't fill.
 * @param {string} configPath
 */
export function canInstallCodexPet(configPath) {
  return canInstallOwnedDir(codexPetDir(configPath), isNexusPetDir);
}

/** Whether the config text selects the Nexus pet. */
export function selectsCodexPet(raw) {
  try {
    return parseToml(raw).tables.tui?.pet === CODEX_PET_SELECTOR;
  } catch {
    return false;
  }
}

/** A pet folder an earlier build installed before the ownership marker. */
function isNexusPetDir(dir) {
  return JSON.parse(readFileSync(path.join(dir, "pet.json"), "utf8"))?.id === CODEX_PET_ID;
}

/**
 * Delete the installed pet, only if Nexus created its folder
 * (lib/harness/owned-asset-dir.mjs). `off` calls this before it restores the config,
 * so an `off` that stops partway never leaves a pet behind on a Codex that no
 * longer looks routed (nothing would remove it then). A failed delete throws,
 * so `off` stops with the config still routed and can be run again.
 * @param {string} configPath
 */
export async function removeCodexPet(configPath) {
  return removeOwnedDir(codexPetDir(configPath), { recognize: isNexusPetDir });
}

/**
 * Select the Nexus pet unless the user already chose one.
 * @param {string} raw config.toml text
 * @returns {string}
 */
export function patchCodexPetRaw(raw) {
  const doc = parseToml(raw);
  const tui = doc.tables.tui;
  if (tui && Object.hasOwn(tui, "pet")) {
    return raw;
  }
  const parts = statements(raw);
  let atRoot = true;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.header) {
      atRoot = false;
      if (Object.keys(part.doc.tables).length === 1 && Object.hasOwn(part.doc.tables, "tui")) {
        let end = i + 1;
        while (end < parts.length && !parts[end].header) end++;
        // Insert after the section's last non-blank statement, ahead of the
        // blank lines that separate it from the next table.
        while (end - 1 > i && !parts[end - 1].raw.trim()) end--;
        const last = parts[end - 1];
        last.raw = `${last.raw.replace(/\n?$/, "\n")}${VALUE}\n`;
        return checked(parts.map((entry) => entry.raw).join(""), raw);
      }
    } else if (atRoot && INLINE_TUI.test(part.raw)) {
      // An inline `tui = { ... }` table is closed: adding a key means
      // rewriting the user's line. Leave it; no pet is better than a mangled table.
      return raw;
    }
  }
  if (tui) {
    // Defined by dotted keys or only by sub-tables: a dotted root key extends it.
    return checked(`${DOTTED_VALUE}\n${raw}`, raw);
  }
  return checked(`${raw}${raw.endsWith("\n") || !raw ? "" : "\n"}\n${TABLE_HEADER}\n${VALUE}\n`, raw);
}

/** The patched text if it still parses, else the original. */
function checked(next, raw) {
  try {
    parseToml(next);
    return next;
  } catch {
    return raw;
  }
}

/**
 * Remove exactly the lines {@link patchCodexPetRaw} added. A `[tui]` header we
 * added stays (minus its marker) if the user has since put keys under it.
 * @param {string} raw
 * @returns {string}
 */
export function stripCodexPetRaw(raw) {
  if (!raw.includes(MARKER)) {
    return raw;
  }
  const parts = statements(raw);
  for (const part of parts) {
    const trimmed = part.raw.trim();
    if (trimmed === VALUE || trimmed === DOTTED_VALUE) {
      part.raw = "";
    }
  }
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].raw.trim() !== TABLE_HEADER) continue;
    let end = i + 1;
    while (end < parts.length && !parts[end].header) end++;
    const body = parts.slice(i + 1, end);
    if (body.every((part) => part.raw.split("\n").every((line) => !line.trim() || line.trimStart().startsWith("#")))) {
      parts[i].raw = "";
      // Drop the blank separator line the patch put before the header.
      const previous = parts[i - 1];
      if (previous && !previous.raw.trim()) previous.raw = "";
    } else {
      parts[i].raw = parts[i].raw.replace(/[ \t]*# nexus: pet[ \t]*(\r?\n?)$/, "$1");
    }
  }
  return checked(parts.map((part) => part.raw).join(""), raw);
}
