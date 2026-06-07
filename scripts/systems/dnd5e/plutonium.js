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

import { MODULE_ID, SETTINGS, SOURCE_MODE } from "../../const.js";

export const PLUTONIUM_ID = "plutonium";

/** The GM-selected 5e source mode (defaults to AUTO). */
export function sourceMode() {
  const m = String(safeSetting(SETTINGS.dnd5eSourceMode, SOURCE_MODE.AUTO) ?? "").trim();
  return m === SOURCE_MODE.PLUTONIUM || m === SOURCE_MODE.INTERNAL ? m : SOURCE_MODE.AUTO;
}

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

/** Does Plutonium expose a usable on-demand import path right now? Never in
 *  INTERNAL mode — that mode is pinned to already-present system compendiums. */
export function canDeepImport() {
  return sourceMode() !== SOURCE_MODE.INTERNAL && plutoniumActive() && !!importApi();
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
 *
 * The source MODE narrows the candidate set first:
 *   PLUTONIUM — only Plutonium-sourced packs are eligible at all.
 *   INTERNAL  — only the dnd5e system's own bundled (SRD) packs are eligible.
 *   AUTO      — every Item pack is eligible and ranked by the score below.
 */
export function sourcePacks() {
  const mode = sourceMode();
  let itemPacks = [...(game.packs ?? [])].filter(
    p => p.metadata?.type === "Item" || p.documentName === "Item"
  );

  if (mode === SOURCE_MODE.PLUTONIUM) itemPacks = itemPacks.filter(isPlutoniumPack);
  else if (mode === SOURCE_MODE.INTERNAL) itemPacks = itemPacks.filter(isInternalPack);

  // Explicit pack picker — one OR MORE collection ids/names, comma-separated.
  // When set it RESTRICTS the pool to the named packs (across whatever the mode
  // left eligible); blank = auto-detect by the scoring below.
  const chosen = parseList(safeSetting(SETTINGS.dnd5eSourcePack, ""));
  if (chosen.length) itemPacks = itemPacks.filter(p => matchesChosen(p, chosen));

  const scored = [];
  for (const p of itemPacks) {
    const id = `${p.collection}`.toLowerCase();
    const label = `${p.metadata?.label ?? ""}`.toLowerCase();
    const pkg = p.metadata?.packageName ?? p.metadata?.package ?? "";
    let score = 0;
    if (chosen.length && matchesChosen(p, chosen)) score += 100;
    if (pkg === PLUTONIUM_ID || hasPlutoniumFlag(p)) score += 50;
    if (/plutonium|5etools|5e-tools|5e\.tools/.test(id + " " + label)) score += 40;
    if (p.metadata?.packageType === "world") score += 20;
    if (/item|magic|loot|treasure|equipment|gear|trove/.test(id + " " + label)) score += 10;
    if (pkg === "dnd5e" || /dnd5e/.test(id)) score += 5; // SRD fallback
    scored.push({ pack: p, score });
  }

  scored.sort((a, b) => b.score - a.score);
  // Keep everything with any positive signal; if nothing scored, fall back to
  // the (already mode-filtered) candidate set so a pinned mode never leaks packs.
  const picked = scored.filter(s => s.score > 0).map(s => s.pack);
  return picked.length ? picked : itemPacks;
}

/** A pack that came from Plutonium (by package name, flag, or naming). */
function isPlutoniumPack(pack) {
  const pkg = pack.metadata?.packageName ?? pack.metadata?.package ?? "";
  const id = `${pack.collection}`.toLowerCase();
  const label = `${pack.metadata?.label ?? ""}`.toLowerCase();
  return pkg === PLUTONIUM_ID || hasPlutoniumFlag(pack) ||
    /plutonium|5etools|5e-tools|5e\.tools/.test(id + " " + label);
}

/** A pack bundled by the dnd5e system itself (the internal SRD compendiums). */
function isInternalPack(pack) {
  const pkg = pack.metadata?.packageName ?? pack.metadata?.package ?? "";
  return pack.metadata?.packageType === "system" || pkg === "dnd5e";
}

/** Split a comma-separated setting into lowercased, trimmed, non-empty tokens. */
function parseList(raw) {
  return String(raw ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Does a pack match any of the GM's chosen tokens (by collection id or label)? */
function matchesChosen(pack, tokens) {
  const id = `${pack.collection}`.toLowerCase();
  const label = `${pack.metadata?.label ?? ""}`.toLowerCase();
  return tokens.some(t => id === t || id.includes(t) || label.includes(t));
}

/* ---------------------------- source allow-list ---------------------------- */

let _allowRaw = null;
let _allowSet = null;

/**
 * The GM's per-source allow-list (SETTINGS.dnd5eSourceBooks) as a normalized Set,
 * or null when unrestricted. This is layered ON TOP of pack/mode selection so a
 * GM can draw from, say, only their homebrew source even though Plutonium imported
 * the core books into the same compendium. Memoized on the raw string.
 */
export function sourceAllowList() {
  const raw = String(safeSetting(SETTINGS.dnd5eSourceBooks, "") ?? "").trim();
  if (raw !== _allowRaw) {
    _allowRaw = raw;
    _allowSet = raw
      ? new Set(raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean))
      : null;
  }
  return _allowSet;
}

/**
 * Is an item from the given source permitted? When no allow-list is set, every
 * source passes. When one IS set, an item with no detectable source is excluded
 * (the whole point of an allow-list is to opt in), and homebrew names match by
 * substring so "My Homebrew" also accepts "My Homebrew Vol. 2".
 */
export function sourceAllowed(src) {
  const allow = sourceAllowList();
  if (!allow) return true;
  const s = String(src ?? "").trim().toLowerCase();
  if (!s) return false;
  if (allow.has(s)) return true;
  for (const a of allow) if (a && (s.includes(a) || a.includes(s))) return true;
  return false;
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
 * Returns { ok, mode } where mode ∈ "deep" | "indexed" | "srd" | "internal" | "none".
 */
export async function ensureContent({ notify = true } = {}) {
  const mode = sourceMode();

  // INTERNAL: pinned to the system's own compendiums; never consult Plutonium.
  if (mode === SOURCE_MODE.INTERNAL) {
    const ok = hasAnySource();
    if (notify) {
      note(ok
        ? "Internal-compendium mode — sourcing loot only from the dnd5e system's bundled (SRD) packs."
        : "Internal-compendium mode is on, but no dnd5e system Item packs were found.", ok ? "info" : "warn");
    }
    return { ok, mode: ok ? "internal" : "none" };
  }

  // PLUTONIUM: require Plutonium; do not silently fall back to SRD.
  if (mode === SOURCE_MODE.PLUTONIUM && !plutoniumActive()) {
    if (notify) note("Source mode is set to Plutonium-only, but Plutonium is not active — install & enable it (or switch the source mode). No loot can be drawn.", "warn");
    return { ok: false, mode: "none" };
  }

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
  if (sourceMode() === SOURCE_MODE.INTERNAL) return null; // never import in internal-only mode
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
