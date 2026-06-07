/**
 * Budget-source adapters (DESIGN §5). Each maps a context-specific "how big"
 * input to a gp amount, derived from the active system's per-level treasure
 * budget so totals stay inside that system's balance (DESIGN §2/§19). Nothing
 * here invents value — it only slices the level budget. The per-level budget and
 * the share tables come from the active SystemAdapter (PF2e: Party Treasure by
 * Level; D&D 5e: the 2024 DMG hoard gold).
 */

import { getAdapter } from "../systems/registry.js";

function adapter() { return getAdapter(); }
function levelBudget(level, size) { return adapter()?.budgetForLevel(level, size) ?? 0; }
function share(kind, key, fallbackKey) {
  const table = adapter()?.budgetShares?.[kind] ?? {};
  return table[key] ?? table[fallbackKey] ?? 0;
}

/** Post-combat: threat band → slice of the level budget. */
export function combatBudgetGp(threat, level, partySize = 4) {
  return Math.round(levelBudget(level, partySize) * share("encounter", threat, "moderate"));
}

/** Exploration: cache tier → slice of the level budget. */
export function cacheBudgetGp(tier, level, partySize = 4) {
  return Math.round(levelBudget(level, partySize) * share("cache", tier, "standard"));
}

/** Quest reward: GM-picked tier → slice of the level budget. */
export function questBudgetGp(tier, level, partySize = 4) {
  return Math.round(levelBudget(level, partySize) * share("quest", tier, "standard"));
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
