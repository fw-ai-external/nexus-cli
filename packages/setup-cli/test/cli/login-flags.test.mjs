import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loginFlagConflict } from "../../lib/cli/commands/login.mjs";
import { runJsonCommand } from "../../lib/auth/login/output.mjs";

describe("nexus login flag combinations", () => {
  it("refuses --paste everywhere, and API-key sign-in at a terminal", () => {
    assert.match(loginFlagConflict({ paste: true }, { tty: false }), /--paste: pasting an API key at a terminal isn't supported/);
    assert.match(loginFlagConflict({ withToken: true }, { tty: true }), /--with-token: at a terminal, sign in through your browser/);
    assert.match(loginFlagConflict({ apiKeyFromFlag: true }, { tty: true }), /--api-key: at a terminal/);
  });

  it("allows API-key sign-in without a terminal (CI, scripts)", () => {
    assert.equal(loginFlagConflict({ withToken: true }, { tty: false }), "");
    assert.equal(loginFlagConflict({ apiKeyFromFlag: true }, { tty: false }), "");
  });

  it("rejects --browser with a flag that picks another sign-in", () => {
    assert.match(loginFlagConflict({ browser: true, account: "acme" }, { tty: true }), /--browser can't be combined with --account/);
    assert.match(loginFlagConflict({ browser: true, withToken: true }, { tty: false }), /--browser can't be combined with --with-token/);
    assert.match(loginFlagConflict({ browser: true, apiKeyFromFlag: true }, { tty: false }), /--api-key/);
  });

  it("rejects browser-only flags without --browser", () => {
    assert.match(loginFlagConflict({ selectAccount: "acme" }, { tty: true }), /--select-account only works with nexus login --browser/);
    assert.match(loginFlagConflict({ noOpen: true, signup: true }, { tty: true }), /--no-open, --signup only work with/);
  });

  it("allows the combinations the desktop app and people use", () => {
    assert.equal(loginFlagConflict({ browser: true, json: true, noOpen: true, force: true, selectAccount: "acme", signup: true }, { tty: false }), "");
    assert.equal(loginFlagConflict({ account: "acme" }, { tty: true }), "");
    assert.equal(loginFlagConflict({}, { tty: true }), "");
  });
});

describe("runJsonCommand result line", () => {
  it("writes no result when the caller already answered", async (t) => {
    const lines = [];
    t.mock.method(process.stdout, "write", (chunk) => { lines.push(String(chunk)); return true; });
    const exitCode = process.exitCode;
    try {
      await runJsonCommand(async () => ({ ok: true }), { claimResult: () => false });
      await runJsonCommand(async () => ({ ok: true }));
    } finally {
      process.exitCode = exitCode;
    }
    assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ type: "result", ok: true }]);
  });
});
