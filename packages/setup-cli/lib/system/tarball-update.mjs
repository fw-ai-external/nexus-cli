import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { warnInsecureUrlOverride } from "./url-override-warning.mjs";

// Same URL install.sh downloads — the documented archive endpoint
// (https://docs.github.com/en/rest/repos/contents), which redirects to
// GitHub's archive host. NEXUS_TARBALL_URL lets tests point at a local
// fixture without touching the network.
export const TARBALL_URL =
  process.env.NEXUS_TARBALL_URL
  ?? "https://api.github.com/repos/fw-ai-external/nexus-cli/tarball/main";

// main's package.json, read only when NEXUS_TARBALL_URL or an injected
// downloader replaces the release lookup below.
export const REMOTE_VERSION_URL =
  "https://raw.githubusercontent.com/fw-ai-external/nexus-cli/main/packages/setup-cli/package.json";

// Redirects to /releases/tag/v<version> of the newest published Release
// (never a draft or prerelease). A github.com redirect, not the REST API, so
// it doesn't use up the 60/hour unauthenticated API quota.
export const LATEST_RELEASE_URL = "https://github.com/fw-ai-external/nexus-cli/releases/latest";
const RELEASE_TAG_PATH = /^\/fw-ai-external\/nexus-cli\/releases\/tag\/(v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/;

export const releaseCommitUrl = (tag) => `https://api.github.com/repos/fw-ai-external/nexus-cli/commits/${tag}`;

function isCommitSha(value) {
  return typeof value === "string" && value.length === 40 && /^[0-9a-f]{40}$/.test(value);
}

/**
 * The newest public Release's tag ("v1.2.3"), or "" on any failure, including
 * a repo with no Release (GitHub then redirects to /releases).
 */
export async function fetchLatestReleaseTag({ fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  try {
    const res = await fetchImpl(LATEST_RELEASE_URL, {
      method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return "";
    const target = new URL(location, LATEST_RELEASE_URL);
    if (target.origin !== "https://github.com" || target.search || target.hash) return "";
    return RELEASE_TAG_PATH.exec(target.pathname)?.[1] ?? "";
  } catch {
    return "";
  }
}

/** The newest public Release's version, or "" on any failure. */
export async function fetchLatestReleaseVersion(options = {}) {
  return (await fetchLatestReleaseTag(options)).slice(1);
}

/**
 * The newest public Release, pinned to its tag's commit: { tag, sha, version,
 * tarballUrl }, or null on any failure. The commit's package.json must hold the
 * tag's version.
 */
export async function fetchPinnedRelease({ fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  try {
    const tag = await fetchLatestReleaseTag({ fetchImpl, timeoutMs });
    if (!tag) return null;
    const res = await fetchImpl(releaseCommitUrl(tag), {
      headers: { Accept: "application/vnd.github.sha" }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const sha = (await boundedResponse(res, 40)).toString("utf8");
    if (!isCommitSha(sha)) return null;
    const version = await fetchLatestVersion({
      url: `https://raw.githubusercontent.com/fw-ai-external/nexus-cli/${sha}/packages/setup-cli/package.json`,
      fetchImpl, timeoutMs,
    });
    return version && `v${version}` === tag
      ? { tag, sha, version, tarballUrl: `https://api.github.com/repos/fw-ai-external/nexus-cli/tarball/${sha}` }
      : null;
  } catch {
    return null;
  }
}

const HEADER_SIZE = 512;
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
export const MAX_TAR_ENTRIES = 20_000;
const MAX_METADATA_BYTES = 64 * 1024;
const inflate = promisify(gunzip);

export function isReleaseVersion(version) {
  if (typeof version !== "string" || version.length > 128) return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  return Boolean(match && match[0] === version && match.slice(1, 4).every((n) => Number.isSafeInteger(Number(n)))
    && (!match[4] || match[4].split(".").every((part) => !/^0\d+$/.test(part))));
}

async function boundedResponse(res, limit) {
  if (Number(res.headers?.get("content-length")) > limit) {
    await res.body?.cancel().catch(() => {});
    throw new Error("Download exceeds the size limit.");
  }
  const chunks = [];
  let size = 0;
  if (!res.body) return Buffer.alloc(0);
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) throw new Error("Download exceeds the size limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function readString(bytes, offset, length) {
  let end = offset;
  const max = Math.min(offset + length, bytes.length);
  while (end < max && bytes[end] !== 0) end += 1;
  return bytes.subarray(offset, end).toString("utf8");
}

function readOctal(bytes, offset, length) {
  const raw = bytes.subarray(offset, offset + length).toString("latin1").replace(/^[\0 ]+|[\0 ]+$/g, "");
  if (!/^[0-7]+$/.test(raw)) throw new Error("Invalid tar numeric field.");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) throw new Error("Invalid tar numeric field.");
  return value;
}

/**
 * Extract a gzipped GitHub tarball into `staging`, dropping the single
 * top-level directory GitHub prefixes every entry with (like
 * `tar --strip-components=1`). Only plain files and directories are
 * extracted; symlinks/devices/PAX records are skipped. Every entry must
 * resolve inside `staging` — anything that would escape (tar-slip) throws.
 *
 * @param {Buffer} gzipBytes
 * @param {string} staging Absolute path of an existing (possibly empty) directory.
 * @returns {Promise<void>}
 */
export async function extractCliTarball(gzipBytes, staging, {
  maxExpandedBytes = MAX_EXPANDED_BYTES,
  maxEntries = MAX_TAR_ENTRIES,
  expectedSha,
} = {}) {
  if (expectedSha !== undefined && !isCommitSha(expectedSha)) throw new Error("Invalid expected archive commit.");
  let tar;
  try {
    tar = await inflate(gzipBytes, { maxOutputLength: maxExpandedBytes });
  } catch {
    throw new Error("Invalid or oversized compressed tarball.");
  }
  if (tar.length < HEADER_SIZE * 2 || tar.length % HEADER_SIZE !== 0) throw new Error("Truncated tar archive.");
  let offset = 0;
  let entries = 0;
  let archiveRoot;
  while (offset + HEADER_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + HEADER_SIZE);
    if (header.every((byte) => byte === 0)) {
      if (offset + HEADER_SIZE * 2 > tar.length || !tar.subarray(offset).every((byte) => byte === 0)) {
        throw new Error("Invalid tar end marker.");
      }
      if (expectedSha && !archiveRoot) throw new Error("Archive commit does not match the checked revision.");
      return;
    }
    if (++entries > maxEntries) throw new Error("Tar entry count exceeds the limit.");
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== readOctal(header, 148, 8)) throw new Error("Invalid tar header checksum.");
    const name = readString(header, 0, 100);
    if (!name) throw new Error("Invalid tar entry name.");
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0);
    const prefix = readString(header, 345, 155);
    const dataStart = offset + HEADER_SIZE;
    const dataEnd = dataStart + size;
    offset = dataStart + Math.ceil(size / HEADER_SIZE) * HEADER_SIZE;
    if (offset > tar.length) throw new Error("Truncated tar entry.");
    if (!tar.subarray(dataEnd, offset).every((byte) => byte === 0) || (type === "5" && size !== 0)) {
      throw new Error("Invalid tar entry size.");
    }

    if (type === "x" || type === "g" || type === "L" || type === "K") {
      continue; // PAX / GNU metadata records: skip their payload.
    }

    const fullName = prefix ? `${prefix}/${name}` : name;
    const parts = fullName.split("/").filter((part) => part && part !== ".");
    if (expectedSha) {
      if (!parts[0]?.endsWith(`-${expectedSha.slice(0, 7)}`) || (archiveRoot && archiveRoot !== parts[0])) {
        throw new Error("Archive commit does not match the checked revision.");
      }
      archiveRoot = parts[0];
    }
    if (parts.length <= 1) continue; // The GitHub top-level directory itself.
    const relative = parts.slice(1).join("/");
    if (path.isAbsolute(relative) || relative.split(path.posix.sep).includes("..")) {
      throw new Error("Refusing to extract unsafe tar entry.");
    }
    const target = path.resolve(staging, relative);
    if (target !== path.resolve(staging) && !target.startsWith(path.resolve(staging) + path.sep)) {
      throw new Error("Refusing to extract unsafe tar entry.");
    }

    if (type === "5") {
      await mkdir(target, { recursive: true });
    } else if (type === "0" || type === "\0") {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, tar.subarray(dataStart, dataEnd));
    }
    // Anything else (symlinks, hardlinks, devices) is skipped.
  }
  throw new Error("Missing tar end marker.");
}

/**
 * Fetch the latest published CLI version over HTTPS. Returns "" on any
 * failure so callers can degrade to a hint instead of crashing.
 *
 * @returns {Promise<string>}
 */
export async function fetchLatestVersion({
  url = REMOTE_VERSION_URL,
  fetchImpl = fetch,
  timeoutMs = 10_000,
} = {}) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return "";
    }
    const { version } = JSON.parse((await boundedResponse(res, MAX_METADATA_BYTES)).toString("utf8"));
    return isReleaseVersion(version) ? version : "";
  } catch {
    return "";
  }
}

/**
 * Download the CLI tarball over HTTPS and extract it into `staging`.
 * Throws on network/HTTP/extract failure; the caller cleans up staging.
 *
 * @param {string} staging Absolute path; must not already exist.
 * @returns {Promise<void>}
 */
export async function downloadCliTarball(
  staging,
  {
    url = TARBALL_URL,
    fetchImpl = fetch,
    timeoutMs = 120_000,
    extract = extractCliTarball,
    maxDownloadBytes = MAX_DOWNLOAD_BYTES,
    expectedSha,
  } = {},
) {
  warnInsecureUrlOverride(url, "NEXUS_TARBALL_URL");
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status} downloading the tarball.`);
  }
  const bytes = await boundedResponse(res, maxDownloadBytes);
  await mkdir(staging, { mode: 0o700 });
  try {
    await extract(bytes, staging, { expectedSha });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
