/**
 * Reads live PF2e character sheets into the neutral shape the auditor needs.
 *
 * The PF2e system's rune data model has shifted across versions (object
 * `system.runes.{potency,striking,resilient}` in recent builds; discrete
 * `system.potencyRune.value` / `strikingRune.value` strings in older ones).
 * Every getter here is defensive so the auditor degrades gracefully rather
 * than throwing on an unexpected shape.
 */

import { MODULE_ID, SETTINGS } from "../const.js";

const STRIKING_TIER = { striking: 1, greaterStriking: 2, majorStriking: 3 };
const RESILIENT_TIER = { resilient: 1, greaterResilient: 2, majorResilient: 3 };

/** True when the PF2e system is the active game system. */
export function isPF2e() {
  return game.system?.id === "pf2e";
}

/**
 * Resolve the party of PCs to audit. Priority:
 *  1. an explicitly configured party actor (setting),
 *  2. the first PF2e "party" actor and its members,
 *  3. all player-assigned characters.
 */
export function resolveParty() {
  const configuredId = safeSetting(SETTINGS.partyActorId, "");
  let partyActor = configuredId ? game.actors?.get(configuredId) : null;
  if (!partyActor) partyActor = game.actors?.find(a => a.type === "party") ?? null;

  let members = [];
  if (partyActor) {
    const raw = partyActor.members ?? partyActor.system?.details?.members ?? [];
    members = raw.map(m => (m?.actor ?? m)).filter(a => a && a.type === "character");
  }
  if (!members.length) {
    // Fall back to characters owned by a player (the usual "the party" set).
    members = (game.actors?.filter(a => a.type === "character" && a.hasPlayerOwner)) ?? [];
  }
  return { partyActor, members };
}

/** Character level (1..20), clamped. */
export function actorLevel(actor) {
  const lv = Number(actor?.system?.details?.level?.value) || 1;
  return Math.max(1, Math.min(20, Math.trunc(lv)));
}

/** Total spendable + invested wealth in gp (coins + the gp value of carried items). */
export function netWorthGp(actor) {
  let gp = 0;
  try { gp += Number(actor?.inventory?.coins?.goldValue) || 0; } catch { /* ignore */ }
  try {
    const items = actor?.inventory ?? actor?.items?.filter(i => i.isOfType?.("physical")) ?? [];
    for (const it of items) {
      const each = itemGoldValue(it);
      const qty = Number(it?.system?.quantity) || 1;
      gp += each * qty;
    }
  } catch { /* ignore */ }
  return Math.round(gp);
}

function itemGoldValue(item) {
  // Prefer the system's computed asset value; fall back to the listed price.
  const fromAsset = Number(item?.assetValue?.goldValue);
  if (Number.isFinite(fromAsset)) return fromAsset;
  const price = item?.system?.price?.value;
  const fromPrice = Number(price?.goldValue);
  if (Number.isFinite(fromPrice)) return fromPrice;
  // Last resort: assemble from coin denominations.
  if (price && typeof price === "object") {
    return (Number(price.pp) || 0) * 10 + (Number(price.gp) || 0)
      + (Number(price.sp) || 0) / 10 + (Number(price.cp) || 0) / 100;
  }
  return 0;
}

/* ------------------------------ rune reading ------------------------------ */

function weaponPotency(item) {
  const r = item?.system?.runes;
  if (r && typeof r === "object" && r.potency != null) return Number(r.potency) || 0;
  return Number(item?.system?.potencyRune?.value) || 0;
}
function weaponStriking(item) {
  const r = item?.system?.runes;
  if (r && typeof r === "object" && r.striking != null) return Number(r.striking) || 0;
  const legacy = item?.system?.strikingRune?.value;
  return STRIKING_TIER[legacy] ?? 0;
}
function armorPotency(item) {
  const r = item?.system?.runes;
  if (r && typeof r === "object" && r.potency != null) return Number(r.potency) || 0;
  return Number(item?.system?.potencyRune?.value) || 0;
}
function armorResilient(item) {
  const r = item?.system?.runes;
  if (r && typeof r === "object" && r.resilient != null) return Number(r.resilient) || 0;
  const legacy = item?.system?.resiliencyRune?.value ?? item?.system?.resilienceRune?.value;
  return RESILIENT_TIER[legacy] ?? 0;
}

function isHeld(item) {
  return item?.system?.equipped?.carryType === "held";
}
function isWornArmor(item) {
  return item?.type === "armor" && (item?.system?.equipped?.inSlot === true
    || item?.system?.equipped?.carryType === "worn");
}

/**
 * The PC's "signature" weapon to awaken weapon runes within (heirloom mode,
 * DESIGN §9): the held weapon if any, else the first weapon. null if unarmed.
 */
export function signatureWeapon(actor) {
  const weapons = (actor?.items ?? []).filter(i => i.type === "weapon");
  if (!weapons.length) return null;
  return weapons.find(isHeld) ?? weapons[0];
}

/** The PC's signature armor (worn if any, else the first armor). null if none. */
export function signatureArmor(actor) {
  const armors = (actor?.items ?? []).filter(i => i.type === "armor");
  if (!armors.length) return null;
  return armors.find(isWornArmor) ?? armors[0];
}

/* ------------------------------ skill / perception / apex ------------------------------ */

/** Scan an item's rules for item-type bonuses to perception or skills. */
function scanItemBonuses(item, out) {
  const rules = item?.system?.rules;
  if (!Array.isArray(rules)) return;
  for (const rule of rules) {
    if (rule?.key !== "FlatModifier") continue;
    if (rule?.type && rule.type !== "item") continue;
    const sel = Array.isArray(rule.selector) ? rule.selector : [rule.selector];
    for (const s of sel) {
      if (s === "perception") out.perception = true;
      else if (typeof s === "string" && SKILL_SLUGS.has(s)) out.skills.add(s);
    }
  }
}

const SKILL_SLUGS = new Set([
  "acrobatics", "arcana", "athletics", "crafting", "deception", "diplomacy",
  "intimidation", "medicine", "nature", "occultism", "performance", "religion",
  "society", "stealth", "survival", "thievery"
]);

/** Is the item currently contributing (invested if it needs investing, else worn/held)? */
function isActive(item) {
  const eq = item?.system?.equipped;
  if (!eq) return false;
  const needsInvest = item?.system?.traits?.value?.includes?.("invested");
  if (needsInvest && eq.invested === false) return false;
  return eq.carryType === "held" || eq.carryType === "worn" || eq.inSlot === true || eq.invested === true;
}

/**
 * Read a character's actual fundamental loadout into tiers comparable with
 * expectedFundamentals(). Tiers: attack/defense 0..3, striking/resilient 0..3,
 * perception 0..3, skills = count of skills with an item bonus, apex 0/1.
 */
export function readFundamentals(actor) {
  const items = actor?.items ?? [];
  const weapons = items.filter(i => i.type === "weapon");
  const heldWeapons = weapons.filter(isHeld);
  const wForRunes = heldWeapons.length ? heldWeapons : weapons;

  let attack = 0, striking = 0;
  for (const w of wForRunes) {
    attack = Math.max(attack, weaponPotency(w));
    striking = Math.max(striking, weaponStriking(w));
  }

  const armors = items.filter(i => i.type === "armor");
  const worn = armors.filter(isWornArmor);
  const aForRunes = worn.length ? worn : armors;
  let defense = 0, resilient = 0;
  for (const a of aForRunes) {
    defense = Math.max(defense, armorPotency(a));
    resilient = Math.max(resilient, armorResilient(a));
  }

  const bonuses = { perception: false, skills: new Set() };
  let apex = 0;
  for (const it of items) {
    if (!it?.system?.equipped) continue;          // only physical, equippable items have this
    if (!isActive(it)) continue;
    scanItemBonuses(it, bonuses);
    if (it?.system?.traits?.value?.includes?.("apex")) apex = 1;
  }

  return {
    attack,
    striking,
    defense,
    resilient,
    perception: bonuses.perception ? 1 : 0,   // perception tier detection is coarse (presence only)
    skills: bonuses.skills.size,
    apex,
    hasWeapon: weapons.length > 0,
    hasArmor: armors.length > 0
  };
}

function safeSetting(key, fallback) {
  try { return game.settings.get(MODULE_ID, key); } catch { return fallback; }
}
