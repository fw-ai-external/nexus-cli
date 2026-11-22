// Hide @napi-rs/keyring so the real cross-keychain picks its secret-tool
// backend (the fixture `secret-tool` on PATH) as the native keychain.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@napi-rs/keyring") {
    throw Object.assign(new Error("hidden by test"), { code: "ERR_MODULE_NOT_FOUND" });
  }
  return nextResolve(specifier, context);
}
