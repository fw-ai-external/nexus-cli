import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { writeFileSync, mkdirSync } from "node:fs";
import {
  accountUnsupportedResidency,
  activeAccountResidency,
  cachedAccountResidency,
  fetchAccountResidency,
  forgetAccountResidency,
  fireworksInferenceUrl,
  isFireworksInferenceUrl,
  recordedHarnessResidency,
  refreshAccountResidency,
  residencyInferenceHost,
  useAccountResidency,
} from "../../lib/fireworks/residency.mjs";

const GLOBAL_V1 = "https://api.fireworks.ai/inference/v1";

/**
 * Run `fn` with the real lookup (NEXUS_TEST off), a stubbed gateway and HOME
 * pointed at a throwaway directory, so the residency cache stays inside it.
 */
async function withGateway({ policyStatus = 200, policy = {}, verifyStatus = 200, offline = false }, fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), "nexus-residency-"));
  const previous = {
    fetch: globalThis.fetch,
    NEXUS_TEST: process.env.NEXUS_TEST,
    NEXUS_GATEWAY_URL: process.env.NEXUS_GATEWAY_URL,
    HOME: process.env.HOME,
    NEXUS_CACHE_DIR: process.env.NEXUS_CACHE_DIR,
  };
  const requests = [];
  process.env.NEXUS_TEST = "0";
  process.env.NEXUS_GATEWAY_URL = "https://gateway.example";
  process.env.HOME = home;
  delete process.env.NEXUS_CACHE_DIR;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), authorization: init?.headers?.Authorization });
    if (offline) throw new TypeError("fetch failed");
    if (String(url).endsWith("/verifyApiKey")) {
      return new Response("", { status: verifyStatus, headers: { "x-fireworks-account-id": "acme" } });
    }
    return new Response(JSON.stringify(policy), { status: policyStatus });
  };
  try {
    return await fn(requests);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of Object.entries(previous)) {
      if (key === "fetch") continue;
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
    forgetAccountResidency();
  }
}

describe("fireworksInferenceUrl", () => {
  test("moves a global Fireworks URL to the residency's regional host", () => {
    assert.equal(fireworksInferenceUrl(GLOBAL_V1, "US"), "https://us.api.fireworks.ai/inference/v1");
  });

  test("leaves the global URL alone without residency", () => {
    assert.equal(fireworksInferenceUrl(GLOBAL_V1, ""), GLOBAL_V1);
  });

  test("never rewrites a URL that isn't the global Fireworks endpoint", () => {
    assert.equal(fireworksInferenceUrl("https://acme.openai.azure.com/openai/v1", "US"), "https://acme.openai.azure.com/openai/v1");
    assert.equal(fireworksInferenceUrl("https://api.fireworks.ai.evil.example/v1", "US"), "https://api.fireworks.ai.evil.example/v1");
  });

  test("uses the residency set for the process when none is passed", () => {
    useAccountResidency("US");
    try {
      assert.equal(fireworksInferenceUrl(GLOBAL_V1), "https://us.api.fireworks.ai/inference/v1");
    } finally {
      useAccountResidency("");
    }
  });
});

describe("isFireworksInferenceUrl", () => {
  test("accepts the global and every regional form of the same URL", () => {
    assert.equal(isFireworksInferenceUrl(GLOBAL_V1, GLOBAL_V1), true);
    assert.equal(isFireworksInferenceUrl("https://us.api.fireworks.ai/inference/v1", GLOBAL_V1), true);
  });

  test("rejects other paths, other hosts and non-strings", () => {
    assert.equal(isFireworksInferenceUrl("https://us.api.fireworks.ai/inference", GLOBAL_V1), false);
    assert.equal(isFireworksInferenceUrl("https://acme.openai.azure.com/inference/v1", GLOBAL_V1), false);
    assert.equal(isFireworksInferenceUrl(undefined, GLOBAL_V1), false);
  });
});

describe("residencyInferenceHost", () => {
  test("names the regional host, or nothing for the global endpoint", () => {
    assert.equal(residencyInferenceHost("US"), "us.api.fireworks.ai");
    assert.equal(residencyInferenceHost(""), "");
  });
});

describe("fetchAccountResidency", () => {
  test("reads the residency from the account's policy settings", async () => {
    await withGateway({ policy: { residency: "US" } }, async (requests) => {
      assert.equal(await fetchAccountResidency("fw_key"), "US");
      assert.equal(requests[1].url, "https://gateway.example/v1/accounts/acme/policySettings");
      assert.equal(requests[1].authorization, "Bearer fw_key");
    });
  });

  test("answers no residency for an account without a policy row or residency", async () => {
    await withGateway({ policyStatus: 404 }, async () => {
      assert.equal(await fetchAccountResidency("fw_key"), "");
    });
    await withGateway({ policy: { rules: [] } }, async () => {
      assert.equal(await fetchAccountResidency("fw_key"), "");
    });
  });

  test("treats GLOBAL and an unspecified region as no residency", async () => {
    await withGateway({ policy: { residency: "GLOBAL" } }, async () => {
      assert.equal(await fetchAccountResidency("fw_key"), "");
    });
    await withGateway({ policy: { residency: "MULTI_REGION_UNSPECIFIED" } }, async () => {
      assert.equal(await fetchAccountResidency("fw_key"), "");
    });
  });

  test("answers unknown for a region Nexus can't set up, and names it", async () => {
    await withGateway({ policy: { residency: "EUROPE" } }, async () => {
      assert.equal(await fetchAccountResidency("fw_key"), null);
      assert.equal(accountUnsupportedResidency(), "EUROPE");
    });
  });

  test("skips the key check when the account is already known", async () => {
    await withGateway({ policy: { residency: "US" } }, async (requests) => {
      assert.equal(await fetchAccountResidency("fw_key", { accountId: "acme" }), "US");
      assert.deepEqual(requests.map((r) => r.url), ["https://gateway.example/v1/accounts/acme/policySettings"]);
    });
  });

  test("answers null without a request when the lookup is turned off", async () => {
    process.env.NEXUS_RESIDENCY_LOOKUP = "0";
    try {
      await withGateway({ policy: { residency: "US" } }, async (requests) => {
        assert.equal(await fetchAccountResidency("fw_key"), null);
        assert.equal(requests.length, 0);
      });
    } finally {
      delete process.env.NEXUS_RESIDENCY_LOOKUP;
    }
  });

  test("answers null when the policy can't be read", async () => {
    await withGateway({ policyStatus: 403 }, async () => {
      assert.equal(await fetchAccountResidency("fw_key"), null);
    });
    await withGateway({ verifyStatus: 401 }, async () => {
      assert.equal(await fetchAccountResidency("fw_key"), null);
    });
    await withGateway({ offline: true }, async () => {
      assert.equal(await fetchAccountResidency("fw_key"), null);
    });
  });
});

describe("refreshAccountResidency", () => {
  test("stores the residency it read and uses it for inference URLs", async () => {
    await withGateway({ policy: { residency: "US" } }, async () => {
      assert.equal(await refreshAccountResidency("fw_key"), "US");
      assert.equal(cachedAccountResidency("fw_key"), "US");
      assert.equal(fireworksInferenceUrl(GLOBAL_V1), "https://us.api.fireworks.ai/inference/v1");
    });
  });

  test("keeps the stored residency when a later lookup fails", async () => {
    await withGateway({ policy: { residency: "US" } }, async () => {
      await refreshAccountResidency("fw_key");
      globalThis.fetch = async () => {
        throw new TypeError("fetch failed");
      };
      assert.equal(await refreshAccountResidency("fw_key"), "US");
    });
  });

  test("answers unknown (null) when the lookup fails and nothing is stored for this key", async () => {
    await withGateway({ offline: true }, async () => {
      assert.equal(await refreshAccountResidency("fw_key"), null);
      assert.equal(cachedAccountResidency("fw_other"), null);
    });
  });
});

describe("unsupported residency", () => {
  test("is not cached, and a cached answer doesn't stand in for it", async () => {
    await withGateway({ policy: { residency: "US" } }, async () => {
      assert.equal(await refreshAccountResidency("fw_key"), "US");
    });
    await withGateway({ policy: { residency: "EUROPE" } }, async () => {
      assert.equal(await refreshAccountResidency("fw_key"), null);
      assert.equal(cachedAccountResidency("fw_key"), null);
    });
  });
});

describe("NEXUS_RESIDENCY_LOOKUP=0", () => {
  test("leaves the residency unknown even with a cached answer", async () => {
    await withGateway({ policy: { residency: "US" } }, async () => {
      assert.equal(await refreshAccountResidency("fw_key"), "US");
      process.env.NEXUS_RESIDENCY_LOOKUP = "0";
      try {
        forgetAccountResidency();
        assert.equal(await refreshAccountResidency("fw_key"), null);
        assert.equal(activeAccountResidency("pi"), "");
      } finally {
        delete process.env.NEXUS_RESIDENCY_LOOKUP;
      }
    });
  });
});

describe("recorded residency fallback", () => {
  function recordHarnesses(home, harnesses) {
    mkdirSync(path.join(home, ".nexus"), { recursive: true });
    writeFileSync(path.join(home, ".nexus", "config.json"), JSON.stringify({ harnesses }));
  }

  test("without a lookup, a harness keeps the residency it was set up for", async () => {
    await withGateway({ offline: true }, async () => {
      recordHarnesses(process.env.HOME, { pi: { enabled: true, provider: "fireworks", residency: "US" }, opencode: { enabled: true } });
      forgetAccountResidency();
      assert.equal(recordedHarnessResidency("pi"), "US");
      assert.equal(activeAccountResidency("pi"), "US");
      assert.equal(activeAccountResidency("opencode"), "");
      assert.equal(fireworksInferenceUrl(GLOBAL_V1, activeAccountResidency("pi")), "https://us.api.fireworks.ai/inference/v1");
    });
  });

  test("a harness never borrows another harness's recorded residency", async () => {
    await withGateway({ offline: true }, async () => {
      recordHarnesses(process.env.HOME, { pi: { enabled: true, residency: "US" }, deepseek: { enabled: true } });
      forgetAccountResidency();
      assert.equal(activeAccountResidency("deepseek"), "");
      assert.equal(activeAccountResidency(), "");
      assert.equal(fireworksInferenceUrl(GLOBAL_V1, activeAccountResidency("deepseek")), GLOBAL_V1);
    });
  });

  test("an unknown lookup leaves the recorded fallback in place", async () => {
    await withGateway({ offline: true }, async () => {
      recordHarnesses(process.env.HOME, { pi: { enabled: true, residency: "US" } });
      forgetAccountResidency();
      assert.equal(await refreshAccountResidency("fw_key"), null);
      assert.equal(activeAccountResidency("pi"), "US");
    });
  });

  test("a lookup that succeeds wins over the recorded residency", async () => {
    await withGateway({ policyStatus: 404 }, async () => {
      recordHarnesses(process.env.HOME, { pi: { enabled: true, residency: "US" } });
      forgetAccountResidency();
      assert.equal(await refreshAccountResidency("fw_key"), "");
      assert.equal(activeAccountResidency("pi"), "");
    });
  });
});
