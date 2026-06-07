/**
 * Tag-source adapters (DESIGN §5, §7). Tag sourcing is hybrid: creature traits
 * + level are auto-derived from tokens (free from Foundry); the GM optionally
 * layers context tags (biome/faction) on top. These readers stay defensive —
 * a missing scene or odd actor shape yields empty tags, never a throw.
 */

import { MODULE_ID } from "../const.js";
import { makeTags } from "./request.js";
import { getAdapter } from "../systems/registry.js";

/** Resolve a token/placeable/actor argument to its actor. */
function actorOf(tok) {
  return tok?.actor ?? tok?.document?.actor ?? tok ?? null;
}

/**
 * Auto-derive tags from a set of tokens/actors — the defeated NPCs of a fight
 * or the occupants of a dungeon. Collects the system's creature traits/types and
 * the highest level (PF2e) / CR (5e) present. `extra` is merged in.
 */
export function tagsFromTokens(tokens, extra = {}) {
  const adapter = getAdapter();
  const traits = [];
  let level = Number(extra.level) || 0;
  for (const tok of tokens ?? []) {
    const actor = actorOf(tok);
    if (!actor) continue;
    traits.push(...(adapter?.actorTraits(actor) ?? []));
    const lv = adapter?.actorLevelOf(actor) ?? 0;
    if (lv > level) level = lv;
  }
  return makeTags({ ...extra, traits: [...(extra.traits ?? []), ...traits], level });
}

/** Just the actor levels/CRs of a token set (feeds the threat estimator). */
export function levelsFromTokens(tokens) {
  const adapter = getAdapter();
  const out = [];
  for (const tok of tokens ?? []) {
    const actor = actorOf(tok);
    const lv = adapter?.actorLevelOf(actor);
    if (Number.isFinite(lv) && lv > 0) out.push(lv);
  }
  return out;
}

/**
 * Scene/region context tags (exploration & dungeon). Reads biome/faction/custom
 * tags stored as module flags on the scene, falling back to anything passed in
 * `extra`. Scene flags let a GM theme a whole map once and reuse it.
 */
export function tagsFromScene(scene, extra = {}) {
  const flags = scene?.flags?.[MODULE_ID] ?? {};
  return makeTags({
    traits:   extra.traits,
    biomes:   flags.biomes   ?? extra.biomes,
    factions: flags.factions ?? extra.factions,
    custom:   flags.custom   ?? extra.custom,
    level:    extra.level ?? 0
  });
}

/** Quest tags from a faction list + an optional free-form questgiver tag. */
export function tagsFromQuest({ factions, questgiver, custom, traits, level } = {}) {
  const giver = questgiver ? [String(questgiver)] : [];
  return makeTags({
    traits,
    factions,
    custom: [...giver, ...(custom ?? [])],
    level: level ?? 0
  });
}
