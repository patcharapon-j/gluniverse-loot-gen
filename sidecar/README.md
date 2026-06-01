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
| `GLLG_TIMEOUT_MS` | `25000` | wall-clock cap per call |
| `GLLG_MAX_ITEMS` | `40` | per-request item cap |
| `GLLG_MAX_BODY` | `262144` | request body byte cap |

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
(or the wand/hammer scene-control button). Instead of reskinning compendium
picks, the workshop has the LLM **author bespoke loot directly**: the module
POSTs a free-text request and the model returns a JSON array of flavor-first
item specs (name, type, level, rarity, price, traits, description, flavor,
provenance). The module turns each into an **editable PF2e `equipment` item**
behind the usual review-card gate — nothing is created until the GM approves, so
the worst case is a discarded draft. The same security posture applies (auth
gate, no shell, timeout, caps).

Both endpoints also accept an optional **`campaign`** field (the GM's *Campaign
Context* module setting) and a per-request **`notes`** field, so generated flavor
and custom loot can be grounded in your world.

```bash
curl -s -X POST localhost:7878/workshop \
  -H 'content-type: application/json' -H 'x-gllg-secret: test' \
  -d '{"prompt":"a cursed signet ring for the cult vault","count":1,"level":5,
       "rarity":"rare","campaign":"Grim coastal city ruled by a merchant cabal.",
       "notes":"recovered from a flooded crypt"}'
```

You should get `{"items":[{"name":"…","type":"equipment","level":5,"price":…,…}]}`.
