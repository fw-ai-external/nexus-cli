// Make every write of the encrypted file store fail (a full or read-only
// disk), while reads still work.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.endsWith("/lib/keys/builtin-file-secret-store.mjs")) {
    const source = String(result.source).replace("await rename(tmp, file);", 'throw new Error("ENOSPC: no space left on device");');
    return { ...result, source };
  }
  return result;
}
