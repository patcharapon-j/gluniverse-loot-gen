/**
 * PF2e treasure & progression reference data.
 *
 * Two yardsticks live here:
 *  1. PARTY_TREASURE_BY_LEVEL — the gp the system expects a 4-PC party to earn
 *     across each level (the wealth-drift yardstick).
 *  2. ABP_THRESHOLDS — the level at which each math-critical bonus is expected.
 *     These thresholds are identical to the standard fundamental-rune item
 *     levels, so they serve as the single source of truth for "what gear a PC
 *     should have at level N" whether or not the campaign uses Automatic Bonus
 *     Progression. (Sources: AoN Treasure / ABP rules — see DESIGN.md.)
 *
 * Currency/total values are tuned per AoN; treat them as adjustable knobs
 * (DESIGN.md §17) — the structure is what matters.
 */

/** Party Treasure by Level (group of four). value = total gp earned during that level. */
export const PARTY_TREASURE_BY_LEVEL = {
  1:  { total: 175,     currency: 40,      perAdd: 13 },
  2:  { total: 300,     currency: 70,      perAdd: 18 },
  3:  { total: 500,     currency: 120,     perAdd: 30 },
  4:  { total: 850,     currency: 200,     perAdd: 50 },
  5:  { total: 1350,    currency: 320,     perAdd: 80 },
  6:  { total: 2000,    currency: 500,     perAdd: 125 },
  7:  { total: 2900,    currency: 720,     perAdd: 180 },
  8:  { total: 4000,    currency: 1000,    perAdd: 250 },
  9:  { total: 5700,    currency: 1400,    perAdd: 350 },
  10: { total: 8000,    currency: 2000,    perAdd: 500 },
  11: { total: 11500,   currency: 2800,    perAdd: 700 },
  12: { total: 16500,   currency: 4000,    perAdd: 1000 },
  13: { total: 25000,   currency: 6000,    perAdd: 1500 },
  14: { total: 36500,   currency: 9000,    perAdd: 2250 },
  15: { total: 54500,   currency: 13000,   perAdd: 3250 },
  16: { total: 82500,   currency: 20000,   perAdd: 5000 },
  17: { total: 128000,  currency: 30000,   perAdd: 7500 },
  18: { total: 208000,  currency: 48000,   perAdd: 12000 },
  19: { total: 355000,  currency: 80000,   perAdd: 20000 },
  20: { total: 490000,  currency: 140000,  perAdd: 35000 }
};

/** Starting wealth for a fresh level-1 PC (gp). */
export const STARTING_WEALTH = 15;

/**
 * Treasure-by-Encounter: each threat's share of a level's total budget.
 * Used by the per-encounter budget adapter (later build). Values approximate
 * AoN Table; "extra" pads the rounding when building a whole level this way.
 */
export const ENCOUNTER_THREAT_SHARE = {
  trivial:  0.025,
  low:      0.09,
  moderate: 0.12,
  severe:   0.17,
  extreme:  0.20,
  extra:    0.12
};

/**
 * Cache-tier → share of a level's total treasure budget (DESIGN §17). Mirrors
 * the Treasure-by-Encounter shares: a "standard" find is about a moderate
 * encounter's worth; a "hoard" bundles several. Tunable knobs.
 */
export const CACHE_TIER_SHARE = {
  minor:    0.05,
  standard: 0.12,
  major:    0.20,
  hoard:    0.40
};

/**
 * Quest-reward tier → share of a level's total budget. "grand" is deliberately
 * large (a milestone payoff). The GM picks the tier; nothing auto-classifies it.
 */
export const QUEST_REWARD_SHARE = {
  minor:    0.10,
  standard: 0.20,
  major:    0.40,
  grand:    0.75
};

/**
 * PF2e encounter XP for a creature whose level is (creatureLevel − partyLevel)
 * relative to the party. Lets the combat adapter estimate a fight's threat so
 * the GM needn't pre-classify it. Creatures 5+ levels below contribute nothing.
 */
export const CREATURE_XP_BY_DELTA = {
  "-4": 10, "-3": 15, "-2": 20, "-1": 30,
  "0": 40, "1": 60, "2": 80, "3": 120, "4": 160
};

/** Encounter XP budget thresholds for a party of four (AoN). */
export const ENCOUNTER_BUDGET = {
  trivial: 40, low: 60, moderate: 80, severe: 120, extreme: 160
};

/** XP each threshold shifts per PC above/below the baseline four (AoN). */
const ENCOUNTER_BUDGET_PER_PC = {
  trivial: 10, low: 15, moderate: 20, severe: 30, extreme: 40
};

/**
 * Estimate a fight's threat from its NPC levels. Sums each creature's XP (by
 * level delta, clamped to the table) and compares to the party-size-adjusted
 * budget. Returns trivial|low|moderate|severe|extreme.
 */
export function estimateThreat(npcLevels, partyLevel, partySize = 4) {
  const pl = clampLevel(partyLevel);
  let xp = 0;
  for (const raw of npcLevels ?? []) {
    const d = Math.trunc(Number(raw) - pl);
    if (!Number.isFinite(d) || d < -4) continue; // far below party level — negligible
    xp += CREATURE_XP_BY_DELTA[String(Math.min(4, d))] ?? 0;
  }
  const adj = partySize - 4; // signed: more PCs raise thresholds, fewer lower them
  for (const t of ["extreme", "severe", "moderate", "low"]) {
    const threshold = ENCOUNTER_BUDGET[t] + adj * ENCOUNTER_BUDGET_PER_PC[t];
    if (xp >= Math.max(1, threshold)) return t;
  }
  return "trivial";
}

/**
 * Expected party wealth *accumulated* to have reached the start of `level`,
 * per PC. A party that has finished levels 1..(level-1) has earned those
 * totals; spread across four PCs, plus the starting stake. This is the
 * "compare each PC to a freshly-built character" proxy (AoN), and is an
 * estimate — coins spent on consumables/services legitimately lower the
 * live sheet value, so treat drift as directional, not exact.
 */
export function expectedWealthPerPC(level) {
  const lv = clampLevel(level);
  let party = 0;
  for (let l = 1; l < lv; l++) party += PARTY_TREASURE_BY_LEVEL[l]?.total ?? 0;
  return Math.round(party / 4) + STARTING_WEALTH;
}

/** Expected currency (coins) a 4-PC party should see during `level`. */
export function expectedCurrencyForLevel(level, partySize = 4) {
  const row = PARTY_TREASURE_BY_LEVEL[clampLevel(level)];
  if (!row) return 0;
  const extra = Math.max(0, partySize - 4) * row.perAdd;
  return row.currency + extra;
}

/** Total treasure budget for `level`, adjusted for party size. */
export function budgetForLevel(level, partySize = 4) {
  const row = PARTY_TREASURE_BY_LEVEL[clampLevel(level)];
  if (!row) return 0;
  // Per-extra-PC scaling mirrors AoN's currency add as a reasonable whole-budget proxy.
  const extra = Math.max(0, partySize - 4) * row.perAdd;
  return row.total + extra;
}

/* ============================================================
   Automatic Bonus Progression — the fundamentals yardstick.
   Each entry is the *minimum character level* at which the
   bonus tier is expected. Identical to the standard fundamental
   rune item levels.
   ============================================================ */

export const ABP_THRESHOLDS = {
  // attack potency: +1 / +2 / +3   (weapon potency rune levels)
  attack:     [2, 10, 16],
  // striking dice tiers: striking / greater / major
  striking:   [4, 12, 19],
  // defense potency: +1 / +2 / +3  (armor potency rune levels)
  defense:    [5, 11, 18],
  // saving-throw potency: +1 / +2 / +3  (resilient rune levels)
  resilient:  [8, 14, 20],
  // perception potency: +1 / +2 / +3
  perception: [7, 13, 19]
};

/** Skill potency: cumulative count of skills expected to carry an item bonus. */
export const ABP_SKILL_COUNT = [
  { level: 3, skills: 1 },
  { level: 6, skills: 2 },
  { level: 13, skills: 3 },
  { level: 15, skills: 4 },
  { level: 17, skills: 5 },
  { level: 20, skills: 6 }
];

/** Attribute apex (a single +X apex item / automatic boost) expected by this level. */
export const ABP_APEX_LEVEL = 17;

/** Given a threshold array and a level, return the expected tier (0..3). */
export function tierForLevel(thresholds, level) {
  let tier = 0;
  for (const t of thresholds) if (level >= t) tier++;
  return tier;
}

/** Expected fundamental loadout for a PC at `level`. */
export function expectedFundamentals(level) {
  const lv = clampLevel(level);
  let skills = 0;
  for (const s of ABP_SKILL_COUNT) if (lv >= s.level) skills = s.skills;
  return {
    attack:     tierForLevel(ABP_THRESHOLDS.attack, lv),
    striking:   tierForLevel(ABP_THRESHOLDS.striking, lv),
    defense:    tierForLevel(ABP_THRESHOLDS.defense, lv),
    resilient:  tierForLevel(ABP_THRESHOLDS.resilient, lv),
    perception: tierForLevel(ABP_THRESHOLDS.perception, lv),
    skills,
    apex: lv >= ABP_APEX_LEVEL ? 1 : 0
  };
}

/** Human label for a fundamental tier (used in the dashboard). */
export const TIER_LABELS = {
  attack:     ["—", "+1", "+2", "+3"],
  striking:   ["—", "striking", "greater", "major"],
  defense:    ["—", "+1", "+2", "+3"],
  resilient:  ["—", "resilient", "greater", "major"],
  perception: ["—", "+1", "+2", "+3"]
};

function clampLevel(level) {
  const n = Math.trunc(Number(level) || 1);
  return Math.max(1, Math.min(20, n));
}
