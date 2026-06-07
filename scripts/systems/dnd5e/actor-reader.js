/**
 * Reads live D&D 5e (2024) character sheets into the neutral shapes the engine
 * needs — the 5e analogue of scripts/pf2e/actor-reader.js. 5e has no runes and no
 * mandatory "fundamentals" (bounded accuracy), so the progression audit tracks
 * what actually matters in 5e: attunement usage (cap 3), magic-item count, and
 * the highest rarity a PC carries, each measured against a per-tier expectation.
 *
 * Every getter is defensive: the dnd5e data model has shifted across major
 * versions (price denominations, attunement booleans, the group actor type), so
 * the reader degrades gracefully rather than throwing on an unexpected shape.
 */

import { MODULE_ID, SETTINGS, SEVERITY } from "../../const.js";
import { buildReadout, worstSeverity } from "../grade.js";
import { expectedMagic, RARITY_ORDER, DND5E_MAX_LEVEL } from "./tables.js";

/** dnd5e physical (ownable, priceable) item types. */
const PHYSICAL_TYPES = new Set([
  "weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"
]);

/** Coin denomination → gp multiplier (5e currency). */
const COIN_TO_GP = { pp: 10, gp: 1, ep: 0.5, sp: 0.1, cp: 0.01 };

/** Normalize a 5e rarity slug to the engine's canonical lowercase-space form. */
export function normRarity(r) {
  const s = String(r ?? "").trim().toLowerCase();
  if (!s) return "common";
  if (s === "veryrare" || s === "very-rare" || s === "very rare") return "very rare";
  if (["common", "uncommon", "rare", "legendary", "artifact"].includes(s)) return s;
  return "common";
}

/* ------------------------------ party / level ------------------------------ */

/**
 * Resolve the party of PCs to audit. Priority:
 *  1. an explicitly configured party/group actor (setting),
 *  2. the first dnd5e "group" actor and its members,
 *  3. all player-assigned characters.
 */
export function resolveParty() {
  const configuredId = safeSetting(SETTINGS.partyActorId, "");
  let partyActor = configuredId ? game.actors?.get(configuredId) : null;
  if (!partyActor) partyActor = game.actors?.find(a => a.type === "group") ?? null;

  let members = [];
  if (partyActor) {
    const raw = partyActor.system?.members ?? partyActor.members ?? [];
    const arr = raw instanceof Map ? [...raw.values()] : Array.isArray(raw) ? raw : [...(raw ?? [])];
    members = arr
      .map(m => m?.actor ?? (m?.uuid ? fromUuidSync(m.uuid) : null) ?? (typeof m === "string" ? game.actors?.get(m) : m))
      .filter(a => a && a.type === "character");
  }
  if (!members.length) {
    members = (game.actors?.filter(a => a.type === "character" && a.hasPlayerOwner)) ?? [];
  }
  return { partyActor, members };
}

/** Character level (1..20), clamped. Sums class levels when no total is exposed. */
export function actorLevel(actor) {
  let lv = Number(actor?.system?.details?.level);
  if (!Number.isFinite(lv) || lv <= 0) {
    // Sum embedded class items' levels (dnd5e characters carry one item per class).
    let sum = 0;
    for (const it of actor?.items ?? []) {
      if (it.type === "class") sum += Number(it.system?.levels) || 0;
    }
    lv = sum;
  }
  if (!Number.isFinite(lv) || lv <= 0) lv = 1;
  return Math.max(1, Math.min(DND5E_MAX_LEVEL, Math.trunc(lv)));
}

/** Raw level read for theming (characters → level; NPCs → CR). May be 0. */
export function actorLevelOf(actor) {
  if (actor?.type === "npc") {
    const cr = actor?.system?.details?.cr;
    return Number(cr) || 0;
  }
  return actorLevel(actor);
}

/** Creature type / subtype / tags for theming. */
export function actorTraits(actor) {
  const out = [];
  const t = actor?.system?.details?.type;
  if (t) {
    if (typeof t === "string") out.push(t.toLowerCase());
    else {
      if (t.value) out.push(String(t.value).toLowerCase());
      if (t.subtype) out.push(String(t.subtype).toLowerCase());
      if (Array.isArray(t.subtypes)) out.push(...t.subtypes.map(s => String(s).toLowerCase()));
      if (t.custom) out.push(...String(t.custom).split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean));
    }
  }
  const align = actor?.system?.details?.alignment;
  if (align) out.push(...String(align).split(/\s+/).map(s => s.toLowerCase()).filter(Boolean));
  return [...new Set(out.filter(Boolean))];
}

/* ------------------------------ wealth ------------------------------ */

/** Convert a 5e item price ({ value, denomination }) to gp. */
export function itemPriceGp(item) {
  const p = item?.system?.price;
  if (p == null) return 0;
  if (typeof p === "number") return p;
  const value = Number(p.value) || 0;
  const mult = COIN_TO_GP[String(p.denomination ?? "gp")] ?? 1;
  return value * mult;
}

/** Total spendable + carried wealth in gp (coins + the gp value of items). */
export function netWorthGp(actor) {
  let gp = 0;
  const cur = actor?.system?.currency ?? {};
  for (const [coin, mult] of Object.entries(COIN_TO_GP)) gp += (Number(cur[coin]) || 0) * mult;
  for (const it of actor?.items ?? []) {
    if (!PHYSICAL_TYPES.has(it.type)) continue;
    const qty = Number(it.system?.quantity) || 1;
    gp += itemPriceGp(it) * qty;
  }
  return Math.round(gp);
}

/* ------------------------------ magic / attunement ------------------------------ */

/** Is this item magical (carries a rarity or the "magical" property)? */
export function isMagic(item) {
  const rarity = String(item?.system?.rarity ?? "").trim().toLowerCase();
  if (rarity && rarity !== "common" && rarity !== "none") return true;
  const props = item?.system?.properties;
  if (props instanceof Set) return props.has("mgc");
  if (Array.isArray(props)) return props.includes("mgc");
  return false;
}

/** Is this item currently attuned by its owner? */
function isAttuned(item) {
  if (item?.system?.attuned === true) return true;
  // Legacy numeric/enum attunement (2 = attuned) on very old dnd5e builds.
  return Number(item?.system?.attunement) === 2;
}

/** The PC's signature (equipped) weapon, for any future heirloom analogue. */
export function signatureWeapon(actor) {
  const weapons = (actor?.items ?? []).filter(i => i.type === "weapon");
  if (!weapons.length) return null;
  return weapons.find(w => w.system?.equipped) ?? weapons[0];
}

/** The PC's signature (equipped) armor. */
export function signatureArmor(actor) {
  const armors = (actor?.items ?? []).filter(i =>
    i.type === "equipment" && ["light", "medium", "heavy"].includes(i.system?.type?.value));
  if (!armors.length) return null;
  return armors.find(a => a.system?.equipped) ?? armors[0];
}

/* ------------------------------ progression audit ------------------------------ */

const AXES = [
  { key: "attunement", label: "GLLG.axis.attunement", soft: true },
  { key: "magicItems", label: "GLLG.axis.magicItems", soft: true },
  { key: "rarity", label: "GLLG.axis.rarity", soft: true }
];
const ATTUNE_LABELS = ["0/3", "1/3", "2/3", "3/3"];
const RARITY_LABELS = ["—", "common", "uncommon", "rare", "very rare", "legendary", "artifact"];
const LABELS = { attunement: ATTUNE_LABELS, rarity: RARITY_LABELS };

/**
 * Audit a 5e PC's magic loadout against the tier expectation (DESIGN §19):
 * attunement slots used, magic-item count, and highest rarity carried. Nothing
 * here is math-critical — every axis is soft — so the dashboard never shows a
 * 5e PC as "CRITICAL"; it just flags who is light or heavy on magic.
 */
export function progressionAudit(actor, level) {
  const expected = expectedMagic(level);
  let attuned = 0, magicCount = 0, topRarity = 0;
  for (const it of actor?.items ?? []) {
    if (!PHYSICAL_TYPES.has(it.type)) continue;
    if (isAttuned(it)) attuned++;
    if (isMagic(it)) {
      magicCount++;
      const ord = RARITY_ORDER[normRarity(it.system?.rarity)] ?? 0;
      if (ord > topRarity) topRarity = ord;
    }
  }

  const actuals = {
    attunement: Math.min(3, attuned),
    magicItems: magicCount,
    rarity: topRarity
  };
  const expects = {
    attunement: Math.min(3, expected.attune),
    magicItems: expected.items,
    rarity: expected.topRarityOrder
  };

  const readouts = AXES.map(axis => buildReadout(axis, expects[axis.key], actuals[axis.key], LABELS));
  const worst = worstSeverity(readouts.map(r => r.severity));
  const missing = readouts
    .filter(r => r.severity === SEVERITY.BEHIND)
    .map(r => r.summary);
  return { readouts, worst, missing };
}

/* ------------------------------ utils ------------------------------ */

export { PHYSICAL_TYPES };

function safeSetting(key, fallback) {
  try { return game.settings.get(MODULE_ID, key); } catch { return fallback; }
}
function fromUuidSync(uuid) {
  try { return globalThis.fromUuidSync?.(uuid) ?? null; } catch { return null; }
}
