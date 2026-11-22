import { defineHarness } from "../../harness/types.mjs";
import { resolveFireworksKeyWithSource } from "../../keys/api-key.mjs";
import { printHarnessConnected, printModelsAdded, printCommandHint, printBody, printInfo, printNote } from "../../cli/messages.mjs";
import { LIMITED_NOTE, WORKSPACE_NOTES } from "./core.mjs";
import { printModelAccessNote } from "../../harness/status-display.mjs";
import { harnessModelAccess } from "../../harness/engine.mjs";

// `on` keeps saved custom models, so "rerun on" can't clear them; say what
// actually happens instead.
const DESKTOP_BLOCKED_ADVICE = "Claude Desktop stops listing it after the next catalog refresh (restart Desktop to see the change) "
  + "and lists it again if your account can use it again.";

const LABEL = "Claude Desktop";

const adapter = defineHarness({
  id: "claude-desktop",
  label: LABEL,
  async resolveKey(ctx) {
    return (await resolveFireworksKeyWithSource({ home: ctx.home })).key;
  },
  async on(ctx) {
    if (!ctx.home) throw new Error("HOME is not set; pass --home.");
    const { enableProfileLane } = await import("./profile-lane.mjs");
    const result = await enableProfileLane(ctx.home, { model: ctx.main || undefined });
    printHarnessConnected("Claude Desktop");
    printBody("Chat, Cowork, and Code now run on Fireworks models.");
    printModelsAdded(result.models ?? []);
    printInfo(LIMITED_NOTE);
    for (const note of WORKSPACE_NOTES) printNote(note);
    printCommandHint("Quit and reopen Claude Desktop, then", "nexus claude-desktop status");
    printCommandHint("Undo", "nexus claude-desktop off");
  },
  async off(ctx) {
    // Honors ctx.quiet (uninstall narrates itself) and returns the outcome.
    const { disableProfileLane, readProfileState } = await import("./profile-lane.mjs");
    const log = ctx.quiet ? () => {} : (line) => console.log(line);
    const touched = Boolean(await readProfileState(ctx.home));
    await disableProfileLane(ctx.home, { log: touched ? log : () => {} });
    return touched ? "restored" : "none";
  },
  /**
   * nexus claude-desktop mcp [list]
   * nexus claude-desktop mcp add <name> <https-url> [--client-id …] [--client-secret …]
   * nexus claude-desktop mcp remove <name>
   * nexus claude-desktop mcp sync   (re-detect from sessions + the pre-Nexus deployment + the org registry)
   * The applied 3p profile is the source of truth; restart Desktop after changes.
   */
  async mcp(ctx, args = []) {
    const {
      listProfileConnectors, addProfileConnector, removeProfileConnector, syncProfileConnectors, syncReportLines,
    } = await import("./profile-lane.mjs");
    const [sub, name, url] = args;

    if (!sub || sub === "list") {
      const connectors = await listProfileConnectors(ctx.home);
      if (!connectors.length) { console.log("No connectors in the profile."); return; }
      for (const c of connectors) console.log(`  ${c.name}  ${c.url ?? c.command ?? ""}`);
      return;
    }

    if (sub === "add") {
      // The URL is optional when the connector already exists (attach an
      // OAuth client to a migrated entry without re-typing its URL).
      const existing = url ? undefined : (await listProfileConnectors(ctx.home)).find((c) => c.name === name);
      const target = url ?? existing?.url;
      if (!name || !target) {
        throw new Error("Usage: nexus claude-desktop mcp add <name> [https-url] [--client-id <id>] [--client-secret <secret>]");
      }
      // No OAuth flags + no new URL means keep the connector's client.
      const oauth = ctx.clientId
        ? { clientId: ctx.clientId, ...(ctx.clientSecret ? { clientSecret: ctx.clientSecret } : {}) }
        : existing?.oauth;
      await addProfileConnector(ctx.home, {
        name, url: target,
        ...(oauth ? { oauth } : {}),
      });
      console.log(`Added connector "${name}" to the profile.`);
    } else if (sub === "remove") {
      if (!name) throw new Error("Usage: nexus claude-desktop mcp remove <name>");
      if (!(await removeProfileConnector(ctx.home, name))) {
        console.log(`No connector named "${name}" in the profile.`);
        return;
      }
      console.log(`Removed connector "${name}" from the profile.`);
    } else if (sub === "sync") {
      const synced = await syncProfileConnectors(ctx.home);
      console.log(`Synced ${synced.total} connector(s) into the profile.`);
      for (const line of syncReportLines(synced)) console.log(line);
    } else {
      throw new Error(`Unknown mcp subcommand: ${sub}. Use list | add | remove | sync.`);
    }
    console.log("Restart Claude Desktop to pick up the change.");
  },
  async restart(ctx) {
    if (!ctx.home) throw new Error("HOME is not set; pass --home.");
    const { restartShim } = await import("./profile-lane.mjs");
    await restartShim(ctx.home);
    printBody("Claude Desktop's connection to Fireworks is running again.");
  },
  /**
   * The models added with `on --model`: the rest of the line-up is rebuilt
   * from the served catalog, so only these can name a model it doesn't list.
   */
  modelAccessAdvice: DESKTOP_BLOCKED_ADVICE,
  async configuredModels(ctx) {
    const { readProfileState, readManualModels } = await import("./profile-lane.mjs");
    const state = await readProfileState(ctx.home);
    if (state?.enabled !== true) return [];
    return (await readManualModels(ctx.home))
      .filter((m) => typeof m?.shortId === "string" && m.shortId)
      .map((m) => ({ slot: "custom", model: m.shortId }));
  },
  /**
   * Status's model-access check never reads the keychain. A literal key in
   * the profile is used as is; a Desktop token stands for the stored key,
   * which status can't read without a possible prompt, so it is unknown.
   */
  async modelAccessKeyInUse(ctx) {
    const { readClaudeDesktopProfileLiteralKey } = await import("./profile-lane.mjs");
    return readClaudeDesktopProfileLiteralKey(ctx.home);
  },
  async keyInUse(ctx) {
    const { readClaudeDesktopProfileKey } = await import("./profile-lane.mjs");
    return readClaudeDesktopProfileKey(ctx.home);
  },
  async status(ctx) {
    const { readProfileStatus } = await import("./profile-lane.mjs");
    const profile = await readProfileStatus(ctx.home);
    if (!profile.state) {
      if (ctx.json === true) console.log(JSON.stringify({ enabled: false, lane: null }, null, 2));
      else console.log(`${LABEL}: not configured. Run \`nexus claude-desktop on\`.`);
      return;
    }
    if (profile.state.enabled !== true) {
      if (ctx.json === true) console.log(JSON.stringify({ enabled: false, lane: "profile", incomplete: true }, null, 2));
      else console.log(`${LABEL}: setup did not finish. Run \`nexus claude-desktop on\` to finish it or \`nexus claude-desktop off\` to undo it.`);
      return;
    }
    const modelAccess = await harnessModelAccess(adapter, ctx);
    if (ctx.json === true) {
      console.log(JSON.stringify({
        enabled: true, lane: "profile", port: profile.state.port,
        shimHealthy: profile.shimHealthy, shimUnverified: profile.shimUnverified, profileApplied: profile.appliedProfileIsOurs,
        connectors: profile.state.connectors ?? [],
        modelAccess,
      }, null, 2));
      return;
    }
    console.log(`${LABEL} profile lane: enabled (Chat/Cowork/Code via shim on 127.0.0.1:${profile.state.port})`);
    const shim = profile.shimHealthy ? "healthy"
      : profile.shimUnverified ? `NOT VERIFIED — something answers on port ${profile.state.port} but isn't the Nexus shim, `
        + "and Claude Desktop sends your Fireworks key to that port. Quit Claude Desktop, then run `nexus claude-desktop on`"
        : "NOT RESPONDING — run `nexus claude-desktop restart`";
    console.log(`  Shim: ${shim}`);
    console.log(`  Profile applied: ${profile.appliedProfileIsOurs ? "yes" : "no — restart Claude Desktop or check Setup"}`);
    console.log(`  Connectors migrated: ${(profile.state.connectors ?? []).join(", ") || "none detected"}`);
    printModelAccessNote("claude-desktop", modelAccess, { advice: adapter.modelAccessAdvice });
  },
});

export default adapter;
