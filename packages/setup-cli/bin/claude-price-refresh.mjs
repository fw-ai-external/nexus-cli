#!/usr/bin/env node

/**
 * Detached price-cache refresher spawned by the Claude status-line helper
 * (see lib/harnesses/claude/statusline-refresh.mjs). Warms the serverless
 * catalog and the models.dev list-price caches through the shared loaders,
 * then exits. Best-effort by design: the helper already printed, failures
 * only cost a retry next turn, and nothing here may write to stdio.
 */

import "../lib/system/legacy-env.mjs";
import process from "node:process";

import { FIREWORKS_GATEWAY_URL } from "../lib/fireworks/models.mjs";
import { refreshPriceCaches, resolveRunnerGatewayUrl } from "../lib/harnesses/claude/statusline-refresh.mjs";

if (process.env.NEXUS_TEST === "1" && process.env.NEXUS_PRICE_REFRESH_IN_TEST !== "1") {
  process.exit(0);
}

await refreshPriceCaches({
  home: process.env.HOME || process.env.USERPROFILE || "",
  env: process.env,
  gatewayUrl: resolveRunnerGatewayUrl(process.env, {
    testOptInEnv: "NEXUS_PRICE_REFRESH_IN_TEST",
    defaultGatewayUrl: FIREWORKS_GATEWAY_URL,
  }),
}).catch(() => {});
