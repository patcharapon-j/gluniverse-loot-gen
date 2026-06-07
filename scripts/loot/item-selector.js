/**
 * ItemSelector — queries the active system's compendia for candidate items and
 * weights them by the cascade's needs (DESIGN §3). Pure selection: it returns
 * lightweight index records ({uuid,name,img,type,level,gp,traits,rarity,…}); the
 * Materializer later hydrates the chosen UUIDs into real item data (DESIGN §10).
 *
 * The pack selection and per-entry mapping are SYSTEM-SPECIFIC and delegated to
 * the active SystemAdapter (scripts/systems/registry.js), so the selector works
 * for both PF2e and D&D 5e. The compendium index is built once and cached for
 * the session. Everything is defensive: a missing pack or odd shape is skipped
 * with a warning, never thrown.
 */

import { MODULE_ID } from "../const.js";
import { FUNDAMENTAL_PATTERNS } from "../pf2e/runes.js";
import { getAdapter } from "../systems/registry.js";

/** Convert a price value to a gp float, via the active adapter (PF2e default). */
export function priceToGp(price) {
  const a = getAdapter();
  if (a?.priceToGp) return a.priceToGp(price);
  const v = price?.value ?? price;
  if (typeof v === "number") return v;
  return 0;
}

let _indexCache = null;

/**
 * Build (or return the cached) flat index of priced physical items across the
 * active system's packs. Async: getIndex hits the pack stores. The adapter
 * decides which packs to read, which fields to request, and how to map each
 * compendium entry into a neutral index record (or skip it).
 */
export async function getItemIndex() {
  if (_indexCache) return _indexCache;
  const adapter = getAdapter();
  if (!adapter) { _indexCache = []; return _indexCache; }

  const fields = adapter.indexFields();
  const packs = adapter.selectPacks();
  const out = [];
  for (const pack of packs) {
    try {
      const idx = await pack.getIndex({ fields });
      for (const e of idx) {
        const rec = adapter.indexEntry(e, pack);
        if (rec) out.push(rec);
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | item index failed for ${pack?.collection}`, err);
    }
  }
  _indexCache = out;
  console.log(`${MODULE_ID} | indexed ${out.length} ${adapter.id} items across ${packs.length} packs`);
  return out;
}

/** Drop the cached index (e.g. after the GM installs a new compendium). */
export function clearItemIndex() { _indexCache = null; }

/**
 * Candidate *mundane base* weapons or armor to etch runes onto (DESIGN §9):
 * plain, common, runeless gear whose value is essentially the base item. These
 * are the legal canvases for a freshly-etched rune set.
 */
export function mundaneBases(index, kind) {
  return index.filter(it =>
    it.type === kind && it.meta && !it.meta.hasRunes
    && it.level <= 0 && it.rarity === "common");
}

/** Filter the index to a level/price/type window. */
export function filterCandidates(index, {
  minLevel = 0, maxLevel = 20, maxGp = Infinity, types = null, excludeUuids = null
} = {}) {
  return index.filter(it =>
    it.level >= minLevel && it.level <= maxLevel && it.gp <= maxGp
    && (!types || types.has(it.type))
    && (!excludeUuids || !excludeUuids.has(it.uuid)));
}

/**
 * Relative selection weight for an item.
 *   tags        — request Tags; trait overlap boosts the weight (DESIGN §7 soft).
 *   preferLevel — items near this level are favored.
 *   unusualBias — 0..1 favors higher rarity (the "unusual" pool, DESIGN §8);
 *                 negative favors common ("core").
 */
export function weightFor(item, { tags, preferLevel, unusualBias = 0 } = {}) {
  let w = 1;

  const reqTraits = tags?.traits ?? [];
  if (reqTraits.length && item.traits.length) {
    const hits = item.traits.filter(t => reqTraits.includes(t)).length;
    w *= 1 + hits * 1.5;
  }

  if (Number.isFinite(preferLevel)) {
    w *= 1 / (1 + Math.abs(item.level - preferLevel) * 0.5);
  }

  const isRare = item.rarity && item.rarity !== "common";
  if (unusualBias > 0) w *= isRare ? 1 + unusualBias * 2 : 1;
  else if (unusualBias < 0) w *= isRare ? Math.max(0.1, 1 + unusualBias) : 1 + (-unusualBias);

  return Math.max(0, w);
}

/** Weighted-random pick from a list using weightFn(item) → number. */
export function weightedPick(items, weightFn) {
  if (!items.length) return null;
  const weights = items.map(it => Math.max(0, weightFn(it)));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/* ----------------------------- fundamental runes ----------------------------- */

/**
 * Find the fundamental rune item that fills (or best approaches) a gap on an
 * axis at the desired tier, within budget. Steps down a tier if the ideal one
 * is unaffordable. Returns { item, tier } or null. Patterns are grounded in the
 * shared rune table (scripts/pf2e/runes.js) so the truth lives in one place.
 */
export function findRune(index, axis, tier, maxGp = Infinity) {
  const pats = FUNDAMENTAL_PATTERNS[axis];
  if (!pats) return null;
  for (let t = Math.min(tier, pats.length); t >= 1; t--) {
    const pat = pats[t - 1];
    const matches = index.filter(it => pat.test(it.name) && it.gp <= maxGp);
    if (matches.length) {
      matches.sort((a, b) => a.gp - b.gp);
      return { item: matches[0], tier: t };
    }
  }
  return null;
}
