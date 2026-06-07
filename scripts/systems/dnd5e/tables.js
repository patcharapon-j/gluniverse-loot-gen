/**
 * D&D 5e (2024) treasure & progression reference data — the 5e analogue of
 * scripts/pf2e/tables.js. The 2024 DMG awards treasure very differently from
 * PF2e: there is no gp-priced "item budget" and no mandatory magic (bounded
 * accuracy), so the economy here has two independent yardsticks:
 *
 *   1. PARTY_GOLD_BY_LEVEL — the coin + sellable-valuables a 4-PC party earns
 *      across a level. Drives the currency portion of a hoard and the
 *      wealth-drift auditor. (Reskin of the DMG hoard gold; a tunable knob.)
 *   2. The MAGIC-ITEM PLAN — how many magic items a hoard contains and at what
 *      rarities, by CR tier (DMG "Treasure Hoard" + "Magic Item Rarity by
 *      Character Level"). Magic items are awarded by COUNT and RARITY, not by gp.
 *
 * Every number is a balance knob (DESIGN §17/§19) — the STRUCTURE is the point.
 * Sources: 2024 DMG Treasure Hoards (p.121) + Magic Item Rarities (p.218);
 * encounter XP budgets (2024 DMG). See DESIGN.md §19.
 */

export const DND5E_MAX_LEVEL = 20;

/* ------------------------------ tiers ------------------------------ */

/** The four play tiers, keyed by the character-level band they cover. */
export const TIERS = [
  { tier: 1, min: 1, max: 4 },
  { tier: 2, min: 5, max: 10 },
  { tier: 3, min: 11, max: 16 },
  { tier: 4, min: 17, max: 20 }
];

/** Play tier (1..4) for a character level. */
export function tierForLevel(level) {
  const lv = clampLevel(level);
  for (const t of TIERS) if (lv >= t.min && lv <= t.max) return t.tier;
  return lv <= 4 ? 1 : 4;
}

/* ------------------------------ gold economy ------------------------------ */

/**
 * Party gold (4 PCs) earned across each level — coins plus sellable gems/art.
 * Deliberately far below PF2e: 5e is gold-poor and magic-light. `currency` is
 * the share that lands as raw coin (the rest is sellable valuables); `perAdd`
 * scales the whole figure per extra PC beyond four.
 */
export const PARTY_GOLD_BY_LEVEL = {
  1:  { total: 80,     currency: 50,     perAdd: 18 },
  2:  { total: 150,    currency: 90,     perAdd: 35 },
  3:  { total: 300,    currency: 180,    perAdd: 70 },
  4:  { total: 500,    currency: 300,    perAdd: 110 },
  5:  { total: 900,    currency: 540,    perAdd: 200 },
  6:  { total: 1300,   currency: 800,    perAdd: 300 },
  7:  { total: 1800,   currency: 1100,   perAdd: 400 },
  8:  { total: 2400,   currency: 1450,   perAdd: 550 },
  9:  { total: 3200,   currency: 1900,   perAdd: 720 },
  10: { total: 4200,   currency: 2500,   perAdd: 950 },
  11: { total: 6000,   currency: 3600,   perAdd: 1350 },
  12: { total: 8000,   currency: 4800,   perAdd: 1800 },
  13: { total: 11000,  currency: 6600,   perAdd: 2500 },
  14: { total: 15000,  currency: 9000,   perAdd: 3400 },
  15: { total: 20000,  currency: 12000,  perAdd: 4500 },
  16: { total: 26000,  currency: 15600,  perAdd: 5800 },
  17: { total: 40000,  currency: 24000,  perAdd: 9000 },
  18: { total: 55000,  currency: 33000,  perAdd: 12000 },
  19: { total: 75000,  currency: 45000,  perAdd: 16000 },
  20: { total: 100000, currency: 60000,  perAdd: 22000 }
};

/** Starting wealth for a fresh level-1 PC (gp) — 5e "Standard" array of gold. */
export const STARTING_WEALTH = 0;

/** Total party gold for a level, scaled for party size. */
export function budgetForLevel(level, partySize = 4) {
  const row = PARTY_GOLD_BY_LEVEL[clampLevel(level)];
  if (!row) return 0;
  const extra = Math.max(0, partySize - 4) * row.perAdd;
  return row.total + extra;
}

/** Coin (not valuables) a 4-PC party should see during a level. */
export function expectedCurrencyForLevel(level, partySize = 4) {
  const row = PARTY_GOLD_BY_LEVEL[clampLevel(level)];
  if (!row) return 0;
  const extra = Math.max(0, partySize - 4) * row.perAdd * (row.currency / row.total);
  return Math.round(row.currency + extra);
}

/**
 * Expected accumulated gold value per PC to have reached the start of `level`,
 * including a rough nominal value of the magic items a PC of that level is
 * expected to be carrying. This is the wealth-drift yardstick — directional, not
 * exact (5e wealth is loose; coins get spent on gear/services legitimately).
 */
export function expectedWealthPerPC(level) {
  const lv = clampLevel(level);
  let party = 0;
  for (let l = 1; l < lv; l++) party += PARTY_GOLD_BY_LEVEL[l]?.total ?? 0;
  const goldPerPC = Math.round(party / 4) + STARTING_WEALTH;
  // Add the nominal value of the magic items a PC of this tier typically holds.
  const magic = expectedMagic(lv);
  return goldPerPC + magic.nominalGp;
}

/* ------------------------------ magic-item plan ------------------------------ */

/** Rarity → a representative character "level" so the level-window selector works. */
export const RARITY_LEVEL = {
  common: 1, uncommon: 4, rare: 9, "very rare": 13, legendary: 18, artifact: 20
};

/** Rarity → nominal gp value (ledger + wealth tracking). Tunable knob. */
export const RARITY_GP = {
  common: 75, uncommon: 350, rare: 3000, "very rare": 22000, legendary: 110000, artifact: 250000
};

/** Rarity → ordinal (for the auditor's "highest rarity present" yardstick). */
export const RARITY_ORDER = {
  common: 1, uncommon: 2, rare: 3, "very rare": 4, legendary: 5, artifact: 6
};

/** Average magic items in a full "standard" hoard, by tier. */
const MAGIC_COUNT_BY_TIER = { 1: 1.5, 2: 2.5, 3: 3.5, 4: 5 };

/** Rarity weights for rolling each magic item's rarity, by tier (DMG p.218). */
const RARITY_WEIGHTS_BY_TIER = {
  1: { common: 5, uncommon: 4, rare: 1 },
  2: { common: 2, uncommon: 5, rare: 2, "very rare": 0.5 },
  3: { uncommon: 1.5, rare: 5, "very rare": 2, legendary: 0.3 },
  4: { rare: 2, "very rare": 5, legendary: 2 }
};

/** What the auditor expects a PC of `level` to be carrying. */
export function expectedMagic(level) {
  const tier = tierForLevel(level);
  const attune = { 1: 1, 2: 2, 3: 3, 4: 3 }[tier] ?? 1;
  const items = { 1: 1, 2: 3, 3: 5, 4: 7 }[tier] ?? 1;
  const topRarity = { 1: "uncommon", 2: "rare", 3: "very rare", 4: "legendary" }[tier] ?? "uncommon";
  // Nominal carried value: ~half the expected item count at the tier's median rarity.
  const medRarity = { 1: "common", 2: "uncommon", 3: "rare", 4: "very rare" }[tier] ?? "common";
  const nominalGp = Math.round(items * 0.6 * (RARITY_GP[medRarity] ?? 100));
  return { tier, attune, items, topRarity, topRarityOrder: RARITY_ORDER[topRarity], nominalGp };
}

/** The rarity weight table for a tier (used by the hoard roller). */
export function rarityWeightsForTier(tier) {
  return RARITY_WEIGHTS_BY_TIER[tier] ?? RARITY_WEIGHTS_BY_TIER[1];
}

/* ------------------------------ context → plan ------------------------------ */

/** Combat threat band → share of a level's gold + magic-item multiplier. */
export const ENCOUNTER_THREAT_SHARE = {
  trivial: 0.02, low: 0.08, moderate: 0.12, severe: 0.18, extreme: 0.22, extra: 0.12
};
const ENCOUNTER_MAGIC_FACTOR = {
  trivial: 0, low: 0.25, moderate: 0.5, severe: 1, extreme: 1.5
};

/** Exploration cache tier → share of a level's gold + magic-item multiplier. */
export const CACHE_TIER_SHARE = { minor: 0.05, standard: 0.12, major: 0.2, hoard: 0.4 };
const CACHE_MAGIC_FACTOR = { minor: 0.25, standard: 0.5, major: 1, hoard: 2 };

/** Quest reward tier → share of a level's gold + magic-item multiplier. */
export const QUEST_REWARD_SHARE = { minor: 0.1, standard: 0.2, major: 0.4, grand: 0.75 };
const QUEST_MAGIC_FACTOR = { minor: 0.5, standard: 1, major: 2, grand: 3 };

/**
 * Magic-item plan for a context: how many magic items the hoard should contain
 * and the rarity-weight table to roll each from. Returns { count, tier, weights }.
 */
export function magicPlan(context, key, level) {
  const tier = tierForLevel(level);
  const base = MAGIC_COUNT_BY_TIER[tier] ?? 1.5;
  let factor;
  switch (context) {
    case "combat": factor = ENCOUNTER_MAGIC_FACTOR[key] ?? ENCOUNTER_MAGIC_FACTOR.moderate; break;
    case "exploration": factor = CACHE_MAGIC_FACTOR[key] ?? CACHE_MAGIC_FACTOR.standard; break;
    case "dungeon": factor = CACHE_MAGIC_FACTOR[key] ?? CACHE_MAGIC_FACTOR.major; break;
    case "quest": factor = QUEST_MAGIC_FACTOR[key] ?? QUEST_MAGIC_FACTOR.standard; break;
    default: factor = 1;
  }
  const raw = base * factor;
  // Probabilistic rounding so fractional plans still occasionally yield an item.
  const count = Math.floor(raw) + (Math.random() < (raw - Math.floor(raw)) ? 1 : 0);
  return { count: Math.max(0, count), tier, weights: rarityWeightsForTier(tier) };
}

/* ------------------------------ threat (CR-based) ------------------------------ */

/** XP value of a creature by Challenge Rating (2024 DMG / standard 5e). */
const XP_BY_CR = {
  0: 10, 0.125: 25, 0.25: 50, 0.5: 100,
  1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900, 8: 3900,
  9: 5000, 10: 5900, 11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000,
  16: 15000, 17: 18000, 18: 20000, 19: 22000, 20: 25000, 21: 33000, 22: 41000,
  23: 50000, 24: 62000, 25: 75000, 26: 90000, 27: 105000, 28: 120000,
  29: 135000, 30: 155000
};

/** 2024 DMG encounter XP budget per character: [low, moderate, high] by level. */
const XP_BUDGET_PER_PC = {
  1: [50, 75, 100], 2: [100, 150, 200], 3: [150, 225, 400], 4: [250, 375, 500],
  5: [500, 750, 1100], 6: [600, 1000, 1400], 7: [750, 1300, 1700], 8: [1000, 1700, 2100],
  9: [1300, 2000, 2600], 10: [1600, 2300, 3100], 11: [1900, 2900, 4100], 12: [2200, 3700, 4700],
  13: [2600, 4200, 5400], 14: [2900, 4900, 6200], 15: [3300, 5400, 7800], 16: [3800, 6100, 9800],
  17: [4500, 7200, 11700], 18: [5000, 8700, 14200], 19: [5500, 10700, 17200], 20: [6400, 13200, 22000]
};

function xpForCr(cr) {
  const c = Number(cr);
  if (!Number.isFinite(c)) return 0;
  if (XP_BY_CR[c] != null) return XP_BY_CR[c];
  // Snap to the nearest known CR rung.
  const rungs = Object.keys(XP_BY_CR).map(Number).sort((a, b) => a - b);
  let best = rungs[0];
  for (const r of rungs) if (Math.abs(r - c) < Math.abs(best - c)) best = r;
  return XP_BY_CR[best] ?? 0;
}

/**
 * Estimate a fight's threat band from its monster CRs (passed in as `npcLevels`,
 * which for 5e are CRs). Sums monster XP and compares to the party's 2024 DMG XP
 * budget. Bands reuse the engine's keys: trivial|low|moderate|severe|extreme.
 */
export function estimateThreat(crList, partyLevel, partySize = 4) {
  const lv = clampLevel(partyLevel);
  const budget = XP_BUDGET_PER_PC[lv] ?? XP_BUDGET_PER_PC[1];
  const size = Math.max(1, Math.trunc(partySize) || 4);
  const [low, mod, high] = budget.map(b => b * size);
  let xp = 0;
  for (const cr of crList ?? []) xp += xpForCr(cr);
  if (xp <= 0) return "trivial";
  if (xp < low) return "trivial";
  if (xp < mod) return "low";
  if (xp < high) return "moderate";
  if (xp < high * 2) return "severe";
  return "extreme";
}

function clampLevel(level) {
  const n = Math.trunc(Number(level) || 1);
  return Math.max(1, Math.min(DND5E_MAX_LEVEL, n));
}
