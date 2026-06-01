/**
 * PF2e trait glossary — fed to the workshop LLM as context so it tags authored
 * items with the RIGHT traits and knows what each one means (instead of guessing
 * or returning only generic "magical"/energy traits).
 *
 * Compiled from the Pathfinder 2e rules (Player Core / GM Core, remaster).
 * Archives of Nethys (https://2e.aonprd.com/Traits.aspx) blocks automated
 * fetching, so this is maintained by hand; values are kept terse on purpose to
 * bound the prompt. Parameterized traits show the slug FORMAT the model must
 * emit (e.g. "thrown-20", "versatile-s", "deadly-d8", "two-hand-d10").
 *
 * Remaster-current: spell-school traits (evocation, abjuration, …) were removed
 * and are listed only as legacy. Energy uses vitality/void and holy/unholy.
 */

export const WEAPON_TRAITS = [
  ["agile", "multiple-attack penalty is -4/-8 instead of -5/-10"],
  ["finesse", "may use Dexterity instead of Strength on melee attack rolls (damage still Strength)"],
  ["reach", "extends your reach by 5 feet with this weapon"],
  ["thrown-{range}", "can be thrown the listed feet (e.g. thrown-10, thrown-20, thrown-30); uses Strength on damage"],
  ["versatile-{B|P|S}", "can instead deal the listed damage type, chosen per attack (e.g. versatile-s, versatile-p)"],
  ["deadly-d{die}", "on a critical hit add one extra weapon die of this size (e.g. deadly-d8, deadly-d10)"],
  ["fatal-d{die}", "on a crit the damage die becomes this size and you add one extra die of it (e.g. fatal-d10)"],
  ["two-hand-d{die}", "wielded in two hands its damage die becomes this size (e.g. two-hand-d10, two-hand-d12)"],
  ["sweep", "+1 circ to attack vs a target if you already attacked a different target this turn with it"],
  ["forceful", "your 2nd attack each turn deals +1 die bonus damage, 3rd and later +2 dice"],
  ["backswing", "+1 circ to your next attack with it after a miss this turn"],
  ["shove", "can use it to Shove"],
  ["trip", "can use it to Trip"],
  ["disarm", "can use it to Disarm"],
  ["grapple", "can use it to Grapple"],
  ["parry", "spend an action to gain +1 circ AC until your next turn"],
  ["propulsive", "add half your Strength mod to ranged damage (full if Strength is negative)"],
  ["volley-{range}", "-2 to attacks against targets within the listed range (e.g. volley-30)"],
  ["nonlethal", "deals nonlethal damage (knock out rather than kill)"],
  ["free-hand", "doesn't occupy the hand; leaves it free though you can't hold anything else with it"],
  ["modular-{B/P/S}", "Interact to switch which listed damage type it deals"],
  ["concussive", "for resistance/immunity, use the weaker of the target's piercing or bludgeoning"],
  ["razing", "especially good at damaging objects, structures, and vehicles"],
  ["brace", "deal damage to a creature that moves into your reach (set against a charge)"],
  ["jousting-d{die}", "while mounted, +1 to attack and its damage die becomes this size"],
  ["twin", "attacking with two of these in a turn grants +1 die bonus damage on later such attacks"],
  ["combination", "one weapon with both a melee and a ranged (firearm) form"],
  ["monk", "favored by monks; works with monk feats and stances"],
  // firearm / siege
  ["kickback", "-2 to attacks unless braced/strong enough; deals +1 damage die"],
  ["scatter-{range}", "also deals splash damage in the listed radius around the target"],
  ["capacity-{n}", "holds the listed number of shots; Interact to rotate (e.g. capacity-5)"],
  ["repeating", "feeds from a 5-shot magazine; reload from the magazine"],
  ["fatal-aim-d{die}", "has fatal of this die size while wielded in two hands"]
];

export const ARMOR_TRAITS = [
  ["bulwark", "+3 to Reflex saves vs damaging areas, and you don't add Dexterity to those saves"],
  ["comfort", "you can rest and sleep in it normally, without penalty"],
  ["flexible", "the armor's check penalty doesn't apply to Acrobatics or Athletics"],
  ["noisy", "the armor's check penalty applies to Stealth even when it normally wouldn't"]
];

// General item, magic, and consumable traits (apply across types).
export const ITEM_TRAITS = [
  ["magical", "created or sustained by magic (most magic items need this)"],
  ["arcane", "magic tradition: arcane (wizards, magi) — pick the tradition that fits"],
  ["divine", "magic tradition: divine (clerics, the faithful)"],
  ["occult", "magic tradition: occult (bards, the esoteric/mind)"],
  ["primal", "magic tradition: primal (druids, nature/elements)"],
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
  ["wand", "holds a spell castable once per day (rechargeable)"],
  ["drug", "consumable: a non-alchemical addictive substance"],
  ["catalyst", "consumable: enhances another item when used with it"],
  ["snare", "a trap a character can set with Crafting"],
  ["fulu", "consumable: a paper talisman charm"],
  ["ammunition", "consumable fired/launched by a weapon"],
  ["apex", "boosts an ability score; only one apex item benefits you at a time"],
  ["tattoo", "applied to the body as a tattoo rather than worn"],
  ["staff", "holds a set of spells, charged each day by the wielder's spell slots"],
  ["companion", "worn/used by an animal companion or mount"]
];

// Energy / element descriptor traits — tag the energy a magic item channels.
export const ENERGY_TRAITS = [
  ["fire", "fire damage/energy"], ["cold", "cold damage/energy"],
  ["electricity", "electricity damage/energy"], ["acid", "acid damage/energy"],
  ["sonic", "sonic damage/energy"], ["force", "raw magical force"],
  ["mental", "affects the mind"], ["poison", "poison/toxic energy"],
  ["bleed", "causes persistent bleed"],
  ["vitality", "life/positive energy (was 'positive'; harms undead)"],
  ["void", "void/negative energy (was 'negative'; harms the living, heals undead)"],
  ["spirit", "spiritual energy (affects most creatures incl. spirits)"],
  ["holy", "anathema to unholy creatures (fiends, undead); blessed/celestial"],
  ["unholy", "anathema to holy creatures; fiendish/profane"],
  ["light", "light-aligned descriptor"], ["water", "water element"],
  ["earth", "earth element"], ["air", "air element"],
  ["metal", "metal element"], ["wood", "wood element"]
];

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
    "Parameterized slugs MUST include their value (e.g. thrown-20, versatile-s, deadly-d8, two-hand-d10).",
    "",
    "  WEAPON traits (give a weapon the combat traits its real-world form would have):",
    fmt(WEAPON_TRAITS),
    "",
    "  ARMOR traits:",
    fmt(ARMOR_TRAITS),
    "",
    "  GENERAL / MAGIC / CONSUMABLE traits:",
    fmt(ITEM_TRAITS),
    "",
    "  ENERGY / ELEMENT descriptor traits (tag the energy a magic item channels):",
    fmt(ENERGY_TRAITS),
    "",
    `  LEGACY (remaster removed these spell-school traits — omit unless told otherwise): ${LEGACY_SCHOOL_TRAITS.join(", ")}.`
  ].join("\n");
}
