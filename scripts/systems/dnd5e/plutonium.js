/**
 * Plutonium integration (DESIGN §19) — the D&D 5e content source.
 *
 * Plutonium (TheGiddyLimit/plutonium-next, module id "plutonium") imports the
 * full 5etools catalogue — including all official 2024 magic items — into
 * Foundry compendiums. This module wants a DEEP integration (the GM's choice):
 * not merely reading whatever packs happen to exist, but actively driving
 * Plutonium to make content available, and preferring Plutonium-sourced packs
 * when indexing loot.
 *
 * Because Plutonium's importer API surface differs across its many Foundry
 * builds (and is not formally published), every hook here is PROBED defensively:
 * we feature-detect a usable entry point and fall back gracefully — to indexing
 * already-imported packs, then to the dnd5e SRD — with a clear GM notification
 * rather than a hard failure. The probe points are centralised in
 * `importApi()` / `ensureContent()` so they are easy to update per Plutonium
 * version without touching the rest of the engine.
 */

import { MODULE_ID, SETTINGS } from "../../const.js";

export const PLUTONIUM_ID = "plutonium";

/** Is the Plutonium module installed and active? */
export function plutoniumActive() {
  const mod = game.modules?.get(PLUTONIUM_ID);
  return !!(mod && mod.active);
}

/** The Plutonium module document (or null). */
function plutoniumModule() {
  return game.modules?.get(PLUTONIUM_ID) ?? null;
}

/**
 * Probe Plutonium for a usable programmatic-import API. Plutonium has exposed
 * import helpers under a few shapes over time; we accept any that looks callable.
 * Returns an object describing what we found, or null. Centralised so a future
 * Plutonium version only needs its entry point added here.
 */
export function importApi() {
  const mod = plutoniumModule();
  if (!mod) return null;
  const api = mod.api ?? globalThis.Plutonium ?? globalThis.PltnmFoundry ?? null;
  if (!api || typeof api !== "object") return null;

  // Common candidate entry points across Plutonium builds (best-effort).
  const importItem =
    api.importItem ?? api.importItemByName ?? api.import?.item ??
    api.Importers?.item?.pImportEntry ?? null;
  const importByName =
    api.importByName ?? api.pImportByName ?? api.import?.byName ?? null;
  const openImporter =
    api.openImporter ?? api.import?.open ?? api.ui?.openImporter ?? null;

  if (!importItem && !importByName && !openImporter) return null;
  return { api, importItem, importByName, openImporter };
}

/** Does Plutonium expose a usable on-demand import path right now? */
export function canDeepImport() {
  return plutoniumActive() && !!importApi();
}

/* ------------------------------ source packs ------------------------------ */

/**
 * The compendium Item packs to index as loot sources, Plutonium-first.
 * Detection (in priority order):
 *   1. an explicit GM-chosen source pack (setting),
 *   2. packs Plutonium flags as its own / whose id mentions plutonium / 5e-tools,
 *   3. world Item compendiums (where Plutonium imports by default),
 *   4. the dnd5e system SRD packs (so the module still works with no Plutonium).
 * Returns a de-duplicated, priority-sorted pack array.
 */
export function sourcePacks() {
  const itemPacks = [...(game.packs ?? [])].filter(
    p => p.metadata?.type === "Item" || p.documentName === "Item"
  );

  const chosen = String(safeSetting(SETTINGS.dnd5eSourcePack, "") ?? "").trim();
  const scored = [];
  for (const p of itemPacks) {
    const id = `${p.collection}`.toLowerCase();
    const label = `${p.metadata?.label ?? ""}`.toLowerCase();
    const pkg = p.metadata?.packageName ?? p.metadata?.package ?? "";
    let score = 0;
    if (chosen && (p.collection === chosen || id.includes(chosen.toLowerCase()))) score += 100;
    if (pkg === PLUTONIUM_ID || hasPlutoniumFlag(p)) score += 50;
    if (/plutonium|5etools|5e-tools|5e\.tools/.test(id + " " + label)) score += 40;
    if (p.metadata?.packageType === "world") score += 20;
    if (/item|magic|loot|treasure|equipment|gear|trove/.test(id + " " + label)) score += 10;
    if (pkg === "dnd5e" || /dnd5e/.test(id)) score += 5; // SRD fallback
    scored.push({ pack: p, score });
  }

  scored.sort((a, b) => b.score - a.score);
  // Keep everything with any positive signal; if nothing scored, fall back to all.
  const picked = scored.filter(s => s.score > 0).map(s => s.pack);
  return picked.length ? picked : itemPacks;
}

function hasPlutoniumFlag(pack) {
  try {
    const flags = pack.metadata?.flags ?? {};
    return !!flags[PLUTONIUM_ID] || Object.keys(flags).some(k => /plutonium/i.test(k));
  } catch { return false; }
}

/* ------------------------------ deep import ------------------------------ */

/**
 * Ensure Plutonium-backed content is available before a generation run. With a
 * usable import API this can trigger Plutonium to import the official item
 * catalogue; without one it no-ops (the packs already imported via Plutonium's
 * UI are indexed instead). Always resolves — never blocks loot generation.
 *
 * Returns { ok, mode } where mode ∈ "deep" | "indexed" | "srd" | "none".
 */
export async function ensureContent({ notify = true } = {}) {
  if (!plutoniumActive()) {
    if (notify) note("Plutonium is not active — sourcing loot from the available dnd5e compendiums (SRD).", "info");
    return { ok: hasAnySource(), mode: hasAnySource() ? "srd" : "none" };
  }

  const apis = importApi();
  if (!apis) {
    if (notify) note("Plutonium is active but exposes no import API in this build — indexing already-imported Plutonium packs. Use Plutonium's importer to add more content.", "info");
    return { ok: true, mode: "indexed" };
  }

  // A deep import is available. We only ATTEMPT a catalogue refresh when the GM
  // has asked for it (setting) to avoid surprising long imports on every run.
  const auto = !!safeSetting(SETTINGS.dnd5eAutoImport, false);
  if (auto && typeof apis.importByName !== "function" && typeof apis.openImporter === "function") {
    try { await apis.openImporter(); } catch (err) { console.warn(`${MODULE_ID} | Plutonium openImporter failed`, err); }
  }
  return { ok: true, mode: "deep" };
}

/**
 * Resolve a named item to a real UUID, importing it through Plutonium on demand
 * when it isn't already in a compendium (deep integration). Best-effort: returns
 * a UUID string or null. The hoard generator uses this to honour LLM-named
 * "wanted" items that aren't in the indexed packs yet.
 */
export async function importItemByName(name) {
  const apis = importApi();
  if (!apis) return null;
  const fn = apis.importByName ?? apis.importItem;
  if (typeof fn !== "function") return null;
  try {
    const res = await fn.call(apis.api, { name, type: "item", category: "item" });
    // Accept a returned document, a uuid string, or { uuid }.
    if (!res) return null;
    if (typeof res === "string") return res;
    return res.uuid ?? res.document?.uuid ?? null;
  } catch (err) {
    console.warn(`${MODULE_ID} | Plutonium import of "${name}" failed`, err);
    return null;
  }
}

/* ------------------------------ utils ------------------------------ */

function hasAnySource() {
  return sourcePacks().length > 0;
}
function note(msg, level = "info") {
  try { ui.notifications?.[level]?.(`GLLG: ${msg}`); } catch { /* ignore */ }
}
function safeSetting(key, fallback) {
  try { return game.settings.get(MODULE_ID, key); } catch { return fallback; }
}
