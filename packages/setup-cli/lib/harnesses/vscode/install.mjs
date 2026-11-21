import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { windowsProgramFilesRoots, withDefaultWindowsProgramFilesRoots } from "../../system/windows-install-roots.mjs";

/**
 * VS Code install detection: which variant (stable / Insiders) is present and
 * the user-data **folder** name ("Code" / "Code - Insiders") that goes with it.
 *
 * The folder is used so `chatLanguageModelsPath` and `vscodeStateDbPath` target
 * the same variant the user actually has installed, and the variant drives the
 * Electron app name used by `vscode-safestorage.mjs` when reading the OS
 * `safeStorage` master key. `--vscode-path` overrides the resolved location.
 *
 * (VS Code Chat's BYOK secrets are NOT individual OS keychain entries — they are
 * `safeStorage`-encrypted blobs in `state.vscdb`; see `vscode-safestorage.mjs`.)
 */

/**
 * Detect a VS Code install. Stable is preferred when both stable and Insiders
 * are present.
 * @param {string|undefined} installDir explicit resources/app dir override
 * @param {Parameters<typeof vscodeInstallCandidates>[0]} [options]
 * @returns {{ variant: "stable"|"insiders", folder: string, productJson: string, nameLong: string | null } | null}
 */
export function detectVscodeInstall(installDir, options) {
  if (installDir) {
    const productJson = path.join(installDir, "product.json");
    if (existsSync(productJson)) {
      return { variant: "stable", folder: "Code", productJson, nameLong: readNameLong(productJson) };
    }
    return null;
  }
  for (const candidate of vscodeInstallCandidates(options)) {
    if (existsSync(candidate.productJson)) {
      return { ...candidate, nameLong: readNameLong(candidate.productJson) };
    }
  }
  return null;
}

function windowsProductJsonPaths(installRoot) {
  const productJson = (...parts) => path.join(installRoot, ...parts, "resources", "app", "product.json");
  const candidates = [productJson()];
  try {
    const commits = readdirSync(installRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{7,40}$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    candidates.push(...commits.map((commit) => productJson(commit)));
  } catch {
    // The legacy path can still be checked when the root cannot be listed.
  }
  return candidates;
}

/**
 * Per-platform candidate installs, stable first. `folder` is the user-data
 * directory name (e.g. "Code", "Code - Insiders"). Install detection reuses
 * the `productJson` paths; `root` prefixes the machine-wide locations so its
 * specs never see the host's own install.
 * @param {{ platform?: string, env?: NodeJS.ProcessEnv, home?: string, root?: string, programFilesRoots?: string[] }} [options]
 * @returns {{ variant: "stable"|"insiders", folder: string, productJson: string }[]}
 */
export function vscodeInstallCandidates({
  platform = os.platform(), env = process.env, home = os.homedir(), root = "/", programFilesRoots,
} = {}) {
  const sys = (...parts) => path.join(root, ...parts);
  if (platform === "darwin") {
    return [
      { variant: "stable", folder: "Code", productJson: sys("Applications", "Visual Studio Code.app", "Contents", "Resources", "app", "product.json") },
      { variant: "insiders", folder: "Code - Insiders", productJson: sys("Applications", "Visual Studio Code - Insiders.app", "Contents", "Resources", "app", "product.json") },
    ];
  }
  if (platform === "win32") {
    const userPrograms = path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs");
    const systemRoots = programFilesRoots ?? windowsProgramFilesRoots(env);
    const roots = [...withDefaultWindowsProgramFilesRoots(systemRoots), userPrograms];
    return [
      { variant: "stable", folder: "Code", installFolder: "Microsoft VS Code" },
      { variant: "insiders", folder: "Code - Insiders", installFolder: "Microsoft VS Code Insiders" },
    ].flatMap(({ variant, folder, installFolder }) => roots.flatMap((dir) =>
      windowsProductJsonPaths(path.join(dir, installFolder)).map((productJson) => ({ variant, folder, productJson }))));
  }
  const xdg = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return [
    { variant: "stable", folder: "Code", productJson: sys("usr", "share", "code", "resources", "app", "product.json") },
    { variant: "stable", folder: "Code", productJson: sys("usr", "lib", "code", "resources", "app", "product.json") },
    { variant: "stable", folder: "Code", productJson: path.join(xdg, "code", "resources", "app", "product.json") },
    { variant: "insiders", folder: "Code - Insiders", productJson: sys("usr", "share", "code-insiders", "resources", "app", "product.json") },
    { variant: "insiders", folder: "Code - Insiders", productJson: path.join(xdg, "code-insiders", "resources", "app", "product.json") },
  ];
}

/** @param {string} productJson @returns {string | null} */
function readNameLong(productJson) {
  try {
    const product = JSON.parse(readFileSync(productJson, "utf8"));
    if (typeof product?.nameLong === "string" && product.nameLong.trim()) {
      return product.nameLong.trim();
    }
  } catch {
    // fall through to null
  }
  return null;
}
