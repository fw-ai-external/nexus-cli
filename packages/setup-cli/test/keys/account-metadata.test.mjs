import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { withTempHome } from "../helpers.mjs";
import { readGlobalConfig } from "../../lib/config/global-config.mjs";
import { persistApiKeyToKeychain, persistApiKeyFromFlag, keysUrlForHome, NEXUS_KEYS_URL, FIREWORKS_KEYS_URL } from "../../lib/keys/api-key.mjs";
import { getSecret, resetSecretStoreForTests } from "../../lib/keys/secret-store.mjs";
import { secretsFilePath } from "../../lib/keys/builtin-file-secret-store.mjs";
import { readMintedKeyState, writeMintedKeyState } from "../../lib/keys/mint-api-key.mjs";
import { storeApiKey } from "../../lib/auth/login/output.mjs";

it("credential replacement never inherits kind; idempotent config repair retains kind and minted state", async () => {
  await withTempHome("account-metadata-", async (home) => {
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const key = "fw_metadata_test_00000000000000000";
      await storeApiKey(home, key, "nexus");
      assert.equal(await keysUrlForHome(home), NEXUS_KEYS_URL);
      await writeMintedKeyState(home, { keyId: "minted-1", userName: "accounts/test/users/test", displayName: "test" });
      await persistApiKeyToKeychain(home, key);
      assert.equal((await readGlobalConfig(home)).nexusAccount, true);
      assert.equal((await readMintedKeyState(home)).keyId, "minted-1");
      // Explicit same-key metadata updates, unlike incidental config repair.
      await storeApiKey(home, key, "platform");
      assert.equal(await keysUrlForHome(home), FIREWORKS_KEYS_URL);
      assert.equal((await readMintedKeyState(home)).keyId, "minted-1");
      await storeApiKey(home, key, "nexus");
      await persistApiKeyToKeychain(home, "fw_metadata_replacement_000000000000");
      assert.equal((await readGlobalConfig(home)).accountType, "unknown");
      assert.equal(await keysUrlForHome(home), NEXUS_KEYS_URL);
      assert.equal(await readMintedKeyState(home), null);
      await storeApiKey(home, key, "nexus");
      await storeApiKey(home, key, "platform");
      await storeApiKey(home, key); // omitted login metadata is explicitly unknown
      assert.equal((await readGlobalConfig(home)).accountType, "unknown");
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});

it("a sign-in that stored its key but failed later drops the replaced key's minted record on rerun", async () => {
  await withTempHome("account-metadata-stale-mint-", async (home) => {
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const minted = "fw_metadata_minted_0000000000000000";
      const pasted = "fw_metadata_pasted_0000000000000000";
      await persistApiKeyToKeychain(home, minted, { onNote: () => {} });
      await writeMintedKeyState(home, { keyId: "minted-1", userName: "accounts/test/users/test", displayName: "test", apiKey: minted });
      const configPath = path.join(home, ".nexus", "config.json");
      const config = await readFile(configPath, "utf8");
      await writeFile(configPath, "{");
      await assert.rejects(persistApiKeyToKeychain(home, pasted, { onNote: () => {} }), /not valid JSON/);
      await writeFile(configPath, config);
      await persistApiKeyToKeychain(home, pasted, { onNote: () => {} });
      // `logout` would otherwise offer to revoke a key this machine no longer holds.
      assert.equal(await readMintedKeyState(home), null);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});

it("a pasted key that fails after it is stored puts the previous key and its minted record back", async () => {
  await withTempHome("account-metadata-paste-rollback-", async (home) => {
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const minted = "fw_metadata_minted_0000000000000000";
      const pasted = "fw_metadata_pasted_0000000000000000";
      await persistApiKeyToKeychain(home, minted, { onNote: () => {} });
      await writeMintedKeyState(home, { keyId: "minted-1", userName: "accounts/test/users/test", displayName: "test", apiKey: minted });
      const configPath = path.join(home, ".nexus", "config.json");
      const config = await readFile(configPath, "utf8");
      await writeFile(configPath, "{");
      await assert.rejects(persistApiKeyToKeychain(home, pasted, { onNote: () => {} }), /not valid JSON/);
      assert.equal(await getSecret(home), minted, "the previous key is still the stored one");
      // `logout` can still revoke the minted key this machine is using again.
      assert.equal((await readMintedKeyState(home))?.keyId, "minted-1");
      await writeFile(configPath, config);
      await persistApiKeyToKeychain(home, pasted, { onNote: () => {} });
      assert.equal(await getSecret(home), pasted);
      assert.equal(await readMintedKeyState(home), null);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});

it("a first --api-key that fails after it is stored leaves no key behind", async () => {
  await withTempHome("account-metadata-flag-rollback-", async (home) => {
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const flagKey = "fw_metadata_flag_00000000000000000";
      const configPath = path.join(home, ".nexus", "config.json");
      await mkdir(path.dirname(configPath), { recursive: true });
      await writeFile(configPath, "{");
      await assert.rejects(persistApiKeyFromFlag(home, flagKey, { onNote: () => {} }), /not valid JSON/);
      assert.equal(await getSecret(home), null);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });
});

it("a failed sign-in that could not read the previous key keeps the new one", async (t) => {
  await withTempHome("account-metadata-unread-rollback-", async (home) => {
    const saved = {
      HOME: process.env.HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      NEXUS_SECRET_STORE: process.env.NEXUS_SECRET_STORE,
      NEXUS_KEY_STORAGE: process.env.NEXUS_KEY_STORAGE,
    };
    process.env.HOME = home;
    process.env.XDG_DATA_HOME = path.join(home, "data");
    process.env.XDG_CONFIG_HOME = path.join(home, "config");
    process.env.NEXUS_KEY_STORAGE = "file";
    delete process.env.NEXUS_SECRET_STORE;
    resetSecretStoreForTests();
    const store = path.join(home, "data", "keyring", "secrets.json");
    try {
      await persistApiKeyToKeychain(home, "fw_metadata_unread_old_000000000000", { onNote: () => {} });
      // The store holding the previous key cannot be read, so nothing proves there was no key to delete.
      await chmod(store, 0);
      if (await readFile(store).then(() => true, () => false)) {
        t.skip("chmod does not block reads here (root or no POSIX permissions)");
        return;
      }
      resetSecretStoreForTests();
      await writeFile(path.join(home, ".nexus", "config.json"), "{");
      const pasted = "fw_metadata_unread_new_000000000000";
      await assert.rejects(persistApiKeyToKeychain(home, pasted, { onNote: () => {} }), /not valid JSON/);
      assert.equal(await getSecret(home, { fresh: true }), pasted, "a usable key is still stored");
    } finally {
      await chmod(store, 0o600).catch(() => {});
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetSecretStoreForTests();
    }
  });
});
