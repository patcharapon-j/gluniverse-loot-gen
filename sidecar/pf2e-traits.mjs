/**
 * PF2e trait glossary — fed to the workshop LLM as context so it tags authored
 * items with the RIGHT traits and knows what each one means (instead of guessing
 * or returning only generic "magical"/energy traits).
 *
 * Categories and the complete trait roster mirror the Archives of Nethys Traits
 * index (Player Core / GM Core, remaster). AoN blocks automated fetching, so the
 * roster was reconciled by hand against that index; meanings are kept terse to
 * bound the prompt. Parameterized traits show the slug FORMAT the model must
 * emit (e.g. "thrown-20", "versatile-s", "deadly-d8", "two-hand-d10").
 *
 * Remaster-current: the eight spell-school traits were removed and are listed
 * only as legacy. Energy is acid/cold/electricity/fire/force/sonic/vitality/void;
 * alignment uses holy/unholy (+ spirit damage).
 */

// --- Weapon traits (combat / function). Ancestry-flavor weapon traits are kept
//     as a names-only group at the end of the block to save tokens.
export const WEAPON_TRAITS = [
  ["agile", "multiple-attack penalty is -4/-8 instead of -5/-10"],
  ["finesse", "may use Dexterity instead of Strength on melee attack rolls (damage still Strength)"],
  ["reach", "extends your reach by 5 feet with this weapon"],
  ["thrown-{ft}", "can be thrown the listed feet (thrown-10, thrown-20, thrown-30); uses Strength on damage"],
  ["versatile-{B|P|S}", "can instead deal the listed damage type, chosen per attack (versatile-s, versatile-p, versatile-b)"],
  ["deadly-d{die}", "on a critical hit add one extra weapon die of this size (deadly-d8, deadly-d10, deadly-d12)"],
  ["fatal-d{die}", "on a crit the damage die becomes this size and you add one extra die of it (fatal-d10, fatal-d12)"],
  ["two-hand-d{die}", "wielded in two hands its damage die becomes this size (two-hand-d10, two-hand-d12)"],
  ["sweep", "+1 circ to attack vs a target if you already attacked a different target this turn with it"],
  ["forceful", "your 2nd attack each turn deals +1 die bonus damage, 3rd and later +2 dice"],
  ["backswing", "+1 circ to your next attack with it after a miss this turn"],
  ["shove", "can use it to Shove"],
  ["trip", "can use it to Trip"],
  ["disarm", "can use it to Disarm"],
  ["grapple", "can use it to Grapple"],
  ["ranged-trip", "a thrown weapon that can Trip at range without being dropped"],
  ["parry", "spend an action to gain +1 circ AC until your next turn"],
  ["propulsive", "add half your Strength mod to ranged damage (full if Strength is negative)"],
  ["brutal", "a thrown/ranged weapon that uses Strength instead of Dexterity on attack rolls"],
  ["volley-{ft}", "-2 to attacks against targets within the listed range (volley-30, volley-50)"],
  ["range-{ft}", "a ranged weapon with the listed range increment (range-60, range-100)"],
  ["reload-{n}", "actions needed to reload between shots (reload-1, reload-2; 0 = none)"],
  ["repeating", "feeds from a magazine — reload the magazine rather than each shot"],
  ["capacity-{n}", "holds the listed number of shots; Interact to rotate (capacity-5)"],
  ["double-barrel", "fire one barrel, or both at once for extra damage"],
  ["kickback", "firearm: -2 to attacks unless braced/strong enough; +1 damage die"],
  ["scatter-{ft}", "also deals splash damage in the listed radius around the target (scatter-5)"],
  ["fatal-aim-d{die}", "has fatal of this die size while wielded in two hands (firearm)"],
  ["critical-fusion", "a combination firearm's special melee/ranged critical options"],
  ["nonlethal", "deals nonlethal damage (knock out rather than kill)"],
  ["free-hand", "strapped to the hand so it doesn't occupy it for wielding; the hand stays free for other actions but can't hold anything else"],
  ["modular-{B/P/S}", "Interact to switch which listed damage type it deals"],
  ["concussive", "for resistance/immunity, use the weaker of the target's piercing or bludgeoning"],
  ["razing", "especially good at damaging objects, structures, and vehicles"],
  ["tearing", "on a hit, deals +1 persistent bleed (+2 with a greater striking rune)"],
  ["hampering", "after a hit, Interact to give the target a -10-foot penalty to Speeds until it takes a move action"],
  ["brace", "deal damage to a creature that moves into your reach (set against a charge)"],
  ["jousting-d{die}", "while mounted, +1 to attack and its damage die becomes this size"],
  ["twin", "if you already attacked with another weapon of the same type this turn, add bonus damage equal to its number of damage dice"],
  ["combination", "one weapon combining a melee and a ranged (firearm) form"],
  ["critical-fusion", "a combination weapon's extra critical-specialization options when its ranged side is loaded"],
  ["monk", "favored by monks; works with monk feats and stances"],
  ["unarmed", "counts as an unarmed attack (works with unarmed-attack feats/effects)"],
  ["attached", "must be combined with the listed item (e.g. attached-shield) and you must wield/wear that item to attack"],
  ["backstabber", "deals +1 precision damage to off-guard targets (+2 if it's a +3 weapon)"],
  ["concealable", "+2 circumstance bonus to Stealth checks and DCs to hide or conceal it"],
  ["injection", "can be loaded with a liquid (usually injury poison); Interact after a hit to inject it"],
  ["venomous", "on a hit, deals +1 persistent poison (+2 with a greater striking rune)"],
  ["climbing", "the hand wielding this weapon is freely available to Climb"],
  ["tethered", "bound by a cord; recall it to hand with an Interact"],
  ["recovery", "a thrown weapon that flies back to your hand after a missed thrown Strike"],
  ["training", "striking a creature marks it so your animal companion gets +1 to its next attack against it"],
  ["cobbled", "a firearm prone to misfire — on a failed attack roll, roll a DC 5 flat check or it misfires"],
  ["mounted", "a mounted siege weapon used in large-scale warfare"],
  ["portable", "a siege weapon light enough to be carried/relocated"],
  ["vehicular", "attached to a vehicle or mount; wielded only by its driver/rider"],
  ["resonant", "can channel energy damage; grants the Conduct Energy free action while wielded"]
];

// Ancestry-flavor weapon traits (slugs only — they only gate ancestry/feat use).
export const ANCESTRY_WEAPON_TRAITS = [
  "dwarf", "elf", "gnome", "goblin", "halfling", "orc", "catfolk", "tengu",
  "kobold", "grippli", "vanara", "vishkanya", "azarketi", "conrasu", "ghoran",
  "geniekin", "clockwork", "alchemical"
];

export const ARMOR_TRAITS = [
  ["bulwark", "+3 to Reflex saves vs damaging areas, and you don't add Dexterity to those saves"],
  ["comfort", "you can rest and sleep in it normally, without penalty"],
  ["flexible", "the armor's check penalty doesn't apply to Acrobatics or Athletics"],
  ["noisy", "the armor's check penalty applies to Stealth even when it normally wouldn't"],
  ["ponderous", "-1 penalty to initiative; this worsens to the armor's check penalty if you don't meet its required Strength"],
  ["hindering", "-5 penalty to all your Speeds, separate from and on top of the armor's Speed penalty, even if you'd ignore that penalty"],
  ["aquadynamic", "streamlined for water — its check penalty doesn't apply to Acrobatics or Athletics made in water"],
  ["laminar", "layered sections soften a break: broken-AC status penalty is only -1 medium / -2 heavy / none for light"],
  ["inscribed", "can hold one scroll inscribed onto it, Activated without needing to draw it (a free hand still required)"],
  ["adjusted", "a specially modified version of a base armor"]
];

export const SHIELD_TRAITS = [
  ["harnessed", "has a brace that locks a jousting weapon in place, letting you wield the shield and that weapon two-handed at once"],
  ["deflecting", "increases the shield's Hardness by 2 against the listed type of attack"],
  ["foldaway", "collapses into a small gauntlet-mounted form; Interact to deploy or stow it"],
  ["integrated", "has a built-in weapon (like an attached weapon, but not removable); the weapon's damage is listed in the trait"],
  ["launching", "a built-in mechanism that shoots projectiles, functioning as a ranged weapon"],
  ["shield-throw-{ft}", "can be thrown as a ranged weapon the listed distance"],
  ["hefty-{n}", "so heavy that Raising it is a 2-action activity unless your Strength modifier is at least the listed number"]
];

// General item / magic / consumable traits (apply across types).
export const ITEM_TRAITS = [
  ["magical", "created or sustained by magic (most magic items need this)"],
  ["invested", "must be Invested (worn) to work; you can invest at most 10 items per day — use for worn magic gear"],
  ["cursed", "bears a curse that resists removal"],
  ["alchemical", "made by alchemy and is NOT magical — do not also tag 'magical'"],
  ["consumable", "used up when activated (pair with the specific kind below)"],
  ["bomb", "a thrown alchemical splash weapon"],
  ["potion", "consumable: a magical liquid, drunk to gain its effect"],
  ["elixir", "consumable: an alchemical liquid, drunk to gain its effect"],
  ["oil", "consumable: applied to a creature or object"],
  ["mutagen", "consumable: an elixir granting a benefit and a drawback"],
  ["poison", "consumable: inflicts a staged toxic affliction"],
  ["scroll", "consumable: holds a single spell, cast once then destroyed"],
  ["talisman", "consumable: affixed to gear, activated once for a burst of power"],
  ["wand", "holds a spell castable once per day"],
  ["staff", "holds a set of spells, charged each day from the wielder's spell slots"],
  ["drug", "consumable: a non-alchemical addictive substance"],
  ["catalyst", "consumable: enhances another item when used with it"],
  ["snare", "a trap a character can set with Crafting"],
  ["fulu", "consumable: a paper talisman charm"],
  ["apex", "boosts an ability score; only one apex item benefits you at a time"],
  ["tattoo", "applied to the body as a tattoo rather than worn"],
  ["companion", "worn or used by an animal companion or mount"],
  ["barding", "armor made for an animal companion or mount"],
  ["grimoire", "a witch/wizard spellbook item"],
  ["spellheart", "an affixable magic item that grants/heightens a spell"],
  ["censer", "an item activated by burning incense"],
  ["relic", "a personal artifact that grows in power with its bearer"],
  ["artifact", "a unique, immensely powerful item that can't be crafted normally"],
  ["precious", "made of a precious material (e.g. cold iron, silver, adamantine)"],
  ["structure", "an item that builds or becomes a structure"],
  ["intelligent", "a sentient item with its own mind and agenda"],
  ["contract", "a binding magical agreement item"]
];

// Effect/mechanics traits that frequently appear on items' activated effects.
export const EFFECT_TRAITS = [
  ["holy", "anathema to unholy creatures (fiends, undead); blessed/celestial"],
  ["unholy", "anathema to holy creatures; fiendish/profane"],
  ["sanctified", "can be made holy or unholy to match its wielder"],
  ["death", "can kill outright via its specific rules"],
  ["healing", "restores Hit Points or removes harmful conditions"],
  ["mental", "affects the mind; doesn't work on mindless creatures"],
  ["emotion", "a mental effect rooted in feeling (foiled by emotionless states)"],
  ["fear", "an emotion/mental effect that frightens"],
  ["sleep", "can render a creature unconscious"],
  ["light", "creates or manipulates light (counters darkness)"],
  ["polymorph", "transforms the target's physical form"],
  ["morph", "alters part of the target's form"],
  ["teleportation", "instantly moves a creature/object across space"],
  ["aura", "emits a continuous area effect around the bearer"],
  ["incapacitation", "strong vs lower-level foes; higher-level targets resist (level x2 rule)"],
  ["fortune", "lets you roll twice and take the higher (no stacking with misfortune)"],
  ["misfortune", "forces a reroll and the worse result"]
];

// Energy (damage) traits — the official eight; tag the energy a magic item channels.
export const ENERGY_TRAITS = [
  "acid", "cold", "electricity", "fire", "force", "sonic", "vitality", "void"
];
// Elemental traits (Player Core 2 elements).
export const ELEMENTAL_TRAITS = ["air", "earth", "fire", "metal", "water", "wood"];
// Magical traditions — pick the one that fits a magic item.
export const TRADITION_TRAITS = ["arcane", "divine", "occult", "primal"];
// Other common descriptor traits.
export const MISC_TRAITS = ["spirit", "bleed", "radiation", "void", "vitality"];
// Pre-remaster only — do not use unless the table still runs legacy rules.
export const LEGACY_SCHOOL_TRAITS = [
  "abjuration", "conjuration", "divination", "enchantment",
  "evocation", "illusion", "necromancy", "transmutation"
];

const fmt = pairs => pairs.map(([k, v]) => `    ${k} — ${v}`).join("\n");

/** A compact, readable glossary block for the workshop prompt. */
export function traitGlossaryBlock() {
  return [
    "PF2e TRAIT REFERENCE — choose traits from these and use the exact slug format shown.",
    "Parameterized slugs MUST include their value (e.g. thrown-20, versatile-s, deadly-d8, two-hand-d10, reload-1).",
    "",
    "  WEAPON traits (give a weapon the combat traits its real-world form would have):",
    fmt(WEAPON_TRAITS),
    `    ancestry weapon traits (use only for that ancestry's signature arms): ${ANCESTRY_WEAPON_TRAITS.join(", ")}.`,
    "",
    "  ARMOR traits:",
    fmt(ARMOR_TRAITS),
    "",
    "  SHIELD traits (for shields):",
    fmt(SHIELD_TRAITS),
    "",
    "  GENERAL / MAGIC / CONSUMABLE traits:",
    fmt(ITEM_TRAITS),
    "",
    "  EFFECT traits (tag an item's activated effect when relevant):",
    fmt(EFFECT_TRAITS),
    "",
    `  ENERGY/damage traits (the official eight): ${ENERGY_TRAITS.join(", ")}.`,
    `  ELEMENTAL traits: ${ELEMENTAL_TRAITS.join(", ")}.   MAGICAL TRADITIONS: ${TRADITION_TRAITS.join(", ")}.`,
    `  Other descriptors: ${MISC_TRAITS.filter((t, i, a) => a.indexOf(t) === i).join(", ")} (spirit = spiritual energy/damage).`,
    "",
    `  LEGACY (remaster removed these spell-school traits — omit unless told otherwise): ${LEGACY_SCHOOL_TRAITS.join(", ")}.`
  ].join("\n");
}
