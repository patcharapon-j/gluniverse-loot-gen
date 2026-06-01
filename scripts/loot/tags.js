/**
 * Tag-source adapters (DESIGN §5, §7). Tag sourcing is hybrid: creature traits
 * + level are auto-derived from tokens (free from Foundry); the GM optionally
 * layers context tags (biome/faction) on top. These readers stay defensive —
 * a missing scene or odd actor shape yields empty tags, never a throw.
 */

import { MODULE_ID } from "../const.js";
import { makeTags } from "./request.js";

/** Resolve a token/placeable/actor argument to its actor. */
function actorOf(tok) {
  return tok?.actor ?? tok?.document?.actor ?? tok ?? null;
}

/**
 * Auto-derive tags from a set of tokens/actors — the defeated NPCs of a fight
 * or the occupants of a dungeon. Collects PF2e creature traits and the highest
 * level present. `extra` is merged in (e.g. a party-level hint).
 */
export function tagsFromTokens(tokens, extra = {}) {
  const traits = [];
  let level = Number(extra.level) || 0;
  for (const tok of tokens ?? []) {
    const actor = actorOf(tok);
    if (!actor) continue;
    const tv = actor?.system?.traits?.value ?? actor?.system?.traits ?? [];
    if (Array.isArray(tv)) traits.push(...tv);
    const lv = Number(actor?.system?.details?.level?.value) || 0;
    if (lv > level) level = lv;
  }
  return makeTags({ ...extra, traits: [...(extra.traits ?? []), ...traits], level });
}

/** Just the actor levels of a token set (feeds the threat estimator). */
export function levelsFromTokens(tokens) {
  const out = [];
  for (const tok of tokens ?? []) {
    const actor = actorOf(tok);
    const lv = Number(actor?.system?.details?.level?.value);
    if (Number.isFinite(lv)) out.push(lv);
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
