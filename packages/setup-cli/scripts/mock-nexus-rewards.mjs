#!/usr/bin/env node

/**
 * Local stand-in for the account rewards the Ultra-fast banner mod reads, for
 * trying the banner without a real boost.
 *
 *   node scripts/mock-nexus-rewards.mjs [--port 8799]
 *
 * Then start Claude Code (after `nexus claude on`) with the mod pointed at it:
 *
 *   NEXUS_ULTRAFAST_MOCK_URL=http://127.0.0.1:8799 claude
 *
 * The mod sends a placeholder key to a loopback mock, never the user's
 * Fireworks key, so nothing secret reaches whatever listens on this port, and
 * checks it every few seconds instead of every two minutes.
 *
 * and type commands here:
 *
 *   on            start a POWERUP Ultra-fast window (5h) and show the banner
 *   off           end the boost
 *   replay        play the banner again for the current boost
 *   reason <text> the reward's reason text (default "You sent 5M tokens!")
 *   hours <n>     the boost window length (default 5)
 *   status        show the mock's state
 *   quit          stop
 *
 * Serves /verifyApiKey (any key, a fixed mock account) and the account's
 * Ultra-fast status and rewards; anything else is a 404. Request bodies
 * are never read, and no key is printed or stored.
 *
 * `replay` starts a new activation, so the mod, which remembers what it
 * played, plays the banner again. Dev-only: not shipped (package.json
 * `files` does not include scripts/).
 */

import http from "node:http";
import process from "node:process";
import readline from "node:readline";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8799;
const ACCOUNT = "mock-account";

const state = {
  active: false,
  startedAt: 0,
  hours: 5,
  reason: "You sent 5M tokens!",
  serial: 0,
  replays: 0,
};

/** The running window's id; a replay starts a new one. */
function activationName() {
  return `window-${state.serial}${state.replays ? `-replay-${state.replays}` : ""}`;
}

function windowTimes() {
  const start = new Date(state.startedAt);
  return { start, end: new Date(state.startedAt + state.hours * 3_600_000) };
}

function ultrafastStatus() {
  const readTime = new Date().toISOString();
  const name = `accounts/${ACCOUNT}/nexusUltrafastStatus`;
  if (!state.active) return { name, featureAvailable: true, bankedDuration: "0s", readTime };
  const { start, end } = windowTimes();
  return {
    name,
    featureAvailable: true,
    bankedDuration: "0s",
    readTime,
    activeWindow: {
      windowId: activationName(),
      source: "POWERUP",
      sourceId: `reward-${state.serial}`,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    },
  };
}

function ultrafastRewards() {
  if (!state.active) return { nexusUltrafastRewards: [] };
  const { start } = windowTimes();
  return {
    nexusUltrafastRewards: [{
      name: `accounts/${ACCOUNT}/nexusUltrafastRewards/reward-${state.serial}`,
      source: "TASK",
      powerup: `accounts/${ACCOUNT}/nexusUltrafastPowerups/auto-sessions-10`,
      duration: `${state.hours * 3600}s`,
      createTime: start.toISOString(),
      updateTime: start.toISOString(),
      acknowledged: false,
      reason: state.reason,
    }],
  };
}

function log(line) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(`${line}\n`);
  rl?.prompt(true);
}

const server = http.createServer((req, res) => {
  // Every route is a GET: a request body is discarded unread.
  req.resume();
  const { pathname } = new URL(req.url, "http://x");
  const json = (payload, headers = {}) => {
    res.writeHead(200, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(payload));
  };
  if (req.method === "GET" && pathname === "/verifyApiKey") {
    return json({}, { "x-fireworks-account-id": ACCOUNT });
  }
  if (req.method === "GET" && pathname === `/v1/accounts/${ACCOUNT}/nexusUltrafastStatus`) {
    log(`  ← mod asked for the Ultra-fast status (boost ${state.active ? "on" : "off"})`);
    return json(ultrafastStatus());
  }
  if (req.method === "GET" && pathname === `/v1/accounts/${ACCOUNT}/nexusUltrafastRewards`) {
    return json(ultrafastRewards());
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 5, message: "not served by the mock" }));
});

const commands = {
  on() {
    state.active = true;
    state.startedAt = Date.now();
    state.serial += 1;
    state.replays = 0;
    log(`Boost ON: a ${state.hours}h POWERUP window, reason "${state.reason}". The mod plays the banner within a few seconds.`);
  },
  off() {
    state.active = false;
    log("Boost OFF.");
  },
  replay() {
    if (!state.active) return log("No boost is on; type `on` first.");
    state.replays += 1;
    log("Replaying the banner for the current boost.");
  },
  reason(text) {
    state.reason = text || state.reason;
    log(`Reason: "${state.reason}" (type \`on\` or \`replay\` to see it).`);
  },
  hours(value) {
    const hours = Number(value);
    if (!(hours > 0)) return log("Usage: hours <n>");
    state.hours = hours;
    log(`Window: ${hours}h (type \`on\` to start a new boost with it).`);
  },
  status() {
    log(state.active
      ? `Boost on since ${new Date(state.startedAt).toLocaleTimeString()}, ${state.hours}h window, reason "${state.reason}".`
      : `Boost off. Next \`on\`: ${state.hours}h window, reason "${state.reason}".`);
  },
  quit() {
    process.exit(0);
  },
};

let rl = null;
server.on("error", (error) => {
  console.error(`Couldn't listen on 127.0.0.1:${PORT}: ${error.message}`);
  process.exit(1);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock Nexus rewards API on http://127.0.0.1:${PORT}`);
  console.log("");
  console.log("In another terminal, start Claude Code with:");
  console.log(`  NEXUS_ULTRAFAST_MOCK_URL=http://127.0.0.1:${PORT} claude`);
  console.log("");
  console.log("Commands: on · off · replay · reason <text> · hours <n> · status · quit");
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "mock> " });
  rl.prompt();
  rl.on("line", (line) => {
    const [command, ...rest] = line.trim().split(/\s+/);
    if (command) {
      const run = commands[command.toLowerCase()];
      if (run) run(rest.join(" "));
      else log(`Unknown command "${command}". Commands: ${Object.keys(commands).join(", ")}`);
    }
    rl.prompt();
  });
  rl.on("close", () => commands.quit());
});
