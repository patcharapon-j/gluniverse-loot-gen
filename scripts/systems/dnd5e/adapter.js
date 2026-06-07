/**
 * D&D 5e (2024 / "5.5e") system adapter. Implements the SystemAdapter contract
 * (scripts/systems/registry.js) on top of the 5e modules in this folder:
 *   - tables.js          the 2024 DMG treasure economy + CR threat
 *   - actor-reader.js    5e sheet reading + the attunement/rarity audit
 *   - hoard.js           the DMG hoard generator (replaces the gp cascade)
 *   - plutonium.js       deep Plutonium content sourcing
 *
 * The index mapping and item-data shape (which used to be PF2e-only, inline in
 * the selector/materializer) are provided here for 5e's data model: rarity- and
 * attunement-aware records, npc-as-loot-chest actors, and 5e currency/coins.
 */

import { registerAdapter } from "../registry.js";
import { MODULE_ID, SEVERITY } from "../../const.js";
import { worstSeverity } from "../grade.js";
import {
  budgetForLevel, expectedWealthPerPC, expectedCurrencyForLevel, estimateThreat,
  magicPlan, RARITY_LEVEL, RARITY_GP, DND5E_MAX_LEVEL,
  ENCOUNTER_THREAT_SHARE, CACHE_TIER_SHARE, QUEST_REWARD_SHARE
} from "./tables.js";
import {
  resolveParty, actorLevel, actorLevelOf, actorTraits, netWorthGp,
  signatureWeapon, signatureArmor, progressionAudit, normRarity, itemPriceGp, PHYSICAL_TYPES
} from "./actor-reader.js";
import { proposeHoard } from "./hoard.js";
import { sourcePacks, sourceMode, plutoniumActive, sourceAllowed } from "./plutonium.js";
import { SOURCE_MODE } from "../../const.js";

/* ------------------------------ index mapping ------------------------------ */

/** Weapon/armor/property tags for soft theming (5e has no PF2e-style traits). */
function deriveTraits(e) {
  const out = [];
  const t = e.system?.type ?? {};
  if (t.value) out.push(String(t.value).toLowerCase());     // armor class / weapon category / tool kind
  if (t.baseItem) out.push(String(t.baseItem).toLowerCase());
  const props = e.system?.properties;
  if (props instanceof Set) out.push(...[...props].map(p => String(p).toLowerCase()));
  else if (Array.isArray(props)) out.push(...props.map(p => String(p).toLowerCase()));
  // Damage type, where the index exposes it.
  const dmg = e.system?.damage;
  if (dmg?.base?.types) out.push(...[...(dmg.base.types instanceof Set ? dmg.base.types : dmg.base.types)].map(String));
  if (Array.isArray(dmg?.parts)) for (const part of dmg.parts) if (Array.isArray(part) && part[1]) out.push(String(part[1]).toLowerCase());
  return [...new Set(out.filter(Boolean))];
}

function rawRarity(e) {
  return String(e.system?.rarity ?? "").trim().toLowerCase();
}
function hasMgc(e) {
  const props = e.system?.properties;
  if (props instanceof Set) return props.has("mgc");
  if (Array.isArray(props)) return props.includes("mgc");
  return false;
}
function attunementRequired(e) {
  const a = e.system?.attunement;
  return a === "required" || a === true || Number(a) === 1;
}

/**
 * The item's content source (book code or homebrew name), used by the per-source
 * allow-list. Reads the dnd5e system source field (object in v3+, string in older
 * builds) and falls back to Plutonium's own source flag.
 */
function entrySource(e) {
  const s = e.system?.source;
  let v = "";
  if (typeof s === "string") v = s;
  else if (s && typeof s === "object") v = s.book || s.custom || s.value || s.id || "";
  const flag = e.flags?.plutonium?.source ?? e.flags?.plutonium?.["homebrew"];
  return String(v || flag || "").trim();
}

/* ------------------------------ item shape ------------------------------ */

/** Add gp to a 5e actor's coin purse. */
async function addCoins(actor, gp) {
  const whole = Math.max(0, Math.round(gp));
  if (!whole) return;
  try {
    const cur = Number(actor.system?.currency?.gp) || 0;
    await actor.update({ "system.currency.gp": cur + whole });
  } catch (err) {
    console.warn(`${MODULE_ID} | addCoins failed, leaving coins note`, err);
    try { await actor.setFlag(MODULE_ID, "pendingCoinsGp", whole); } catch { /* ignore */ }
  }
}

/* ------------------------------ the adapter ------------------------------ */

export const dnd5eAdapter = {
  id: "dnd5e",
  label: "D&D 5e (2024)",
  maxLevel: DND5E_MAX_LEVEL,
  generation: "dmg-hoard",
  capabilities: { runes: false, heirloom: false, etch: false, attunement: true },
  sidecarSystem: "dnd5e",

  notReadyReason() {
    // The "always use Plutonium" trigger: if the GM pinned Plutonium-only sourcing
    // but Plutonium isn't active, say so plainly rather than generating empty loot.
    if (sourceMode() === SOURCE_MODE.PLUTONIUM && !plutoniumActive()) {
      return "GLLG.audit.plutoniumRequired";
    }
    return null;
  },

  /* --- actors --- */
  resolveParty,
  actorLevel,
  actorLevelOf,
  actorTraits,
  netWorthGp,
  signatureWeapon,
  signatureArmor,

  /* --- economy --- */
  budgetForLevel,
  expectedWealthPerPC,
  expectedCurrencyForLevel,
  estimateThreat,
  budgetShares: { encounter: ENCOUNTER_THREAT_SHARE, cache: CACHE_TIER_SHARE, quest: QUEST_REWARD_SHARE },
  magicPlan,

  /* --- progression audit (attunement + rarity by tier) --- */
  progressionAudit(actor, level) {
    const res = progressionAudit(actor, level);
    // worstSeverity already computed inside; recompute defensively for safety.
    return { ...res, worst: res.worst ?? worstSeverity(res.readouts.map(r => r.severity)) };
  },

  /* --- selection / index --- */
  indexFields() {
    return [
      "system.price.value", "system.price.denomination",
      "system.rarity", "system.properties", "system.attunement",
      "system.type.value", "system.type.baseItem",
      "system.damage", "system.quantity",
      "system.source", "system.source.book", "system.source.custom",
      "flags.plutonium.source", "flags.plutonium.homebrew"
    ];
  },
  selectPacks: sourcePacks,
  indexEntry(e, pack) {
    if (!PHYSICAL_TYPES.has(e.type)) return null;
    const source = entrySource(e);
    if (!sourceAllowed(source)) return null;     // per-source allow-list (homebrew control)
    const raw = rawRarity(e);
    const magic = (!!raw && raw !== "none" && raw !== "common-mundane") || hasMgc(e) || attunementRequired(e);
    const rarity = magic ? normRarity(raw || "common") : "common";

    let gp = itemPriceGp(e);
    if (!(gp > 0)) {
      if (magic) gp = RARITY_GP[rarity] ?? 0;     // magic items are often unpriced in 5e
      else return null;                            // skip free mundane junk
    }
    return {
      uuid: e.uuid ?? `Compendium.${pack.collection}.${e._id}`,
      name: e.name, img: e.img, type: e.type,
      level: magic ? (RARITY_LEVEL[rarity] ?? 1) : 0,
      gp, rarity, magic, attunement: attunementRequired(e),
      traits: deriveTraits(e),
      source,
      meta: null
    };
  },
  priceToGp: (price) => {
    if (price == null) return 0;
    if (typeof price === "number") return price;
    const COIN = { pp: 10, gp: 1, ep: 0.5, sp: 0.1, cp: 0.01 };
    return (Number(price.value) || 0) * (COIN[String(price.denomination ?? "gp")] ?? 1);
  },
  permanentTypes: new Set(["weapon", "equipment", "tool"]),
  consumableTypes: new Set(["consumable"]),
  physicalTypes: PHYSICAL_TYPES,

  /* --- generation --- */
  proposeHoard,

  /* --- materialize / item shape --- */
  applyEnrichment: () => { /* 5e has no runes to etch */ },
  descValuePath: () => "system.description.value",
  applyGmNote(data, html) {
    // 5e items have no GM-only note field; append to the description with a clear
    // marker (the prompt is an innocuous art hint, not a spoiler).
    const existing = foundry.utils.getProperty(data, "system.description.value") ?? "";
    foundry.utils.setProperty(data, "system.description.value", existing ? `${existing}${html}` : html);
  },
  lootActorType: "npc",                                  // 5e has no "loot" actor; an npc holds items + coin
  lootActorImg: "icons/containers/chest/chest-worn-oak-tan.webp",
  merchantActorData: () => ({
    type: "npc", img: "icons/svg/coins.svg",
    flags: { [MODULE_ID]: { vendor: true } }             // pair with Item Piles for buy/sell, if installed
  }),
  merchantDescPath: () => "system.details.biography.value",
  addCoins,

  /* --- sidecar vocabulary --- */
  traitVocab() {
    const cfg = globalThis.CONFIG?.DND5E ?? {};
    const keysOf = (o) => (o && typeof o === "object" ? Object.keys(o) : []);
    return {
      system: "dnd5e",
      dnd5e: {
        damageTypes: keysOf(cfg.damageTypes),
        rarities: keysOf(cfg.itemRarity).length ? keysOf(cfg.itemRarity) : ["common", "uncommon", "rare", "very rare", "legendary", "artifact"],
        weaponProperties: keysOf(cfg.weaponProperties ?? cfg.itemProperties)
      }
    };
  }
};

registerAdapter(dnd5eAdapter);
