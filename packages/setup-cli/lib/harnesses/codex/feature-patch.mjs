import { parseToml } from "./toml.mjs";

const VALUE_MARKER = "# nexus: image_generation";
const TABLE_MARKER = "[features] # nexus: image_generation";
const INLINE_MARKER = "# nexus: image_generation inline";
const KEY = `(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[A-Za-z0-9_-]+)`;
const INLINE_FEATURES = new RegExp(`^(\\s*${KEY}\\s*=\\s*\\{)`);

// Parse complete statements so table-like text in multiline strings stays data.
export function statements(raw) {
  const result = [];
  let pending = "";
  for (const line of raw.match(/[^\n]*(?:\n|$)/g).filter(Boolean)) {
    pending += line;
    try {
      const doc = parseToml(pending);
      result.push({ raw: pending, doc, header: pending.trimStart().startsWith("[") });
      pending = "";
    } catch {
      // A multiline value is not a complete TOML statement yet.
    }
  }
  if (pending) parseToml(pending);
  return result;
}

export function patchCodexImageGenerationRaw(raw) {
  const doc = parseToml(raw);
  if (Object.hasOwn(doc.tables.features ?? {}, "image_generation")
    || Object.hasOwn(doc.root, "features")) {
    return raw;
  }
  // Fireworks routing has no image-generation endpoint; respect explicit choices.
  const value = `image_generation = false ${VALUE_MARKER}\n`;
  const parts = statements(raw);
  let atRoot = true;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.header) {
      atRoot = false;
      if (Object.hasOwn(part.doc.tables, "features") && Object.keys(part.doc.tables).length === 1) {
        let end = i + 1;
        while (end < parts.length && !parts[end].header) end++;
        const previous = parts[end - 1];
        previous.raw = `${previous.raw.replace(/\n?$/, "\n")}${value}`;
        return parts.map((entry) => entry.raw).join("");
      }
    }
    if (atRoot && part.doc.tables.features && INLINE_FEATURES.test(part.raw)) {
      const separator = Object.keys(part.doc.tables.features).length ? ", " : "";
      part.raw = `${INLINE_MARKER}\n${part.raw.replace(INLINE_FEATURES, `$1image_generation = false${separator}`)}`;
      return parts.map((entry) => entry.raw).join("");
    }
  }
  if (doc.tables.features) {
    return `features.${value}${raw}`;
  }
  return `${raw}${raw.endsWith("\n") || !raw ? "" : "\n"}\n${TABLE_MARKER}\n${value}`;
}

export function stripCodexImageGenerationRaw(raw) {
  if (!raw.includes(VALUE_MARKER)) return raw;
  parseToml(raw);
  const parts = statements(raw);
  let inFeatures = false;
  let atRoot = true;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.header) {
      atRoot = false;
      inFeatures = Object.hasOwn(part.doc.tables, "features") && Object.keys(part.doc.tables).length === 1;
    }
    const value = inFeatures ? "image_generation" : (atRoot ? "features.image_generation" : "");
    if (value && part.raw.trim() === `${value} = false ${VALUE_MARKER}`) {
      part.raw = "";
    }
    if (atRoot && part.raw.trim() === INLINE_MARKER && parts[i + 1]) {
      const next = parts[i + 1];
      if (next.doc.tables.features?.image_generation === false && INLINE_FEATURES.test(next.raw)) {
        const patched = next.raw.replace(
          new RegExp(`^(\\s*${KEY}\\s*=\\s*\\{)image_generation = false(?:, )?`), "$1",
        );
        if (patched !== next.raw) {
          next.raw = patched;
          part.raw = "";
        }
      }
    }
  }
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].raw.trim() !== TABLE_MARKER) continue;
    let end = i + 1;
    while (end < parts.length && !parts[end].header) end++;
    if (parts.slice(i + 1, end).every((part) => part.raw.split("\n").every((line) => !line.trim() || line.trimStart().startsWith("#")))) {
      parts[i].raw = "";
    }
  }
  // `off` leaves no marker behind on a table or value the user kept or edited.
  inFeatures = false;
  for (const part of parts) {
    const features = Object.hasOwn(part.doc.tables, "features");
    if (part.header) inFeatures = features && Object.keys(part.doc.tables).length === 1;
    if (!/^[^\n]*\n?$/.test(part.raw)) continue;
    const trimmed = part.raw.trim();
    const owned = part.header ? inFeatures
      : (inFeatures ? Object.hasOwn(part.doc.root, "image_generation")
        : features && Object.hasOwn(part.doc.tables.features, "image_generation"));
    if (trimmed === VALUE_MARKER || trimmed === INLINE_MARKER) {
      part.raw = "";
    } else if (owned && trimmed.endsWith(` ${VALUE_MARKER}`)) {
      part.raw = part.raw.replace(/[ \t]*# nexus: image_generation[ \t]*(\r?\n?)$/, "$1");
    }
  }
  const stripped = parts.map((part) => part.raw).join("");
  parseToml(stripped);
  return stripped;
}
