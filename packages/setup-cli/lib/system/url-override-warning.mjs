import { isHttpsOrLoopbackHttp } from "./loopback.mjs";

const warned = new Set();

export function warnInsecureUrlOverride(value, label = "URL override") {
  try {
    if (!value || isHttpsOrLoopbackHttp(new URL(value)) || warned.has(label)) return;
    warned.add(label);
    console.warn(`Warning: ${label} uses a non-HTTPS remote URL; traffic may be exposed.`);
  } catch {
    // Warnings must never interrupt a request or background observer.
  }
}
