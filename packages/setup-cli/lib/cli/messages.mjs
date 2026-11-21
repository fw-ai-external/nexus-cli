import { accent, bold, colorsEnabled, dim, muted, ok } from "../ui.mjs";
import { besideLogo } from "../ui/brand-logo.mjs";
import { AZURE_PROVIDER_LABEL } from "../fireworks/azure-core.mjs";
import { isFirerouterModelPattern, isFirerouterModel } from "../fireworks/model-id.mjs";

export const PROVIDER_KEYS_DOCS_URL = "https://docs.fireworks.ai/nexus/provider-keys";

function displayModel(model) {
  if (typeof model !== "string") {
    return "";
  }
  const stripped = model.replace(/\[1m\]$/, "");
  // Keep the firerouter/... routing prefix for compound slugs; collapse others to last segment.
  if (isFirerouterModelPattern(stripped) && !isFirerouterModel(stripped)) {
    return stripped.replace(/^accounts\/fireworks\/(?:models|routers)\//i, "");
  }
  return stripped.split("/").at(-1);
}

/** `Label: nexus …` with the command in accent. */
export function printCommandHint(label, command) {
  const prefix = label.endsWith(":") ? label : `${label}:`;
  console.log(`${prefix} ${accent(command)}`);
}

/** Indented detail (secondary). */
function printDetail(label, value) {
  console.log(`  ${muted(`${label}: ${value}`)}`);
}

/** Primary ✓ headline. */
export function printSuccess(message) {
  console.log(ok(message));
}

/** Plain informational line. */
export function printInfo(message) {
  console.log(message);
}

/** Muted footnote. */
export function printNote(message) {
  console.log(muted(message));
}

/** Dim supporting copy. */
export function printBody(message) {
  console.log(dim(message));
}

// `on` edits settings on this machine only. A cloud or remote agent session
// (even signed in to the same account) never reads them and never sees the key.
export const LOCAL_ONLY_NOTE =
  "Only works on this computer. Cloud and remote agents aren't supported.";

/** Harness turned on (direct Fireworks). */
export function printHarnessConnected(name, { model } = {}) {
  const display = displayModel(model);
  const message = display ? `${name} → Fireworks · ${display}` : `${name} → Fireworks`;
  // The Fireworks symbol beside the success line, on a color TTY only: in a
  // pipe or CI log the bare Braille dots would just be noise.
  if (colorsEnabled(process.stdout)) {
    console.log(besideLogo([ok(message), muted(LOCAL_ONLY_NOTE)]).join("\n"));
    return;
  }
  printSuccess(message);
  printNote(LOCAL_ONLY_NOTE);
}

export function printModelsAdded(models = [], { primaryModel } = {}) {
  const display = [...new Set(models.map(displayModel).filter(Boolean))];
  if (display.length === 0) {
    return;
  }
  let shown = display;
  if (primaryModel !== undefined) {
    const primary = displayModel(primaryModel);
    shown = display.filter((model) => model !== primary);
    if (shown.length === 0) {
      return;
    }
  }
  // Compact one-liner for short lists; wrap into continuation rows once the
  // catalog outgrows a single line.
  const inline = `Also in your model list: ${shown.join(", ")}`;
  if (inline.length <= 76) {
    printNote(inline);
    return;
  }
  printNote("Also in your model list:");
  const width = 76;
  const indent = "  ";
  let row = indent;
  for (const model of shown) {
    const piece = `${model}, `;
    if (row.length > indent.length && row.length + piece.length > width) {
      console.log(muted(row.replace(/, $/, ",")));
      row = indent;
    }
    row += piece;
  }
  console.log(muted(row.replace(/, $/, "")));
}

export function printClaudeModelManagementHints() {
  const rows = [
    ["Browse", "nexus model list"],
    ["Choose model", "nexus claude --model <id>"],
  ];
  console.log("");
  console.log(bold("Manage models"));
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  for (const [label, command] of rows) {
    console.log(`  ${muted(label.padEnd(labelWidth))} ${accent(command)}`);
  }
}

function printSpacer() {
  console.log("");
}

/**
 * Footnotes and restart hint for `<harness> on`, with spacing between sections.
 * @param {string[]} modelsAdded
 * @param {Array<() => void>} footnotes
 * @param {() => void} restartHint
 */
export function printHarnessOnFootnotes(modelsAdded, footnotes, restartHint, { primaryModel } = {}) {
  printModelsAdded(modelsAdded, { primaryModel });
  if (footnotes.length > 0) {
    printSpacer();
    for (const footnote of footnotes) {
      footnote();
    }
  }
  printSpacer();
  restartHint();
}

/**
 * Standard success output for `<harness> on`.
 * @param {{
 *   label: string,
 *   model?: string,
 *   modelsAdded?: string[],
 *   footnotes?: Array<() => void>,
 *   restartHint: () => void,
 *   afterConnected?: () => void | Promise<void>,
 * }} args
 */
export async function printHarnessOnSuccess({
  label,
  model,
  modelsAdded = [],
  footnotes = [],
  restartHint,
  afterConnected,
}) {
  printHarnessConnected(label, { model });
  if (afterConnected) {
    await afterConnected();
  }
  printHarnessOnFootnotes(modelsAdded, footnotes, restartHint, { primaryModel: model });
}

/**
 * Harness turned on via the Azure/Foundry provider: success line, endpoint, and
 * the endpoint.
 * @param {{ id: string, result: { model: string, baseUrl: string, apiKeyMode?: string } }} args
 */
export function printAzureConnected({ id, result }) {
  printSuccess(`${id} → ${AZURE_PROVIDER_LABEL} · ${displayModel(result.model)}`);
  printNote(LOCAL_ONLY_NOTE);
  printDetail("Endpoint", result.baseUrl);
  printSpacer();
}

/** Harness turned off or unchanged. */
export function printHarnessRestored(name) {
  printInfo(`${name} restored to your previous setup.`);
}

export function printHarnessUnchanged(name) {
  printNote(`${name} was not connected; nothing changed.`);
}

export function printRestartHint(message) {
  console.log(muted(message));
}

function printSessionRestartHint(name) {
  printRestartHint(`Restart ${name} to use the new setup.`);
}

export function printClaudeRestartHint() {
  printSessionRestartHint("Claude Code");
}

export function printClaudeModelActivationHint() {
  printSessionRestartHint("Claude Code");
}

export function printCodexRestartHint({
  resume = true,
  providerId = "fireworks-ai",
  providerLabel = "Fireworks",
  sessionsOpen = false,
} = {}) {
  // The app caches the model catalog at boot (see codex/ide-running.mjs); reopen
  // it to pick up the new provider/models. `on`/`off` block while it runs, so
  // this is the matching "reopen it now" nudge. Applies to both on and off.
  printRestartHint("Quit & reopen the ChatGPT app (if you use it) for the change to take effect in its model dropdown.");

  // `codex resume` resolves a session's recorded `model_provider` against the
  // live config.toml; the rollout only stores the provider name, not its
  // definition. The provider table only exists while Nexus routes that
  // provider, so resuming without forcing the provider falls back to OpenAI
  // (or 400s if the session used a ChatGPT account). The resume command only
  // applies after an `on` for that provider. After `off` the table is gone and
  // the ChatGPT app refuses to open those threads, so tell users to re-run `on`.
  // The app has no provider override at all (`turn/start` takes a model, not a
  // provider), so an OpenAI thread sends a Fireworks pick to ChatGPT, which 400s.
  if (!resume) {
    // `off` waited for every Codex session to close and stopped the shared
    // daemon (codex/ide-running.mjs), so the next `codex` already reads it,
    // unless --force left sessions open. The daemon outlives them, so only a
    // rerun with none open stops it.
    printRestartHint(sessionsOpen
      ? "Close every Codex session, then run `nexus codex off` again to finish."
      : "Start Codex again to use the new setup.");
    printRestartHint(
      `ChatGPT app threads started on ${providerLabel} won't open until you run \`nexus codex on\` again.`,
    );
    return;
  }
  printRestartHint(
    `To resume existing Codex sessions with ${providerLabel}:\n`
      + `  codex resume <id> -c model_provider="${providerId}"\n`
      + `ChatGPT app threads started on OpenAI stay on OpenAI. Start a new thread to use ${providerLabel} models.`,
  );
}

export function printPiRestartHint() {
  printSessionRestartHint("Pi");
}

export function printDeepseekRestartHint() {
  printSessionRestartHint("DeepSeek Harness");
}

/**
 * @param {{ gatewayRunning?: boolean }} [opts] A live Hermes gateway (the Hermes
 *   app's, a service's, or a terminal's) read config.yaml at startup and keeps
 *   the old setup until restarted, so the hint names it.
 */
export function printHermesRestartHint({ gatewayRunning = false } = {}) {
  if (!gatewayRunning) {
    printSessionRestartHint("Hermes Agent");
    return;
  }
  // Not `hermes gateway restart`: with no service installed it runs the new
  // gateway in the calling terminal, and closing that terminal stops it.
  printRestartHint(
    "A Hermes gateway is running with the old setup. Restart it: quit and reopen the Hermes app, "
    + "or run `hermes gateway stop` then `hermes gateway ensure`.",
  );
}

export function printOpenCodeRestartHint() {
  printSessionRestartHint("OpenCode");
}
