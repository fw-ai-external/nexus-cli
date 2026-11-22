import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { enableCopilotFireworks, disableCopilotFireworks } from "../../../lib/harnesses/copilot-app/core.mjs";
import { recoverCopilotStubDatabase } from "../../../lib/harnesses/copilot-app/sqlite.mjs";
import { loadNodeSqlite } from "../../../lib/io/sqlite.mjs";
import { createCopilotDb, createCopilotStubDb } from "../../fixtures/copilot-db.mjs";
import { itIfSqlite, runCli, withTempHome } from "../../helpers.mjs";

function sql(dbPath, statement) {
  const result = spawnSync("sqlite3", [dbPath, statement], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function backupPaths(dbPath) {
  return readdirSync(path.dirname(dbPath))
    .filter((name) => name.startsWith(`${path.basename(dbPath)}.nexus-stub-`) && !/-(wal|shm)$/.test(name))
    .map((name) => path.join(path.dirname(dbPath), name));
}

describe("Copilot legacy stub recovery", () => {
  for (const verb of ["on", "off"]) {
    itIfSqlite(`${verb} preserves the stub and its sidecars in a timestamped backup`, async () => {
      await withTempHome("copilot-stub-cli-", async (home) => {
        const dbPath = path.join(home, ".copilot", "data.db");
        createCopilotStubDb(dbPath);
        writeFileSync(`${dbPath}-wal`, "synthetic WAL sidecar");
        writeFileSync(`${dbPath}-shm`, "synthetic SHM sidecar");
        const before = ["", "-wal", "-shm"].map((suffix) => readFileSync(`${dbPath}${suffix}`));
        const result = await runCli(["copilot-app", verb, "--force", "--db-path", dbPath], { home });
        assert.equal(result.code, verb === "on" ? 1 : 0, result.stderr);
        if (verb === "on") assert.match(result.stderr, /Open GitHub Copilot once/);
        else {
          assert.match(result.stdout, /Saved the uninitialized Copilot database/);
          assert.doesNotMatch(result.stdout, /nothing changed/);
        }
        const backups = backupPaths(dbPath);
        assert.equal(backups.length, 1);
        assert.match(path.basename(backups[0]), /\.nexus-stub-\d{4}-\d{2}-\d{2}T/);
        for (const [index, suffix] of ["", "-wal", "-shm"].entries()) {
          assert.equal(existsSync(`${dbPath}${suffix}`), false);
          assert.deepEqual(readFileSync(`${backups[0]}${suffix}`), before[index]);
        }
        const again = await runCli(["copilot-app", "off", "--force", "--db-path", dbPath], { home });
        assert.equal(again.code, 0, again.stderr);
        assert.deepEqual(backupPaths(dbPath), backups);
      });
    });
  }

  itIfSqlite("core on and off also recover a stub, never replacing an earlier backup", async () => {
    await withTempHome("copilot-stub-core-", async (home) => {
      const dbPath = path.join(home, "data.db");
      createCopilotStubDb(dbPath);
      await assert.rejects(enableCopilotFireworks({ dbPath, apiKey: "fw_TEST_NOT_A_REAL_KEY", force: true }), /Open GitHub Copilot once/);
      const [first] = backupPaths(dbPath);
      const original = readFileSync(first);
      createCopilotStubDb(dbPath);
      assert.equal(await disableCopilotFireworks({ dbPath, force: true }), "restored");
      assert.equal(backupPaths(dbPath).length, 2);
      assert.deepEqual(readFileSync(first), original);
      assert.equal(existsSync(dbPath), false);
    });
  });

  itIfSqlite("leaves an app-shaped database byte-for-byte untouched", async () => {
    await withTempHome("copilot-app-shaped-", async (home) => {
      const dbPath = path.join(home, "data.db");
      createCopilotDb(dbPath);
      const before = readFileSync(dbPath);
      assert.equal(await recoverCopilotStubDatabase(dbPath, { force: true }), "");
      assert.deepEqual(readFileSync(dbPath), before);
      assert.deepEqual(backupPaths(dbPath), []);
    });
  });

  itIfSqlite("reads app schema changes from a real WAL without modifying any original file", async (t) => {
    const DatabaseSync = await loadNodeSqlite();
    if (!DatabaseSync) {
      t.skip("node:sqlite is required to hold a WAL connection open");
      return;
    }
    await withTempHome("copilot-app-wal-", async (home) => {
      const dbPath = path.join(home, "data.db");
      createCopilotStubDb(dbPath);
      const db = new DatabaseSync(dbPath);
      try {
        db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; ALTER TABLE accounts ADD COLUMN parent_account_id TEXT;");
        const before = ["", "-wal", "-shm"].map((suffix) => readFileSync(`${dbPath}${suffix}`));
        assert.equal(await recoverCopilotStubDatabase(dbPath, { force: true }), "");
        for (const [index, suffix] of ["", "-wal", "-shm"].entries()) {
          assert.deepEqual(readFileSync(`${dbPath}${suffix}`), before[index]);
        }
        assert.deepEqual(backupPaths(dbPath), []);
      } finally {
        db.close();
      }
    });
  });

  for (const [shape, statement] of [
    ["non-empty accounts", "INSERT INTO accounts VALUES ('example-account');"],
    ["an extra app table", "CREATE TABLE app_state (id TEXT);"],
    ["an extra accounts column", "ALTER TABLE accounts ADD COLUMN parent_account_id TEXT;"],
    ["an extended provider schema", "ALTER TABLE model_providers ADD COLUMN app_setting TEXT;"],
    ["a user provider", "INSERT INTO model_providers (id, name) VALUES ('example-provider', 'Example provider');"],
    ["a differently cased user prefix", "INSERT INTO model_providers (id, name) VALUES ('FC-example-provider', 'Example provider');"],
    ["a user model", "INSERT INTO provider_models (id, provider_id, model_id, display_name) VALUES ('example-user-model', 'example-provider', 'example-model', 'Example model');"],
    ["an app view", "CREATE VIEW app_accounts AS SELECT * FROM accounts;"],
    ["an app index", "CREATE INDEX idx_accounts_parent ON accounts(id);"],
    ["an app trigger", "CREATE TRIGGER app_accounts AFTER INSERT ON accounts BEGIN SELECT 1; END;"],
  ]) {
    itIfSqlite(`never quarantines a database with ${shape}`, async () => {
      await withTempHome("copilot-app-data-", async (home) => {
        const dbPath = path.join(home, "data.db");
        createCopilotStubDb(dbPath);
        sql(dbPath, statement);
        const before = readFileSync(dbPath);
        assert.equal(await recoverCopilotStubDatabase(dbPath, { force: true }), "");
        assert.deepEqual(readFileSync(dbPath), before);
        assert.deepEqual(backupPaths(dbPath), []);
      });
    });
  }

  itIfSqlite("off keeps non-empty accounts while removing only Nexus provider rows", async () => {
    await withTempHome("copilot-stub-user-", async (home) => {
      const dbPath = path.join(home, "data.db");
      createCopilotStubDb(dbPath);
      sql(dbPath, "INSERT INTO accounts VALUES ('example-account');");
      assert.equal(await disableCopilotFireworks({ dbPath, force: true }), "restored");
      assert.equal(sql(dbPath, "SELECT id FROM accounts;"), "example-account");
      assert.deepEqual(backupPaths(dbPath), []);
    });
  });

  itIfSqlite("restores already-moved sidecars when the database rename fails", async () => {
    await withTempHome("copilot-stub-rename-", async (home) => {
      const dbPath = path.join(home, "data.db");
      createCopilotStubDb(dbPath);
      writeFileSync(`${dbPath}-wal`, "synthetic WAL sidecar");
      writeFileSync(`${dbPath}-shm`, "synthetic SHM sidecar");
      const before = ["", "-wal", "-shm"].map((suffix) => readFileSync(`${dbPath}${suffix}`));
      await assert.rejects(recoverCopilotStubDatabase(dbPath, {
        force: true,
        move: (source, destination) => {
          if (source === dbPath) throw new Error("database rename denied");
          renameSync(source, destination);
        },
      }), /database rename denied/);
      for (const [index, suffix] of ["", "-wal", "-shm"].entries()) {
        assert.deepEqual(readFileSync(`${dbPath}${suffix}`), before[index]);
      }
      assert.deepEqual(backupPaths(dbPath), []);
    });
  });

  itIfSqlite("preserves both copies' locations if a rollback rename also fails", async () => {
    await withTempHome("copilot-stub-rollback-", async (home) => {
      const dbPath = path.join(home, "data.db");
      createCopilotStubDb(dbPath);
      writeFileSync(`${dbPath}-wal`, "synthetic WAL sidecar");
      writeFileSync(`${dbPath}-shm`, "synthetic SHM sidecar");
      const original = readFileSync(dbPath);
      let backupWal = "";
      await assert.rejects(recoverCopilotStubDatabase(dbPath, {
        force: true,
        move: (source, destination) => {
          if (source === dbPath || destination === `${dbPath}-wal`) throw new Error("rename denied");
          if (source === `${dbPath}-wal`) backupWal = destination;
          renameSync(source, destination);
        },
      }), /Could not restore the Copilot database from/);
      assert.deepEqual(readFileSync(dbPath), original);
      assert.equal(readFileSync(backupWal, "utf8"), "synthetic WAL sidecar");
      assert.equal(readFileSync(`${dbPath}-shm`, "utf8"), "synthetic SHM sidecar");
    });
  });

  itIfSqlite("recovers a stub through the sqlite3 CLI fallback too", async () => {
    await withTempHome("copilot-stub-fallback-", async (home) => {
      const dbPath = path.join(home, "data.db");
      createCopilotStubDb(dbPath);
      const before = readFileSync(dbPath);
      const core = new URL("../../../lib/harnesses/copilot-app/core.mjs", import.meta.url).href;
      const result = spawnSync(process.execPath, ["--no-experimental-sqlite", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        const m = await import(${JSON.stringify(core)});
        assert.equal(await m.disableCopilotFireworks({ dbPath: process.argv[1], force: true }), 'restored');
      `, dbPath], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(dbPath), false);
      const [backup] = backupPaths(dbPath);
      assert.deepEqual(readFileSync(backup), before);
    });
  });

  it("leaves corrupt databases in place instead of guessing their ownership", async () => {
    await withTempHome("copilot-corrupt-", async (home) => {
      const dbPath = path.join(home, "data.db");
      writeFileSync(dbPath, "not a SQLite database");
      await assert.rejects(recoverCopilotStubDatabase(dbPath, { force: true }), /not a database/);
      assert.equal(readFileSync(dbPath, "utf8"), "not a SQLite database");
      assert.deepEqual(backupPaths(dbPath), []);
    });
  });
});
