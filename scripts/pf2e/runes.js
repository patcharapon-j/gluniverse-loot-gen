/**
 * Grounded PF2e rune reference — the single source of truth for which runes
 * exist, what they cost, what level they are, and (critically) what they may be
 * etched onto. Reconciled by hand against the Archives of Nethys "Runes" index
 * (Fundamental Weapon/Armor Runes, Weapon Property Runes, Armor Property Runes).
 *
 * Why this file exists: the generator etches *appropriate* rune sets onto weapon
 * and armor loot (DESIGN §9 — runes-as-loot). "Appropriate" means legal — every
 * property rune carries the Usage restriction from its stat block (e.g. Keen is
 * "piercing or slashing melee", Shadow is "light or medium armor", Magnetizing
 * is "metal armor"), so we never mint an illegal item like a keen mace.
 *
 * Prices/levels are RAW (gp). Slugs follow the PF2e system's rune model
 * (camelCase; graded variants prefixed "greater"/"major"/"true"). Because
 * third-party or older system builds may not know every long-tail slug, etch-time code
 * validates each slug against the live system config and silently drops unknowns
 * (see `knownRuneSlug`), so a missing slug degrades to "rune not etched" rather
 * than an invalid item.
 *
 * Fundamental rune levels are identical to the ABP thresholds in tables.js
 * (intentionally — they are the same yardstick).
 */

import { expectedFundamentals } from "./tables.js";

/* ============================================================
   Fundamental runes (tier → level → price). Tier is the index+1.
   ============================================================ */

/** Weapon potency (+1/+2/+3). axis "attack". */
export const WEAPON_POTENCY = [
  { tier: 1, level: 2,  price: 35 },
  { tier: 2, level: 10, price: 935 },
  { tier: 3, level: 16, price: 8935 }
];

/** Striking dice (striking/greater/major). axis "striking". */
export const STRIKING = [
  { tier: 1, slug: "striking",        name: "striking",         level: 4,  price: 65 },
  { tier: 2, slug: "greaterStriking", name: "greater striking", level: 12, price: 1065 },
  { tier: 3, slug: "majorStriking",   name: "major striking",   level: 19, price: 31065 }
];

/** Armor potency (+1/+2/+3). axis "defense". */
export const ARMOR_POTENCY = [
  { tier: 1, level: 5,  price: 160 },
  { tier: 2, level: 11, price: 1060 },
  { tier: 3, level: 18, price: 20560 }
];

/** Resilient (resilient/greater/major). axis "resilient". */
export const RESILIENT = [
  { tier: 1, slug: "resilient",        name: "resilient",         level: 8,  price: 340 },
  { tier: 2, slug: "greaterResilient", name: "greater resilient", level: 14, price: 3440 },
  { tier: 3, slug: "majorResilient",   name: "major resilient",   level: 20, price: 49440 }
];

/** Axis → fundamental progression table. */
export const FUNDAMENTAL = {
  attack: WEAPON_POTENCY,
  striking: STRIKING,
  defense: ARMOR_POTENCY,
  resilient: RESILIENT
};

/** Name patterns for matching fundamental rune *items* in a compendium index. */
export const FUNDAMENTAL_PATTERNS = {
  attack:    [/weapon potency \(\+1\)/i, /weapon potency \(\+2\)/i, /weapon potency \(\+3\)/i],
  striking:  [/^striking rune/i, /greater striking rune/i, /major striking rune/i],
  defense:   [/armor potency \(\+1\)/i, /armor potency \(\+2\)/i, /armor potency \(\+3\)/i],
  resilient: [/^resilient rune/i, /greater resilient rune/i, /major resilient rune/i]
};

/** The fundamental entry at a tier (1..3), or null. */
export function fundamentalAt(axis, tier) {
  const table = FUNDAMENTAL[axis];
  if (!table) return null;
  const t = Math.max(0, Math.trunc(Number(tier) || 0));
  return t >= 1 && t <= table.length ? table[t - 1] : null;
}

/* ============================================================
   Property runes. `on` encodes the Usage restriction:
     weapons: { melee, thrown, damage:[…], baseItem, monk, excludeTrait }
     armor:   { category:[…], material }
   An omitted field means "no restriction on that axis".
   `usage` keeps the verbatim stat-block restriction for traceability.
   ============================================================ */

/** Weapon property runes (AoN). */
export const WEAPON_PROPERTY = defineRunes("weapon", [
  // name, level, price, rarity, on, usage
  ["Fanged",              2,  30,    "uncommon", { melee: true }, "etched onto a melee weapon"],
  ["Authorized",          3,  50,    "common",   {}, "etched onto a weapon"],
  ["Crushing",            3,  50,    "uncommon", { damage: ["bludgeoning"] }, "etched onto a bludgeoning weapon"],
  ["Underwater",          3,  50,    "common",   {}, "etched onto a weapon"],
  ["Kin-Warding",         3,  52,    "uncommon", { baseItem: "clan-dagger" }, "etched onto a clan dagger"],
  ["Returning",           3,  55,    "common",   { thrown: true }, "etched onto a thrown weapon"],
  ["Merciful",            4,  70,    "common",   {}, "etched onto a weapon"],
  ["Ghost Touch",         4,  75,    "common",   {}, "etched onto a weapon"],
  ["Bane",                4,  100,   "uncommon", {}, "etched onto a weapon"],
  ["Earthbinding",        5,  125,   "common",   {}, "etched onto a weapon"],
  ["Cunning",             5,  140,   "uncommon", { damage: ["slashing", "piercing"] }, "etched on a slashing or piercing weapon"],
  ["Hooked",              5,  140,   "rare",     { melee: true }, "etched onto a melee weapon"],
  ["Pacifying",           5,  150,   "common",   {}, "etched onto a weapon"],
  ["Vitalizing",          5,  150,   "common",   {}, "etched onto a weapon"],
  ["Fearsome",            5,  160,   "common",   {}, "etched onto a weapon"],
  ["Shifting",            6,  225,   "common",   { melee: true }, "etched onto a melee weapon"],
  ["Hauling",             6,  225,   "uncommon", {}, "etched onto a weapon"],
  ["Demolishing",         6,  225,   "rare",     {}, "etched onto a weapon"],
  ["Energizing",          6,  250,   "uncommon", {}, "etched onto a weapon"],
  ["Flickering",          6,  250,   "uncommon", {}, "etched onto a weapon"],
  ["Conducting",          7,  300,   "common",   {}, "etched onto a weapon"],
  ["Wounding",            7,  340,   "common",   { damage: ["piercing", "slashing"], melee: true }, "etched onto a piercing or slashing melee weapon"],
  ["Called",              7,  350,   "common",   {}, "etched onto a weapon"],
  ["Deathdrinking",       7,  360,   "rare",     {}, "etched onto a weapon without a disrupting rune"],
  ["Flurrying",           7,  360,   "common",   { melee: true, monk: true }, "etched onto a melee weapon with the monk trait"],
  ["Rooting",             7,  360,   "common",   { melee: true }, "etched onto a melee weapon"],
  ["Astral",              8,  450,   "common",   {}, "etched onto a weapon"],
  ["Giant-Killing",       8,  450,   "rare",     {}, "etched onto a weapon"],
  ["Fanged (Greater)",    8,  425,   "uncommon", { melee: true }, "etched onto a melee weapon"],
  ["Bloodbane",           8,  475,   "uncommon", { baseItem: "clan-dagger" }, "etched onto a clan dagger"],
  ["Corrosive",           8,  500,   "common",   {}, "etched onto a weapon"],
  ["Decaying",            8,  500,   "common",   {}, "etched onto a weapon"],
  ["Flaming",             8,  500,   "common",   {}, "etched onto a weapon"],
  ["Frost",               8,  500,   "common",   {}, "etched onto a weapon"],
  ["Shock",               8,  500,   "common",   {}, "etched onto a weapon"],
  ["Thundering",          8,  500,   "common",   {}, "etched onto a weapon"],
  ["Nightmare",           9,  250,   "uncommon", {}, "etched onto a weapon"],
  ["Crushing (Greater)",  9,  650,   "uncommon", { damage: ["bludgeoning"] }, "etched onto a bludgeoning weapon"],
  ["Ashen",               9,  700,   "uncommon", {}, "etched onto a weapon"],
  ["Coating",             9,  700,   "common",   {}, "etched onto a weapon"],
  ["Extending",           9,  700,   "common",   { melee: true }, "etched onto a melee weapon"],
  ["Grievous",            9,  700,   "common",   {}, "etched onto a weapon"],
  ["Swarming",            9,  700,   "common",   { thrown: true }, "etched onto a thrown weapon"],
  ["Anchoring",           10, 900,   "uncommon", {}, "etched onto a weapon"],
  ["Impactful",           10, 1000,  "common",   {}, "etched onto a weapon"],
  ["Serrating",           10, 1000,  "uncommon", { damage: ["slashing"], melee: true }, "etched onto a slashing melee weapon"],
  ["Hopeful",             11, 1200,  "uncommon", {}, "etched onto a weapon"],
  ["Hauling (Greater)",   11, 1300,  "uncommon", {}, "etched onto a weapon"],
  ["Holy",                11, 1400,  "common",   { excludeTrait: "unholy" }, "etched onto a weapon that isn't unholy"],
  ["Rooting (Greater)",   11, 1400,  "common",   { melee: true }, "etched onto a melee weapon"],
  ["Unholy",              11, 1400,  "common",   { excludeTrait: "holy" }, "etched into a weapon that isn't holy"],
  ["Brilliant",           12, 2000,  "common",   {}, "etched onto a weapon"],
  ["Fearsome (Greater)",  12, 2000,  "common",   {}, "etched onto a weapon"],
  ["Animated",            13, 2700,  "uncommon", { melee: true }, "etched onto a melee weapon"],
  ["Spell Reservoir",     13, 2700,  "uncommon", { melee: true }, "etched onto a melee weapon"],
  ["Bloodbane (Greater)", 13, 2800,  "uncommon", { baseItem: "clan-dagger" }, "etched onto a clan dagger"],
  ["Extending (Greater)", 13, 3000,  "common",   { melee: true }, "etched onto a melee weapon"],
  ["Keen",                13, 3000,  "uncommon", { damage: ["piercing", "slashing"], melee: true }, "etched onto a piercing or slashing melee weapon"],
  ["Shockwave",           13, 3000,  "uncommon", { damage: ["bludgeoning"], melee: true }, "etched onto a bludgeoning melee weapon"],
  ["Vitalizing (Greater)", 14, 4300, "common",   {}, "etched onto a weapon"],
  ["Astral (Greater)",    15, 6000,  "common",   {}, "etched onto a weapon"],
  ["Fanged (Major)",      15, 6000,  "uncommon", { melee: true }, "etched onto a melee weapon"],
  ["Giant-Killing (Greater)", 15, 6000, "rare",  {}, "etched onto a weapon"],
  ["Corrosive (Greater)", 15, 6500,  "common",   {}, "etched onto a weapon"],
  ["Decaying (Greater)",  15, 6500,  "common",   {}, "etched onto a weapon"],
  ["Flaming (Greater)",   15, 6500,  "common",   {}, "etched onto a weapon"],
  ["Frost (Greater)",     15, 6500,  "common",   {}, "etched onto a weapon"],
  ["Rooting (Major)",     15, 6500,  "common",   { melee: true }, "etched onto a melee weapon"],
  ["Shock (Greater)",     15, 6500,  "common",   {}, "etched onto a weapon"],
  ["Thundering (Greater)", 15, 6500, "common",   {}, "etched onto a weapon"],
  ["Ancestral Echoing",   15, 9500,  "rare",     {}, "etched onto a weapon"],
  ["Bloodthirsty",        16, 8500,  "uncommon", { damage: ["slashing", "piercing"], melee: true }, "etched onto a slashing or piercing melee weapon"],
  ["Ashen (Greater)",     16, 9000,  "uncommon", {}, "etched onto a weapon"],
  ["Quickstrike",         16, 10000, "rare",     {}, "etched onto a weapon"],
  ["Impactful (Greater)", 17, 15000, "common",   {}, "etched onto a weapon"],
  ["Vorpal",              17, 15000, "rare",     { damage: ["slashing"], melee: true }, "etched onto a slashing melee weapon"],
  ["Anchoring (Greater)", 18, 22000, "uncommon", {}, "etched onto a weapon"],
  ["Brilliant (Greater)", 18, 24000, "common",   {}, "etched onto a weapon"],
  ["Rooting (True)",      19, 40000, "common",   { melee: true }, "etched onto a melee weapon"],
  ["Impossible",          20, 70000, "common",   {}, "etched onto a weapon"]
]);

/** Armor property runes (AoN). */
export const ARMOR_PROPERTY = defineRunes("armor", [
  ["Slick",                  5,  45,    "common",   {}, "etched onto armor"],
  ["Shadow",                 5,  55,    "common",   { category: ["light", "medium"] }, "etched onto light or medium armor"],
  ["Assisting",              5,  125,   "common",   {}, "etched onto armor"],
  ["Stanching",              5,  130,   "uncommon", {}, "etched onto armor"],
  ["Raiment",                5,  140,   "common",   {}, "etched onto armor"],
  ["Ready",                  6,  200,   "common",   {}, "etched onto armor"],
  ["Swallow-Spike",          6,  200,   "common",   {}, "etched onto armor"],
  ["Aim-Aiding",             6,  225,   "common",   {}, "etched onto armor"],
  ["Dread (Lesser)",         6,  225,   "uncommon", {}, "etched onto armor"],
  ["Quenching",              6,  250,   "common",   {}, "etched onto armor"],
  ["Deathless",              7,  330,   "uncommon", {}, "etched onto armor"],
  ["Size-Changing",          7,  350,   "common",   {}, "etched onto armor"],
  ["Energy-Resistant",       8,  420,   "common",   {}, "etched onto armor"],
  ["Gliding",                8,  450,   "common",   {}, "etched onto armor"],
  ["Slick (Greater)",        8,  450,   "common",   {}, "etched onto armor"],
  ["Invisibility",           8,  500,   "common",   { category: ["light"] }, "etched onto light armor"],
  ["Sinister Knight",        8,  500,   "uncommon", { category: ["heavy"] }, "etched onto heavy armor"],
  ["Bitter",                 9,  135,   "uncommon", {}, "etched onto armor"],
  ["Stanching (Greater)",    9,  600,   "uncommon", {}, "etched onto armor"],
  ["Advancing",              9,  625,   "common",   { category: ["heavy"] }, "etched onto heavy armor"],
  ["Malleable",              9,  650,   "common",   { material: "metal", category: ["medium", "heavy"] }, "etched onto a metal medium or heavy armor"],
  ["Shadow (Greater)",       9,  650,   "common",   { category: ["light", "medium"] }, "etched onto light or medium armor"],
  ["Portable",               9,  660,   "common",   {}, "etched onto armor"],
  ["Magnetizing",            10, 900,   "common",   { material: "metal" }, "etched onto metal armor"],
  ["Invisibility (Greater)", 10, 1000,  "common",   { category: ["light"] }, "etched onto light armor"],
  ["Quenching (Greater)",    10, 1000,  "common",   {}, "etched onto armor"],
  ["Energy-Absorbing",       11, 1200,  "rare",     {}, "etched onto armor"],
  ["Implacable",             11, 1200,  "uncommon", { category: ["medium", "heavy"] }, "etched onto medium or heavy armor"],
  ["Ready (Greater)",        11, 1200,  "common",   {}, "etched onto armor"],
  ["Energy-Resistant (Greater)", 12, 1650, "common", {}, "etched onto armor"],
  ["Swallow-Spike (Greater)", 12, 1750, "common",  {}, "etched onto armor"],
  ["Dread (Moderate)",       12, 1800,  "uncommon", {}, "etched onto armor"],
  ["Immovable",              12, 1800,  "uncommon", {}, "etched onto armor"],
  ["Fortification",          12, 2000,  "common",   { category: ["medium", "heavy"] }, "etched onto medium or heavy armor"],
  ["Stanching (Major)",      13, 2500,  "uncommon", {}, "etched onto armor"],
  ["Winged",                 13, 2500,  "common",   {}, "etched onto armor"],
  ["Energy Adaptive",        13, 2600,  "common",   {}, "etched onto armor"],
  ["Spellwatch",             13, 3000,  "common",   {}, "etched onto armor"],
  ["Rock-Braced",            13, 3000,  "rare",     { category: ["medium", "heavy"] }, "etched onto medium or heavy armor"],
  ["Soaring",                14, 3750,  "common",   {}, "etched onto armor"],
  ["Cavern's Heart",         14, 4100,  "rare",     { category: ["medium", "heavy"] }, "etched onto medium or heavy armor"],
  ["Quenching (Major)",      14, 4500,  "common",   {}, "etched onto armor"],
  ["Energy-Absorbing (Greater)", 15, 6000, "rare", {}, "etched onto armor"],
  ["Antimagic",              15, 6500,  "uncommon", {}, "etched onto armor"],
  ["Advancing (Greater)",    16, 8000,  "common",   { category: ["heavy"] }, "etched onto heavy armor"],
  ["Misleading",             16, 8000,  "common",   { category: ["light"] }, "etched onto light armor"],
  ["Slick (Major)",          16, 9000,  "common",   {}, "etched onto armor"],
  ["Swallow-Spike (Major)",  16, 19250, "common",   {}, "etched onto armor"],
  ["Stanching (True)",       17, 12500, "uncommon", {}, "etched onto armor"],
  ["Ethereal",               17, 13500, "uncommon", {}, "etched onto armor"],
  ["Shadow (Major)",         17, 14000, "common",   { category: ["light", "medium"] }, "etched onto light or medium armor"],
  ["Dread (Greater)",        18, 21000, "uncommon", {}, "etched onto armor"],
  ["Fortification (Greater)", 18, 24000, "common",  { category: ["medium", "heavy"] }, "etched onto medium or heavy armor"],
  ["Quenching (True)",       18, 24000, "common",   {}, "etched onto armor"],
  ["Winged (Greater)",       19, 35000, "common",   {}, "etched onto armor"]
]);

/* ------------------------------ eligibility ------------------------------ */

/**
 * Is a property rune legal on a base item, per its Usage restriction?
 * `meta` is the lightweight item descriptor produced by the item index
 * (kind/damage/melee/thrown/category/material/baseItem/traits).
 */
export function runeFits(rune, meta) {
  if (!rune || !meta) return false;
  if (rune.itemKind !== meta.kind) return false;
  const on = rune.on ?? {};

  if (meta.kind === "weapon") {
    if (on.melee && !meta.melee) return false;
    if (on.thrown && !meta.thrown) return false;
    if (on.monk && !(meta.traits ?? []).includes("monk")) return false;
    if (on.baseItem && meta.baseItem !== on.baseItem) return false;
    if (on.excludeTrait && (meta.traits ?? []).includes(on.excludeTrait)) return false;
    if (Array.isArray(on.damage) && on.damage.length) {
      const can = new Set(meta.damage ?? []);
      if (!on.damage.some(d => can.has(d))) return false;
    }
    return true;
  }

  if (meta.kind === "armor") {
    if (Array.isArray(on.category) && on.category.length) {
      if (!meta.category || !on.category.includes(meta.category)) return false;
    }
    if (on.material === "metal" && meta.material !== "metal") return false;
    return true;
  }

  return false;
}

/** All property runes (of the matching kind) that legally fit a base item. */
export function eligiblePropertyRunes(meta, { maxLevel = 99, maxGp = Infinity } = {}) {
  const table = meta?.kind === "weapon" ? WEAPON_PROPERTY
    : meta?.kind === "armor" ? ARMOR_PROPERTY : null;
  if (!table) return [];
  return table.filter(r => r.level <= maxLevel && r.price <= maxGp && runeFits(r, meta));
}

/* ------------------------------ rune-set builder ------------------------------ */

/**
 * Build a *legal, level-appropriate, budget-bounded* rune set for a base item.
 *
 *   meta       — index descriptor (kind weapon|armor + facts for eligibility)
 *   level      — party/item level; caps fundamentals to the ABP-expected tier
 *               (we never gift gear above the curve) and gates property level.
 *   maxGp      — gp the caller is willing to spend on runes for this item.
 *   themeSlugs — preferred property-rune slugs (theme weighting); optional.
 *
 * Returns { runes, addedGp, addedLevel, names } or null when nothing legal/
 * affordable applies (e.g. level 1, or budget below the cheapest potency rune).
 * `runes` is the modern PF2e shape: weapons {potency,striking,property[]},
 * armor {potency,resilient,property[]}.
 */
export function buildRuneSet(meta, { level, maxGp = Infinity, themeSlugs = [] } = {}) {
  if (!meta || (meta.kind !== "weapon" && meta.kind !== "armor")) return null;
  if (meta.hasRunes) return null; // never double-etch an already-runed/magic item

  const isWeapon = meta.kind === "weapon";
  const exp = expectedFundamentals(level);
  let potTier = isWeapon ? exp.attack : exp.defense;       // capped to the curve
  let secTier = isWeapon ? exp.striking : exp.resilient;
  if (potTier < 1) return null;                             // pre-rune levels: nothing to etch

  const potTable = isWeapon ? WEAPON_POTENCY : ARMOR_POTENCY;
  const secTable = isWeapon ? STRIKING : RESILIENT;

  // Fit the fundamentals in budget, stepping the secondary (striking/resilient)
  // down first, then potency, until they fit.
  let chosen = null;
  while (potTier >= 1) {
    const pot = potTable[potTier - 1];
    const sec = secTier >= 1 ? secTable[secTier - 1] : null;
    const cost = pot.price + (sec ? sec.price : 0);
    if (cost <= maxGp) { chosen = { potTier, secTier, pot, sec, cost }; break; }
    if (secTier > 0) secTier--; else potTier--;
  }
  if (!chosen) return null;

  let spent = chosen.cost;
  let remaining = maxGp - spent;
  let addedLevel = Math.max(chosen.pot.level, chosen.sec ? chosen.sec.level : 0);
  const names = [`+${chosen.potTier}`];
  if (chosen.sec) names.push(chosen.sec.name);

  // Property runes: a weapon/armor may hold property runes equal to its potency.
  const slots = chosen.potTier;
  const wishes = new Set(themeSlugs ?? []);
  const pool = eligiblePropertyRunes(meta, { maxLevel: level, maxGp: remaining })
    .filter(r => knownRuneSlug(meta.kind, r.slug))
    .sort((a, b) => {
      const aw = wishes.has(a.slug) ? 1 : 0;
      const bw = wishes.has(b.slug) ? 1 : 0;
      if (aw !== bw) return bw - aw;          // themed first
      return b.level - a.level;               // then the strongest we can afford
    });

  const property = [];
  for (const r of pool) {
    if (property.length >= slots) break;
    if (r.price > remaining) continue;
    property.push(r.slug);
    names.push(r.name);
    remaining -= r.price;
    spent += r.price;
    addedLevel = Math.max(addedLevel, r.level);
  }

  const runes = isWeapon
    ? { potency: chosen.potTier, striking: chosen.secTier, property }
    : { potency: chosen.potTier, resilient: chosen.secTier, property };

  return { runes, addedGp: round2(spent), addedLevel, names };
}

/* ------------------------------ theming ------------------------------ */

/** Source tag (creature trait / biome / faction) → preferred property slugs. */
const THEME_RUNE_AFFINITY = {
  // energy & element traits
  fire: ["flaming", "greaterFlaming"],
  cold: ["frost", "greaterFrost"],
  electricity: ["shock", "greaterShock"],
  sonic: ["thundering", "greaterThundering"],
  acid: ["corrosive", "greaterCorrosive"],
  void: ["decaying", "greaterDecaying"],
  // creature kinds
  undead: ["ghostTouch", "disrupting", "decaying"],
  incorporeal: ["ghostTouch"],
  ghost: ["ghostTouch"],
  giant: ["giantKilling", "greaterGiantKilling"],
  fiend: ["holy"],
  demon: ["holy"],
  devil: ["holy"],
  celestial: ["unholy"],
  plant: ["rooting"],
  fungus: ["rooting"],
  dragon: ["fearsome"],
  // biomes
  aquatic: ["underwater"],
  arctic: ["frost"],
  desert: ["flaming"],
  // armor-side affinities
  shadow: ["shadow", "invisibility"],
  stealth: ["shadow", "invisibility"]
};

/** Collect preferred property slugs from a request's tag bundle. */
export function themeRuneSlugs(tags) {
  if (!tags) return [];
  const out = new Set();
  const groups = [tags.traits, tags.biomes, tags.factions];
  for (const g of groups) {
    for (const t of g ?? []) {
      for (const slug of THEME_RUNE_AFFINITY[String(t).toLowerCase()] ?? []) out.add(slug);
    }
  }
  return [...out];
}

/* ------------------------------ system slug validation ------------------------------ */

/**
 * Does the live PF2e system know this rune slug? Etch-time guard so we never
 * write a property slug the installed system would silently strip (third-party
 * or older builds). When not running under PF2e (e.g. tests), assume true.
 */
export function knownRuneSlug(kind, slug) {
  if (!slug) return false;
  const cfg = globalThis.CONFIG?.PF2E;
  if (!cfg) return true; // not in Foundry/PF2e — don't filter
  const modern = cfg.runes?.[kind]?.property; // recent system shape
  const legacy = kind === "weapon" ? cfg.weaponPropertyRunes : cfg.armorPropertyRunes;
  const bag = modern ?? legacy;
  if (!bag) return true; // unknown shape — don't over-filter
  return Object.prototype.hasOwnProperty.call(bag, slug) || (bag instanceof Map && bag.has?.(slug));
}

/* ------------------------------ internals ------------------------------ */

/** Turn a rune name into the PF2e system slug (graded variants prefixed). */
export function runeSlug(name) {
  const m = String(name).match(/\s*\((Lesser|Moderate|Greater|Major|True)\)\s*$/i);
  let grade = null;
  let base = name;
  if (m) { grade = m[1].toLowerCase(); base = name.slice(0, m.index); }
  const camel = camelize(base);
  if (!grade || grade === "lesser") return camel;
  return grade + camel.charAt(0).toUpperCase() + camel.slice(1);
}

function camelize(s) {
  const words = String(s).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/);
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join("");
}

/** Expand the compact tuple list into rune objects with derived slugs. */
function defineRunes(itemKind, rows) {
  return rows.map(([name, level, price, rarity, on, usage]) => ({
    itemKind, name, slug: runeSlug(name), level, price, rarity, on: on ?? {}, usage
  }));
}

function round2(n) { return Math.round(n * 100) / 100; }
