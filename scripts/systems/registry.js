/**
 * System-adapter registry — the seam that lets the one loot engine drive
 * multiple Foundry game systems (DESIGN §19). Everything PF2e-specific the
 * engine used to import directly (sheet reading, the treasure economy, the
 * progression yardstick, item-data shape, the rune layer, the LLM vocabulary)
 * now lives behind a `SystemAdapter`. The engine asks `getAdapter()` for the
 * active system's adapter and never branches on `game.system.id` itself.
 *
 * Two adapters ship today:
 *   - pf2e  — Pathfinder 2e: the original behaviour, preserved exactly by
 *     delegating to scripts/pf2e/* (no functional change).
 *   - dnd5e — D&D 5e (2024 / "5.5e"): the 2024 DMG treasure-hoard economy, an
 *     attunement + rarity-by-tier auditor, and Plutonium-sourced selection.
 *
 * Adapters self-register on import (see module.js, which imports both). A
 * resolved adapter is cached per system id; call clearAdapterCache() if the
 * active system ever changes mid-session (it doesn't in practice).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * The SystemAdapter contract (every adapter implements all of it):
 *
 *  identity
 *    id            string         — matches game.system.id
 *    label         string         — human name ("Pathfinder 2e")
 *    maxLevel      number         — top character level (20)
 *    generation    string         — "pf2e-cascade" | "dmg-hoard"
 *    capabilities  object         — { runes, heirloom, etch, attunement } booleans
 *    sidecarSystem string         — "pf2e" | "dnd5e" (LLM vocabulary selector)
 *    notReadyReason() string|null — i18n key when this system can't be audited
 *
 *  actors
 *    resolveParty()              → { partyActor, members[] }
 *    actorLevel(actor)           → 1..maxLevel
 *    netWorthGp(actor)           → gp number (coins + carried item value)
 *    actorTraits(actor)          → string[]  (creature traits / types, for theming)
 *    actorLevelOf(actor)         → number|null (raw level read for theming, may be 0)
 *    signatureWeapon(actor)      → item|null  (heirloom target; null if unsupported)
 *    signatureArmor(actor)       → item|null
 *
 *  economy
 *    budgetForLevel(level, size)            → gp
 *    expectedWealthPerPC(level)             → gp
 *    expectedCurrencyForLevel(level, size)  → gp
 *    estimateThreat(npcLevels, lvl, size)   → threat band key
 *    contextBudgetGp(kind, key, lvl, size)  → gp  (kind: combat|cache|quest|dungeon)
 *    magicPlan(context, key, level)         → { count, rarities[] }  (dmg-hoard only)
 *
 *  progression audit
 *    progressionAudit(actor, level) → {
 *      readouts: [{ key, name, soft, expectedTier, actualTier,
 *                   expectedLabel, actualLabel, severity, summary }],
 *      worst: severity, missing: string[]
 *    }
 *
 *  selection / compendium index
 *    indexFields()             → string[] of dot-paths to request from getIndex
 *    selectPacks()             → Foundry compendium pack[]
 *    indexEntry(e, pack)       → neutral record | null
 *                                { uuid,name,img,type,level,gp,traits,rarity,meta }
 *    priceToGp(price)          → gp number
 *    permanentTypes            Set<string>
 *    consumableTypes           Set<string>
 *    physicalTypes             Set<string>
 *
 *  generation
 *    proposeHoard(request)     → proposal   (dmg-hoard systems only)
 *    runeLayer                 object|null  (pf2e-cascade: findRune/buildRuneSet/…)
 *
 *  materialize / item shape
 *    applyEnrichment(data, pick)   → void  (pf2e: etch runes; dnd5e: attunement)
 *    descValuePath(data)           → dot-path to the player-facing description
 *    applyGmNote(data, html)       → void  (GM-only note: icon prompt etc.)
 *    lootActorType                 string
 *    lootActorImg                  string
 *    merchantActorData()           → partial actor data for a vendor
 *    merchantDescPath(actor)       → dot-path for the shopkeeper bio
 *    addCoins(actor, gp)           → Promise
 *
 *  sidecar vocabulary
 *    traitVocab()              → object merged into the LLM payload
 * ──────────────────────────────────────────────────────────────────────────
 */

const _registry = new Map();   // id → adapter factory or adapter object
const _cache = new Map();      // id → resolved adapter

/** Register an adapter under its system id. Idempotent (last wins). */
export function registerAdapter(adapter) {
  if (!adapter?.id) throw new Error("registerAdapter: adapter.id is required");
  _registry.set(adapter.id, adapter);
}

/** All registered system ids (for diagnostics / the settings UI). */
export function registeredSystems() {
  return [..._registry.keys()];
}

/**
 * The adapter for the active Foundry system, or null when no adapter matches
 * (e.g. the module is loaded under an unsupported system). Cached per id.
 */
export function getAdapter() {
  const id = globalThis.game?.system?.id ?? null;
  if (!id) return null;
  if (_cache.has(id)) return _cache.get(id);
  const adapter = _registry.get(id) ?? null;
  _cache.set(id, adapter);
  return adapter;
}

/** True when the active system has a registered adapter. */
export function systemSupported() {
  return !!getAdapter();
}

/** Drop resolved-adapter caches (used by tests / a hypothetical system swap). */
export function clearAdapterCache() {
  _cache.clear();
}
