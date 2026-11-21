import { HARNESS } from "../harness/id.mjs";
import { readLocalVersion } from "../system/version.mjs";

export const FIRECONNECT_TELEMETRY_HEADER_NAMES = Object.freeze([
  "x-firerouter-harness",
  "x-title",
  "fireworks-use-case",
  "http-referer",
]);

const MANAGED_NAMES = new Set(FIRECONNECT_TELEMETRY_HEADER_NAMES);
const VERSION_PATTERN = /\bv?(\d+\.\d+\.\d+)\b/;
const HARNESS_TITLES = Object.freeze({
  [HARNESS.CLAUDE]: "Claude Code",
  [HARNESS.CLAUDE_DESKTOP]: "Claude Desktop",
  [HARNESS.OPENCODE]: "OpenCode",
  [HARNESS.CODEX]: "Codex",
  [HARNESS.PI]: "Pi",
  [HARNESS.VSCODE]: "VS Code Chat",
  [HARNESS.COPILOT_APP]: "GitHub Copilot",
  [HARNESS.COPILOT_CLI]: "GitHub Copilot CLI",
  [HARNESS.DEEPSEEK]: "DeepSeek Harness",
  [HARNESS.HERMES]: "Hermes Agent",
});

function normalizedVersion(value) {
  return String(value ?? "").match(VERSION_PATTERN)?.[1] ?? "";
}

export function buildFireconnectTelemetryHeaders(
  harnessId,
  { fireconnectVersion = readLocalVersion() } = {},
) {
  const harnessTitle = HARNESS_TITLES[harnessId];
  if (!harnessTitle) {
    throw new Error(`No request attribution title configured for harness: ${harnessId}`);
  }
  return {
    "X-Title": harnessTitle,
    "HTTP-Referer": telemetryReferer(fireconnectVersion),
  };
}

/**
 * The `HTTP-Referer` value that identifies this CLI's traffic to the gateway.
 * @param {string} [version]
 */
export function telemetryReferer(version = readLocalVersion()) {
  const safeVersion = normalizedVersion(version);
  return `nexus/${safeVersion ? `v${safeVersion}` : "unknown"}`;
}

const LEGACY_REFERER = /(?<![\w/.-])(?:fireconnect\/(?:unknown|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)|nexus\/unknown)(?![\w.-])/g;

/**
 * Replace pre-rename `fireconnect/v<version>` referer values baked into a
 * harness config with the current one. Format-agnostic: the value is unique
 * to this CLI wherever it appears (JSON, TOML, or header lines).
 * @param {string} text
 */
export function retargetLegacyReferer(text) {
  return text.replace(LEGACY_REFERER, telemetryReferer());
}

function isLegacyFireconnectUserAgent(name, value) {
  return name.toLowerCase() === "user-agent"
    && /^(?:fireconnect|nexus)\/(?:unknown|\d+\.\d+\.\d+)$/i.test(String(value).trim());
}

const ATTRIBUTION_REFERER = /^(?:nexus|fireconnect)\/(?:unknown|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;

/**
 * Whether a header map carries this CLI's own attribution: the
 * `HTTP-Referer` value {@link telemetryReferer} writes (or its pre-rename
 * `fireconnect/` form), or a legacy CLI `User-Agent`. Header names alone
 * are generic (any client can send `X-Title`); these values are unique to
 * this CLI, so they mark a provider entry Nexus wrote.
 * @param {unknown} headers
 */
export function hasFireconnectAttributionHeader(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return false;
  }
  return Object.entries(headers).some(([name, value]) => (
    name.toLowerCase() === "http-referer"
      && typeof value === "string"
      && ATTRIBUTION_REFERER.test(value.trim())
  ) || isLegacyFireconnectUserAgent(name, value));
}

export function stripFireconnectTelemetryHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => !MANAGED_NAMES.has(name.toLowerCase())
        && !isLegacyFireconnectUserAgent(name, value),
    ),
  );
}

export function mergeFireconnectTelemetryHeaders(existing = {}, telemetry = {}) {
  return {
    ...stripFireconnectTelemetryHeaders(existing),
    ...telemetry,
  };
}

export function stripFireconnectTelemetryHeaderLines(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .split("\n")
    .filter((line) => {
      const colon = line.indexOf(":");
      const name = colon === -1 ? "" : line.slice(0, colon).trim().toLowerCase();
      const headerValue = colon === -1 ? "" : line.slice(colon + 1).trim();
      return line.trim()
        && !MANAGED_NAMES.has(name)
        && !isLegacyFireconnectUserAgent(name, headerValue);
    })
    .join("\n");
}

/**
 * Whether an ANTHROPIC_CUSTOM_HEADERS value has a telemetry line this CLI
 * writes. Blank lines and user headers are not telemetry.
 * @param {unknown} value
 */
export function hasFireconnectTelemetryHeaderLine(value) {
  if (typeof value !== "string") {
    return false;
  }
  return value.split("\n").some((line) => {
    const colon = line.indexOf(":");
    if (colon === -1) {
      return false;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    return MANAGED_NAMES.has(name)
      || isLegacyFireconnectUserAgent(name, line.slice(colon + 1).trim());
  });
}

export function mergeFireconnectTelemetryHeaderLines(value, telemetry = {}) {
  const managed = Object.entries(telemetry)
    .map(([name, headerValue]) => `${name}: ${headerValue}`)
    .join("\n");
  return [managed, stripFireconnectTelemetryHeaderLines(value)]
    .filter(Boolean)
    .join("\n");
}
