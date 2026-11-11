/**
 * Panel batch executor.
 *
 * Drives one queued batch through application.editDocument and reports the
 * result exactly once, after the *edit callback's own Promise* has settled.
 *
 * Why this exists: `application.editDocument()`'s return value is not
 * documented to be the edit callback's Promise (in XD 61 it was observed to be
 * undefined). Awaiting the return value can therefore report an empty result
 * list before the async edit callback has finished. Completion is keyed on the
 * callback Promise only; the outer return value is ignored on purpose.
 *
 * This file has no DOM/UXP dependency so the completion contract is testable.
 * It performs no document work itself: `execute` is supplied by main.js and
 * runs inside the caller's editDocument callback.
 */
(function () {
  "use strict";

  /**
   * @param {Object} options
   * @param {Object} options.application  module with editDocument()
   * @param {Array}  options.operations   [{op, params}] to execute as one batch
   * @param {Function} options.execute    async (operations) => results[]
   * @param {Function} options.onSettled  (results, error) => void  (called once)
   * @param {string} [options.editLabel]
   * @returns {{ callbackInvoked: boolean, settled: boolean }}
   */
  function runQueuedBatch(options) {
    const opts = options || {};
    const application = opts.application;
    const operations = Array.isArray(opts.operations) ? opts.operations : [];
    const execute = opts.execute;
    const onSettled = opts.onSettled;

    let settled = false;
    let callbackInvoked = false;

    function settle(results, error) {
      if (settled) return;
      settled = true;
      if (typeof onSettled === "function") onSettled(Array.isArray(results) ? results : [], error || null);
    }

    if (!application || typeof application.editDocument !== "function") {
      settle([], new Error("application.editDocument is unavailable"));
      return { callbackInvoked: false, settled: true };
    }
    if (typeof execute !== "function") {
      settle([], new Error("batch executor requires an execute function"));
      return { callbackInvoked: false, settled: true };
    }

    const editCallback = async function () {
      callbackInvoked = true;
      try {
        const results = await execute(operations);
        settle(results, null);
      } catch (e) {
        settle([], e);
      }
    };

    try {
      // XD invokes the callback synchronously when the call is legal (i.e. from
      // a panel UI event). The returned Promise is deliberately not awaited.
      application.editDocument({ editLabel: opts.editLabel || "OpenCode Design Bridge" }, editCallback);
    } catch (e) {
      settle([], e);
      return { callbackInvoked: callbackInvoked, settled: settled };
    }

    if (!callbackInvoked) {
      settle([], new Error("XD did not invoke the edit callback; execute pending must be triggered by a panel UI event"));
    }

    return { callbackInvoked: callbackInvoked, settled: settled };
  }

  (typeof window !== "undefined" ? window : globalThis).__xdBridgeExecutor = {
    runQueuedBatch: runQueuedBatch,
  };
})();
