import { ensurePrivateParent } from "../../io/private-files.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isMap, isScalar, parseDocument } from "yaml";
import {
  AUTO_MODEL_ID,
  dropRetiredModelId,
  normalizeModelId,
  shortFireworksModelRef,
  defaultMainModel,
} from "../../fireworks/model-id.mjs";
import { ANTHROPIC_BYOK_HEADER, OPENAI_BYOK_HEADER } from "../../firerouter/core.mjs";
import { NEXUS_PROVIDERS_HEADER } from "../../config/auto-providers.mjs";
import { planModelList } from "../../harness/catalog-refresh.mjs";
import { readJsonIfExists, writeJson } from "../../io/json.mjs";
import { writeFileAtomic } from "../../io/atomic-write.mjs";
import { MISSING_FIREWORKS_API_KEY_MESSAGE } from "../../keys/key-type.mjs";
import { FIRECONNECT_TELEMETRY_HEADER_NAMES } from "../../telemetry/request-headers.mjs";
import { readRawIfExists } from "../opencode/core.mjs";
import {
  readEnvAssignment,
  stripEnvAssignment,
  upsertEnvAssignment,
} from "../deepseek/core.mjs";
import {
  HERMES_API_KEY_ENV,
  HERMES_CONFIG_FILENAME,
  HERMES_DATA_RELATIVE_DIR,
  HERMES_DEFAULT_PROVIDER,
  HERMES_ENV_FILENAME,
  HERMES_GATEWAY_PID_FILENAME,
  HERMES_FIREWORKS_BASE_URL,
  HERMES_FIREWORKS_PROVIDER_ALIASES,
  HERMES_FIREWORKS_PROVIDER_ID,
  HERMES_HOME_RELATIVE_DIR,
  HERMES_NEXUS_AUTO_ALIAS,
  HERMES_NEXUS_AUTO_MODEL_ID,
  HERMES_PLUGIN_INIT_FILENAME,
  HERMES_PLUGIN_MANIFEST_FILENAME,
  HERMES_PLUGIN_RELATIVE_DIR,
} from "./constants.mjs";
import { activeAccountResidency, fireworksInferenceUrl } from "../../fireworks/residency.mjs";

export {
  HERMES_API_KEY_ENV,
  HERMES_DATA_RELATIVE_DIR,
  HERMES_DEFAULT_PROVIDER,
  HERMES_FIREWORKS_BASE_URL,
  HERMES_FIREWORKS_PROVIDER_ID,
  HERMES_NEXUS_AUTO_ALIAS,
  HERMES_NEXUS_AUTO_MODEL_ID,
} from "./constants.mjs";

/** Header names Nexus owns, whatever the last `on` sent. */
const NEXUS_HEADER_NAMES = Object.freeze([
  ...FIRECONNECT_TELEMETRY_HEADER_NAMES,
  ANTHROPIC_BYOK_HEADER,
  OPENAI_BYOK_HEADER,
  NEXUS_PROVIDERS_HEADER,
].map((name) => name.toLowerCase()));

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Hermes Agent home: `$HERMES_HOME`, else `%LOCALAPPDATA%\hermes` on Windows,
 * else `~/.hermes` (mirrors Hermes's own resolution).
 * @param {string} home
 * @param {NodeJS.ProcessEnv} [env]
 */
export function hermesHomePath(home, env = process.env) {
  const fromEnv = env.HERMES_HOME?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local"), "hermes");
  }
  return path.join(home, HERMES_HOME_RELATIVE_DIR);
}

export function hermesConfigPath(home, configPath = "") {
  return configPath ? path.resolve(configPath) : path.join(hermesHomePath(home), HERMES_CONFIG_FILENAME);
}

/** Hermes reads secrets from the `.env` beside its config.yaml. */
export function hermesEnvPath(configPath) {
  return path.join(path.dirname(configPath), HERMES_ENV_FILENAME);
}

/**
 * Whether a Hermes gateway is running for the home that holds `configPath`.
 * The gateway (started by the Hermes app, a launchd/systemd service, or
 * `hermes gateway run`) reads config.yaml at startup, so it keeps the old
 * setup until restarted. Reads the `gateway.pid` record Hermes writes beside
 * config.yaml and probes that pid with signal 0, an existence check that
 * never signals the process. Nexus never restarts the gateway itself: Hermes
 * owns how it was launched. Never throws; any doubt reads as not running.
 * @param {string} configPath
 * @returns {boolean}
 */
export function hermesGatewayRunning(configPath) {
  try {
    const record = JSON.parse(readFileSync(path.join(path.dirname(configPath), HERMES_GATEWAY_PID_FILENAME), "utf8"));
    if (!record || typeof record !== "object" || record.kind !== "hermes-gateway") {
      return false;
    }
    const pid = Number(record.pid);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      return false;
    }
    process.kill(pid, 0);
    return true;
  } catch {
    // Missing/unparseable record, ESRCH (gone), or EPERM (the pid now belongs
    // to another user's process, so it isn't this user's gateway).
    return false;
  }
}

export function hermesDataDir(home, dataDir = "") {
  return dataDir || path.join(home, HERMES_DATA_RELATIVE_DIR);
}

export function hermesBackupPath(dataDir, configPath) {
  const key = createHash("sha256").update(path.resolve(configPath)).digest("hex").slice(0, 16);
  return path.join(dataDir, `config-backup.${key}.json`);
}

/**
 * Parse config.yaml as a YAML document so edits keep the user's comments and
 * key order. An empty file is an empty mapping; anything else must be one.
 * @param {string} raw
 */
function parseHermesDocument(raw) {
  const doc = parseDocument(raw ?? "");
  if (doc.errors.length) {
    throw new Error(`Couldn't parse Hermes config.yaml: ${doc.errors[0].message}`);
  }
  const contents = doc.contents;
  const empty = contents === null || (isScalar(contents) && (contents.value === null || contents.value === ""));
  if (!empty && !isMap(contents)) {
    throw new Error("Hermes config.yaml must be a YAML mapping.");
  }
  if (empty) {
    doc.contents = doc.createNode({});
  }
  return doc;
}

/**
 * Serialize a document parsed by `parseHermesDocument`. The `yaml` default
 * pads flow collections (`[a]` becomes `[ a ]`), rewriting lines Nexus never
 * touched; Hermes writes them unpadded, so keep them that way.
 * @param {import("yaml").Document} doc
 */
function serializeHermesDocument(doc) {
  return doc.toString({ flowCollectionPadding: false });
}

/**
 * @param {string} raw
 * @returns {Record<string, unknown>}
 */
export function parseHermesConfig(raw) {
  return asPlainObject(parseHermesDocument(raw).toJS()) ?? {};
}

/** @param {string} configPath */
export async function readHermesConfigIfExists(configPath) {
  const { existed, raw } = await readRawIfExists(configPath);
  return { existed, raw, config: existed ? parseHermesConfig(raw) : {} };
}

/** @param {string} configPath */
export async function readHermesEnvKey(configPath) {
  const { raw } = await readRawIfExists(hermesEnvPath(configPath));
  return readEnvAssignment(raw, HERMES_API_KEY_ENV);
}

function modelSection(config) {
  return asPlainObject(config?.model);
}

function isFireworksProvider(value) {
  return typeof value === "string"
    && HERMES_FIREWORKS_PROVIDER_ALIASES.includes(value.trim().toLowerCase());
}

/**
 * The `providers.fireworks` entry: Hermes's built-in provider, which a
 * `providers:` entry of the same name extends without renaming the section.
 * @returns {Record<string, unknown> | null}
 */
function fireworksProviderEntry(config) {
  return asPlainObject(asPlainObject(config?.providers)?.[HERMES_FIREWORKS_PROVIDER_ID]);
}

/** `model.provider` selects Hermes's built-in Fireworks provider. */
function selectsFireworksProvider(config) {
  return isFireworksProvider(modelSection(config)?.provider);
}

function stringHeaders(value) {
  return Object.fromEntries(
    Object.entries(asPlainObject(value) ?? {}).filter(([, header]) => typeof header === "string"),
  );
}

/**
 * Headers Hermes sends on every main-model request: `model.extra_headers`
 * merged with the selected provider's own `extra_headers`.
 * @param {Record<string, unknown>} config
 * @returns {Record<string, string>}
 */
export function hermesStoredHeaders(config) {
  return {
    ...stringHeaders(modelSection(config)?.extra_headers),
    ...(selectsFireworksProvider(config) ? stringHeaders(fireworksProviderEntry(config)?.extra_headers) : {}),
  };
}

/**
 * Fireworks routing: Hermes's built-in `fireworks` provider (the entry `on`
 * extends, or one set up by hand).
 * @returns {"fireworks" | null}
 */
export function hermesProviderStatus(config) {
  return selectsFireworksProvider(config) ? "fireworks" : null;
}

/** Fireworks selected and carrying Nexus's own request attribution. */
export function isNexusManagedHermes(config) {
  if (!selectsFireworksProvider(config)) {
    return false;
  }
  return Object.entries(stringHeaders(fireworksProviderEntry(config)?.extra_headers)).some(
    ([name, value]) => name.toLowerCase() === "http-referer" && value.startsWith("nexus/"),
  );
}

/**
 * Fireworks selected and set up by Nexus: either its attribution is still
 * there or a Nexus backup exists for this config, so editing the headers
 * after `on` doesn't hide a route that `off` and `uninstall` must undo.
 * @param {{ configPath: string, dataDir: string }} paths
 */
export async function hermesRoutedByNexus({ configPath, dataDir }, config) {
  if (isNexusManagedHermes(config)) {
    return true;
  }
  if (!selectsFireworksProvider(config)) {
    return false;
  }
  try {
    const backup = await readJsonIfExists(hermesBackupPath(dataDir, configPath));
    return backup.configPath === path.resolve(configPath);
  } catch {
    // An unreadable backup can't vouch for the route; `off` reports it.
    return false;
  }
}

/** @returns {string | null} */
export function hermesCurrentModelId(config) {
  if (typeof config?.model === "string") {
    return config.model.trim() || null;
  }
  const value = modelSection(config)?.default;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * @param {Record<string, unknown>} headers
 * @param {string[]} extraNames
 */
function withoutNexusHeaders(headers, extraNames = []) {
  const owned = new Set([...NEXUS_HEADER_NAMES, ...extraNames.map((name) => name.toLowerCase())]);
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => !owned.has(name.toLowerCase())),
  );
}

function modelMapNode(doc) {
  const node = doc.get("model", true);
  return isMap(node) ? node : null;
}

/** The map at `key` under `parent`, created (or replacing a non-map) if needed. */
function ensureMapNode(doc, parent, key) {
  if (!isMap(parent.get(key, true))) {
    parent.set(key, doc.createNode({}));
  }
  return parent.get(key, true);
}

function fireworksProviderNode(doc) {
  const providers = doc.get("providers", true);
  const node = isMap(providers) ? providers.get(HERMES_FIREWORKS_PROVIDER_ID, true) : null;
  return isMap(node) ? node : null;
}

/**
 * Put `parentKey.childKey` back to its value in `original`, or remove it,
 * dropping `parentKey` when it only existed for that entry.
 */
function restoreNestedEntry(doc, original, parentKey, childKey) {
  const parent = doc.get(parentKey, true);
  const originalParent = asPlainObject(original?.[parentKey]);
  const originalValue = originalParent?.[childKey];
  if (originalValue !== undefined) {
    ensureMapNode(doc, doc, parentKey).set(childKey, doc.createNode(originalValue));
    return;
  }
  if (!isMap(parent)) {
    return;
  }
  parent.delete(childKey);
  if (parent.items.length === 0 && !originalParent) {
    doc.delete(parentKey);
  }
}

/**
 * Delete `key` from `map` without losing the comment written above it: the
 * `yaml` library stores that comment on the key, so it moves to the next key
 * (or after the map when `key` was last). Hermes's own config documents each
 * setting in long comment blocks; deleting a setting must not delete those.
 * @param {import("yaml").YAMLMap} map
 * @param {string} key
 */
function deleteKeepingComment(map, key) {
  const index = map.items.findIndex((pair) => pair.key?.value === key);
  if (index === -1) {
    return;
  }
  const comment = map.items[index].key?.commentBefore;
  map.items.splice(index, 1);
  if (!comment) {
    return;
  }
  const next = map.items[index]?.key;
  if (next) {
    next.commentBefore = next.commentBefore ? `${comment}\n${next.commentBefore}` : comment;
  } else {
    map.comment = map.comment ? `${comment}\n${map.comment}` : comment;
  }
}

function setExtraHeaders(doc, modelNode, headers) {
  if (Object.keys(headers).length) {
    modelNode.set("extra_headers", doc.createNode(headers));
  } else {
    modelNode.delete("extra_headers");
  }
}

/**
 * The ids under a `providers.fireworks` entry's `models:` map, in order.
 * @param {unknown} providerEntry
 * @returns {string[]}
 */
function registeredHermesModelIds(providerEntry) {
  return Object.keys(asPlainObject(asPlainObject(providerEntry)?.models) ?? {});
}

/**
 * The `providers.fireworks.models` ids `on` writes, which the plugin serves
 * as the whole Fireworks picker: the account's catalog as every picker harness
 * lists it (`-latest` aliases in place of the versions they cover),
 * reconciled through the shared list policy (lib/harness/catalog-refresh.mjs),
 * with `nexus-auto` always present.
 * @param {{
 *   currentIds: string[],
 *   catalogModelIds: string[],
 *   catalogAvailable: boolean,
 *   selectedId: string,
 * }} args
 * @returns {string[]}
 */
export function hermesModelList({ currentIds, catalogModelIds, catalogAvailable, selectedId }) {
  const ids = planModelList({
    currentIds,
    freshIds: catalogModelIds.map(hermesModelId).filter(Boolean),
    catalogAvailable,
    freshInstall: currentIds.length === 0,
    selectedId,
    keepUnserved: (id) => id === HERMES_NEXUS_AUTO_MODEL_ID,
  });
  return ids.includes(HERMES_NEXUS_AUTO_MODEL_ID) ? ids : [HERMES_NEXUS_AUTO_MODEL_ID, ...ids];
}

/**
 * Select Hermes's built-in Fireworks provider for `modelId`, extend its
 * `providers.fireworks` entry with Nexus's headers and model rows (keeping
 * every other key the user had there), and alias it as Nexus Auto. Every
 * other key, comment, and user header is kept.
 *
 * `modelIds`, when given, is the whole `models:` list (see
 * {@link hermesModelList}): rows not in it are dropped and missing ones
 * appended, keeping the metadata of rows that stay. Without it, only
 * `nexus-auto` and `modelId` are added.
 * @param {import("yaml").Document} doc
 * @param {{
 *   modelId: string,
 *   modelIds?: string[],
 *   headers?: Record<string, string>,
 *   previousHeaderNames?: string[],
 * }} opts
 */
export function patchHermesDocument(doc, { modelId, modelIds, headers = {}, previousHeaderNames = [] }) {
  const modelNode = ensureMapNode(doc, doc, "model");
  const userHeaders = withoutNexusHeaders(
    asPlainObject(modelNode.get("extra_headers", true)?.toJSON?.()) ?? {},
    previousHeaderNames,
  );
  modelNode.set("provider", HERMES_FIREWORKS_PROVIDER_ID);
  modelNode.set("default", modelId);
  // A URL, key, or API mode left from another provider would override the
  // provider entry; the snapshot keeps them for `off`.
  modelNode.delete("base_url");
  modelNode.delete("api_key");
  modelNode.delete("api_mode");
  setExtraHeaders(doc, modelNode, userHeaders);

  const providerNode = ensureMapNode(doc, ensureMapNode(doc, doc, "providers"), HERMES_FIREWORKS_PROVIDER_ID);
  const existingHeaders = stringHeaders(asPlainObject(providerNode.get("extra_headers", true)?.toJSON?.()));
  providerNode.set("base_url", fireworksInferenceUrl(HERMES_FIREWORKS_BASE_URL, activeAccountResidency("hermes")));
  providerNode.set("key_env", HERMES_API_KEY_ENV);
  setExtraHeaders(doc, providerNode, {
    ...withoutNexusHeaders(existingHeaders, previousHeaderNames),
    ...headers,
  });
  const models = registeredHermesModelIds(providerNode.toJSON());
  const wanted = modelIds ?? [HERMES_NEXUS_AUTO_MODEL_ID, modelId];
  if (modelIds) {
    const modelsNode = providerNode.get("models", true);
    for (const id of models.filter((existing) => !wanted.includes(existing))) {
      modelsNode?.delete(id);
    }
  }
  for (const id of new Set(wanted)) {
    if (!models.includes(id)) {
      ensureMapNode(doc, providerNode, "models").set(id, doc.createNode({}));
    }
  }
  ensureMapNode(doc, doc, "model_aliases").set(HERMES_NEXUS_AUTO_ALIAS, doc.createNode({
    model: HERMES_NEXUS_AUTO_MODEL_ID,
    provider: HERMES_FIREWORKS_PROVIDER_ID,
  }));
  return doc;
}

/**
 * Undo `on` in a config Hermes (or the user) has rewritten since: put the
 * original `model` section back when Fireworks is still selected, drop or
 * restore the `providers.fireworks` entry and the Nexus Auto alias, and
 * strip any Nexus headers left in `model` and in that entry.
 * @param {import("yaml").Document} doc
 * @param {{ original?: Record<string, unknown>, managedHeaderNames?: string[] }} opts
 */
export function stripHermesDocument(doc, { original, managedHeaderNames = [] }) {
  const current = asPlainObject(doc.toJS()) ?? {};
  const modelNode = modelMapNode(doc);
  if (selectsFireworksProvider(current) && original?.model !== undefined) {
    doc.set("model", doc.createNode(original.model));
  } else if (modelNode) {
    // No original to put back (a config Nexus routed before its backup was
    // lost, or one `on` created): take back only the selection Nexus made.
    // `provider: auto` is Hermes's documented default (detect from
    // credentials); setting it, rather than deleting the key, keeps the
    // section and the comment blocks Hermes hangs off its keys.
    if (selectsFireworksProvider(current)) {
      modelNode.set("provider", HERMES_DEFAULT_PROVIDER);
      deleteKeepingComment(modelNode, "default");
    }
    const headers = asPlainObject(modelNode.get("extra_headers", true)?.toJSON?.());
    if (headers) {
      setExtraHeaders(doc, modelNode, withoutNexusHeaders(headers, managedHeaderNames));
    }
    if (modelNode.items.length === 0) {
      doc.delete("model");
    }
  } else if (selectsFireworksProvider(current)) {
    doc.delete("model");
  }
  // The entry is either the user's own (restored exactly) or Nexus's alone
  // (dropped, taking an `on`-created `providers:` map with it).
  restoreNestedEntry(doc, original, "providers", HERMES_FIREWORKS_PROVIDER_ID);
  restoreNestedEntry(doc, original, "model_aliases", HERMES_NEXUS_AUTO_ALIAS);
  return doc;
}

async function snapshotFile(filePath) {
  const { existed, raw } = await readRawIfExists(filePath);
  if (!existed) {
    return { existed, raw };
  }
  const { mode } = await stat(filePath);
  return { existed, raw, mode: mode & 0o777 };
}

async function restoreSnapshot(snapshot, filePath) {
  if (snapshot?.existed) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFileAtomic(filePath, snapshot.raw, { mode: snapshot.mode ?? 0o600 });
    return;
  }
  await unlinkIfExists(filePath);
}

async function unlinkIfExists(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Hermes loads `$HERMES_HOME/plugins/model-providers/<name>/` in place of the
 * bundled provider with that name, so this re-registers Fireworks's own
 * profile, unchanged, with two differences: its model list is the one `on`
 * writes into the plugin (the account's catalog as the other harnesses list
 * it, the same ids as `providers.fireworks.models`), led by `nexus-auto`, in
 * place of the live listing; and a request for `nexus-auto` goes out as Fireworks's `auto`
 * router. The list lives in the plugin itself, not read back from
 * config.yaml, so a catalog of `auto` alone still pins the picker to Nexus
 * Auto. The rewrite runs for auxiliary calls
 * (titles, compression, vision) too. The profile is cloned from the
 * registered one, and the methods take any arguments, so Hermes changes to
 * the profile's fields or hook signatures don't break it; if the listing
 * change still fails, the rewrite is registered alone, since Fireworks
 * rejects `nexus-auto` as a model id.
 */
const HERMES_PLUGIN_MODELS_TOKEN = "__NEXUS_MODELS_JSON__";
const HERMES_PLUGIN_INIT_TEMPLATE = `"""Nexus Auto for Hermes.

Written by \`nexus hermes on\` and removed by \`nexus hermes off\`; edits are
overwritten. Re-registers Hermes's Fireworks profile with two changes:
the model list is NEXUS_MODELS below (the account's Nexus models),
led by \`nexus-auto\`, and requests for it go out as Fireworks's
\`auto\` router. If the listing change can't be applied, the
rewrite is registered alone, so \`nexus-auto\` never reaches Fireworks as-is.
"""
import copy
import dataclasses
import importlib.util
import json
import logging
from pathlib import Path

NEXUS_AUTO_ID = "nexus-auto"
WIRE_MODEL_ID = "auto"
NEXUS_MODELS = json.loads(${HERMES_PLUGIN_MODELS_TOKEN})
_log = logging.getLogger(__name__)


def _is_nexus_auto(model_id):
    return str(model_id or "").strip().lower() == NEXUS_AUTO_ID


def _reads_as_auto(model_id):
    # Catalog ids that are Fireworks's own router (\`auto\`, \`firerouter/auto\`).
    return str(model_id).strip().lower().rsplit("/", 1)[-1] == WIRE_MODEL_ID


def _bundled_profile():
    import providers

    # Bundled plugins load before user plugins, so Hermes's own profile is
    # normally registered already; otherwise load it from its file.
    base = providers.get_provider_profile("fireworks")
    if base is not None and not getattr(base, "_nexus_auto", False):
        return base
    src = (Path(providers.__file__).resolve().parent.parent
           / "plugins" / "model-providers" / "fireworks" / "__init__.py")
    spec = importlib.util.spec_from_file_location("_nexus_bundled_fireworks", src)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.fireworks


def _profile_class(base_cls, listing, pinned):
    class NexusFireworksProfile(base_cls):
        _nexus_auto = True

        def build_api_kwargs_extras(self, *args, **context):
            body, top = super().build_api_kwargs_extras(*args, **context)
            if _is_nexus_auto(context.get("model")):
                top = {**(top or {}), "model": WIRE_MODEL_ID}
            return body, top

        if listing:
            def fetch_models(self, *args, **kwargs):
                # The Nexus list is the picker: no live listing, so models
                # Nexus doesn't offer never show up.
                return list(pinned)

    return NexusFireworksProfile


def _clone(base, cls):
    try:
        profile = copy.copy(base)
        profile.__class__ = cls
        return profile
    except TypeError:
        fields = {f.name: getattr(base, f.name) for f in dataclasses.fields(base) if f.init}
        return cls(**fields)


def _configured_entry():
    try:
        from hermes_cli.config import load_config

        entry = ((load_config() or {}).get("providers") or {}).get("fireworks") or {}
        return entry if isinstance(entry, dict) else {}
    except Exception:
        return {}


def _configured_headers(entry):
    # Hermes adds \`providers.fireworks.extra_headers\` to main-turn requests
    # only; auxiliary clients (titles, compression, vision) send the
    # profile's \`default_headers\`, so carry Nexus's headers there too.
    headers = entry.get("extra_headers") or {}
    if not isinstance(headers, dict):
        return {}
    return {str(k): str(v) for k, v in headers.items() if isinstance(v, (str, int, float))}


def _pinned_models():
    # Nexus Auto first, then the rest of NEXUS_MODELS; a list of \`auto\`
    # alone pins the picker to Nexus Auto.
    rest = []
    for model_id in NEXUS_MODELS:
        if isinstance(model_id, str) and model_id.strip() and not _is_nexus_auto(model_id) \
                and not _reads_as_auto(model_id) and model_id.strip() not in rest:
            rest.append(model_id.strip())
    return (NEXUS_AUTO_ID, *rest)


def _register(listing):
    from providers import register_provider

    base = _bundled_profile()
    entry = _configured_entry()
    pinned = _pinned_models() if listing else ()
    profile = _clone(base, _profile_class(type(base), listing, pinned))
    headers = _configured_headers(entry)
    if headers:
        object.__setattr__(profile, "default_headers", {
            **dict(getattr(base, "default_headers", None) or {}), **headers})
    if listing:
        # Hermes merges the live list with these, so they are the Nexus list too.
        object.__setattr__(profile, "fallback_models", pinned)
    register_provider(profile)


try:
    _register(listing=True)
except Exception:
    _log.warning("Nexus Auto: couldn't add the picker row; routing nexus-auto only", exc_info=True)
    try:
        _register(listing=False)
    except Exception:
        _log.error(
            "Nexus Auto plugin failed to load, so nexus-auto won't route. "
            "Run \`nexus hermes on\` again or pick another model with /model.",
            exc_info=True,
        )
`;

const HERMES_PLUGIN_MANIFEST_SOURCE = `name: fireworks-provider
kind: model-provider
version: 1.0.0
description: Fireworks AI with Nexus Auto (written by the Nexus CLI)
author: Nexus CLI
`;

/** @param {string} configPath */
function hermesPluginDir(configPath) {
  return path.join(path.dirname(configPath), HERMES_PLUGIN_RELATIVE_DIR);
}

/** Directories under the Hermes home that hold the plugin, outermost first. */
const HERMES_PLUGIN_DIR_CHAIN = Object.freeze(
  HERMES_PLUGIN_RELATIVE_DIR.split("/").map((_, index, parts) => parts.slice(0, index + 1).join(path.sep)),
);

/** First line of the plugin docstring; marks files `on` wrote. */
const HERMES_PLUGIN_MARKER = "Written by `nexus hermes on`";

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} configPath */
async function snapshotPlugin(configPath) {
  const home = path.dirname(configPath);
  const dir = hermesPluginDir(configPath);
  const missingDirs = [];
  for (const rel of HERMES_PLUGIN_DIR_CHAIN) {
    if (!(await pathExists(path.join(home, rel)))) {
      missingDirs.push(rel);
    }
  }
  const files = {};
  for (const name of [HERMES_PLUGIN_INIT_FILENAME, HERMES_PLUGIN_MANIFEST_FILENAME]) {
    files[name] = await snapshotFile(path.join(dir, name));
  }
  return { dirExisted: !missingDirs.includes(HERMES_PLUGIN_DIR_CHAIN.at(-1)), missingDirs, files };
}

/**
 * The plugin source with `modelIds` as its model list: a JSON string that
 * Python reads as a string literal (JSON's escapes are a subset of Python's).
 * @param {string[]} modelIds
 */
export function hermesPluginSource(modelIds) {
  return HERMES_PLUGIN_INIT_TEMPLATE.replace(
    HERMES_PLUGIN_MODELS_TOKEN,
    () => JSON.stringify(JSON.stringify(modelIds)),
  );
}

/**
 * @param {string} configPath
 * @param {string[]} modelIds
 */
async function writePlugin(configPath, modelIds) {
  const dir = hermesPluginDir(configPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(path.join(dir, HERMES_PLUGIN_INIT_FILENAME), hermesPluginSource(modelIds), { mode: 0o600 });
  // The source carries the model list, and Python trusts cached bytecode
  // whose source mtime (whole seconds) and size match: a same-length list
  // written within the same second would load the old one. Clear it after the
  // write, so any import from here on compiles the new source.
  await removePluginBytecode(dir);
  await writeFileAtomic(path.join(dir, HERMES_PLUGIN_MANIFEST_FILENAME), HERMES_PLUGIN_MANIFEST_SOURCE, { mode: 0o600 });
}

/**
 * Python's bytecode cache for the plugin's `__init__.py`, which Hermes's
 * import writes beside it; without the source it is Nexus's leftover.
 */
async function removePluginBytecode(dir) {
  const cacheDir = path.join(dir, "__pycache__");
  let names = [];
  try {
    names = await readdir(cacheDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^__init__\..+\.pyc$/.test(name)) {
      await unlinkIfExists(path.join(cacheDir, name));
    }
  }
  await removeEmptyDirs(dir, ["__pycache__"]);
}

/** Remove `rels` (under `home`), innermost first, each only if empty. */
async function removeEmptyDirs(home, rels) {
  for (const rel of [...rels].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(path.join(home, rel));
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) {
        throw error;
      }
    }
  }
}

/**
 * Put the plugin files back the way `on` found them and remove the
 * directories `on` created, keeping anything else found in them. With no
 * snapshot (a config Nexus routed before its backup was lost), remove the
 * files only when they are still Nexus's own.
 */
async function restorePlugin(snapshot, configPath) {
  const home = path.dirname(configPath);
  const dir = hermesPluginDir(configPath);
  if (snapshot?.files) {
    for (const [name, fileSnapshot] of Object.entries(snapshot.files)) {
      await restoreSnapshot(fileSnapshot, path.join(dir, name));
    }
    if (!snapshot.files[HERMES_PLUGIN_INIT_FILENAME]?.existed) {
      await removePluginBytecode(dir);
    }
    // Backups from before `missingDirs` only recorded the plugin directory.
    const created = snapshot.missingDirs
      ?? (snapshot.dirExisted === false ? [HERMES_PLUGIN_DIR_CHAIN.at(-1)] : []);
    await removeEmptyDirs(home, created);
    return;
  }
  const { raw } = await readRawIfExists(path.join(dir, HERMES_PLUGIN_INIT_FILENAME));
  if (raw.includes(HERMES_PLUGIN_MARKER)) {
    await unlinkIfExists(path.join(dir, HERMES_PLUGIN_INIT_FILENAME));
    const manifest = await readRawIfExists(path.join(dir, HERMES_PLUGIN_MANIFEST_FILENAME));
    if (manifest.raw === HERMES_PLUGIN_MANIFEST_SOURCE) {
      await unlinkIfExists(path.join(dir, HERMES_PLUGIN_MANIFEST_FILENAME));
    }
    await removePluginBytecode(dir);
    await removeEmptyDirs(home, [HERMES_PLUGIN_DIR_CHAIN.at(-1)]);
  }
}

/**
 * The model id `on` stores: Fireworks's `auto` mix (or a retired `auto-*`)
 * becomes `nexus-auto`, the id the plugin lists as Nexus Auto and routes back
 * to `auto`; any other model is stored as its short Fireworks ref.
 * @param {string} model
 */
export function hermesModelId(model) {
  const trimmed = String(model ?? "").trim();
  if (trimmed.toLowerCase() === HERMES_NEXUS_AUTO_MODEL_ID) {
    return HERMES_NEXUS_AUTO_MODEL_ID;
  }
  const short = shortFireworksModelRef(normalizeModelId(dropRetiredModelId(trimmed)));
  return short.toLowerCase() === AUTO_MODEL_ID ? HERMES_NEXUS_AUTO_MODEL_ID : short;
}

// The backup holds the user's original `.env`, which can carry their other
// provider keys: keep it private from creation.
async function writeBackup(backupPath, backup) {
  ensurePrivateParent(backupPath);
  await writeJson(backupPath, backup, { mode: 0o600 });
}

/** Record what Nexus last wrote so `off` can tell an untouched file apart. */
async function recordWritten(dataDir, configPath, written) {
  if (!dataDir) {
    return;
  }
  const backupPath = hermesBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);
  if (backup.configPath === undefined) {
    return;
  }
  await writeBackup(backupPath, { ...backup, written: { ...backup.written, ...written } });
}

/**
 * @param {{
 *   configPath: string,
 *   dataDir: string,
 *   effectiveApiKey: string,
 *   modelId?: string,
 *   headers?: Record<string, string>,
 *   catalogModelIds?: string[],
 *   catalogAvailable?: boolean,
 * }} args
 */
export async function enableHermesFireworks({
  configPath,
  dataDir,
  effectiveApiKey: effectiveApiKeyInput = "",
  modelId = "",
  headers = {},
  catalogModelIds = [],
  catalogAvailable = catalogModelIds.length > 0,
}) {
  const effectiveApiKey = effectiveApiKeyInput.trim();
  if (!effectiveApiKey) {
    throw new Error(MISSING_FIREWORKS_API_KEY_MESSAGE);
  }
  const envPath = hermesEnvPath(configPath);
  const [configSnap, envSnap] = await Promise.all([snapshotFile(configPath), snapshotFile(envPath)]);
  // Parse before writing anything: a config Hermes can't read either is left alone.
  const doc = parseHermesDocument(configSnap.raw);
  const current = asPlainObject(doc.toJS()) ?? {};

  // A re-`on` keeps the Fireworks model already selected; another
  // provider's model id means nothing on Fireworks.
  const keptModel = hermesProviderStatus(current) === "fireworks"
    ? dropRetiredModelId(hermesCurrentModelId(current) || "")
    : "";
  const storedModel = hermesModelId(modelId || keptModel || defaultMainModel());

  const backupPath = hermesBackupPath(dataDir, configPath);
  const existingBackup = await readJsonIfExists(backupPath);
  if (existingBackup.configPath !== undefined && existingBackup.configPath !== path.resolve(configPath)) {
    throw new Error(`Backup at ${backupPath} was taken for ${existingBackup.configPath}, not ${configPath}.`);
  }
  // Snapshot once, before the first edit. A config already routed by Nexus
  // with no backup (deleted data dir) has no original left to capture.
  const hasSnapshot = existingBackup.configSnapshot !== undefined;
  const takeSnapshot = !hasSnapshot && !isNexusManagedHermes(current);
  // The plugin directory is snapshotted with the config, so `off` can put
  // back a plugin the user had at that path.
  const pluginSnapshot = hasSnapshot
    ? existingBackup.pluginSnapshot
    : takeSnapshot ? await snapshotPlugin(configPath) : undefined;

  const modelIds = hermesModelList({
    currentIds: registeredHermesModelIds(asPlainObject(current.providers)?.[HERMES_FIREWORKS_PROVIDER_ID]),
    catalogModelIds,
    catalogAvailable,
    selectedId: storedModel,
  });
  patchHermesDocument(doc, {
    modelId: storedModel,
    modelIds,
    headers,
    previousHeaderNames: existingBackup.managedHeaderNames ?? [],
  });
  const nextConfigRaw = serializeHermesDocument(doc);
  const nextEnvRaw = upsertEnvAssignment(envSnap.raw, HERMES_API_KEY_ENV, effectiveApiKey);

  await writeBackup(backupPath, {
    configPath: path.resolve(configPath),
    ...(hasSnapshot
      ? { configSnapshot: existingBackup.configSnapshot, envSnapshot: existingBackup.envSnapshot }
      : takeSnapshot ? { configSnapshot: configSnap, envSnapshot: envSnap } : {}),
    ...(pluginSnapshot ? { pluginSnapshot } : {}),
    managedHeaderNames: Object.keys(headers),
    written: { config: sha256(nextConfigRaw), env: sha256(nextEnvRaw) },
  });

  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  // The plugin first: a config naming `nexus-auto` without it can't route.
  await writePlugin(configPath, modelIds);
  await writeFileAtomic(configPath, nextConfigRaw, { mode: configSnap.mode ?? 0o600 });
  await writeFileAtomic(envPath, nextEnvRaw, { mode: 0o600 });

  return {
    model: storedModel,
    modelsAdded: modelIds,
    modelSpec: `${HERMES_FIREWORKS_PROVIDER_ID}:${storedModel}`,
    authMode: "literal",
    apiKeyMode: "literal",
  };
}

/**
 * @param {{ configPath: string, dataDir: string, wasEnabled?: boolean }} args
 * @returns {Promise<"restored" | "stripped" | "unchanged">}
 */
export async function disableHermesFireworks({ configPath, dataDir, wasEnabled = false }) {
  const backupPath = hermesBackupPath(dataDir, configPath);
  const backup = await readJsonIfExists(backupPath);
  const envPath = hermesEnvPath(configPath);
  const [configNow, envNow] = await Promise.all([readRawIfExists(configPath), readRawIfExists(envPath)]);
  const hasBackup = backup.configPath !== undefined;

  // With no backup, only a config carrying Nexus's attribution is Nexus's to
  // undo: `wasEnabled` alone can't tell it from a Fireworks setup the user
  // made by hand.
  if (!hasBackup) {
    let managed = false;
    try {
      managed = configNow.existed && isNexusManagedHermes(parseHermesConfig(configNow.raw));
    } catch {
      managed = false;
    }
    if (!managed) {
      return "unchanged";
    }
  }
  if (hasBackup && backup.configPath !== path.resolve(configPath)) {
    throw new Error(`Backup at ${backupPath} was taken for ${backup.configPath}, not ${configPath}; refusing to restore.`);
  }

  const written = asPlainObject(backup.written) ?? {};
  const configSnapshot = backup.configSnapshot;
  const envSnapshot = backup.envSnapshot;
  let outcome = /** @type {"restored" | "stripped"} */ ("restored");

  if (configSnapshot && configNow.existed && sha256(configNow.raw) === written.config) {
    await restoreSnapshot(configSnapshot, configPath);
  } else if (configNow.existed) {
    // Rewritten since `on` (Hermes's `/model`, `hermes config set`, an edit):
    // keep those changes and take back only what Nexus set.
    const doc = parseHermesDocument(configNow.raw);
    const original = configSnapshot?.existed
      ? asPlainObject(parseHermesDocument(configSnapshot.raw).toJS()) ?? {}
      : undefined;
    stripHermesDocument(doc, { original, managedHeaderNames: backup.managedHeaderNames ?? [] });
    const nextRaw = serializeHermesDocument(doc);
    const emptied = Object.keys(asPlainObject(doc.toJS()) ?? {}).length === 0;
    if (emptied && !configSnapshot?.existed) {
      await unlinkIfExists(configPath);
    } else {
      await writeFileAtomic(configPath, nextRaw, { mode: configSnapshot?.mode ?? 0o600 });
    }
    outcome = "stripped";
  } else if (configSnapshot?.existed) {
    // Deleted while connected: the original is the only config left.
    await restoreSnapshot(configSnapshot, configPath);
  }

  if (envSnapshot && envNow.existed && sha256(envNow.raw) === written.env) {
    await restoreSnapshot(envSnapshot, envPath);
  } else if (envNow.existed) {
    const originalKey = envSnapshot?.existed ? readEnvAssignment(envSnapshot.raw, HERMES_API_KEY_ENV) : "";
    let envRaw = stripEnvAssignment(envNow.raw, HERMES_API_KEY_ENV);
    if (originalKey) {
      envRaw = upsertEnvAssignment(envRaw, HERMES_API_KEY_ENV, originalKey);
    }
    if (envRaw || envSnapshot?.existed) {
      await writeFileAtomic(envPath, envRaw, { mode: envSnapshot?.mode ?? 0o600 });
    } else {
      await unlinkIfExists(envPath);
    }
    outcome = "stripped";
  } else if (envSnapshot?.existed) {
    await restoreSnapshot(envSnapshot, envPath);
  }

  // After the config: it no longer names `nexus-auto` once restored.
  await restorePlugin(backup.pluginSnapshot, configPath);

  if (!configSnapshot) {
    outcome = "stripped";
  }
  await unlinkIfExists(backupPath);
  return outcome;
}

/**
 * Rewrite the Fireworks key in Hermes's `.env` after `nexus login` stores a
 * new one, when Hermes is routed through Nexus.
 * @param {{ configPath: string, dataDir?: string, fireworksKey: string }} args
 * @returns {Promise<boolean>}
 */
export async function refreshHermesGatewayKey({ configPath, dataDir = "", fireworksKey }) {
  const key = fireworksKey?.trim();
  if (!key) {
    return false;
  }
  const { config } = await readHermesConfigIfExists(configPath);
  if (!(await hermesRoutedByNexus({ configPath, dataDir }, config))) {
    return false;
  }
  const envPath = hermesEnvPath(configPath);
  const envSnap = await readRawIfExists(envPath);
  if (readEnvAssignment(envSnap.raw, HERMES_API_KEY_ENV) === key) {
    return false;
  }
  const nextRaw = upsertEnvAssignment(envSnap.raw, HERMES_API_KEY_ENV, key);
  await mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
  await writeFileAtomic(envPath, nextRaw, { mode: 0o600 });
  await recordWritten(dataDir, configPath, { env: sha256(nextRaw) });
  return true;
}

/**
 * Drop the named provider-key headers from the `providers.fireworks` entry's
 * `extra_headers`, keeping every other header. False when none was present.
 * @param {{ configPath: string, dataDir?: string, headerNames: string[] }} args
 * @returns {Promise<boolean>}
 */
export async function removeHermesSavedProviderKeys({ configPath, dataDir = "", headerNames }) {
  const { existed, raw } = await readRawIfExists(configPath);
  if (!existed) {
    return false;
  }
  const doc = parseHermesDocument(raw);
  const providerNode = fireworksProviderNode(doc);
  const headers = asPlainObject(providerNode?.get("extra_headers", true)?.toJSON?.());
  if (!providerNode || !headers) {
    return false;
  }
  const drop = new Set(headerNames.map((name) => name.toLowerCase()));
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !drop.has(name.toLowerCase())));
  if (Object.keys(kept).length === Object.keys(headers).length) {
    return false;
  }
  setExtraHeaders(doc, providerNode, kept);
  const nextRaw = serializeHermesDocument(doc);
  await writeFileAtomic(configPath, nextRaw, { mode: 0o600 });
  await recordWritten(dataDir, configPath, { config: sha256(nextRaw) });
  return true;
}
