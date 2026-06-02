# GLUniverse — Loot Generator

A premium, dynamic **Pathfinder 2e** loot generator for **Foundry VTT v13+**, with a
live gear **health-check ("the Auditor")**. Budget-aware, source-themed, treadmill-free
loot — plus an auditor that reads your party's sheets and tells you who's ahead, behind,
or missing fundamentals.

Everything reskins **balance-safe PF2e quantities** (Party Treasure by Level,
Treasure-by-Encounter, the ABP curve as a yardstick) rather than inventing a parallel
economy, so nothing you generate breaks the math.

---

## Install

In Foundry: **Add-on Modules → Install Module**, paste this **Manifest URL**:

```
https://github.com/patcharapon-j/gluniverse-loot-gen/releases/latest/download/module.json
```

Then enable it in a world running the **Pathfinder 2e** system.

> The LLM flavor layer (below) is **optional** and off by default — the module is fully
> functional without it.

---

## What it does

- **Auditor / wealth ledger** — reads each PC's runes, skill/perception items, and net
  worth against the ABP curve; flags wealth drift and math-critical gaps. `Alt+L` or the
  gem button.
- **Budget-aware generation** — four push-button contexts (Combat, Exploration cache,
  Dungeon, Quest reward) plus an ad-hoc **single item** mode. `Alt+G` or the wand button.
- **Prescriptive cascade** — spends the budget in order: fundamental gaps → wealth-drift
  correction → themed fun layer → currency, with a human-readable reason per pick.
- **Theming** — auto-reads creature traits / scene tags, plus 12 biomes and 12 faction
  archetypes as soft weights (never hard filters).
- **GM review card** — every hoard is gated: reroll, swap, remove, and choose the
  destination before anything is created.
- **Multi-target materialization** — Loot actor (chest), chat hand-out, or direct to PC
  sheets. Writes valid PF2e item data (real compendium UUIDs, prices intact).
- **Rune-etched weapon & armor** *(on by default)* — weapon and armor drops come
  **pre-etched with an appropriate, legal, RAW-priced rune set** (potency, striking/
  resilient, and eligible property runes) sized to the party level and the find's theme.
  Eligibility is grounded in each rune's actual Usage restriction (e.g. *keen* only on
  piercing/slashing melee, *shadow* only on light/medium armor, *magnetizing* only on
  metal armor), so no illegal combinations are ever minted. **Workshop-authored** weapons
  and armor are etched too: the LLM's rune choices are validated against the same table
  (illegal/unknown runes dropped) and priced so the sheet total matches the item's fair
  value. See `scripts/pf2e/runes.js`.
- **Heirloom mode** *(opt-in)* — fundamental runes **awaken in place** on a PC's
  signature weapon/armor instead of dropping new gear. RAW-priced, so budget/auditor are
  unaffected.
- **LLM provenance flavor** *(opt-in)* — one batched `claude -p` call per hoard adds
  cosmetic provenance text. Fully graceful: any failure drops loot with plain rules-text.
- **Loot Workshop** *(opt-in, needs the sidecar)* — describe loot in plain words and the
  `claude -p` sidecar **authors bespoke PF2e items** (type, traits, fair price, encoded
  dice/DCs), reviewed on the same card. `/grill-me`, `Alt+W`, or the hammer button.
- **Loot from creatures** *(Workshop)* — **select one or more creature tokens** and the
  Workshop bases the loot **on / from** them: carried gear & keepsakes, or **harvested
  monster parts** (scales, fangs, glands, cores) — your pick per batch. Item level/count
  default from the creatures, provenance names each source, and harvested parts carry a
  clickable **harvest check** (Nature/Survival/Crafting). Just select tokens and run
  `/grill-me`.

---

## Build status

**v1 — implemented (#1–#6):**

| # | Build | Status |
|---|-------|--------|
| 1 | Auditor (wealth ledger + health-check dashboard) | ✅ |
| 2 | LootRequest + budget/tag adapters (4 contexts + cache tiers) | ✅ |
| 3 | Priority cascade + chat-card review gate | ✅ |
| 4 | Theming + multi-target materialization (incl. direct-to-sheet) | ✅ |
| 5 | Heirloom rune-as-loot mode | ✅ |
| 6 | `claude -p` flavor sidecar + batched provenance | ✅ |

**v1 — remaining:**

| # | Build | Status |
|---|-------|--------|
| 7 | Wishlist + teaser, boon-draft, salvage/crafting feed | ⏳ planned |

**v2 — deferred:** full Automatic Bonus Progression mode, apex-item handling.

See [DESIGN.md](DESIGN.md) for the full 17-section specification and build order.

---

## Settings (GM, world-scoped)

| Setting | Default | What it does |
|---------|---------|--------------|
| Shopping Access | Limited (~75% core) | Baseline core-vs-unusual loot ratio (AoN guidance) |
| Automatic Bonus Progression | off | Tells the auditor fundamentals come from the character, not runes |
| Wealth Drift Tolerance (%) | 25 | How far a PC may stray from the curve before being flagged |
| Party Actor ID | *(auto)* | Force a specific Party actor; blank = auto-detect |
| Heirloom Mode | off | Fundamental runes awaken in place on signature items |
| Heirloom Mode — include armor | off | Also awaken armor fundamentals (else weapons only) |
| Etch runes onto weapon & armor loot | on | Weapon/armor drops carry a legal, RAW-priced rune set (potency, striking/resilient, eligible property runes) sized to level & theme |
| LLM Flavor & Provenance | off | Request batched flavor from the `claude -p` sidecar |
| Flavor Sidecar URL | `/gllg-sidecar` | Same-origin path to the sidecar (behind nginx) |
| Flavor Sidecar Secret | *(empty)* | Shared secret; must match the sidecar's `GLLG_SECRET` |

---

## Optional: LLM flavor sidecar

The flavor layer needs a tiny Node service deployed alongside Foundry (browser code can't
spawn processes). It's loopback-only, behind your existing nginx, gated by a shared
secret, and **fails closed**. Full deployment guide: [sidecar/README.md](sidecar/README.md).

If you don't deploy it, leave **LLM Flavor** off — nothing else depends on it.

---

## Console API

Everything is scriptable via `game.modules.get("gluniverse-loot-gen").api`:

```js
const api = game.modules.get("gluniverse-loot-gen").api;
const req = api.loot.combatRequest({ partyLevel: 5, partySize: 4 });
const proposal = await api.generate.proposeLoot(req);
await api.generate.postReviewCard(proposal);
```

---

## Releasing (maintainers)

Releases are cut manually from the **Actions** tab → **Release** workflow → *Run workflow*.
Pick a **bump** — `patch` / `minor` / `major` — and the version auto-increments from
`module.json` (or type an explicit `version` to override). The workflow then:

1. stamps `module.json` with the new version + correct manifest/download URLs,
2. commits the bump back to the branch (so the next auto-increment is cumulative),
3. zips the module and publishes a GitHub Release with `module.json` + `module.zip`,

so the manifest link above always resolves to the latest. There's also a *pre-release*
toggle. See [.github/workflows/release.yml](.github/workflows/release.yml).
