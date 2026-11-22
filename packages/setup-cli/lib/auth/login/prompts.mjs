import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { accent } from "../../ui/term.mjs";

/**
 * Which kind of account the user signs in with: it picks the browser sign-in
 * (the Nexus page or the Fireworks Platform's) and the page an API key comes from.
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream, browser?: boolean }} [options]  `browser: false` when login goes straight to key paste.
 * @returns {Promise<"nexus" | "platform" | null>}
 */
export async function promptAccountKind({ stdin: in_ = stdin, stdout: out_ = stdout, browser = true } = {}) {
  out_.write("\n");
  out_.write("  Let's sign you in to Nexus on this machine.\n");
  out_.write("\n");
  out_.write("  Which account do you use?\n");
  out_.write("\n");
  out_.write(`    ${accent("1", out_)}) Nexus account: Pro, Team, or Enterprise plan at nexus.fireworks.ai\n`);
  out_.write(`    ${accent("2", out_)}) Fireworks Platform account: app.fireworks.ai\n`);
  out_.write("\n");
  if (browser) {
    out_.write("  Your browser opens to sign in. Company SSO? Press q, then run nexus login --account <account-id>.\n");
  } else {
    out_.write("  This picks the page where you create an API key.\n");
  }
  out_.write(`  You can sign out anytime with ${accent("nexus logout", out_)}.\n`);
  out_.write("\n");
  const rl = createInterface({ input: in_, output: out_ });
  try {
    rl.setPrompt("  Choice [1]: ");
    rl.prompt();
    for await (const line of rl) {
      const answer = line.trim().toLowerCase();
      if (answer === "" || answer === "1") {
        return "nexus";
      }
      if (answer === "2") {
        return "platform";
      }
      if (answer === "q" || answer === "quit") {
        return null;
      }
      out_.write("  Please enter 1 or 2 (or q to cancel).\n");
      rl.prompt();
    }
    return null;
  } finally {
    rl.close();
  }
}

/**
 * @param {string} question
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream, defaultYes?: boolean }} [options]
 * @returns {Promise<boolean|null>}  `null` when input closes (Ctrl-C, EOF) before an answer.
 */
export async function promptYesNo(question, { stdin: in_ = stdin, stdout: out_ = stdout, defaultYes = true } = {}) {
  const rl = createInterface({ input: in_, output: out_ });
  try {
    rl.setPrompt(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `);
    rl.prompt();
    for await (const line of rl) {
      const answer = line.trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        return true;
      }
      if (answer === "n" || answer === "no") {
        return false;
      }
      if (answer === "") {
        return defaultYes;
      }
      out_.write("  Enter y or n.\n");
      rl.prompt();
    }
    return null;
  } finally {
    rl.close();
  }
}

function accountLabel(name) {
  return name.startsWith("accounts/") ? name.slice("accounts/".length) : name;
}

/**
 * @param {string[]} accountNames
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [streams]
 * @returns {Promise<number|null>}
 */
export async function promptAccountChoice(accountNames, { stdin: in_ = stdin, stdout: out_ = stdout } = {}) {
  out_.write("\n");
  out_.write("  Your sign-in is linked to more than one Fireworks account. Which one should this key belong to?\n");
  out_.write("\n");
  accountNames.forEach((name, i) => {
    out_.write(`    ${accent(String(i + 1), out_)}) ${accountLabel(name)}\n`);
  });
  out_.write("\n");
  const rl = createInterface({ input: in_, output: out_ });
  try {
    rl.setPrompt("  Choice [1]: ");
    rl.prompt();
    for await (const line of rl) {
      const answer = line.trim().toLowerCase();
      if (answer === "" || answer === "1") {
        return 0;
      }
      if (answer === "q" || answer === "quit") {
        return null;
      }
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= accountNames.length) {
        return n - 1;
      }
      out_.write(`  Enter 1 to ${accountNames.length}, or q to cancel.\n`);
      rl.prompt();
    }
    return null;
  } finally {
    rl.close();
  }
}
