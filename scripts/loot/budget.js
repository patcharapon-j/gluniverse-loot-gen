/**
 * Budget-source adapters (DESIGN §5). Each maps a context-specific "how big"
 * input to a gp amount, always derived from the RAW Party-Treasure-by-Level
 * budget so totals stay inside core balance (DESIGN §2). Nothing here invents
 * value — it only slices the level budget.
 */

import {
  budgetForLevel, ENCOUNTER_THREAT_SHARE, CACHE_TIER_SHARE, QUEST_REWARD_SHARE
} from "../pf2e/tables.js";

/** Post-combat: threat band → slice of the level budget. */
export function combatBudgetGp(threat, level, partySize = 4) {
  const share = ENCOUNTER_THREAT_SHARE[threat] ?? ENCOUNTER_THREAT_SHARE.moderate;
  return Math.round(budgetForLevel(level, partySize) * share);
}

/** Exploration: cache tier → slice of the level budget. */
export function cacheBudgetGp(tier, level, partySize = 4) {
  const share = CACHE_TIER_SHARE[tier] ?? CACHE_TIER_SHARE.standard;
  return Math.round(budgetForLevel(level, partySize) * share);
}

/** Quest reward: GM-picked tier → slice of the level budget. */
export function questBudgetGp(tier, level, partySize = 4) {
  const share = QUEST_REWARD_SHARE[tier] ?? QUEST_REWARD_SHARE.standard;
  return Math.round(budgetForLevel(level, partySize) * share);
}

/** Dungeon: the whole complex is sized like a cache tier, then parcelled. */
export function dungeonBudgetGp(tier, level, partySize = 4) {
  return cacheBudgetGp(tier, level, partySize);
}

/**
 * Split a dungeon's total budget across rooms. Some rooms come up empty (loot
 * shouldn't be everywhere) and the filled ones get an uneven share so a few
 * feel richer than others. Returns an array of gp amounts (length = rooms) that
 * sums exactly to `total`.
 */
export function splitDungeon(total, rooms, { emptyRatio = 0.4 } = {}) {
  rooms = Math.max(1, Math.trunc(rooms));
  if (rooms === 1) return [Math.max(0, Math.round(total))];

  const filled = [];
  for (let i = 0; i < rooms; i++) filled.push(Math.random() >= emptyRatio);
  if (!filled.some(Boolean)) filled[Math.floor(Math.random() * rooms)] = true; // never all-empty

  const weights = filled.map(f => (f ? 0.5 + Math.random() : 0));
  const sum = weights.reduce((s, w) => s + w, 0) || 1;

  let allocated = 0;
  const out = weights.map(w => {
    const gp = Math.round(total * (w / sum));
    allocated += gp;
    return gp;
  });

  // Push any rounding drift onto the richest room so the sum stays exact.
  const diff = Math.round(total) - allocated;
  if (diff !== 0) {
    let idx = 0, best = -1;
    out.forEach((g, i) => { if (g > best) { best = g; idx = i; } });
    out[idx] = Math.max(0, out[idx] + diff);
  }
  return out;
}
