/**
 * D&D 5e (2024) hoard generator — the 5e analogue of the PF2e priority cascade
 * (DESIGN §19). 5e treasure is awarded by COUNT and RARITY, not by spending a gp
 * budget, so this does NOT run the gp cascade. Instead, per the 2024 DMG model:
 *
 *   1. roll N magic items for the hoard (N + rarity from the tier plan),
 *      selecting a real, themed, rarity-appropriate compendium item for each;
 *   2. add a small mundane layer (themed gear + consumables);
 *   3. drop the monetary treasure as coins (the context's gold slice).
 *
 * The LLM "curator" (loot-plan profile) steers only the discretionary picks —
 * named wants + theme/rarity weighting — exactly like the PF2e path. Output is
 * the same proposal shape proposeLoot returns, so the review card, decorator,
 * and materializer consume it unchanged.
 */

import { MODULE_ID, SETTINGS, CORE_RATIO } from "../../const.js";
import { getItemIndex, filterCandidates, weightFor, weightedPick } from "../../loot/item-selector.js";
import {
  requestSelectionProfile, profileWeight, applyExclude, resolveWanted, rarityLeanBias
} from "../../loot/selection-profile.js";
import { magicPlan, RARITY_LEVEL, RARITY_GP, RARITY_ORDER } from "./tables.js";
import { normRarity } from "./actor-reader.js";
import { importItemByName, ensureContent } from "./plutonium.js";

const RARITIES = ["common", "uncommon", "rare", "very rare", "legendary"];
const MAX_ITEMS = 30;

/** Build a full loot proposal for a 5e budget context (combat/cache/dungeon/quest). */
export async function proposeHoard(request) {
  await ensureContent({ notify: false });            // deep Plutonium sourcing (best-effort)
  const index = await getItemIndex();
  const level = request.partyLevel;
  const tags = request.tags;
  const context = request.context;
  const key = request.meta?.threat ?? request.meta?.tier ?? "standard";
  const cap = Math.max(1, Math.min(MAX_ITEMS, request.maxItems ?? MAX_ITEMS));

  const plan = magicPlan(context, key, level);       // { count, tier, weights }
  const access = safeSetting(SETTINGS.shoppingAccess, "limited");
  const coreRatio = CORE_RATIO[access] ?? 0.75;

  const used = new Set();
  const picks = [];
  const reasoning = [];
  reasoning.push(`D&D 2024 model: tier ${plan.tier} hoard — about ${plan.count} magic item(s) plus coin.`);

  // Optional LLM curator — steers named wants + theme/rarity weighting only.
  const profile = await planLoot(request, level, tags);
  if (profile) reasoning.push("Discretionary picks steered by the LLM curator from your context note.");
  const leanBias = profile ? rarityLeanBias(profile.rarityLean) : 0;

  /* ---- Phase 1: named wants from the brief (resolved to real items) ---- */
  let magicQuota = plan.count;
  if (profile?.wanted?.length) {
    for (const name of profile.wanted) {
      if (picks.length >= cap) break;
      let it = resolveWanted(index, name, { maxLevel: 25, used });
      if (!it) {
        // Deep Plutonium import on demand for a named want not yet in a pack.
        const uuid = await importItemByName(name);
        if (uuid) { clearIndexFor(); it = await reindexFind(uuid); }
      }
      if (it) {
        used.add(it.uuid);
        picks.push(toMagicPick(it, `Included to match your context note — “${String(name).slice(0, 40)}”`));
        reasoning.push(`Included “${it.name}” to match your context note.`);
        if (it.magic) magicQuota = Math.max(0, magicQuota - 1);
      }
    }
  }

  /* ---- Phase 2: roll the hoard's magic items by rarity ---- */
  let attuneItems = 0;
  for (let i = 0; i < magicQuota && picks.length < cap; i++) {
    const rarity = rollRarity(plan.weights, leanBias);
    const it = pickMagicItem(index, { rarity, tags, used, profile, attuneItems });
    if (!it) continue;
    used.add(it.uuid);
    if (it.attunement) attuneItems++;
    picks.push(toMagicPick(it, magicReason(it, tags)));
    reasoning.push(magicReason(it, tags));
  }

  /* ---- Phase 3: a small mundane layer (themed gear + consumables) ---- */
  const mundaneCount = mundaneLayerCount(plan.tier, coreRatio);
  for (let i = 0; i < mundaneCount && picks.length < cap; i++) {
    const wantConsumable = i % 2 === 1;
    const it = pickMundane(index, { level, tags, used, profile, consumable: wantConsumable });
    if (!it) continue;
    used.add(it.uuid);
    picks.push(toMundanePick(it, themeReason(it, tags)));
  }

  /* ---- Phase 4: monetary treasure (coins) ---- */
  const currencyGp = Math.max(0, round2(request.budgetGp));

  const parcels = distributeToParcels(request, picks, currencyGp);
  const totalGp = round2(picks.reduce((s, p) => s + p.gp, 0) + currencyGp);

  return {
    id: `gllg-${context}-d5e-${picks.length}-${Math.round(currencyGp)}-${parcels.length}`,
    context, label: request.label, level, partySize: request.partySize,
    target: request.target, request, parcels, reasoning,
    totalGp, itemCount: picks.length, currencyGp
  };
}

/* ------------------------------ selection ------------------------------ */

/** Roll one rarity from a weight table, nudged by an LLM rarity lean. */
function rollRarity(weights, leanBias = 0) {
  const entries = Object.entries(weights).map(([r, w]) => {
    const ord = RARITY_ORDER[r] ?? 1;
    // A positive lean boosts rarer items; negative favours common.
    const lean = 1 + leanBias * (ord - 2) * 0.5;
    return [r, Math.max(0, (Number(w) || 0) * Math.max(0.05, lean))];
  });
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return "uncommon";
  let r = Math.random() * total;
  for (const [rarity, w] of entries) { r -= w; if (r <= 0) return rarity; }
  return entries[entries.length - 1][0];
}

/**
 * Select a real magic item of (or near) the rolled rarity, themed by the tags
 * and biased by the LLM profile. Soft attunement-awareness: once the hoard
 * already carries a few attunement items, prefer non-attunement ones so a single
 * find doesn't demand more attunement slots than the party has.
 */
function pickMagicItem(index, { rarity, tags, used, profile, attuneItems }) {
  let cands = magicOfRarity(index, rarity, used);
  if (!cands.length) {           // widen to adjacent rarities if the pack is thin
    for (const r of nearbyRarities(rarity)) {
      cands = magicOfRarity(index, r, used);
      if (cands.length) break;
    }
  }
  if (!cands.length) return null;
  if (profile) cands = applyExclude(cands, profile.exclude);
  if (!cands.length) return null;

  const preferLevel = RARITY_LEVEL[rarity] ?? 5;
  const softAttune = attuneItems >= 3;
  return weightedPick(cands, it => {
    let w = profile
      ? profileWeight(it, { profile, tags, preferLevel, unusualBias: 0 })
      : weightFor(it, { tags, preferLevel, unusualBias: 0 });
    if (softAttune && it.attunement) w *= 0.3;   // discourage over-attunement
    return w;
  });
}

function magicOfRarity(index, rarity, used) {
  return index.filter(it => it.magic && it.rarity === rarity && !used.has(it.uuid));
}
function nearbyRarities(rarity) {
  const i = RARITIES.indexOf(rarity);
  if (i < 0) return RARITIES;
  const out = [];
  for (let d = 1; d < RARITIES.length; d++) {
    if (RARITIES[i - d]) out.push(RARITIES[i - d]);
    if (RARITIES[i + d]) out.push(RARITIES[i + d]);
  }
  return out;
}

/** Pick a mundane (non-magic) themed gear or consumable. */
function pickMundane(index, { level, tags, used, profile, consumable }) {
  const types = consumable ? new Set(["consumable"]) : new Set(["weapon", "equipment", "tool"]);
  let cands = index.filter(it => !it.magic && types.has(it.type) && !used.has(it.uuid) && it.gp > 0);
  if (profile) cands = applyExclude(cands, profile.exclude);
  if (!cands.length) return null;
  return weightedPick(cands, it => profile
    ? profileWeight(it, { profile, tags, preferLevel: 0, unusualBias: -0.3 })
    : weightFor(it, { tags, preferLevel: 0, unusualBias: -0.3 }));
}

/** How many mundane bonus items to include, by tier + shopping access. */
function mundaneLayerCount(tier, coreRatio) {
  const base = { 1: 2, 2: 2, 3: 1, 4: 1 }[tier] ?? 1;           // less mundane filler at high tiers
  const bonus = Math.random() < coreRatio ? 1 : 0;             // more "core" worlds → a bit more mundane
  return base + bonus;
}

/* ------------------------------ pick shaping ------------------------------ */

function toMagicPick(it, reason) {
  return {
    uuid: it.uuid, name: it.name, img: it.img, type: it.type,
    level: it.level, gp: round2(it.gp || RARITY_GP[it.rarity] || 0), qty: 1, rarity: it.rarity,
    tier: it.rarity && it.rarity !== "common" ? "unusual" : "magic",
    reason, forActorId: null, forActorName: null
  };
}
function toMundanePick(it, reason) {
  return {
    uuid: it.uuid, name: it.name, img: it.img, type: it.type,
    level: it.level, gp: round2(it.gp), qty: 1, rarity: it.rarity ?? "common",
    tier: it.type === "consumable" ? "consumable" : "core",
    reason, forActorId: null, forActorName: null
  };
}

function magicReason(it, tags) {
  const hits = (it.traits ?? []).filter(t => (tags?.traits ?? []).includes(t));
  if (hits.length) return `Themed ${it.rarity} find (matches ${hits.slice(0, 2).join(", ")})`;
  return `${capitalize(it.rarity)} magic item for the hoard`;
}
function themeReason(it, tags) {
  const hits = (it.traits ?? []).filter(t => (tags?.traits ?? []).includes(t));
  if (hits.length) return `Themed pick (matches ${hits.slice(0, 2).join(", ")})`;
  return it.type === "consumable" ? "Consumable for the haul" : "Mundane gear";
}

/* ------------------------------ parcels ------------------------------ */

/**
 * Spread picks across the request's non-empty parcels by COUNT (5e magic items
 * have a large nominal value but a hoard isn't gp-bin-packed), then split the
 * coins by each parcel's gold share. Single-parcel requests take everything.
 */
function distributeToParcels(request, picks, currencyGp) {
  const live = request.parcels.filter(p => !p.empty && p.budgetGp > 0);
  if (live.length <= 1) {
    const p = live[0] ?? request.parcels[0];
    return [{
      id: p.id, label: p.label, target: p.target,
      items: picks, currencyGp, totalGp: round2(picks.reduce((s, x) => s + x.gp, 0) + currencyGp)
    }];
  }

  const bins = live.map(p => ({ ...p, items: [] }));
  picks.forEach((pick, i) => bins[i % bins.length].items.push(pick));

  const totalBudget = bins.reduce((s, b) => s + b.budgetGp, 0) || 1;
  let allocated = 0;
  const out = bins.map((b, i) => {
    const coins = i === bins.length - 1
      ? Math.max(0, round2(currencyGp - allocated))
      : Math.max(0, round2(currencyGp * (b.budgetGp / totalBudget)));
    allocated += coins;
    return {
      id: b.id, label: b.label, target: b.target,
      items: b.items, currencyGp: coins,
      totalGp: round2(b.items.reduce((s, x) => s + x.gp, 0) + coins)
    };
  });
  return out;
}

/* ------------------------------ LLM curator ------------------------------ */

async function planLoot(request, level, tags) {
  if (!request?.meta?.useLlm || !llmPlanEnabled()) return null;
  const brief = String(request?.meta?.extraContext ?? "").trim();
  if (!brief) return null;
  const payload = {
    brief, context: request.context, level, maxLevel: 25,
    system: "dnd5e",
    count: Number.isFinite(request.maxItems) ? request.maxItems : null,
    theme: themeWordsFor(tags),
    campaign: String(safeSetting(SETTINGS.campaignContext, "") ?? "").trim(),
    model: String(safeSetting(SETTINGS.llmModel, "") ?? "").trim()
  };
  try { return await requestSelectionProfile({ endpoint: "/loot-plan", payload, kind: "loot-plan" }); }
  catch (err) { console.warn(`${MODULE_ID} | loot plan failed — theme fallback`, err); return null; }
}

function llmPlanEnabled() {
  return !!safeSetting(SETTINGS.llmFlavor, false) && !!String(safeSetting(SETTINGS.sidecarUrl, "")).trim();
}
function themeWordsFor(tags) {
  return [...(tags?.biomes ?? []), ...(tags?.factions ?? []), ...(tags?.traits ?? [])].slice(0, 5).join(", ");
}

/* ------------------------------ index helpers ------------------------------ */

/** After a deep import, re-read the index and find the freshly-imported uuid. */
async function reindexFind(uuid) {
  const { clearItemIndex } = await import("../../loot/item-selector.js");
  clearItemIndex();
  const index = await getItemIndex();
  return index.find(it => it.uuid === uuid) ?? null;
}
function clearIndexFor() { /* placeholder kept for symmetry; reindex handles it */ }

/* ------------------------------ utils ------------------------------ */

function safeSetting(key, fallback) { try { return game.settings.get(MODULE_ID, key); } catch { return fallback; } }
function round2(n) { return Math.round(n * 100) / 100; }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
