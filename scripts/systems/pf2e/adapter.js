/**
 * Pathfinder 2e system adapter. Packages the original PF2e behaviour behind the
 * SystemAdapter contract (scripts/systems/registry.js). It is a thin façade over
 * the existing scripts/pf2e/* modules plus the PF2e index-mapping and item-shape
 * logic that used to live inline in the selector/materializer — so the PF2e path
 * is functionally unchanged; only its call sites now go through the adapter.
 */

import { registerAdapter } from "../registry.js";
import { MODULE_ID } from "../../const.js";
import { buildReadout, worstSeverity } from "../grade.js";
import { SEVERITY } from "../../const.js";
import {
  resolveParty, actorLevel, netWorthGp, signatureWeapon, signatureArmor, readFundamentals
} from "../../pf2e/actor-reader.js";
import {
  budgetForLevel, expectedWealthPerPC, expectedCurrencyForLevel, estimateThreat,
  expectedFundamentals, TIER_LABELS,
  ENCOUNTER_THREAT_SHARE, CACHE_TIER_SHARE, QUEST_REWARD_SHARE
} from "../../pf2e/tables.js";

/* ------------------------------ index mapping ------------------------------ */

const PHYSICAL_TYPES = new Set([
  "weapon", "armor", "shield", "equipment", "consumable", "treasure", "backpack"
]);
const METAL_ARMOR_GROUPS = new Set(["plate", "chain", "composite"]);
const METAL_MATERIALS = new Set([
  "steel", "iron", "cold-iron", "adamantine", "silver", "mithral", "orichalcum",
  "djezet", "inubrix", "noqual", "siccatite", "abysium", "dawnsilver", "duskwood-no"
]);
const VERSATILE_DAMAGE = { b: "bludgeoning", p: "piercing", s: "slashing" };

/** Convert a PF2e price coin object (or number) to a gp float. */
function priceToGp(price) {
  const v = price?.value ?? price;
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const per = Number(v.per) || 1;
  const gp = (Number(v.pp) || 0) * 10 + (Number(v.gp) || 0)
    + (Number(v.sp) || 0) / 10 + (Number(v.cp) || 0) / 100;
  return per > 1 ? gp / per : gp;
}

function armorMaterial(e) {
  const type = e.system?.material?.type ?? e.system?.material?.precious ?? null;
  if (type && METAL_MATERIALS.has(String(type))) return "metal";
  if (METAL_ARMOR_GROUPS.has(String(e.system?.group ?? ""))) return "metal";
  return null;
}

/** Weapon/armor facts the rune-eligibility check needs (else null). */
function runeMeta(e, traits) {
  const runes = e.system?.runes;
  const hasRunes = !!runes && (
    (Number(runes.potency) || 0) > 0 ||
    (Number(runes.striking) || 0) > 0 ||
    (Number(runes.resilient) || 0) > 0 ||
    (Array.isArray(runes.property) && runes.property.length > 0)
  );

  if (e.type === "weapon") {
    const versatile = traits
      .filter(t => t.startsWith("versatile-"))
      .map(t => VERSATILE_DAMAGE[t.split("-")[1]])
      .filter(Boolean);
    const dmg = [e.system?.damage?.damageType, ...versatile].filter(Boolean);
    const ranged = e.system?.range != null || traits.includes("ranged");
    return {
      kind: "weapon", damage: dmg, melee: !ranged,
      thrown: traits.some(t => t === "thrown" || t.startsWith("thrown-")),
      category: e.system?.category ?? null, group: e.system?.group ?? null,
      baseItem: e.system?.baseItem ?? null, traits, hasRunes
    };
  }
  if (e.type === "armor") {
    return {
      kind: "armor", category: e.system?.category ?? null, group: e.system?.group ?? null,
      material: armorMaterial(e), traits, hasRunes
    };
  }
  return null;
}

/* ------------------------------ progression audit ------------------------------ */

const CORE_AXES = [
  { key: "attack", label: "GLLG.axis.attack", soft: false },
  { key: "striking", label: "GLLG.axis.striking", soft: false },
  { key: "defense", label: "GLLG.axis.defense", soft: false },
  { key: "resilient", label: "GLLG.axis.resilient", soft: false }
];
const SOFT_AXES = [
  { key: "perception", label: "GLLG.axis.perception", soft: true },
  { key: "skills", label: "GLLG.axis.skills", soft: true }
];

/* ------------------------------ item shape ------------------------------ */

const STRIKING_LEGACY = { 1: "striking", 2: "greaterStriking", 3: "majorStriking" };
const RESILIENT_LEGACY = { 1: "resilient", 2: "greaterResilient", 3: "majorResilient" };

/** Etch a cascade-built rune set (pick.runes) onto a hydrated base weapon/armor. */
function applyRunes(data, pick) {
  const r = pick?.runes;
  if (!r || (data.type !== "weapon" && data.type !== "armor")) return;
  const isArmor = data.type === "armor";
  const property = (Array.isArray(r.property) ? r.property : []).filter(Boolean).slice(0, 4);
  const modern = data.system?.runes && typeof data.system.runes === "object";

  if (modern) {
    const runes = { ...data.system.runes };
    runes.potency = Math.max(Number(runes.potency) || 0, Number(r.potency) || 0);
    if (isArmor) runes.resilient = Math.max(Number(runes.resilient) || 0, Number(r.resilient) || 0);
    else runes.striking = Math.max(Number(runes.striking) || 0, Number(r.striking) || 0);
    runes.property = property;
    foundry.utils.setProperty(data, "system.runes", runes);
  } else {
    foundry.utils.setProperty(data, "system.potencyRune.value", Number(r.potency) || 0);
    if (isArmor) foundry.utils.setProperty(data, "system.resiliencyRune.value", RESILIENT_LEGACY[r.resilient] ?? null);
    else foundry.utils.setProperty(data, "system.strikingRune.value", STRIKING_LEGACY[r.striking] ?? null);
    property.forEach((slug, i) => foundry.utils.setProperty(data, `system.propertyRune${i + 1}.value`, slug));
  }
}

/** Add gp to a PF2e actor, tolerating API differences across versions. */
async function addCoins(actor, gp) {
  const whole = Math.max(0, Math.round(gp));
  if (!whole) return;
  try {
    if (typeof actor.inventory?.addCoins === "function") {
      await actor.inventory.addCoins({ gp: whole });
      return;
    }
  } catch (err) { console.warn(`${MODULE_ID} | addCoins failed, leaving coins note`, err); }
  try { await actor.setFlag(MODULE_ID, "pendingCoinsGp", whole); } catch { /* ignore */ }
}

/* ------------------------------ the adapter ------------------------------ */

export const pf2eAdapter = {
  id: "pf2e",
  label: "Pathfinder 2e",
  maxLevel: 20,
  generation: "pf2e-cascade",
  capabilities: { runes: true, heirloom: true, etch: true, attunement: false },
  sidecarSystem: "pf2e",

  notReadyReason() { return null; },   // the registry already gated on system id

  /* --- actors --- */
  resolveParty,
  actorLevel,
  netWorthGp,
  signatureWeapon,
  signatureArmor,
  actorLevelOf: (actor) => Number(actor?.system?.details?.level?.value) || 0,
  actorTraits: (actor) => {
    const tv = actor?.system?.traits?.value ?? actor?.system?.traits ?? [];
    return Array.isArray(tv) ? tv : [];
  },

  /* --- economy --- */
  budgetForLevel,
  expectedWealthPerPC,
  expectedCurrencyForLevel,
  estimateThreat,
  budgetShares: { encounter: ENCOUNTER_THREAT_SHARE, cache: CACHE_TIER_SHARE, quest: QUEST_REWARD_SHARE },
  magicPlan: null,                     // PF2e is gp-budget driven, not item-count driven

  /* --- progression audit (the ABP yardstick) --- */
  progressionAudit(actor, level) {
    const expected = expectedFundamentals(level);
    const actual = readFundamentals(actor);
    const readouts = [...CORE_AXES, ...SOFT_AXES].map(axis =>
      buildReadout(axis, expected[axis.key] ?? 0, actual[axis.key] ?? 0, TIER_LABELS));
    const worst = worstSeverity(readouts.map(r => r.severity));
    const missing = readouts
      .filter(r => r.severity === SEVERITY.CRITICAL || r.severity === SEVERITY.BEHIND)
      .map(r => r.summary);
    return { readouts, worst, missing };
  },

  /* --- selection / index --- */
  indexFields() {
    return [
      "system.level.value", "system.price.value",
      "system.traits.value", "system.traits.rarity",
      "system.category", "system.group", "system.baseItem",
      "system.damage.damageType", "system.range", "system.material", "system.runes"
    ];
  },
  selectPacks() {
    const all = [...(game.packs ?? [])].filter(p => p.metadata?.type === "Item" || p.documentName === "Item");
    const equip = all.filter(p =>
      /equipment|treasure|loot|gear|item/i.test(`${p.collection} ${p.metadata?.label ?? ""}`));
    return equip.length ? equip : all;
  },
  indexEntry(e, pack) {
    if (!PHYSICAL_TYPES.has(e.type)) return null;
    const gp = priceToGp(e.system?.price?.value);
    if (!(gp > 0)) return null;
    const traits = Array.isArray(e.system?.traits?.value) ? e.system.traits.value : [];
    return {
      uuid: e.uuid ?? `Compendium.${pack.collection}.${e._id}`,
      name: e.name, img: e.img, type: e.type,
      level: Number(e.system?.level?.value) || 0, gp, traits,
      rarity: e.system?.traits?.rarity ?? "common",
      meta: runeMeta(e, traits)
    };
  },
  priceToGp,
  permanentTypes: new Set(["weapon", "armor", "shield", "equipment"]),
  consumableTypes: new Set(["consumable"]),
  physicalTypes: PHYSICAL_TYPES,

  /* --- generation --- */
  proposeHoard: null,                  // PF2e uses the in-engine priority cascade

  /* --- materialize / item shape --- */
  applyEnrichment: applyRunes,
  descValuePath: () => "system.description.value",
  applyGmNote(data, html) {
    const existing = foundry.utils.getProperty(data, "system.description.gm") ?? "";
    foundry.utils.setProperty(data, "system.description.gm", existing ? `${existing}${html}` : html);
  },
  lootActorType: "loot",
  lootActorImg: "icons/containers/chest/chest-worn-oak-tan.webp",
  merchantActorData: () => ({ type: "loot", img: "icons/svg/coins.svg", system: { lootSheetType: "Merchant" } }),
  merchantDescPath(actor) {
    const cur = actor?.system?.details?.description;
    return (cur && typeof cur === "object") ? "system.details.description.value" : "system.details.description";
  },
  addCoins,

  /* --- sidecar vocabulary --- */
  traitVocab() {
    const cfg = globalThis.CONFIG?.PF2E ?? {};
    const keysOf = (o) => (o && typeof o === "object" ? Object.keys(o) : []);
    return {
      system: "pf2e",
      pf2e: {
        damageTypes: keysOf(cfg.damageTypes),
        usages: keysOf(cfg.usages),
        rarities: keysOf(cfg.rarityTraits).length ? keysOf(cfg.rarityTraits) : ["common", "uncommon", "rare", "unique"]
      }
    };
  }
};

registerAdapter(pf2eAdapter);
