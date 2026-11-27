/**
 * Lightweight custom-header parsing shared by FireRouter and the Claude
 * status-line hot path. Zero non-builtin dependencies.
 */

export const FIREROUTER_FIREWORKS_HEADER = "X-Fireworks-Api-Key";

/**
 * Extract the first matching header line's value from an ANTHROPIC_CUSTOM_HEADERS
 * string (case-insensitive on the header name). Returns "" when absent.
 * @param {unknown} value
 * @param {string[]} headerNames
 * @returns {string}
 */
export function customHeaderValue(value, headerNames) {
  if (typeof value !== "string") {
    return "";
  }
  const wanted = headerNames.map((name) => name.toLowerCase());
  for (const line of value.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (wanted.includes(name)) {
      return line.slice(colon + 1).trim();
    }
  }
  return "";
}

/**
 * Extract the Fireworks API key from an ANTHROPIC_CUSTOM_HEADERS string.
 * @param {unknown} value
 * @returns {string}
 */
export function fireworksKeyFromCustomHeaders(value) {
  return customHeaderValue(value, [FIREROUTER_FIREWORKS_HEADER]);
}
