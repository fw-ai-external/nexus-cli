import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import http from "node:http";
import { runUpgradeCommand } from "../../lib/cli/commands/global.mjs";
import { withTempHome } from "../helpers.mjs";

import {
  downloadCliTarball,
  extractCliTarball,
  fetchLatestVersion,
  fetchLatestReleaseVersion,
  fetchPinnedRelease,
  LATEST_RELEASE_URL,
  releaseCommitUrl,
  isReleaseVersion,
} from "../../lib/system/tarball-update.mjs";

function setChecksum(header) {
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  return header;
}

// Hand-build minimal ustar entries so tests control the archive byte-for-byte
// (system `tar` refuses to create path-traversal entries).
function tarEntry(name, data = Buffer.alloc(0), type = "0") {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 99), 0, "utf8");
  header.write("0000644\0", 100, "utf8"); // mode
  header.write("0000000\0", 108, "utf8"); // uid
  header.write("0000000\0", 116, "utf8"); // gid
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "utf8"); // size
  header.write("00000000000\0", 136, "utf8"); // mtime
  header.write(type, 156, "utf8");
  header.write("ustar\0", 258, "utf8"); // magic
  setChecksum(header);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function gzipTarball(...entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function fakeFetchFor(bytes) {
  return async () => new Response(bytes);
}

describe("extractCliTarball", () => {
  async function withStaging(callback) {
    const staging = await mkdtemp(path.join(os.tmpdir(), "nexus-untar-"));
    try {
      await callback(staging);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  it("extracts files and directories, stripping the top-level prefix", async () => {
    await withStaging(async (staging) => {
      const archive = gzipTarball(
        tarEntry("nexus-cli-main/packages/setup-cli/bin/", Buffer.alloc(0), "5"),
        tarEntry("nexus-cli-main/packages/setup-cli/bin/nexus.mjs", Buffer.from("// cli\n")),
        tarEntry("nexus-cli-main/README.md", Buffer.from("readme\n")),
      );

      await extractCliTarball(archive, staging);

      assert.equal(await readFile(path.join(staging, "packages/setup-cli/bin/nexus.mjs"), "utf8"), "// cli\n");
      assert.equal(await readFile(path.join(staging, "README.md"), "utf8"), "readme\n");
    });
  });

  it("honors the ustar prefix field for long paths", async () => {
    await withStaging(async (staging) => {
      // name field holds the basename; the prefix field holds the directory.
      const data = Buffer.from("// p\n");
      const header = Buffer.alloc(512);
      header.write("nexus.mjs", 0, "utf8");
      header.write("0000644\0", 100, "utf8");
      header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "utf8");
      header.write("0", 156, "utf8");
      header.write("nexus-cli-main/packages/setup-cli/bin", 345, "utf8");
      setChecksum(header);
      const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
      const archive = gzipTarball(Buffer.concat([header, data, padding]));

      await extractCliTarball(archive, staging);

      assert.equal(await readFile(path.join(staging, "packages/setup-cli/bin/nexus.mjs"), "utf8"), "// p\n");
    });
  });

  it("refuses entries that escape the staging directory (tar-slip)", async () => {
    await withStaging(async (staging) => {
      const archive = gzipTarball(
        tarEntry("nexus-cli-main/packages/setup-cli/bin/nexus.mjs", Buffer.from("// ok\n")),
        tarEntry("nexus-cli-main/../evil.txt", Buffer.from("pwned\n")),
      );

      await assert.rejects(
        extractCliTarball(archive, staging),
        /Refusing to extract unsafe tar entry/,
      );
      assert.equal(existsSync(path.join(staging, "..", "evil.txt")), false);
    });
  });

  it("skips symlink entries instead of creating them", async () => {
    await withStaging(async (staging) => {
      const archive = gzipTarball(
        tarEntry("nexus-cli-main/packages/setup-cli/bin/nexus.mjs", Buffer.from("// ok\n")),
        tarEntry("nexus-cli-main/link", Buffer.from("/etc/passwd"), "2"),
      );

      await extractCliTarball(archive, staging);

      assert.equal(existsSync(path.join(staging, "link")), false);
      assert.equal(await readFile(path.join(staging, "packages/setup-cli/bin/nexus.mjs"), "utf8"), "// ok\n");
    });
  });
});

describe("fetchLatestVersion", () => {
  it("returns the remote package.json version", async () => {
    const version = await fetchLatestVersion({
      fetchImpl: async () => Response.json({ version: "1.2.3" }),
    });
    assert.equal(version, "1.2.3");
  });

  it("returns an empty string on HTTP failure, bad JSON, or network error", async () => {
    assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: false }) }), "");
    assert.equal(await fetchLatestVersion({ fetchImpl: async () => Response.json({}) }), "");
    assert.equal(
      await fetchLatestVersion({ fetchImpl: async () => { throw new Error("offline"); } }),
      "",
    );
  });
});

describe("downloadCliTarball", () => {
  it("downloads and extracts into an exclusively created private staging directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-download-"));
    try {
      const staging = path.join(root, "staging");

      const archive = gzipTarball(
        tarEntry("nexus-cli-main/packages/setup-cli/bin/nexus.mjs", Buffer.from("// downloaded\n")),
      );
      await downloadCliTarball(staging, { fetchImpl: fakeFetchFor(archive) });

      assert.equal(existsSync(path.join(staging, "stale")), false);
      if (process.platform !== "win32") assert.equal((await stat(staging)).mode & 0o777, 0o700);
      assert.equal(
        await readFile(path.join(staging, "packages/setup-cli/bin/nexus.mjs"), "utf8"),
        "// downloaded\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("throws on HTTP errors so callers can leave the install in place", async () => {
    await assert.rejects(
      downloadCliTarball("/tmp/should-not-exist-staging", {
        fetchImpl: async () => ({ ok: false, status: 502 }),
      }),
      /HTTP 502/,
    );
    assert.equal(existsSync("/tmp/should-not-exist-staging"), false);
  });
});

describe("commit-pinned updates", () => {
  const sha = "a".repeat(40);
  const metadataUrl = `https://raw.githubusercontent.com/fw-ai-external/nexus-cli/${sha}/packages/setup-cli/package.json`;
  const tarballUrl = `https://api.github.com/repos/fw-ai-external/nexus-cli/tarball/${sha}`;
  const commitUrl = releaseCommitUrl("v1.0.0");
  const releaseTag = "https://github.com/fw-ai-external/nexus-cli/releases/tag/v1.0.0";

  async function fixture(check, { location = releaseTag, commit = sha, status = 200, archiveCommit = sha, archiveVersion = "1.0.0", metadataVersion = "1.0.0", stall = false } = {}) {
    await withTempHome("pinned-update-", async (home) => {
      const requests = [];
      const archive = gzipTarball(
        tarEntry(`example-${archiveCommit.slice(0, 7)}/packages/setup-cli/package.json`, Buffer.from(JSON.stringify({ version: archiveVersion, dependencies: {} }))),
        tarEntry(`example-${archiveCommit.slice(0, 7)}/packages/setup-cli/package-lock.json`, Buffer.from("fixture-lock")),
        tarEntry(`example-${archiveCommit.slice(0, 7)}/packages/setup-cli/bin/nexus.mjs`, Buffer.from("replacement")),
      );
      const server = http.createServer((req, res) => {
        const target = new URL(req.url, "http://localhost").searchParams.get("target");
        requests.push({ url: target, accept: req.headers.accept, method: req.method });
        if (target === LATEST_RELEASE_URL) {
          res.writeHead(302, location ? { Location: location } : {});
          res.end();
        } else if (target === commitUrl) {
          res.writeHead(status);
          if (stall === "headers") return;
          if (stall) { res.write("a"); return; }
          res.end(commit);
        } else if (target.endsWith("package.json")) {
          res.end(JSON.stringify({ version: metadataVersion }));
        } else {
          res.end(archive);
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const fetchImpl = (url, options) => fetch(`http://127.0.0.1:${server.address().port}/?target=${encodeURIComponent(url)}`, options);
      const setup = path.join(home, ".nexus/cli/packages/setup-cli");
      await mkdir(path.join(setup, "bin"), { recursive: true });
      await writeFile(path.join(setup, "package.json"), JSON.stringify({ version: "0.9.0", dependencies: {} }));
      await writeFile(path.join(setup, "package-lock.json"), "fixture-lock");
      await writeFile(path.join(setup, "bin/nexus.mjs"), "original");
      const upgrade = (extra = {}) => runUpgradeCommand({
        home, fetchImpl, dataDirBlocked: () => false,
        preflight: async () => ({ proceed: true }), getClaudeAdapter: () => ({}),
        printBannerFn: () => {}, infoFn: () => {}, successFn: () => {},
        finalize: async () => {}, printNotes: async () => {}, runtimeDepsPresent: () => true,
        ...extra,
      });
      try { await check({ home, setup, fetchImpl, requests, upgrade }); }
      finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }

  it("resolves the newest Release's tag once and uses its commit for metadata and payload", async () => {
    await fixture(async ({ upgrade, requests, setup }) => {
      await upgrade();
      assert.deepEqual(requests.map((request) => request.url), [LATEST_RELEASE_URL, commitUrl, metadataUrl, tarballUrl]);
      assert.equal(requests[0].method, "HEAD");
      assert.equal(requests[1].accept, "application/vnd.github.sha");
      assert.equal(await readFile(path.join(setup, "bin/nexus.mjs"), "utf8"), "replacement");
    });
  });

  for (const commit of ["", "a".repeat(39), "a".repeat(41), "A".repeat(40), `${sha}\n`, ` ${sha}`, "not-a-commit"]) {
    it(`fails closed on malformed SHA ${JSON.stringify(commit)}`, async () => {
      await fixture(async ({ upgrade, requests, setup, home }) => {
        await assert.rejects(upgrade(), /could not check/);
        assert.deepEqual(requests.map((request) => request.url), [LATEST_RELEASE_URL, commitUrl]);
        assert.equal(await readFile(path.join(setup, "bin/nexus.mjs"), "utf8"), "original");
        assert.deepEqual(await readdir(path.join(home, ".nexus")), ["cli"]);
      }, { commit });
    });
  }

  for (const location of [
    "",
    "https://github.com/fw-ai-external/nexus-cli/releases",
    "https://github.com/fw-ai-external/nexus-cli/releases/tag/v1.0.0-beta.1",
    "https://github.com/fw-ai-external/nexus-cli/releases/tag/1.0.0",
    "https://github.com/someone/else/releases/tag/v1.0.0",
    "https://example.com/fw-ai-external/nexus-cli/releases/tag/v1.0.0",
    "https://github.com/fw-ai-external/nexus-cli/releases/tag/v1.0.0?x=1",
  ]) {
    it(`fails closed without a plain public Release (${JSON.stringify(location)})`, async () => {
      await fixture(async ({ upgrade, requests, setup, fetchImpl }) => {
        await assert.rejects(upgrade(), /could not check/);
        assert.deepEqual(requests.map((request) => request.url), [LATEST_RELEASE_URL]);
        assert.equal(await fetchLatestReleaseVersion({ fetchImpl }), "");
        assert.equal(await readFile(path.join(setup, "bin/nexus.mjs"), "utf8"), "original");
      }, { location });
    });
  }

  it("reads the newest Release's version for the update check, relative redirects included", async () => {
    await fixture(async ({ fetchImpl }) => {
      assert.equal(await fetchLatestReleaseVersion({ fetchImpl }), "1.0.0");
    }, { location: "/fw-ai-external/nexus-cli/releases/tag/v1.0.0" });
  });

  it("refuses a Release whose commit has another version", async () => {
    await fixture(async ({ upgrade, requests, setup }) => {
      await assert.rejects(upgrade(), /could not check/);
      assert.deepEqual(requests.map((request) => request.url), [LATEST_RELEASE_URL, commitUrl, metadataUrl]);
      assert.equal(await readFile(path.join(setup, "bin/nexus.mjs"), "utf8"), "original");
    }, { metadataVersion: "1.0.1", archiveVersion: "1.0.1" });
  });

  it("does not fall back after SHA endpoint HTTP failure", async () => {
    await fixture(async ({ upgrade, requests, setup }) => {
      await assert.rejects(upgrade(), /could not check/);
      assert.equal(requests.length, 2);
      assert.equal(await readFile(path.join(setup, "bin/nexus.mjs"), "utf8"), "original");
    }, { status: 503 });
  });

  it("bounds stalled SHA response bodies and catches network errors", { timeout: 5000 }, async () => {
    for (const stall of [true, "headers"]) {
      await fixture(async ({ fetchImpl, requests }) => {
        assert.equal(await fetchPinnedRelease({ fetchImpl, timeoutMs: 100 }), null);
        assert.equal(requests.length, 2);
      }, { stall });
    }
    assert.equal(await fetchPinnedRelease({ fetchImpl: async () => { throw new Error("offline"); } }), null);
  });

  it("rejects malformed pinned metadata without downloading", async () => {
    await fixture(async ({ upgrade, requests, setup }) => {
      await assert.rejects(upgrade(), /could not check/);
      assert.deepEqual(requests.map((request) => request.url), [LATEST_RELEASE_URL, commitUrl, metadataUrl]);
      assert.equal(await readFile(path.join(setup, "bin/nexus.mjs"), "utf8"), "original");
    }, { metadataVersion: "invalid" });
  });

  for (const [name, options, error] of [
    ["archive commit", { archiveCommit: "b".repeat(40) }, /Archive commit does not match/],
    ["archive version", { archiveVersion: "1.0.1" }, /downloaded version does not match/],
  ]) {
    it(`rejects a mismatched ${name} before replacing the install`, async () => {
      await fixture(async ({ upgrade, setup, home }) => {
        await assert.rejects(upgrade(), error);
        assert.equal(await readFile(path.join(setup, "bin/nexus.mjs"), "utf8"), "original");
        assert.deepEqual(await readdir(path.join(home, ".nexus")), ["cli"]);
      }, options);
    });
  }

  it("rejects mixed archive roots and empty pinned archives", async () => {
    await withTempHome("pinned-roots-", async (staging) => {
      const mixed = gzipTarball(tarEntry(`first-${sha.slice(0, 7)}/file`), tarEntry(`second-${sha.slice(0, 7)}/file`));
      await assert.rejects(extractCliTarball(mixed, staging, { expectedSha: sha }), /Archive commit/);
      await assert.rejects(extractCliTarball(gzipTarball(), staging, { expectedSha: sha }), /Archive commit/);
    });
  });

  it("keeps injected development metadata and archive overrides unpinned", async () => {
    await fixture(async ({ upgrade, fetchImpl, requests, setup }) => {
      await upgrade({
        readRemoteVersion: () => fetchLatestVersion({ url: "http://localhost/package.json", fetchImpl }),
        downloadTarball: (staging) => downloadCliTarball(staging, { url: "http://localhost/archive", fetchImpl }),
      });
      assert.deepEqual(requests.map((request) => request.url), ["http://localhost/package.json", "http://localhost/archive"]);
      assert.equal(await readFile(path.join(setup, "bin/nexus.mjs"), "utf8"), "replacement");
    }, { commit: "invalid", archiveCommit: "b".repeat(40), archiveVersion: "1.0.1" });
  });

  it("a tarball environment override bypasses commit resolution", async () => {
    await fixture(async ({ upgrade, requests, setup }) => {
      const saved = process.env.NEXUS_TARBALL_URL;
      process.env.NEXUS_TARBALL_URL = "http://localhost/archive";
      try { await upgrade(); }
      finally {
        if (saved === undefined) delete process.env.NEXUS_TARBALL_URL;
        else process.env.NEXUS_TARBALL_URL = saved;
      }
      assert.equal(requests.some((request) => request.url === LATEST_RELEASE_URL || request.url === commitUrl), false);
      assert.equal(requests.at(-1).url, "http://localhost/archive");
      assert.equal(await readFile(path.join(setup, "bin/nexus.mjs"), "utf8"), "replacement");
    }, { commit: "invalid", archiveCommit: "b".repeat(40), archiveVersion: "1.0.1" });
  });
});

describe("bounded updates", () => {
  async function withServer(t, handle, check) {
    await withTempHome("bounded-update-", async (home) => {
      const savedHome = process.env.HOME;
      process.env.HOME = home;
      const server = http.createServer(handle);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        await check(`http://127.0.0.1:${server.address().port}`, home);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
      }
    });
  }

  for (const version of [null, 1, {}, "", "1", "v1.2.3", "01.2.3", "1.2.3\n", "1.2.3\nexample", "1.2.3-01", "1.2.3-", "1.2.3+", "9".repeat(200)]) {
    it(`rejects malformed release version ${JSON.stringify(version)}`, async () => {
      assert.equal(isReleaseVersion(version), false);
      assert.equal(await fetchLatestVersion({ fetchImpl: async () => Response.json({ version }) }), "");
    });
  }

  it("accepts valid release, prerelease and build versions", () => {
    for (const version of ["0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3+example.1"]) assert.equal(isReleaseVersion(version), true);
  });

  it("bounds metadata and degrades silently on malformed, stalled or oversized responses", { timeout: 5000 }, async (t) => {
    for (const body of ["null", "{", JSON.stringify({ version: "1.2.3", padding: "x".repeat(65536) })]) {
      assert.equal(await fetchLatestVersion({ fetchImpl: async () => new Response(body) }), "");
    }
    await withServer(t, (_req, res) => { res.writeHead(200); res.write("{"); }, async (url) => {
      assert.equal(await fetchLatestVersion({ url, timeoutMs: 150 }), "");
    });
  });

  for (const declared of [false, true]) {
    it(`bounds ${declared ? "declared" : "chunked"} compressed downloads`, async (t) => {
      await withServer(t, (_req, res) => {
        res.writeHead(200, declared ? { "content-length": 2048 } : {});
        res.write(Buffer.alloc(1024));
        res.end(Buffer.alloc(1024));
      }, async (url, home) => {
        const staging = path.join(home, "staging");
        await assert.rejects(downloadCliTarball(staging, { url, maxDownloadBytes: 1024 }), /size limit/);
        assert.equal(existsSync(staging), false);
      });
    });
  }

  it("does not overwrite an existing staging directory", async () => {
    await withTempHome("update-existing-stage-", async (home) => {
      const staging = path.join(home, "staging");
      await mkdir(staging);
      await writeFile(path.join(staging, "sentinel"), "keep");
      await assert.rejects(downloadCliTarball(staging, { fetchImpl: fakeFetchFor(gzipTarball()) }), { code: "EEXIST" });
      assert.equal(await readFile(path.join(staging, "sentinel"), "utf8"), "keep");
    });
  });

  const corruptions = {
    "bad checksum": () => {
      const entry = tarEntry("example/file", Buffer.from("data"));
      entry[0] ^= 1;
      return gzipTarball(entry);
    },
    "bad size": () => {
      const entry = tarEntry("example/file");
      entry.write("0000000001x\0", 124);
      setChecksum(entry.subarray(0, 512));
      return gzipTarball(entry);
    },
    "truncated payload": () => gzipSync(tarEntry("example/file", Buffer.alloc(2048)).subarray(0, 1024)),
    "missing terminator": () => gzipSync(tarEntry("example/file")),
    "partial header": () => gzipSync(Buffer.alloc(513)),
    "nonzero padding": () => {
      const entry = tarEntry("example/file", Buffer.from("data"));
      entry[520] = 1;
      return gzipTarball(entry);
    },
    "compressed truncation": () => gzipTarball(tarEntry("example/file")).subarray(0, 20),
  };
  for (const [name, makeArchive] of Object.entries(corruptions)) {
    it(`rejects ${name} without changing an installed release`, async (t) => {
      await withServer(t, (_req, res) => res.end(makeArchive()), async (url, home) => {
        const install = path.join(home, ".nexus/cli");
        await mkdir(path.join(install, "packages/setup-cli/bin"), { recursive: true });
        const installed = path.join(install, "packages/setup-cli/bin/nexus.mjs");
        await writeFile(installed, "original");
        await writeFile(path.join(install, "packages/setup-cli/package.json"), JSON.stringify({ version: "0.9.0" }));
        await assert.rejects(runUpgradeCommand({
          home, dataDirBlocked: () => false, readRemoteVersion: async () => "1.0.0",
          downloadTarball: (staging) => downloadCliTarball(staging, { url }),
          preflight: async () => ({ proceed: true }), printBannerFn: () => {}, infoFn: () => {},
        }), /Update failed: could not download/);
        assert.equal(await readFile(installed, "utf8"), "original");
        assert.deepEqual(await readdir(path.join(home, ".nexus")), ["cli"]);
      });
    });
  }

  it("caps expanded bytes and counts even skipped tar entries", async () => {
    await withTempHome("update-extract-limits-", async (staging) => {
      await assert.rejects(extractCliTarball(gzipTarball(tarEntry("example/file", Buffer.alloc(4096))), staging, { maxExpandedBytes: 1024 }), /oversized/);
      await assert.rejects(extractCliTarball(gzipTarball(...Array.from({ length: 4 }, () => tarEntry("example/link", Buffer.alloc(0), "2"))), staging, { maxEntries: 3 }), /entry count/);
    });
  });
});
