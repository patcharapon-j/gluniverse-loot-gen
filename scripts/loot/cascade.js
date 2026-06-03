/**
 * PacingEngine — the prescriptive priority cascade (DESIGN §6). Given a
 * LootRequest it reads the Auditor (HealthCheck + WealthLedger) and spends the
 * budget in strict order, recording a human reason for every pick:
 *
 *   1. Math-critical fundamental gaps  (themed where possible)
 *   2. Wealth-drift correction         (over-weight whoever's behind)
 *   3. Fun layer                       (themed / unusual + consumables)
 *   4. Currency fills the remainder
 *
 * Output is a *proposal* — nothing is created here. The review card gates it and
 * the Materializer realizes it. The proposal is plain-serializable so it can
 * ride along in a chat-message flag (survives reroll/approve across a reload).
 */

import { CORE_RATIO, SETTINGS, SEVERITY } from "../const.js";
import {
  getItemIndex, filterCandidates, weightFor, weightedPick, findRune, mundaneBases
} from "./item-selector.js";
import { buildReport } from "../auditor/health-check.js";
import { expectedFundamentals } from "../pf2e/tables.js";
import { buildRuneSet, themeRuneSlugs } from "../pf2e/runes.js";
import { signatureWeapon, signatureArmor } from "../pf2e/actor-reader.js";

const ARMOR_AXES = new Set(["defense", "resilient"]);

const CORE_AXES = ["attack", "striking", "defense", "resilient"];
const MAX_ITEMS = 30;            // runaway guard
const MIN_ITEM_GP = 0.5;         // below this, stop buying and dump to currency
const MIN_RUNED_GP = 35;         // don't attempt etching below the cheapest potency rune (+1 weapon, 35 gp)
const RUNED_GEAR_CHANCE = 0.6;   // share of permanent picks that etch a base weapon/armor (vs. a pre-made magic item)

/** Build a full loot proposal for a request. Async (queries compendia). */
export async function proposeLoot(request) {
  // Shops are budget-neutral and stock a Merchant; they reuse the proposal shape
  // and review card but not the priority cascade (DESIGN §18). Delegated lazily
  // so the review card's reroll path works without any special-casing.
  if (request?.meta?.shop) {
    const { proposeShop } = await import("./shop.js");
    return proposeShop(request);
  }
  if (request?.meta?.single) return proposeSingle(request);

  const index = await getItemIndex();
  const level = request.partyLevel;
  const report = safeReport();
  const tags = request.tags;
  // GM item cap (excess budget → currency); falls back to the runaway guard.
  const cap = Math.max(1, Math.min(MAX_ITEMS, request.maxItems ?? MAX_ITEMS));

  // Core-vs-unusual: shopping-access baseline, nudged toward core if the party
  // has math-critical gaps (DESIGN §8).
  const access = safeSetting(SETTINGS.shoppingAccess, "limited");
  const coreRatio = CORE_RATIO[access] ?? 0.75;
  const critCount = report?.party?.counts?.critical ?? 0;
  const funBias = clamp((1 - coreRatio) - critCount * 0.1, 0, 1);

  const used = new Set();
  const picks = [];
  const reasoning = [];
  let remaining = request.budgetGp;
  const heirloom = heirloomEnabled();
  const etch = etchEnabled();
  const themeSlugs = themeRuneSlugs(tags);

  const buy = (item, extra) => {
    if (!item) return false;
    used.add(item.uuid);
    remaining -= item.gp;
    picks.push({
      uuid: item.uuid, name: item.name, img: item.img, type: item.type,
      level: item.level, gp: round2(item.gp), qty: 1, rarity: item.rarity,
      tier: extra.tier ?? classifyTier(item),
      reason: extra.reason ?? "",
      forActorId: extra.forActorId ?? null,
      forActorName: extra.forActorName ?? null
    });
    return true;
  };

  // Etch an appropriate, legal, RAW-priced rune set onto a mundane base weapon/
  // armor (DESIGN §9). gp is base + runes; the item level rises to the highest
  // rune level. The rune set rides on the pick so the Materializer can write the
  // real `system.runes` object onto the hydrated base item.
  const buyRuned = (base, set, extra) => {
    if (!base || !set) return false;
    used.add(base.uuid);
    const gp = round2(base.gp + set.addedGp);
    remaining -= gp;
    picks.push({
      uuid: base.uuid, name: base.name, img: base.img, type: base.type,
      level: Math.max(base.level, set.addedLevel), gp, qty: 1, rarity: base.rarity,
      tier: "runed",
      reason: extra.reason ?? "",
      forActorId: extra.forActorId ?? null,
      forActorName: extra.forActorName ?? null,
      runes: set.runes,
      runeNames: set.names
    });
    return true;
  };

  // Pick a level-appropriate permanent. Part of the time (so wondrous items,
  // wands, and worn gear still appear) it etches a freshly-runed base weapon or
  // armor so that weapon/armor loot carries its rune set (DESIGN §9); otherwise
  // it pulls a pre-made magic item. Returns { runed:{base,set} } | { item } |
  // null. Commits via `place`.
  const pickGear = (maxGp, { unusualBias = 0 } = {}) => {
    if (etch && maxGp >= MIN_RUNED_GP && Math.random() < RUNED_GEAR_CHANCE) {
      const kind = Math.random() < 0.5 ? "weapon" : "armor";
      const runed = pickRunedGear(index, { level, tags, maxGp, used, kind, themeSlugs })
        ?? pickRunedGear(index, { level, tags, maxGp, used, themeSlugs, kind: kind === "weapon" ? "armor" : "weapon" });
      if (runed) return { runed };
    }
    const item = pickPermanent(index, { level, tags, maxGp, used, unusualBias });
    return item ? { item } : null;
  };

  // Commit a pickGear result with a shared reason/target; returns gp spent.
  const place = (res, { forActorId = null, forActorName = null } = {}) => {
    if (!res) return 0;
    const before = remaining;
    if (res.runed) {
      const r = runedReason(res.runed.base, res.runed.set);
      buyRuned(res.runed.base, res.runed.set, { reason: r, forActorId, forActorName });
      reasoning.push(forActorName ? `${r} for ${forActorName}` : r);
    } else {
      const r = forActorName ? `Weighted toward ${forActorName} (behind on wealth)` : themeReason(res.item, tags);
      buy(res.item, { reason: r, forActorId, forActorName });
      reasoning.push(r);
    }
    return round2(before - remaining);
  };

  // Heirloom awakening: same RAW-priced rune, but it climbs *within* the PC's
  // signature item (in-place, direct-to-sheet) instead of dropping a new one.
  // Not added to `used` — two PCs may awaken the same rune tier (DESIGN §9).
  const awaken = (found, gap, sig) => {
    remaining -= found.item.gp;
    picks.push({
      uuid: found.item.uuid, name: found.item.name, img: found.item.img, type: found.item.type,
      level: found.item.level, gp: round2(found.item.gp), qty: 1, rarity: found.item.rarity,
      tier: "heirloom",
      reason: `Awakens within ${sig.name}`,
      forActorId: gap.actorId, forActorName: gap.actorName,
      heirloom: true, axis: gap.axis, targetTier: found.tier,
      forItemId: sig.id, forItemName: sig.name
    });
  };

  /* ---- Phase 1: math-critical fundamentals ---- */
  if (report?.ok) {
    const gaps = collectFundamentalGaps(report); // worst-first
    for (const gap of gaps) {
      if (remaining < MIN_ITEM_GP || picks.length >= cap) break;
      const found = findRune(index, gap.axis, gap.expectedTier, remaining);
      if (found && !used.has(found.item.uuid)) {
        const sig = heirloom ? signatureFor(gap.actorId, gap.axis) : null;
        const fill = found.tier >= gap.expectedTier ? "to tier " + found.tier : "partial, tier " + found.tier;
        if (sig) {
          const r = `Awakens ${gap.actorName}'s ${gap.label} within ${sig.name} (${fill})`;
          awaken(found, gap, sig);
          reasoning.push(r);
        } else {
          const r = `Fills ${gap.actorName}'s ${gap.label} gap (${fill})`;
          buy(found.item, { tier: "rune", reason: r, forActorId: gap.actorId, forActorName: gap.actorName });
          reasoning.push(r);
        }
      } else {
        // No affordable rune found — note it so the GM sees the unmet need.
        reasoning.push(`Could not afford a rune for ${gap.actorName}'s ${gap.label} gap.`);
      }
    }
  }

  /* ---- Phase 2: wealth-drift correction ---- */
  const behind = (report?.members ?? []).filter(m => m.wealth?.severity === SEVERITY.BEHIND);
  if (behind.length && remaining >= MIN_ITEM_GP) {
    let driftBudget = remaining * 0.4;            // a portion, not all
    let i = 0;
    while (driftBudget >= MIN_ITEM_GP && picks.length < cap) {
      const target = behind[i % behind.length];
      const res = pickGear(Math.min(driftBudget, remaining), { unusualBias: funBias * 0.5 });
      if (!res) break;
      const spent = place(res, { forActorId: target.id, forActorName: target.name });
      if (spent <= 0) break;
      driftBudget -= spent;
      i++;
    }
  }

  /* ---- Phase 3: fun layer (themed permanents + consumables) ---- */
  // A couple of permanents, leaning unusual per the core/unusual split.
  let safety = 0;
  while (remaining >= MIN_ITEM_GP && picks.length < cap && safety++ < MAX_ITEMS) {
    // Alternate permanents and consumables; consumables sit 2–3 levels below.
    const wantConsumable = safety % 2 === 0;
    if (wantConsumable) {
      const c = pickConsumable(index, { level, tags, maxGp: remaining, used });
      if (c) { buy(c, { reason: themeReason(c, tags) }); continue; }
      // Fall through to a permanent if no consumable fits.
      const res = pickGear(remaining, { unusualBias: funBias });
      if (!res) break;
      place(res);
      continue;
    }
    const res = pickGear(remaining, { unusualBias: funBias });
    if (res) { place(res); continue; }
    // Try a consumable once before giving up.
    const c = pickConsumable(index, { level, tags, maxGp: remaining, used });
    if (!c) break;
    buy(c, { reason: themeReason(c, tags) });
  }

  /* ---- Phase 4: currency fills the rest ---- */
  const currencyGp = Math.max(0, round2(remaining));

  // Distribute picks + currency into the request's parcels (dungeon rooms etc).
  const parcels = distributeToParcels(request, picks, currencyGp);

  return {
    id: `gllg-${request.context}-${picks.length}-${Math.round(request.budgetGp)}-${parcels.length}`,
    context: request.context,
    label: request.label,
    level,
    partySize: request.partySize,
    target: request.target,
    request,                       // plain object — safe to persist in a flag
    parcels,
    reasoning,
    totalGp: round2(request.budgetGp),
    itemCount: picks.length,
    currencyGp
  };
}

/**
 * Ad-hoc single item: pick exactly one item near meta.itemLevel, themed by the
 * request tags, of the requested kind. Not budget-driven (DESIGN — a GM utility
 * on top of the same selector). Returns the same proposal shape as proposeLoot.
 */
async function proposeSingle(request) {
  const index = await getItemIndex();
  const itemLevel = clamp(request.meta?.itemLevel ?? request.partyLevel, 0, 25);
  const kind = request.meta?.kind ?? "any";
  const tags = request.tags;

  const types = kind === "consumable" ? CONSUMABLE_TYPES
    : kind === "permanent" ? PERMANENT_TYPES
    : new Set([...PERMANENT_TYPES, ...CONSUMABLE_TYPES]);

  let cands = filterCandidates(index, { minLevel: Math.max(0, itemLevel - 1), maxLevel: itemLevel + 1, types });
  if (!cands.length) cands = filterCandidates(index, { minLevel: Math.max(0, itemLevel - 2), maxLevel: itemLevel + 2, types });
  const item = weightedPick(cands, it => weightFor(it, { tags, preferLevel: itemLevel }));

  const picks = [];
  const reasoning = [];
  if (item) {
    picks.push({
      uuid: item.uuid, name: item.name, img: item.img, type: item.type,
      level: item.level, gp: round2(item.gp), qty: 1, rarity: item.rarity,
      tier: classifyTier(item), reason: `Ad-hoc single ${item.type} near level ${itemLevel}`,
      forActorId: null, forActorName: null
    });
    reasoning.push(`Generated one ${item.type} (level ${item.level}) near target level ${itemLevel}.`);
  } else {
    reasoning.push(`No matching item found near level ${itemLevel}.`);
  }

  const totalGp = round2(picks.reduce((s, x) => s + x.gp, 0));
  const parcel = request.parcels[0] ?? { id: "single-0", label: request.label, target: request.target };
  return {
    id: `gllg-single-${itemLevel}-${picks.length}`,
    context: request.context,
    label: request.label,
    level: request.partyLevel,
    partySize: request.partySize,
    target: request.target,
    request,
    parcels: [{ id: parcel.id, label: parcel.label, target: request.target, items: picks, currencyGp: 0, totalGp }],
    reasoning,
    totalGp,
    itemCount: picks.length,
    currencyGp: 0
  };
}

/* ------------------------------ phase helpers ------------------------------ */

/** Collect each PC's missing/behind core fundamentals, worst (critical) first. */
function collectFundamentalGaps(report) {
  const gaps = [];
  for (const m of report.members) {
    const want = expectedFundamentals(m.level);
    for (const f of m.fundamentals) {
      if (!CORE_AXES.includes(f.key)) continue;
      if (f.severity === SEVERITY.CRITICAL || f.severity === SEVERITY.BEHIND) {
        gaps.push({
          actorId: m.id, actorName: m.name,
          axis: f.key, label: f.name,
          expectedTier: want[f.key] ?? 1,
          critical: f.severity === SEVERITY.CRITICAL
        });
      }
    }
  }
  gaps.sort((a, b) => (b.critical - a.critical));
  return gaps;
}

/**
 * Build a runed base weapon/armor for the fun/drift layers (DESIGN §9): pick a
 * themed, affordable mundane base, then etch a legal, level-appropriate rune set
 * onto it. Returns { base, set } or null when nothing fits the budget.
 */
function pickRunedGear(index, { level, tags, maxGp, used, kind, themeSlugs }) {
  const bases = mundaneBases(index, kind)
    .filter(b => b.gp <= maxGp - MIN_RUNED_GP && !used.has(b.uuid));
  if (!bases.length) return null;
  const base = weightedPick(bases, it => weightFor(it, { tags, preferLevel: 0 }));
  if (!base) return null;
  const set = buildRuneSet(base.meta, { level, maxGp: maxGp - base.gp, themeSlugs });
  if (!set) return null;
  return { base, set };
}

/** Human reason for a freshly-runed item, e.g. "Etched +1 striking flaming dagger". */
function runedReason(base, set) {
  const runes = (set?.names ?? []).join(" ");
  return `Etched ${runes} ${base.name}`.replace(/\s+/g, " ").trim();
}

function pickPermanent(index, { level, tags, maxGp, used, unusualBias = 0 }) {
  const cands = filterCandidates(index, {
    minLevel: Math.max(0, level - 1), maxLevel: level + 2, maxGp,
    types: PERMANENT_TYPES, excludeUuids: used
  });
  return weightedPick(cands, it => weightFor(it, { tags, preferLevel: level + 1, unusualBias }));
}

function pickConsumable(index, { level, tags, maxGp, used }) {
  const cands = filterCandidates(index, {
    minLevel: Math.max(0, level - 3), maxLevel: Math.max(0, level - 1), maxGp,
    types: CONSUMABLE_TYPES, excludeUuids: used
  });
  return weightedPick(cands, it => weightFor(it, { tags, preferLevel: level - 2, unusualBias: 0 }));
}

const PERMANENT_TYPES = new Set(["weapon", "armor", "shield", "equipment"]);
const CONSUMABLE_TYPES = new Set(["consumable"]);

function classifyTier(item) {
  if (item.type === "consumable") return "consumable";
  return item.rarity && item.rarity !== "common" ? "unusual" : "core";
}

function themeReason(item, tags) {
  const hits = (item.traits ?? []).filter(t => (tags?.traits ?? []).includes(t));
  if (hits.length) return `Themed pick (matches ${hits.slice(0, 2).join(", ")})`;
  if (item.type === "consumable") return "Consumable for the haul";
  return item.rarity && item.rarity !== "common" ? "Unusual find" : "Level-appropriate gear";
}

/**
 * Greedily bin-pack picks into the request's non-empty parcels (largest budget
 * first), then set each parcel's leftover budget as its currency. Single-parcel
 * requests (combat/quest/exploration) trivially take everything.
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

  // Multi-parcel (dungeon): fit items into rooms, then spread currency by room budget.
  const bins = live
    .slice()
    .sort((a, b) => b.budgetGp - a.budgetGp)
    .map(p => ({ ...p, items: [], spent: 0 }));

  const sorted = picks.slice().sort((a, b) => b.gp - a.gp);
  for (const pick of sorted) {
    let bin = bins.find(b => b.spent + pick.gp <= b.budgetGp);
    if (!bin) bin = bins[0]; // overflow → richest room
    bin.items.push(pick);
    bin.spent += pick.gp;
  }

  // Currency = each room's remaining budget (clamped ≥ 0), summing to currencyGp ±rounding.
  return bins.map(b => {
    const left = Math.max(0, round2(b.budgetGp - b.spent));
    return {
      id: b.id, label: b.label, target: b.target,
      items: b.items, currencyGp: left,
      totalGp: round2(b.spent + left)
    };
  });
}

/* ------------------------------ utilities ------------------------------ */

function safeReport() {
  try { return buildReport({ tolerancePct: safeSetting(SETTINGS.driftTolerancePct, 25) }); }
  catch { return { ok: false, members: [], party: null }; }
}

/** Is heirloom (in-place rune awakening) mode on for this world? */
function heirloomEnabled() {
  return !!safeSetting(SETTINGS.heirloomMode, false);
}

/** Should weapon/armor loot be etched with appropriate rune sets (DESIGN §9)? */
function etchEnabled() {
  return !!safeSetting(SETTINGS.etchRunes, true);
}

/**
 * Resolve a PC's signature item for a rune axis, or null when no in-place edit
 * is possible (no item, or armor awakening disabled). Falls back to a normal
 * rune drop in the caller so the gap is never silently dropped.
 */
function signatureFor(actorId, axis) {
  const actor = actorId ? game.actors?.get(actorId) : null;
  if (!actor) return null;
  if (ARMOR_AXES.has(axis) && !safeSetting(SETTINGS.heirloomArmor, false)) return null;
  const item = ARMOR_AXES.has(axis) ? signatureArmor(actor) : signatureWeapon(actor);
  return item ? { id: item.id, name: item.name } : null;
}
function safeSetting(key, fallback) {
  try { return game.settings.get("gluniverse-loot-gen", key); } catch { return fallback; }
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function round2(n) { return Math.round(n * 100) / 100; }
