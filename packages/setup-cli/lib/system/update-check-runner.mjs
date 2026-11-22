import process from "node:process";
import { fetchLatestReleaseVersion } from "./tarball-update.mjs";
import { patchUpdateCache, releaseUpdateLock } from "./update-cache.mjs";

// A bounded hint only: the newest public Release's version. A foreground
// update resolves that Release's commit itself before downloading.
export async function runUpdateCheck({ home = process.env.HOME ?? "", now = Date.now, fetchVersion = fetchLatestReleaseVersion } = {}) {
  if (!home) return;
  const checkedAt = now();
  try {
    const version = await fetchVersion({ timeoutMs: 5000 });
    if (!version) throw new Error("missing version");
    await patchUpdateCache(home, {
      checkedAt,
      latestVersion: version,
      // Clear sticky failure so the next spawn uses the 24h TTL again.
      fetchFailed: false,
    });
  } catch {
    // Record the failed attempt, keeping any known version, so the next
    // spawn waits out the failure retry instead of trying on every run.
    try {
      await patchUpdateCache(home, { checkedAt, fetchFailed: true });
    } catch {
      // Silent — main CLI must never be affected.
    }
  } finally {
    releaseUpdateLock(home);
  }
}
