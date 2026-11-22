import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { storedKeyMessage } from "../../lib/keys/storage-report.mjs";

describe("storedKeyMessage", () => {
  test("keychain: names the keychain and the harness config copies", () => {
    const message = storedKeyMessage({ backend: "keychain", label: "macOS Keychain" });
    assert.match(message, /OS keychain \(macOS Keychain\)/);
    assert.match(message, /Connected harnesses may also save it in their owner-only config files/);
    // Harness configs hold the literal key, so the message must not claim
    // that config files only reference it.
    assert.doesNotMatch(message, /only ever hold a reference/);
  });
});
