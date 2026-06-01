/**
 * LootRequest — the single normalized shape every entry point produces and the
 * PacingEngine (build #3) consumes (DESIGN §3, §5). Adapters differ only in how
 * they fill `budgetGp` and `tags`; downstream code never branches on context.
 *
 * A request always carries one or more `parcels`. A combat hoard or quest
 * reward is a single parcel; a dungeon is many (one per room, some empty). The
 * top-level `budgetGp` is kept equal to the sum of parcel budgets so the single
 * WealthLedger only ever sees one number per request (DESIGN §5).
 */

import { CONTEXT, TARGET } from "../const.js";
import { isBiome, isFaction } from "./vocab.js";

function dedupeTrim(list) {
  return [...new Set((list ?? []).map(x => String(x ?? "").trim()).filter(Boolean))];
}
function normLower(list) {
  return [...new Set((list ?? []).map(x => String(x ?? "").trim().toLowerCase()).filter(Boolean))];
}

/**
 * Normalize a loose tag bag into the canonical Tags shape. Traits/custom are
 * lowercased (free-form, case-insensitive); biome/faction keys keep their case
 * and are validated against the vocabulary (unknown keys are dropped).
 */
export function makeTags({ traits, biomes, factions, custom, level } = {}) {
  return {
    traits: normLower(traits),
    biomes: dedupeTrim(biomes).filter(isBiome),
    factions: dedupeTrim(factions).filter(isFaction),
    custom: dedupeTrim(custom),
    level: Number.isFinite(level) ? Math.max(0, Math.trunc(level)) : 0
  };
}

/** True for an already-normalized Tags object (so we don't double-process). */
function isTags(t) {
  return !!t && Array.isArray(t.traits) && Array.isArray(t.biomes) && Array.isArray(t.factions);
}

/** Union two tag bags (either may be raw or already-normalized). */
export function mergeTags(a, b) {
  return makeTags({
    traits:   [...(a?.traits ?? []), ...(b?.traits ?? [])],
    biomes:   [...(a?.biomes ?? []), ...(b?.biomes ?? [])],
    factions: [...(a?.factions ?? []), ...(b?.factions ?? [])],
    custom:   [...(a?.custom ?? []), ...(b?.custom ?? [])],
    level:    Math.max(a?.level ?? 0, b?.level ?? 0)
  });
}

/**
 * Build a normalized LootRequest. All adapters funnel through here.
 *   { context, partyLevel, partySize, budgetGp, tags, target, label, parcels, meta }
 */
export function makeRequest({
  context = CONTEXT.COMBAT,
  partyLevel = 1,
  partySize = 4,
  budgetGp = 0,
  tags,
  target = TARGET.CHAT_CARD,
  label = "",
  parcels = null,
  maxItems = null,
  meta = {}
} = {}) {
  const lvl = Math.max(1, Math.min(20, Math.trunc(Number(partyLevel) || 1)));
  const req = {
    context,
    partyLevel: lvl,
    partySize: Math.max(1, Math.trunc(Number(partySize) || 4)),
    budgetGp: Math.max(0, Math.round(Number(budgetGp) || 0)),
    tags: isTags(tags) ? tags : makeTags(tags),
    target,
    label,
    // Optional hard cap on item picks (excess budget → currency). null = auto.
    maxItems: Number.isFinite(maxItems) && maxItems > 0 ? Math.trunc(maxItems) : null,
    meta: meta ?? {}
  };

  // A request always has parcels. Default: one parcel mirroring the request.
  req.parcels = Array.isArray(parcels) && parcels.length
    ? parcels.map((p, i) => normalizeParcel(p, i, req))
    : [{
        id: `${context}-0`,
        label: req.label,
        budgetGp: req.budgetGp,
        tags: req.tags,
        target: req.target,
        empty: req.budgetGp <= 0
      }];

  // Keep the headline budget equal to the sum of parcels (the ledger reads one).
  req.budgetGp = req.parcels.reduce((s, p) => s + p.budgetGp, 0);
  return req;
}

function normalizeParcel(p, i, req) {
  const budgetGp = Math.max(0, Math.round(Number(p?.budgetGp) || 0));
  return {
    id: p?.id ?? `${req.context}-${i}`,
    label: p?.label ?? `${req.label} ${i + 1}`.trim(),
    budgetGp,
    tags: isTags(p?.tags) ? p.tags : mergeTags(req.tags, makeTags(p?.tags)),
    target: p?.target ?? req.target,
    empty: p?.empty != null ? !!p.empty : budgetGp <= 0
  };
}
