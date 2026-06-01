/**
 * ItemSelector — queries PF2e compendia for candidate items and weights them by
 * the cascade's needs (DESIGN §3). Pure selection: it returns lightweight index
 * records ({uuid,name,img,type,level,gp,traits,rarity}); the Materializer later
 * hydrates the chosen UUIDs into real item data (DESIGN §10 — no fake items).
 *
 * The compendium index is built once (across equipment-ish Item packs) and
 * cached for the session. Everything is defensive: a missing pack or odd index
 * shape is skipped with a warning, never thrown.
 */

import { MODULE_ID } from "../const.js";

/** Physical item types we treat as lootable. */
const PHYSICAL_TYPES = new Set([
  "weapon", "armor", "shield", "equipment", "consumable", "treasure", "backpack"
]);

/** Convert a PF2e price coin object (or number) to a gp float. */
export function priceToGp(price) {
  const v = price?.value ?? price;
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const per = Number(v.per) || 1;
  const gp = (Number(v.pp) || 0) * 10 + (Number(v.gp) || 0)
    + (Number(v.sp) || 0) / 10 + (Number(v.cp) || 0) / 100;
  return per > 1 ? gp / per : gp;
}

/** Choose which compendium packs to index — prefer equipment/treasure packs. */
function selectPacks() {
  const all = [...(game.packs ?? [])].filter(
    p => p.metadata?.type === "Item" || p.documentName === "Item"
  );
  const equip = all.filter(p =>
    /equipment|treasure|loot|gear|item/i.test(`${p.collection} ${p.metadata?.label ?? ""}`));
  return equip.length ? equip : all;
}

let _indexCache = null;

/**
 * Build (or return the cached) flat index of priced physical items across the
 * selected packs. Async: getIndex hits the pack stores.
 */
export async function getItemIndex() {
  if (_indexCache) return _indexCache;
  const fields = [
    "system.level.value",
    "system.price.value",
    "system.traits.value",
    "system.traits.rarity"
  ];
  const out = [];
  for (const pack of selectPacks()) {
    try {
      const idx = await pack.getIndex({ fields });
      for (const e of idx) {
        if (!PHYSICAL_TYPES.has(e.type)) continue;
        const gp = priceToGp(e.system?.price?.value);
        if (!(gp > 0)) continue; // skip unpriced / quest-only items
        out.push({
          uuid: e.uuid ?? `Compendium.${pack.collection}.${e._id}`,
          name: e.name,
          img: e.img,
          type: e.type,
          level: Number(e.system?.level?.value) || 0,
          gp,
          traits: Array.isArray(e.system?.traits?.value) ? e.system.traits.value : [],
          rarity: e.system?.traits?.rarity ?? "common"
        });
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | item index failed for ${pack?.collection}`, err);
    }
  }
  _indexCache = out;
  console.log(`${MODULE_ID} | indexed ${out.length} priced items across ${selectPacks().length} packs`);
  return out;
}

/** Drop the cached index (e.g. after the GM installs a new compendium). */
export function clearItemIndex() { _indexCache = null; }

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

/** Name patterns for fundamental rune items, indexed by tier (1..3). */
const RUNE_PATTERNS = {
  attack:    [/weapon potency \(\+1\)/i, /weapon potency \(\+2\)/i, /weapon potency \(\+3\)/i],
  striking:  [/^striking rune/i, /greater striking rune/i, /major striking rune/i],
  defense:   [/armor potency \(\+1\)/i, /armor potency \(\+2\)/i, /armor potency \(\+3\)/i],
  resilient: [/^resilient rune/i, /greater resilient rune/i, /major resilient rune/i]
};

/**
 * Find the fundamental rune item that fills (or best approaches) a gap on an
 * axis at the desired tier, within budget. Steps down a tier if the ideal one
 * is unaffordable. Returns { item, tier } or null.
 */
export function findRune(index, axis, tier, maxGp = Infinity) {
  const pats = RUNE_PATTERNS[axis];
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
