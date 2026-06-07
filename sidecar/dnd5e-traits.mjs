/**
 * D&D 5e (2024) vocabulary blocks for the loot sidecar — the 5e counterpart of
 * pf2e-traits.mjs. These ground the LLM so it authors real, balance-sane 5e
 * items: the right item kinds, damage types, weapon/armor properties, conditions,
 * and rarity/attunement conventions, plus numeric guidance (5e items are NOT
 * priced by a tight gp table the way PF2e is, so pricing is given as rarity bands).
 *
 * Everything is fed to `claude` as DATA/context; nothing here is executed.
 */

/** Rarity → rough gp value band (5e market is loose; these are guidance bands). */
const RARITY_PRICE = {
  common: "50–100 gp",
  uncommon: "101–500 gp",
  rare: "501–5,000 gp",
  "very rare": "5,001–50,000 gp",
  legendary: "50,001+ gp",
  artifact: "priceless (not for sale)"
};

/** The 5e damage types. */
const DAMAGE_TYPES = [
  "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic",
  "piercing", "poison", "psychic", "radiant", "slashing", "thunder"
];

/** The 5e conditions (2024). */
const CONDITIONS = [
  "blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled",
  "incapacitated", "invisible", "paralyzed", "petrified", "poisoned", "prone",
  "restrained", "stunned", "unconscious"
];

/** Weapon properties (2024 PHB). */
const WEAPON_PROPERTIES = [
  "ammunition", "finesse", "heavy", "light", "loading", "range", "reach",
  "thrown", "two-handed", "versatile", "special",
  // 2024 mastery properties (informational):
  "cleave", "graze", "nick", "push", "sap", "slow", "topple", "vex"
];

/**
 * The glossary block injected into the 5e /workshop prompt. Tells the model
 * exactly which item kinds and keywords exist so it authors valid 5e data.
 */
export function dnd5eGlossaryBlock() {
  return [
    "D&D 5e (2024) ITEM DICTIONARY — author every item against this vocabulary:",
    "",
    "ITEM KINDS (set \"type\"):",
    '  "weapon"     — melee or ranged weapons. Also set "category" ("simple" or "martial") and, when ranged, say so; give "damageDie" (d4/d6/d8/d10/d12) and a "damageType" from the list below; set "baseItem" to the real base weapon it is built on (e.g. "longsword", "shortbow", "dagger", "greataxe") when it has one.',
    '  "armor"      — armor or shields. Set "category" ("light", "medium", "heavy", or "shield") and "baseItem" (e.g. "leather", "chain shirt", "breastplate", "plate", "shield"); give "ac" (base AC: light 11–12, medium 13–15, heavy 16–18, shield +2).',
    '  "consumable" — potions, scrolls, oils, ammunition, poisons, food.',
    '  "tool"       — tools, kits, instruments, gaming sets.',
    '  "treasure"   — gems, art objects, trade goods (pure value, no powers).',
    '  "equipment"  — the catch-all for wondrous items: rings, rods, wands, staves, cloaks, amulets, boots, worn/held wondrous gear.',
    "",
    `DAMAGE TYPES: ${DAMAGE_TYPES.join(", ")}.`,
    `WEAPON PROPERTIES (put real ones in "traits"): ${WEAPON_PROPERTIES.join(", ")}.`,
    `CONDITIONS (use real names): ${CONDITIONS.join(", ")}.`,
    "ARMOR: light (Dex to AC, no cap), medium (Dex to AC, max +2), heavy (no Dex, may need Str), shield (+2 AC).",
    "",
    "MAGIC & ATTUNEMENT:",
    '  - A magic item has a "rarity" of uncommon or higher (or a common magic item that says it is magical). Set "magical": true for any magic item.',
    '  - Set "attunement": true if the item requires attunement (each character can attune to at most 3 items). Powerful items almost always require attunement.',
    "  - Express bonuses the 5e way: \"+1/+2/+3\" weapons/armor, advantage/disadvantage, a flat AC/attack/save bonus, or a spell save DC. Do NOT invent PF2e-style runes or proficiency math.",
    "",
    "RARITIES (set \"rarity\"): common, uncommon, rare, very rare, legendary, artifact."
  ].join("\n");
}

/**
 * Numeric grounding for a target rarity/level. 5e doesn't price by a level table,
 * so we anchor on rarity bands and the 2024 magic-item tier guidance.
 */
export function dnd5eReferenceBlock(level, rarity) {
  const lines = [];
  lines.push("D&D 5e NUMERIC GROUNDING — keep every number 5e-legal:");
  if (rarity && RARITY_PRICE[rarity]) {
    lines.push(`  - Target rarity ${rarity}: price it around ${RARITY_PRICE[rarity]}. Consumables of a rarity sit at the low end of the band; permanent attunement items at the high end.`);
  } else {
    lines.push("  - Price by rarity band (gp): " + Object.entries(RARITY_PRICE).map(([r, p]) => `${r} ${p}`).join("; ") + ".");
  }
  if (level != null) {
    lines.push(`  - Around character level ${level}: tier 1 (lv 1–4) leans common/uncommon, tier 2 (5–10) uncommon/rare, tier 3 (11–16) rare/very rare, tier 4 (17–20) very rare/legendary. Match the rarity to the tier.`);
  }
  lines.push("  - Spell save DC for an item effect: about 13 (uncommon), 15 (rare), 17 (very rare), 19 (legendary). Attack-roll items use a flat +5 to +9 over the same bands.");
  lines.push("  - DAMAGE scales modestly in 5e: uncommon ~2d6–4d6, rare ~4d6–8d6, very rare ~8d6–10d6, legendary ~10d6+. Save-for-half for area effects. Healing scales similarly (e.g. potion of healing 2d4+2, superior 8d4+8).");
  lines.push("  - Bonuses are bounded: +1 (uncommon), +2 (rare/very rare), +3 (very rare/legendary). Never exceed +3 on weapons/armor. Tie any imposed condition to a saving throw vs. the item's save DC, usually ending on a later save.");
  lines.push("  - Charges: many wondrous items have N charges (e.g. 3–7) that regain 1d6+1 at dawn. Use this pattern instead of unlimited effects.");
  return lines.join("\n");
}
