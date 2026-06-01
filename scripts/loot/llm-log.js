/**
 * LLM call log — a small client-side ring buffer of recent sidecar calls
 * (flavor + workshop), surfaced through a module-settings menu so the GM can see
 * what was sent, whether it succeeded, how long it took, and why it failed
 * (timeout, HTTP 502, bad JSON…). Purely diagnostic; never blocks the loot loop.
 *
 * An in-memory cache is the source of truth to avoid read-modify-write races
 * between back-to-back calls; it is mirrored into a hidden client setting so the
 * history survives a reload.
 */

import { MODULE_ID, SETTINGS } from "../const.js";

const MAX_ENTRIES = 60;

let cache = null;

function ensure() {
  if (cache) return cache;
  try {
    const v = game.settings.get(MODULE_ID, SETTINGS.llmLog);
    cache = Array.isArray(v) ? v.slice(-MAX_ENTRIES) : [];
  } catch { cache = []; }
  return cache;
}

function persist() {
  try { game.settings.set(MODULE_ID, SETTINGS.llmLog, cache.slice()); }
  catch (err) { console.warn(`${MODULE_ID} | failed to persist LLM log`, err); }
}

/** Record one sidecar call. Fire-and-forget; tolerant of partial entries. */
export function logLlmCall(entry = {}) {
  const log = ensure();
  log.push({
    ts: Date.now(),
    kind: String(entry.kind ?? "llm"),
    endpoint: String(entry.endpoint ?? ""),
    ok: !!entry.ok,
    status: entry.status ?? null,
    ms: Math.max(0, Math.round(Number(entry.ms) || 0)),
    detail: String(entry.detail ?? "").slice(0, 300),
    error: entry.error ? String(entry.error).slice(0, 300) : ""
  });
  while (log.length > MAX_ENTRIES) log.shift();
  persist();
}

/** Newest-first copy of the log for display. */
export function getLlmLog() {
  return ensure().slice().reverse();
}

/** Drop every recorded entry. */
export function clearLlmLog() {
  cache = [];
  persist();
}
