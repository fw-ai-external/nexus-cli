#!/usr/bin/env node

/**
 * Detached credit-standing cache refresher spawned by the Claude status-line
 * helper (see lib/harnesses/claude/statusline-refresh.mjs). Refreshes the
 * Nexus plan usage and account credit-standing cache through the shared loader,
 * then exits. Best-effort by design: the helper already printed, failures keep
 * any valid cache intact behind the refresh lock, and nothing here writes to
 * stdio.
 */

import "../lib/system/legacy-env.mjs";
import process from "node:process";

import {
  CREDIT_STANDING_DEFAULT_GATEWAY_URL,
  refreshCreditStandingCache,
} from "../lib/fireworks/credit-standing.mjs";
import { resolveRunnerGatewayUrl } from "../lib/harnesses/claude/statusline-refresh.mjs";

function parseLockToken(argv) {
  const index = argv.indexOf("--lock-token");
  return index >= 0 && typeof argv[index + 1] === "string" ? argv[index + 1].trim() : "";
}

function parseLockKeyFingerprint(argv) {
  if (argv.includes("--lock-unscoped")) return "";
  const index = argv.indexOf("--lock-scope");
  return index >= 0 && typeof argv[index + 1] === "string" ? argv[index + 1].trim() : undefined;
}

if (process.env.NEXUS_TEST === "1" && process.env.NEXUS_CREDIT_REFRESH_IN_TEST !== "1") {
  process.exit(0);
}

const cliArgs = process.argv.slice(2);
await refreshCreditStandingCache({
  home: process.env.HOME || process.env.USERPROFILE || "",
  env: process.env,
  gatewayUrl: resolveRunnerGatewayUrl(process.env, {
    testOptInEnv: "NEXUS_CREDIT_REFRESH_IN_TEST",
    defaultGatewayUrl: CREDIT_STANDING_DEFAULT_GATEWAY_URL,
  }),
  lockToken: parseLockToken(cliArgs),
  lockKeyFingerprint: parseLockKeyFingerprint(cliArgs),
}).catch(() => {});
