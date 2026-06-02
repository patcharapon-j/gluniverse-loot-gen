# GLUniverse Loot Generator — Design Specification

> PF2e dynamic loot generation + gear health-check, for Foundry VTT.
> Status: **mechanics/design phase** (pre-implementation). Deploy target: DigitalOcean droplet hosting the Foundry instance.

## 1. Goals (priority order)

1. **(a) Save GM prep** — push-button, balanced, party-appropriate loot without manual bookkeeping. *The retention hook.*
2. **(b) Make loot feel exciting/meaningful** — drops that land emotionally. *The differentiator vs. the existing PF2e Loot Generator.*
3. **(c) Escape the +1→+2→+3 upgrade treadmill** — gear progression that feels organic.
4. **Gear health-check** — read live PC sheets, report who's ahead/behind and what fundamentals are missing.

Guiding principle throughout: **reskin existing balance-safe PF2e quantities rather than invent parallel economies.** Every "new" mechanic is a costume over RAW-priced data, so the budget math and health-check never break.

## 2. Hard constraints (PF2e treasure math — non-negotiable)

Treasure is **part of core balance**, not a bonus layer. The generator always operates *within* these:

- **Per-level budget** (Party Treasure by Level): 4 permanent items/level (~char level −1 to +2), ~2× as many consumables (2–3 levels below), currency fills the rest. Selling = 50% value.
- **Per-encounter budget** (threat → % of level budget) for sandbox/single drops.
- **Core vs. unusual mix**: ~50% core w/ free shops, ~75% limited, ~100%/ABP none.
- **Apex items**: special, ~one per PC ~L17. *(v2)*
- **ABP variant**: bonuses automatic, all loot becomes flavor. *(full mode = v2)*

## 3. Architecture overview

```
Entry points (combat / exploration / dungeon / quest)
        │  each populates ↓ via pluggable adapters
   ┌────────────┐    budget-source adapter  +  tag-source adapter
   │ LootRequest │ ←──────────────────────────────────────────────
   └────────────┘
        │
   PacingEngine  ──reads──►  WealthLedger + HealthCheck (the AUDITOR)
        │  (priority cascade)
   ItemSelector  ──filters/weights──►  PF2e compendia (by tags + per-PC bias)
        │
   Decorator     ──►  heirloom/rune flags, provenance (claude -p), curses, salvage
        │
   GM-review chat card  ──approve/swap/reroll──►
        │
   Materializer  ──►  Loot actor | chat card | direct-to-sheet
                       (every result decrements the one WealthLedger)
```

## 4. The Auditor (health-check + wealth ledger) — **build #1, the keystone**

Reads live PC sheets (Foundry PF2e exposes full actor/item data). Two **separate** readouts (never a single blended score):

1. **Fundamentals-gap** — audits actual equipped runes + skill/perception items against the **ABP progression table** as the universal yardstick (works for both standard-rune and ABP campaigns). Flags exactly what's missing and by how much. *Math-critical.*
2. **Wealth-drift** — cumulative gp-value awarded vs. Party-Treasure-by-Level expectation. Answers "rich/poor," per-PC and party-wide.

> A PC can be gp-rich but missing a striking rune — the split keeps that visible.

Ships as a standalone read-only dashboard before any generation exists (de-risks the sheet-reading/PF2e-data layer; useful by itself).

## 5. LootRequest + entry-point adapters

One generator, pluggable adapters. Only **budget-source** and **tag-source** vary by context:

| Context | Budget source | Tag source | Default materialize target |
|---|---|---|---|
| Post-combat hoard | encounter **threat** → budget slice | auto from defeated NPC traits + level | Loot actor (chest) |
| Exploration find | **cache tier** (minor/standard/major/hoard) → % of level budget | scene/region context tags | Loot actor or chat card |
| Dungeon | **dungeon budget** parceled across N rooms (some empty) | dungeon theme + occupant traits | Loot actors per room |
| Quest reward | **reward tier** GM picks | questgiver / faction tags | chat card → assign, or direct |

**Every find decrements the single WealthLedger** regardless of entry point.

## 6. Priority cascade (prescriptive, GM-gated)

Budget is spent in order, with transparent reasoning shown:

1. **Math-critical fundamental gaps first** (themed where possible) — e.g., PC missing striking → drop carries a striking rune.
2. **Wealth-drift correction** — over-weight toward whoever's behind.
3. **Fun layer** — themed/unique items, heirloom awakenings, wishlist hits, boon-draft pool.

Cascade **proposes → chat-card preview with reasoning → GM approves/swaps/rerolls → materializes.** Never fully automatic (preserves authorship + the surprise/reveal moment).

## 7. Theming (source-driven generation) — goal (b)

- **Tag sourcing: hybrid.** Auto-derive creature traits + level/role from selected tokens/encounter (free from Foundry); GM optionally layers **context tags** (biome/faction/"BBEG vault"), default empty.
- **Vocabulary: curated but extensible.** Creature traits = PF2e's fixed list. Biomes (~12: arctic, swamp, urban, darklands, desert…) + faction archetypes (cult, thieves' guild, knightly order, merchant house…) shipped as stable keys so weighting maps and the LLM prompt stay crisp. GM-extensible.
- **Theme = soft weight, not hard filter**, with a **reflavor escape hatch** + **strictness slider** ("prefer theme ↔ prefer fundamentals"). Conflicts are mostly illusory: a striking rune is flavor-agnostic, so it gets *reskinned* onto a themed weapon ("frost-scarred greataxe etched in giant-runes") rather than rejected.

## 8. Core-vs-unusual ratio — per-PC dynamic

- **Baseline** ratio from a **shopping-access campaign toggle** (free/limited/none → 50/75/100% core), per AoN.
- **Per-PC shift** driven by the health-check: PCs missing fundamentals get more **core**; well-equipped PCs get more **unusual**. Self-balancing and personal.
- **Unusual pool** = whole compendium theme-weighted (Q10 tags) minus obvious core items. This is where the `claude -p` flavor layer earns its keep.

## 9. Escape the treadmill (goal c) — runes-as-loot reskinned as evolving heirlooms

- **Grounded rune truth** (`scripts/pf2e/runes.js`): the full AoN rune roster — fundamental (weapon/armor potency, striking, resilient) and property (weapon + armor) — with RAW level/price/rarity **and each rune's Usage restriction** encoded as an eligibility predicate. This is the single source of truth for "which runes exist and what they may go on."
- **Weapon & armor loot is etched, not bare** (on by default, setting `etchRunes`): when the cascade drops a weapon or armor in the drift/fun layers it picks a mundane base and **etches a legal, level-appropriate, budget-bounded rune set** onto it — potency + striking/resilient capped to the ABP curve, plus property runes equal to the potency tier, theme-weighted from the find's tags. Strict eligibility means no illegal item is ever minted (no keen mace, no shadow plate, no magnetizing leather). The Materializer writes the real `system.runes` object; PF2e derives the runed price/level, and the proposal books base + rune gp so the ledger stays exact.
- **Mechanically = rune transfer** (RAW-priced): loot drops as runes; players keep their signature weapon; only runes climb. Budget + health-check unaffected because nothing is bypassed.
- **Narratively = evolving heirloom**: the rune *awakens within* the PC's existing item at a story beat ("the blade drinks the giant's frost") = striking rune applied in place.
- **Opt-in mode** (some groups love whole new weapons — don't force it). **One signature item per PC** by default, expandable to armor. Per-PC, per-slot setting.
- Heirloom awakening is **always an in-place direct-to-sheet edit** (cannot be a loot chest).

## 10. Materialization (multi-target)

GM-review chat card is always the gate; sinks are context-aware: **Loot actor** (caches/hoards, preserves discovery), **chat card** (review + divvy), **direct-to-sheet** (heirloom awakening, some quest rewards). The engine writes **valid PF2e item data** (real compendium UUIDs, correct rune objects, prices intact) so sheets/ledger/auditor keep reading correctly. No fake items.

## 11. Wishlist + teaser (player agency) — goal (b)

- **Strength: weight + teaser** (not hard-grant). Biases the cascade's fun layer; sometimes delivers a *lesser version* or a *clue/lead* toward the real item (turns wishlist into a quest hook, not a vending machine).
- **Scope: deliberate contexts only** (boss hoards, quest rewards, major caches) — NOT random minor finds.
- **Storage: structured per-PC entries** (flag editable via small sheet UI / structured journal), matched to real compendium item UUIDs.

## 12. Boon-draft (distribution skin over the cascade)

- **Trigger:** GM-invoked, **defaulting to milestone/boss** contexts. A ceremony, not every fight.
- **Pool is cascade-generated** (~1.5× what the party can take, themed + gap-aware) → guaranteed to contain what people need. **Snake draft** for picks.
- **Pick-order seeded by health-check deficit** (furthest-behind drafts first) → automatic drift correction + feels fair.
- **Undrafted items → currency bucket** at full value (found, not sold) by default; or remain as loot-actor remainder (GM's call). Budget stays exact.

## 13. Salvage / crafting feed

- **Budget: a carved slice of the currency bucket**, gp-valued as raw crafting materials. Ledger never notices it.
- **Form: named themed components** ("frost-giant marrow," "dragon scale") from the source tags.
- **Depth: plain gp-valued by default** (usable for any recipe, always balance-safe), with **optional** "unlocks/discounts this themed recipe" hook for signature crafts. No mandatory new rules.
- **Acquisition: optional harvest check** (Nature/Survival/Crafting vs. level DC; crit = bonus, fail = spoiled), **default auto-include**.
- **Implemented via the Loot Workshop:** the GM selects creature tokens and the workshop authors loot **found on / harvested from** them (carried gear, keepsakes, or monster parts), level/count defaulting from the creatures, provenance attributed per source, and harvested parts carrying the harvest check above.

## 14. LLM provenance layer (`claude -p`)

- **Form: LLM-generated** flavor/provenance via the **`claude` CLI**, reusing existing Claude Code auth on the droplet (no separate API key/billing).
- **Architecture: local sidecar** (Node service) — Foundry module code runs in the **browser** and cannot spawn processes. Module → `fetch` → sidecar → `claude -p`.
- **Deployment: sidecar bound to `127.0.0.1` on the droplet, reverse-proxied through existing nginx** under the Foundry domain (same-origin HTTPS; sidecar never directly internet-facing). Runs as a `systemd` unit (auto-start, co-located with Foundry + `claude`).
- **Security (hard rules):**
  1. **Auth gate** = shared secret in GM-only module settings (header), v1; architected so a Foundry session/role check can slot in later. Worst-case abuse = flavor text only (no loot grant / actor edit / arbitrary shell).
  2. **No shell interpolation** — pass prompt to `claude -p` via **stdin** / `execFile` args array, never concatenated `exec`. Treat all item text (esp. third-party compendia) as hostile → command-injection defense.
  3. **Strict output contract** — `--output-format json`, wall-clock timeout, batch **one call per hoard** (JSON array keyed by item id; never per-item — too many spawns).
- **Fallback:** any failure (no sidecar / timeout / bad JSON) → item still drops with plain rules-text, **graceful no-flavor**. The loot loop never blocks on the LLM.

## 15. Build order

**v1 (this includes everything except the two v2 items below):**
1. **Auditor** (wealth ledger + health-check dashboard) — keystone, shippable alone.
2. **LootRequest + budget/tag adapters** (4 entry points, cache tiers).
3. **Priority cascade + chat-card review gate.**
4. **Theming** (auto-traits + context tags + biome/faction vocab) + **multi-target materialization.**
5. **Heirloom rune-as-loot mode.**
6. **`claude -p` sidecar** + batched LLM provenance.
7. **Wishlist + teaser**, **boon-draft**, **salvage/crafting feed.**

**v2 (deferred):** full-ABP mode, apex-item handling.

Campaign currently runs **standard runes** (→ ABP-mode safely v2).

## 16. Foundry implementation notes

PF2e system primitives to lean on: **Party actor** (membership/level), **compendium packs** (full item-level/trait/price metadata — queryable), **Loot actor** type, physical-item value APIs. Study the existing **PF2e Loot Generator** module as prior art / baseline to beat. Heavy lifting = selection/pacing logic, not Foundry plumbing.

## 17. Open items for implementation phase

- Exact cache-tier → %-of-budget mapping (mirror Treasure-by-Encounter threat %s).
- WealthLedger storage shape (flag on Party actor).
- Sidecar prompt template + JSON schema for batched flavor.
- Reflavor/strictness-slider weighting formula.
- Biome/faction starter vocabulary final list.

---

## Sources

- [Treasure (core rules) — AoN](https://2e.aonprd.com/Rules.aspx?ID=2655)
- [Party Treasure by Level — AoN](https://2e.aonprd.com/Rules.aspx?ID=2656)
- [Treasure by Encounter — AoN](https://2e.aonprd.com/Rules.aspx?ID=2738)
- [Automatic Bonus Progression — AoN](https://2e.aonprd.com/Rules.aspx?ID=2741)
- [Pathfinder Treasure & Loot guidelines — Pathfinder Authority](https://pathfinderauthority.com/pathfinder-treasure-and-loot-system)
- [PF2e Loot Generator (prior-art module) — Foundry VTT](https://foundryvtt.com/packages/pf2e-loot-generator)
