/**
 * The meter's hooks for harnesses whose logs are not Claude Code's.
 *
 * `runUsageMeter` reads Claude-shaped records. Another harness (Codex) hands
 * in a translator from its own log lines, and may refresh slow-changing facts
 * (which model served a call) in the background. Both are kept here so the
 * tail loop in `meter.mjs` stays about tailing. No in-folder imports: this sits
 * at the bottom of the layering with `meter-style`.
 */

/**
 * Turns parsed log lines into the records the Dashboard tallies.
 *
 * `translate` is a factory: a translator may keep state across lines (which
 * turn is open, which model a turn uses), so a replay or a rewritten log
 * starts a fresh one with `reset()`. Without a factory every record passes
 * through unchanged. A translator that fails (to build, or on a line) drops
 * lines rather than pass a foreign log through raw, and `failure` keeps the
 * first error so the meter can say why it shows nothing.
 *
 * `onFailure` hears the first error as it happens, so a live frame can say so
 * at once rather than only after the meter closes.
 *
 * @param {(() => (record: any) => any[]) | undefined} translate
 * @param {{ onFailure?: (error: Error) => void }} [options]
 */
export function createRecordReader(translate, { onFailure } = {}) {
  const hasTranslate = typeof translate === "function";
  /** @type {Error | null} */
  let failure = null;
  const fail = (error) => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    try {
      onFailure?.(failure);
    } catch {
      /* a listener can't stop the meter */
    }
  };
  const fresh = () => {
    if (!hasTranslate) return null;
    try {
      return translate();
    } catch (error) {
      fail(error);
      return null;
    }
  };
  let translator = fresh();
  return {
    /** @param {any} record */
    records(record) {
      if (!hasTranslate) return [record];
      if (!translator) return [];
      try {
        const out = translator(record);
        return Array.isArray(out) ? out : [];
      } catch (error) {
        fail(error);
        return [];
      }
    },
    reset() {
      translator = fresh();
    },
    get failure() {
      return failure;
    },
  };
}

/**
 * A background refresh on its own slow cadence that the tail loop never
 * awaits: at most one in flight, at most one start per `everyMs`, and any
 * failure leaves things as they were. `onChange` runs when `run` resolves to
 * `true` (it learned something new). `run` must carry its own deadline: one
 * that never settles keeps the refresh busy, so it never runs again.
 *
 * @param {{ run?: () => Promise<boolean>, everyMs: number, onChange: () => void, now?: () => number }} opts
 */
export function createBackgroundRefresh({ run, everyMs, onChange, now = Date.now }) {
  let startedAt = 0;
  let busy = false;
  return () => {
    if (typeof run !== "function" || busy) return;
    const at = now();
    if (startedAt && at - startedAt < everyMs) return;
    busy = true;
    startedAt = at;
    Promise.resolve()
      .then(() => run())
      .then((changed) => { if (changed === true) onChange(); })
      .catch(() => { /* best effort */ })
      .finally(() => { busy = false; });
  };
}
