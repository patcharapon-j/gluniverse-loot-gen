# GLLG Flavor Sidecar

The optional LLM provenance layer for **GLUniverse — Loot Generator** (DESIGN §14).

Foundry module code runs in the browser and can't spawn processes, so generation
posts a batch of items to this tiny Node service, which calls the **`claude` CLI**
(reusing the Claude Code auth already on your droplet — no separate API key) and
returns provenance flavor text. It is **purely cosmetic**: prices, rarity, and
rules never change, and **any failure is graceful** — the loot still drops with
plain rules-text. The loot loop never blocks on the LLM.

## What it is

- **Zero dependencies.** Node 18+ stdlib only (`http`, `child_process`).
- **One spawn per hoard.** The module batches every pick into a single call.
- **Loopback only.** Binds `127.0.0.1`; you reach it same-origin via nginx.

## Security model (read before deploying)

1. **Never internet-facing.** Bind to `127.0.0.1` and reverse-proxy through the
   nginx that already serves Foundry, so it's same-origin HTTPS.
2. **Shared-secret gate.** Set `GLLG_SECRET`; the module sends it as the
   `x-gllg-secret` header. The service **fails closed** if the secret is unset.
3. **No shell.** The prompt is handed to `claude` via **stdin** using `execFile`
   with an args array — never a concatenated shell string. Hostile item text
   (e.g. from a third-party compendium) is treated as data; worst case is odd
   flavor for that one item, never a loot grant, actor edit, or shell command.
4. **Strict contract.** `claude --output-format json`, a wall-clock timeout, body
   size + item-count caps.

## Install (droplet)

```bash
sudo mkdir -p /opt/gllg-sidecar
sudo cp server.mjs package.json /opt/gllg-sidecar/
sudo chown -R foundry:foundry /opt/gllg-sidecar     # the user whose ~/.claude is authed

# systemd unit
sudo cp gllg-sidecar.service /etc/systemd/system/
sudo systemctl edit gllg-sidecar     # set GLLG_SECRET (and User/paths) in the override
sudo systemctl daemon-reload
sudo systemctl enable --now gllg-sidecar
systemctl status gllg-sidecar
```

Then add the nginx block and reload:

```bash
# paste nginx-gllg-sidecar.conf's `location` into your Foundry server { } block
sudo nginx -t && sudo systemctl reload nginx
```

### Important: which user runs it

`claude` reads its login/config from the **home directory of the user running the
service**. Run the unit as the same user you authenticated `claude` as (the unit
ships with `User=foundry`). Verify manually first:

```bash
sudo -u foundry bash -lc 'echo "say hi as JSON {\"a\":1}" | claude -p --output-format json'
```

If that prints a JSON envelope with a `result` field, the sidecar will work. If
`ProtectHome=read-only` blocks `claude` from reading `~/.claude`, switch to the
`ProtectHome=tmpfs` + `BindReadOnlyPaths` variant noted in the unit file.

## Configure the module

In Foundry → **Module Settings → GLUniverse Loot Generator**:

- **LLM Flavor & Provenance** → on
- **Flavor Sidecar URL** → `/gllg-sidecar`
- **Flavor Sidecar Secret** → the same string as `GLLG_SECRET`

Generate a hoard; the review card shows an italic flavor line per item and a
**Reflavor** button to re-roll the prose without changing the loot.

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `GLLG_SECRET` | *(none — fails closed)* | shared secret; must match the module setting |
| `GLLG_HOST` | `127.0.0.1` | bind address (keep loopback) |
| `GLLG_PORT` | `7878` | bind port |
| `GLLG_CLAUDE_BIN` | `claude` | path to the Claude CLI |
| `GLLG_MODEL` | *(CLI default)* | optional `--model` override |
| `GLLG_TIMEOUT_MS` | `45000` | base wall-clock cap per call (flavor / one workshop item) |
| `GLLG_TIMEOUT_PER_ITEM_MS` | `30000` | extra time per additional workshop item |
| `GLLG_MAX_TIMEOUT_MS` | `240000` | hard ceiling for a workshop batch |
| `GLLG_MAX_ITEMS` | `40` | per-request item cap |
| `GLLG_MAX_BODY` | `262144` | request body byte cap |

> **Workshop timeouts.** Authoring multiple items takes longer than one, so the
> workshop cap scales as `GLLG_TIMEOUT_MS + (count − 1) × GLLG_TIMEOUT_PER_ITEM_MS`
> (bounded by `GLLG_MAX_TIMEOUT_MS`). Make sure your nginx `proxy_read_timeout`
> is at least as large, or a slow multi-item request gets cut off as a **502**.

## Quick local test

```bash
GLLG_SECRET=test node server.mjs &
curl -s localhost:7878/health
curl -s -X POST localhost:7878/flavor \
  -H 'content-type: application/json' -H 'x-gllg-secret: test' \
  -d '{"context":"combat","label":"Frost giant hoard","level":7,
       "tags":{"biomes":["arctic"],"factions":[],"traits":["cold"]},
       "items":[{"id":"p0_0","name":"Greataxe","type":"weapon","level":7,"rarity":"common"}]}'
```

You should get `{"flavors":{"p0_0":{"flavor":"…","provenance":"…"}}}`.

## The Loot Workshop (`/workshop`)

The same sidecar also backs the **Loot Workshop** — the GM's `/grill-me` command
(or the hammer scene-control button / Alt+W). Instead of reskinning compendium
picks, the workshop has the LLM **author bespoke loot directly**: the module
POSTs a free-text request and the model returns a JSON array of item specs
(name, type, level, rarity, price, traits, usage, description, flavor,
provenance — plus `category`/`group`/`baseItem` for weapons & armor and optional
weapon damageType/die). The model is told to pick the **correct PF2e item type**
(weapon / armor / consumable / treasure / equipment), give each item
**appropriate traits**, set a real **`baseItem`** (e.g. `longsword`, `chain-shirt`)
so forged weapons/armor inherit proper mechanics, and encode any dice/DCs as
**Foundry enrichers** (`@Damage[2d6[fire]]`, `@Check[type:reflex|dc:22]`, `[[/r 1d20+5]]`).

To get traits right, the prompt embeds a full **PF2e trait dictionary**
([`pf2e-traits.mjs`](pf2e-traits.mjs)) — the complete weapon, armor, shield,
equipment, energy/elemental, and effect/mechanics trait rosters, each with a
verified one-line meaning and the
exact slug format for parameterized ones (`thrown-20`, `versatile-s`, `deadly-d8`,
`two-hand-d10`). The roster mirrors the Archives of Nethys trait index and the
meanings were checked against the rules (e.g. `recovery` = a thrown weapon returns
on a miss; `hindering` = -5 to all Speeds). It's remaster-current (spell schools
listed only as legacy; vitality/void and holy/unholy energy). On the
module side, if a weapon comes back with no combat trait, the canonical traits are
**inferred from its base-weapon name** as a safety net (never overriding traits the
model did choose), and weapons/armor get a validated `baseItem` so they aren't
rootless custom items.

To keep those numbers honest, the prompt embeds **canonical PF2e grounding tables**
— the *DCs by Level* table and the baseline *permanent-item price by level* — so
the model reads real values instead of guessing. Damage, persistent damage,
healing, and **conditions** are anchored to the item-**grade** ladder
(lesser/moderate/greater/major, keyed to item level): grade-appropriate damage
dice, splash/persistent scaling mirroring alchemical bombs, real condition names
with small (usually 1-2) values, and save-gated graded outcomes at the level-based
DC. The request also carries the
campaign's variant rules: when **Proficiency Without Level** is on, the prompt
pre-computes the flatter, level-subtracted DC for the item's level (e.g. a level-10
item is told its DC is **17**, not 27) and reminds the model that PWL changes only
proficiency-based DCs/modifiers — item bonuses, striking dice, and prices are
unchanged.

The module then **sanitizes traits/usage/damage against the live `CONFIG.PF2E`**
and **validates each item against the actual PF2e DataModel** (filling defaults,
dropping anything invalid, falling back to a generic `equipment` item if a richer
type won't construct) before it ever reaches the review card. Nothing is created
until the GM approves, so the worst case is a discarded draft. The same security
posture applies (auth gate, no shell, timeout, caps).

Both endpoints also accept an optional **`campaign`** field (the GM's *Campaign
Context* module setting) and a per-request **`notes`** field, so generated flavor
and custom loot can be grounded in your world.

### Loot from creatures

`/workshop` also accepts an optional **`sources`** array and a **`lootKind`**
(`"carried"` / `"harvested"` / `"both"`). When the GM has creature tokens selected,
the module reads each into a bounded descriptor — `name`, `level`, `rarity`, `size`,
`traits`, the names of the physical `gear` it carries, and a trimmed `lore` snippet —
and the prompt frames the batch as loot **found on / harvested from** those creatures.
Each item's provenance names the specific source creature, and (for `harvested` /
`both`) the prompt asks for a clickable **harvest check** at the item's level-based DC
(Nature/Survival/Crafting; crit = bonus, fail = spoiled — DESIGN §13). The free-text
`prompt` becomes optional extra steering; with sources present it may be empty.

```bash
curl -s -X POST localhost:7878/workshop \
  -H 'content-type: application/json' -H 'x-gllg-secret: test' \
  -d '{"count":2,"lootKind":"both",
       "sources":[{"name":"Frost Drake","level":5,"rarity":"uncommon","size":"lg",
                   "traits":["dragon","cold"],"gear":["Hoard coins"],
                   "lore":"An ancient wyrm of the northern peaks."}]}'
```

```bash
curl -s -X POST localhost:7878/workshop \
  -H 'content-type: application/json' -H 'x-gllg-secret: test' \
  -d '{"prompt":"a cursed signet ring for the cult vault","count":1,"level":5,
       "rarity":"rare","campaign":"Grim coastal city ruled by a merchant cabal.",
       "notes":"recovered from a flooded crypt"}'
```

You should get `{"items":[{"name":"…","type":"equipment","level":5,"price":…,…}]}`.
