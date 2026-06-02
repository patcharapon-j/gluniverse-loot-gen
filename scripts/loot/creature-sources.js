/**
 * Creature-source reader for the Loot Workshop (DESIGN §7, §13). The GM selects
 * one or more creature tokens; this reads each into a compact, bounded "source"
 * descriptor — identity (name/level/rarity/size/type), creature traits, a trimmed
 * lore snippet, and the names of the physical gear it actually carries. Those
 * descriptors are fed to the `claude -p` sidecar, which authors loot found ON the
 * creature (its carried gear/keepsakes) or harvested FROM it (scales, marrow,
 * cores — monster parts), provenance attributed per creature.
 *
 * Defensive throughout: an odd actor shape yields a partial descriptor, never a
 * throw. Only NPC/creature actors are kept — selecting a PC, loot pile, or hazard
 * by accident never produces "loot from a player character."
 */

const MAX_SOURCES = 8;     // matches the workshop's per-batch item ceiling
const MAX_TRAITS = 16;
const MAX_GEAR = 12;
const LORE_MAX = 300;

/** Resolve a token/placeable/actor argument to its actor. */
function actorOf(tok) {
  return tok?.actor ?? tok?.document?.actor ?? tok ?? null;
}

/** Is this actor a creature we can derive loot from (an NPC/monster, not a PC)? */
export function isCreatureActor(actor) {
  const t = actor?.type;
  // PF2e creature actor types are "npc" and "character"; characters are the
  // party, so loot "from" a creature means NPCs (and the rare familiar). Loot
  // actors, vehicles, hazards, and parties are excluded.
  return t === "npc" || t === "familiar";
}

/** The GM's currently-controlled tokens that resolve to creature actors. */
export function selectedCreatureTokens() {
  const controlled = globalThis.canvas?.tokens?.controlled ?? [];
  return controlled.filter(tok => isCreatureActor(actorOf(tok)));
}

/**
 * Read the selected creature tokens into bounded source descriptors. Dedupes by
 * actor name+level so selecting five identical goblins yields one "Goblin
 * Warrior ×5" source rather than five near-identical prompt blocks. Returns
 * `[]` when nothing creature-like is selected.
 */
export function readCreatureSources(tokens = selectedCreatureTokens()) {
  const byKey = new Map();
  for (const tok of tokens ?? []) {
    const actor = actorOf(tok);
    if (!isCreatureActor(actor)) continue;
    const src = describeCreature(actor);
    if (!src.name) continue;
    const key = `${src.name.toLowerCase()}|${src.level}`;
    const existing = byKey.get(key);
    if (existing) existing.count += 1;
    else byKey.set(key, { ...src, count: 1 });
    if (byKey.size >= MAX_SOURCES) break;
  }
  return [...byKey.values()];
}

/** One bounded descriptor for a single creature actor. */
function describeCreature(actor) {
  const sys = actor?.system ?? {};
  const traitsObj = sys?.traits ?? {};
  const traitVals = Array.isArray(traitsObj?.value) ? traitsObj.value
    : Array.isArray(traitsObj) ? traitsObj : [];

  return {
    name: String(actor?.name ?? "").trim().slice(0, 80),
    level: clampLevel(sys?.details?.level?.value),
    rarity: String(traitsObj?.rarity ?? "common").toLowerCase().slice(0, 20),
    size: String(traitsObj?.size?.value ?? traitsObj?.size ?? "med").slice(0, 12),
    traits: [...new Set(traitVals.map(slug).filter(Boolean))].slice(0, MAX_TRAITS),
    gear: carriedGear(actor),
    lore: loreSnippet(sys)
  };
}

/**
 * The names of the physical gear the creature is actually carrying — its real
 * loadout, so "carried loot" can reference what it wielded rather than the
 * model's invention. NPC stat-actions (melee/ranged "Strikes", spells, abilities)
 * are not physical items and are filtered out. Names only, deduped and capped.
 */
function carriedGear(actor) {
  let items = [];
  try {
    items = (actor?.items ?? []).filter(it =>
      it?.isOfType?.("physical")
      ?? ["weapon", "armor", "equipment", "consumable", "treasure", "shield", "backpack"].includes(it?.type));
  } catch { items = []; }

  const names = [];
  for (const it of items) {
    const n = String(it?.name ?? "").trim();
    if (!n) continue;
    const qty = Number(it?.system?.quantity) || 1;
    names.push(qty > 1 ? `${n} ×${qty}` : n);
    if (names.length >= MAX_GEAR) break;
  }
  return [...new Set(names)];
}

/** A trimmed, tag-stripped lore blurb from the NPC's public notes / description. */
function loreSnippet(sys) {
  const raw = sys?.details?.publicNotes
    ?? sys?.details?.blurb
    ?? sys?.details?.description
    ?? sys?.description?.value
    ?? "";
  return String(raw)
    .replace(/<[^>]*>/g, " ")            // strip HTML tags
    .replace(/@\w+\[[^\]]*\]({[^}]*})?/g, " ") // strip Foundry enrichers
    .replace(/&[a-z]+;/gi, " ")          // strip HTML entities
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LORE_MAX);
}

/* ------------------------------ helpers ------------------------------ */

function clampLevel(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(-1, Math.min(25, n)) : 0;
}

function slug(s) {
  return String(s ?? "").toLowerCase().trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Highest level among the sources (the workshop's default item-level hint). */
export function topSourceLevel(sources) {
  let top = null;
  for (const s of sources ?? []) {
    const lv = Number(s?.level);
    if (Number.isFinite(lv) && (top == null || lv > top)) top = lv;
  }
  return top;
}

/** Total creature count across sources (deduped sources carry a `count`). */
export function totalSourceCount(sources) {
  return (sources ?? []).reduce((n, s) => n + (Number(s?.count) || 1), 0);
}

/** A short "Goblin Warrior ×3, Owlbear" label for the proposal/title. */
export function sourcesLabel(sources, max = 4) {
  const parts = (sources ?? []).slice(0, max).map(s =>
    s.count > 1 ? `${s.name} ×${s.count}` : s.name);
  const extra = (sources ?? []).length - parts.length;
  if (extra > 0) parts.push(`+${extra} more`);
  return parts.join(", ");
}
