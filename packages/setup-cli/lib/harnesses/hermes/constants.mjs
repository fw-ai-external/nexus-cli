import { FIREWORKS_OPENAI_BASE_URL } from "../../fireworks/model-id.mjs";
export const HERMES_HOME_RELATIVE_DIR = ".hermes";
export const HERMES_DATA_RELATIVE_DIR = ".nexus/hermes";
export const HERMES_CONFIG_FILENAME = "config.yaml";
export const HERMES_ENV_FILENAME = ".env";
/** JSON record (`{ pid, kind: "hermes-gateway", … }`) the running gateway writes beside config.yaml. */
export const HERMES_GATEWAY_PID_FILENAME = "gateway.pid";

/** Hermes's built-in Fireworks provider (aliases: `fireworks-ai`, `fw`). */
export const HERMES_FIREWORKS_PROVIDER_ID = "fireworks";
export const HERMES_FIREWORKS_PROVIDER_ALIASES = Object.freeze(["fireworks", "fireworks-ai", "fw"]);
export const HERMES_FIREWORKS_BASE_URL = FIREWORKS_OPENAI_BASE_URL;
export const HERMES_API_KEY_ENV = "FIREWORKS_API_KEY";
/** Hermes's default `model.provider`: detect the provider from the credentials it finds. */
export const HERMES_DEFAULT_PROVIDER = "auto";

/**
 * The model id `on` selects and the Nexus plugin lists first under Fireworks
 * AI; the plugin maps it back to Fireworks's `auto` route on the wire. The
 * picker shows the id as-is; the status bar shows the alias below.
 */
export const HERMES_NEXUS_AUTO_MODEL_ID = "nexus-auto";
/** `model_aliases:` key; Hermes's status bar shows it in place of the id. */
export const HERMES_NEXUS_AUTO_ALIAS = "Nexus Auto";

/**
 * The Hermes provider plugin `on` installs (and `off` removes): Hermes loads
 * `$HERMES_HOME/plugins/model-providers/<name>/` in place of the bundled
 * provider of that name, which is how `nexus-auto` can list and route.
 */
export const HERMES_PLUGIN_RELATIVE_DIR = "plugins/model-providers/fireworks";
export const HERMES_PLUGIN_INIT_FILENAME = "__init__.py";
export const HERMES_PLUGIN_MANIFEST_FILENAME = "plugin.yaml";
