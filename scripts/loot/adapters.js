/**
 * Entry-point adapters (DESIGN §5). One generator, four contexts; each adapter
 * fills a LootRequest's budget + tags + default target from its context, then
 * funnels through makeRequest() so everything downstream is uniform.
 *
 * Every adapter accepts a loose `opts` bag and fills sensible defaults from the
 * live game state (resolved party, selected tokens, current scene) so each is
 * genuinely push-button, while still letting a caller override any field.
 */

import { CONTEXT, TARGET, SHOP_TIER } from "../const.js";
import { makeRequest, makeTags, mergeTags } from "./request.js";
import {
  combatBudgetGp, cacheBudgetGp, questBudgetGp, dungeonBudgetGp, splitDungeon
} from "./budget.js";
import {
  tagsFromTokens, levelsFromTokens, tagsFromScene, tagsFromQuest
} from "./tags.js";
import { getAdapter } from "../systems/registry.js";

function estimateThreat(npcLevels, level, size) {
  return getAdapter()?.estimateThreat(npcLevels, level, size) ?? "moderate";
}
function resolveParty() { return getAdapter()?.resolveParty() ?? { partyActor: null, members: [] }; }
function actorLevel(a) { return getAdapter()?.actorLevel(a) ?? 1; }

/** Best-guess party level/size from the resolved party (adapter default). */
function partyContext(opts = {}) {
  const out = {};
  if (Number.isFinite(opts.partyLevel)) out.level = Math.trunc(opts.partyLevel);
  if (Number.isFinite(opts.partySize)) out.size = Math.trunc(opts.partySize);
  if (out.level != null && out.size != null) return out;

  const { members } = resolveParty();
  const levels = members.map(actorLevel);
  if (out.size == null) out.size = members.length || 4;
  if (out.level == null) {
    out.level = levels.length
      ? Math.round(levels.reduce((s, n) => s + n, 0) / levels.length)
      : 1;
  }
  return out;
}

function currentScene(opts) {
  return opts.scene ?? globalThis.canvas?.scene ?? null;
}

/**
 * Default token set for a combat hoard: the GM's selected tokens, else any
 * hostile placeables on the canvas. (The combat adapter reads the *defeated*
 * enemies — selecting them is the intended workflow.)
 */
function combatTokens(opts) {
  if (opts.tokens) return opts.tokens;
  const c = globalThis.canvas;
  const controlled = c?.tokens?.controlled ?? [];
  if (controlled.length) return controlled;
  const placeables = c?.tokens?.placeables ?? [];
  return placeables.filter(t =>
    t?.document?.disposition === -1 || t?.actor?.alliance === "opposition");
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/* ------------------------------- combat -------------------------------- */

export function combatRequest(opts = {}) {
  const { level, size } = partyContext(opts);
  const tokens = combatTokens(opts);
  const threat = opts.threat ?? estimateThreat(levelsFromTokens(tokens), level, size);
  const budgetGp = combatBudgetGp(threat, level, size);
  const tags = mergeTags(tagsFromTokens(tokens, { level }), makeTags(opts.tags));

  return makeRequest({
    context: CONTEXT.COMBAT,
    partyLevel: level,
    partySize: size,
    budgetGp,
    tags,
    target: opts.target ?? TARGET.LOOT_ACTOR,
    label: opts.label ?? `${capitalize(threat)} encounter hoard`,
    meta: { threat, sourceCount: tokens.length }
  });
}

/* ----------------------------- exploration ----------------------------- */

export function explorationRequest(opts = {}) {
  const { level, size } = partyContext(opts);
  const tier = opts.tier ?? "standard";
  const budgetGp = cacheBudgetGp(tier, level, size);
  const tags = mergeTags(
    tagsFromScene(currentScene(opts), { level }),
    makeTags(opts.tags)
  );

  return makeRequest({
    context: CONTEXT.EXPLORATION,
    partyLevel: level,
    partySize: size,
    budgetGp,
    tags,
    target: opts.target ?? TARGET.LOOT_ACTOR,
    label: opts.label ?? `${capitalize(tier)} cache`,
    meta: { tier }
  });
}

/* ------------------------------- dungeon ------------------------------- */

export function dungeonRequest(opts = {}) {
  const { level, size } = partyContext(opts);
  const tier = opts.tier ?? "major";
  const rooms = Math.max(1, Math.trunc(opts.rooms ?? 5));
  const total = dungeonBudgetGp(tier, level, size);
  const splits = splitDungeon(total, rooms, { emptyRatio: opts.emptyRatio ?? 0.4 });
  const baseTags = mergeTags(
    tagsFromScene(currentScene(opts), { level }),
    makeTags(opts.tags)
  );

  const parcels = splits.map((gp, i) => ({
    id: `dungeon-room-${i + 1}`,
    label: `Room ${i + 1}`,
    budgetGp: gp,
    tags: baseTags,
    target: opts.target ?? TARGET.LOOT_ACTOR,
    empty: gp <= 0
  }));

  return makeRequest({
    context: CONTEXT.DUNGEON,
    partyLevel: level,
    partySize: size,
    tags: baseTags,
    target: opts.target ?? TARGET.LOOT_ACTOR,
    label: opts.label ?? `${capitalize(tier)} dungeon (${rooms} rooms)`,
    parcels,
    meta: { tier, rooms, emptyRooms: parcels.filter(p => p.empty).length }
  });
}

/* -------------------------------- quest -------------------------------- */

export function questRequest(opts = {}) {
  const { level, size } = partyContext(opts);
  const tier = opts.tier ?? "standard";
  const budgetGp = questBudgetGp(tier, level, size);
  const tags = mergeTags(
    tagsFromQuest({ factions: opts.factions, questgiver: opts.questgiver, level }),
    makeTags(opts.tags)
  );

  return makeRequest({
    context: CONTEXT.QUEST,
    partyLevel: level,
    partySize: size,
    budgetGp,
    tags,
    target: opts.target ?? TARGET.CHAT_CARD,
    label: opts.label ?? `${capitalize(tier)} quest reward`,
    meta: { tier }
  });
}

/* ----------------------------- single item ----------------------------- */

/**
 * Ad-hoc single item: not budget-driven. The cascade detects meta.single and
 * picks exactly one item near `itemLevel` (defaults to party level), themed by
 * the same tags, of the requested kind ("any" | "permanent" | "consumable").
 */
export function singleRequest(opts = {}) {
  const { level, size } = partyContext(opts);
  const itemLevel = Number.isFinite(opts.itemLevel) ? Math.max(0, Math.trunc(opts.itemLevel)) : level;
  const tags = mergeTags(tagsFromScene(currentScene(opts), { level }), makeTags(opts.tags));

  return makeRequest({
    context: CONTEXT.SINGLE,
    partyLevel: level,
    partySize: size,
    budgetGp: 0,
    tags,
    target: opts.target ?? TARGET.CHAT_CARD,
    label: opts.label ?? `Single item (Lv ${itemLevel})`,
    maxItems: 1,
    meta: { single: true, itemLevel, kind: opts.kind ?? "any" }
  });
}

/* -------------------------------- shop --------------------------------- */

/**
 * Shop (DESIGN §18): budget-NEUTRAL. Not a slice of the treasure budget — a
 * curated, themed Merchant the party spends their own gp at. The cascade detects
 * meta.shop and delegates to proposeShop, which sizes the stock by `tier`
 * (peddler/stall/shop/emporium) and themes it from the scene tags. `useLlm` rides
 * in meta so the shop decorator knows whether to author a shopkeeper + signatures.
 */
export function shopRequest(opts = {}) {
  const { level, size } = partyContext(opts);
  const tier = Object.values(SHOP_TIER).includes(opts.tier) ? opts.tier : SHOP_TIER.SHOP;
  const tags = mergeTags(tagsFromScene(currentScene(opts), { level }), makeTags(opts.tags));

  return makeRequest({
    context: CONTEXT.SHOP,
    partyLevel: level,
    partySize: size,
    budgetGp: 0,                                  // budget-neutral — never touches the ledger
    tags,
    target: opts.target ?? TARGET.MERCHANT,
    label: opts.label ?? `${capitalize(tier)} (shop)`,
    maxItems: Number.isFinite(opts.maxItems) && opts.maxItems > 0 ? Math.trunc(opts.maxItems) : null,
    meta: { shop: true, shopTier: tier, useLlm: !!opts.useLlm }
  });
}

/* ------------------------------ dispatch ------------------------------- */

export const ADAPTERS = {
  [CONTEXT.COMBAT]: combatRequest,
  [CONTEXT.EXPLORATION]: explorationRequest,
  [CONTEXT.DUNGEON]: dungeonRequest,
  [CONTEXT.QUEST]: questRequest,
  [CONTEXT.SINGLE]: singleRequest,
  [CONTEXT.SHOP]: shopRequest
};

/** Build a LootRequest for any context by key. Throws on an unknown context. */
export function buildRequest(context, opts = {}) {
  const fn = ADAPTERS[context];
  if (!fn) throw new Error(`${context}: unknown loot context (expected one of ${Object.keys(ADAPTERS).join(", ")})`);
  const req = fn(opts);
  // Honor an explicit item cap from any caller (the single adapter sets its own).
  if (Number.isFinite(opts.maxItems) && opts.maxItems > 0) req.maxItems = Math.trunc(opts.maxItems);
  return req;
}
