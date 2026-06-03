/**
 * Shop generator (DESIGN §18) — stocks a buyable PF2e Merchant actor.
 *
 * A shop reuses the whole loot spine (item selector, theming, rune etching, the
 * review card, the Materializer, the LLM sidecar) but diverges in one defining
 * way: it is **budget-neutral**. Generating a shop never decrements the
 * WealthLedger — it is simply a curated, themed place for the party to spend gp
 * they already have (buying = converting wealth to gear, the PF2e default). The
 * Materializer's ledger write is skipped for any proposal carrying `.shop`.
 *
 * Sizing is by **shop tier** (peddler → emporium): each tier maps to an
 * item-count band, a level reach above the party, a core-vs-unusual lean, and a
 * count of bespoke "signature" items the Workshop may author. The stock itself
 * is picked deterministically from the compendia (no LLM); the optional LLM
 * layer (DESIGN §14 contract — flavor only, fails closed) adds a shopkeeper
 * persona + per-item provenance in one `/shop` call, and authors the signature
 * stock through the existing `/workshop` path.
 *
 * proposeShop() is reached via cascade.proposeLoot() delegating on `meta.shop`,
 * so the review card's reroll/swap/remove/reflavor all work unchanged.
 */

import { CONTEXT, TARGET, SETTINGS, CORE_RATIO, SHOP_TIER, MODULE_ID } from "../const.js";
import {
  getItemIndex, filterCandidates, weightFor, weightedPick, mundaneBases
} from "./item-selector.js";
import { buildRuneSet, themeRuneSlugs } from "../pf2e/runes.js";
import { runWorkshop } from "./workshop.js";
import { logLlmCall } from "./llm-log.js";
import { resolveParty, actorLevel } from "../pf2e/actor-reader.js";

const PERMANENT_TYPES = new Set(["weapon", "armor", "shield", "equipment"]);
const CONSUMABLE_TYPES = new Set(["consumable"]);

/**
 * Shop-tier table. Each tier sets:
 *   count           — [min,max] item slots (the GM may override with maxItems),
 *   maxOffset       — how many levels above the party level the stock can reach,
 *   unusual         — extra unusual-pool lean added to the shopping-access baseline,
 *   signatures      — bespoke Workshop items layered in (needs the sidecar + LLM on),
 *   consumableShare — fraction of slots that lean consumable,
 *   etchChance      — chance a weapon/armor slot is a freshly-etched runed base.
 */
export const SHOP_TIERS = {
  [SHOP_TIER.PEDDLER]:  { label: "Peddler",  count: [5, 8],   maxOffset: 0, unusual: 0.00, signatures: 0, consumableShare: 0.60, etchChance: 0.20 },
  [SHOP_TIER.STALL]:    { label: "Stall",    count: [8, 12],  maxOffset: 1, unusual: 0.10, signatures: 0, consumableShare: 0.50, etchChance: 0.30 },
  [SHOP_TIER.SHOP]:     { label: "Shop",     count: [12, 18], maxOffset: 2, unusual: 0.25, signatures: 1, consumableShare: 0.45, etchChance: 0.35 },
  [SHOP_TIER.EMPORIUM]: { label: "Emporium", count: [18, 28], maxOffset: 3, unusual: 0.45, signatures: 2, consumableShare: 0.40, etchChance: 0.40 }
};

/** True for a known shop tier key. */
export function isShopTier(key) {
  return Object.prototype.hasOwnProperty.call(SHOP_TIERS, key);
}

/* ------------------------------ proposal ------------------------------ */

/**
 * Build a shop proposal: a single parcel of themed, level-appropriate, priced
 * stock for a Merchant actor. Budget-neutral — there is no currency remainder
 * and nothing is booked to the ledger. Same proposal shape as the loot cascade,
 * plus a `.shop` block the Materializer / review card branch on.
 */
export async function proposeShop(request) {
  const index = await getItemIndex();
  const level = request.partyLevel;
  const tier = isShopTier(request.meta?.shopTier) ? request.meta.shopTier : SHOP_TIER.SHOP;
  const spec = SHOP_TIERS[tier];
  const tags = request.tags;

  const count = clampInt(request.maxItems ?? randInt(spec.count[0], spec.count[1]), 1, 40);

  // Core-vs-unusual: shopping-access baseline + the tier's unusual lean (DESIGN §8).
  const access = safeSetting(SETTINGS.shoppingAccess, "limited");
  const coreRatio = CORE_RATIO[access] ?? 0.75;
  const unusualBias = clamp((1 - coreRatio) + spec.unusual, 0, 1);

  const etch = !!safeSetting(SETTINGS.etchRunes, true);
  const themeSlugs = themeRuneSlugs(tags);
  const maxLevel = level + spec.maxOffset;

  const used = new Set();
  const items = [];
  let safety = 0;
  const opts = { level, tags, used, maxLevel, unusualBias, etch, etchChance: spec.etchChance, themeSlugs };
  while (items.length < count && safety++ < count * 5) {
    const wantConsumable = Math.random() < spec.consumableShare;
    let pick = wantConsumable ? pickShopConsumable(index, opts) : pickShopPermanent(index, opts);
    if (!pick) pick = wantConsumable ? pickShopPermanent(index, opts) : pickShopConsumable(index, opts);
    if (!pick) break;
    used.add(pick.uuid);
    items.push(pick);
  }

  // Tidy catalog order: cheaper/lower goods first.
  items.sort((a, b) => a.level - b.level || a.gp - b.gp || a.name.localeCompare(b.name));

  const totalGp = round2(items.reduce((s, x) => s + x.gp, 0));
  const target = request.target ?? TARGET.MERCHANT;
  const reasoning = [
    `Stocked a ${spec.label.toLowerCase()} with ${items.length} item(s)${themeLabel(tags)}.`,
    "Budget-neutral — players buy with their own coin; nothing is booked to the wealth ledger."
  ];

  return {
    id: `gllg-shop-${tier}-${items.length}-${Date.now()}`,
    context: CONTEXT.SHOP,
    label: request.label,
    level,
    partySize: request.partySize,
    target,
    request,
    parcels: [{ id: "shop-0", label: request.label, target, items, currencyGp: 0, totalGp }],
    reasoning,
    totalGp,
    itemCount: items.length,
    currencyGp: 0,
    shop: {
      tier,
      signatureTarget: spec.signatures,
      wantSignatures: !!request.meta?.useLlm && spec.signatures > 0,
      keeper: null
    }
  };
}

/* ------------------------------ selection ------------------------------ */

function pickShopPermanent(index, { level, tags, used, maxLevel, unusualBias, etch, etchChance, themeSlugs }) {
  if (etch && Math.random() < etchChance) {
    const runed = pickRuned(index, { level, tags, used, themeSlugs });
    if (runed) return runed;
  }
  const cands = filterCandidates(index, { minLevel: 0, maxLevel, types: PERMANENT_TYPES, excludeUuids: used });
  const item = weightedPick(cands, it => weightFor(it, { tags, preferLevel: level, unusualBias }));
  return item ? toPick(item, shopReason(item, tags)) : null;
}

function pickShopConsumable(index, { level, tags, used, maxLevel }) {
  const cands = filterCandidates(index, {
    minLevel: 0, maxLevel: Math.max(0, maxLevel - 1), types: CONSUMABLE_TYPES, excludeUuids: used
  });
  const item = weightedPick(cands, it => weightFor(it, { tags, preferLevel: Math.max(0, level - 1) }));
  return item ? toPick(item, shopReason(item, tags)) : null;
}

/** Etch a legal, level-appropriate rune set onto a themed mundane base (DESIGN §9). */
function pickRuned(index, { level, tags, used, themeSlugs }) {
  const first = Math.random() < 0.5 ? "weapon" : "armor";
  return makeRuned(index, { level, tags, used, themeSlugs, kind: first })
    ?? makeRuned(index, { level, tags, used, themeSlugs, kind: first === "weapon" ? "armor" : "weapon" });
}

function makeRuned(index, { level, tags, used, themeSlugs, kind }) {
  const bases = mundaneBases(index, kind).filter(b => !used.has(b.uuid));
  if (!bases.length) return null;
  const base = weightedPick(bases, it => weightFor(it, { tags, preferLevel: 0 }));
  if (!base) return null;
  const set = buildRuneSet(base.meta, { level, maxGp: Infinity, themeSlugs });
  if (!set) return null;
  return {
    uuid: base.uuid, name: base.name, img: base.img, type: base.type,
    level: Math.max(base.level, set.addedLevel), gp: round2(base.gp + set.addedGp), qty: 1, rarity: base.rarity,
    tier: "runed",
    reason: `On the shelf — etched ${(set.names ?? []).join(" ")} ${base.name}`.replace(/\s+/g, " ").trim(),
    runes: set.runes, runeNames: set.names,
    forActorId: null, forActorName: null
  };
}

function toPick(item, reason) {
  return {
    uuid: item.uuid, name: item.name, img: item.img, type: item.type,
    level: item.level, gp: round2(item.gp), qty: 1, rarity: item.rarity,
    tier: item.type === "consumable" ? "consumable"
      : (item.rarity && item.rarity !== "common" ? "unusual" : "core"),
    reason, forActorId: null, forActorName: null
  };
}

function shopReason(item, tags) {
  const hits = (item.traits ?? []).filter(t => (tags?.traits ?? []).includes(t));
  if (hits.length) return `On the shelf — themed (${hits.slice(0, 2).join(", ")})`;
  if (item.type === "consumable") return "Stock consumable";
  return item.rarity && item.rarity !== "common" ? "Specialty stock" : "Common stock";
}

/* ------------------------------ LLM enrichment ------------------------------ */

/**
 * Enrich a shop proposal with the optional LLM layer (DESIGN §14, §18). Two
 * gated, graceful steps — any failure leaves the shop fully usable with plain
 * rules-text:
 *   1. bespoke SIGNATURE stock via the existing /workshop path (idempotent),
 *   2. shopkeeper PERSONA + per-item provenance via one /shop call.
 * Reached through decorator.decorateProposal(), so reroll/reflavor reuse it.
 */
export async function decorateShop(proposal, { force = false } = {}) {
  if (!proposal?.shop) return proposal;
  await maybeAuthorSignatures(proposal);
  if (flavorOn()) await applyShopFlavor(proposal, { force });
  return proposal;
}

/** Author the tier's signature items once (counts existing ones — reflavor-safe). */
async function maybeAuthorSignatures(proposal) {
  if (!proposal.shop?.wantSignatures || !sidecarConfigured()) return;
  const parcel = proposal.parcels[0];
  const have = (parcel.items ?? []).filter(p => p.signature).length;
  const need = (proposal.shop.signatureTarget ?? 0) - have;
  if (need <= 0) return;

  let sub;
  try { sub = await runWorkshop({ prompt: signaturePrompt(proposal), count: need, level: proposal.level, label: "Signature stock" }); }
  catch (err) { console.warn(`${MODULE_ID} | shop signature authoring failed`, err); return; }
  if (!sub?.parcels?.length) return;

  for (const it of sub.parcels[0].items ?? []) {
    it.signature = true;
    it.tier = it.tier || "unusual";
    it.reason = "Signature stock (bespoke)";
    parcel.items.push(it);
  }
  recompute(parcel, proposal);
}

/** Build the creative brief for the signature stock from the shop's theme. */
function signaturePrompt(proposal) {
  const tier = proposal.shop?.tier || "shop";
  const theme = themeWords(proposal.request?.tags);
  const base = `Signature, memorable stock for a ${tier}-class Pathfinder 2e shop`
    + (theme ? ` themed around ${theme}` : "")
    + `. Design desirable, distinctive items this particular shop would be known for — balance-safe and fairly priced for around level ${proposal.level}.`;
  const note = String(proposal.request?.meta?.extraContext ?? "").trim();
  return (note ? `${base} Context: ${note}` : base).slice(0, 1500);
}

/** Shopkeeper persona + per-item provenance in one batched /shop call. */
async function applyShopFlavor(proposal, { force }) {
  const parcel = proposal.parcels[0];
  const targets = [];
  (parcel.items ?? []).forEach((pick, ii) => {
    if (pick.custom || pick.signature) return;   // these author their own flavor
    if (!force && pick.flavor) return;
    targets.push({ id: `s${ii}`, pick });
  });

  let result;
  try { result = await callShop(proposal, targets); }
  catch (err) { console.warn(`${MODULE_ID} | shop flavor sidecar unavailable — plain stock`, err); return; }
  if (!result) return;

  if (result.keeper) proposal.shop.keeper = result.keeper;
  const flavors = result.flavors ?? {};
  for (const { id, pick } of targets) {
    const f = flavors[id];
    if (!f) continue;
    if (typeof f === "string") { pick.flavor = clean(f); continue; }
    if (f.flavor) pick.flavor = clean(f.flavor);
    if (f.provenance) pick.provenance = clean(f.provenance);
    if (f.name) pick.flavorName = clean(f.name); // cosmetic reskin (uuid unchanged)
  }
}

const SHOP_REQUEST_TIMEOUT_MS = 90000; // client cap; must exceed the sidecar's own

async function callShop(proposal, targets) {
  const base = String(safeSetting(SETTINGS.sidecarUrl, "")).trim().replace(/\/+$/, "");
  if (!base) return null;
  const secret = String(safeSetting(SETTINGS.sidecarSecret, "")).trim();

  const payload = {
    tier: proposal.shop?.tier,
    label: proposal.label,
    level: proposal.level,
    theme: pickTags(proposal.request?.tags),
    campaign: String(safeSetting(SETTINGS.campaignContext, "") ?? "").trim(),
    notes: String(proposal.request?.meta?.extraContext ?? "").trim(),
    model: String(safeSetting(SETTINGS.llmModel, "") ?? "").trim(),
    party: partyBlurb(),
    items: targets.map(({ id, pick }) => ({
      id, name: pick.name, type: pick.type, level: pick.level, rarity: pick.rarity, reason: pick.reason ?? ""
    }))
  };

  const t0 = Date.now();
  const modelNote = payload.model ? ` · model ${payload.model}` : "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SHOP_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/shop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { "x-gllg-secret": secret } : {}) },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`sidecar HTTP ${res.status}`);
    const data = await res.json();
    logLlmCall({ kind: "shop", endpoint: "/shop", ok: true, status: res.status,
      ms: Date.now() - t0, detail: `${payload.items.length} item(s) + keeper${modelNote}` });
    return { keeper: sanitizeKeeper(data?.keeper), flavors: data?.flavors ?? {} };
  } catch (err) {
    logLlmCall({ kind: "shop", endpoint: "/shop", ok: false, ms: Date.now() - t0,
      detail: `${payload.items.length} item(s)`, error: errText(err) });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeKeeper(k) {
  if (!k || typeof k !== "object") return null;
  const name = clean(k.name, 80);
  const shop = clean(k.shop ?? k.shopName, 80);
  if (!name && !shop) return null;
  return {
    name: name || "the proprietor",
    shop: shop || "",
    greeting: clean(k.greeting ?? k.pitch, 200),
    bio: clean(k.bio ?? k.description, 600)
  };
}

/* ------------------------------ helpers ------------------------------ */

function recompute(parcel, proposal) {
  parcel.totalGp = round2((parcel.items ?? []).reduce((s, x) => s + x.gp, 0) + (parcel.currencyGp || 0));
  proposal.itemCount = proposal.parcels.reduce((s, p) => s + p.items.length, 0);
  proposal.totalGp = round2(proposal.parcels.reduce((s, p) => s + p.totalGp, 0));
}

function themeWords(tags) {
  return [...(tags?.biomes ?? []), ...(tags?.factions ?? []), ...(tags?.traits ?? [])].slice(0, 5).join(", ");
}
function themeLabel(tags) {
  const w = themeWords(tags);
  return w ? ` (themed: ${w})` : "";
}
function pickTags(tags) {
  if (!tags) return {};
  return { traits: tags.traits ?? [], biomes: tags.biomes ?? [], factions: tags.factions ?? [] };
}
function partyBlurb() {
  try {
    const { members } = resolveParty();
    return members.slice(0, 8).map(m => `${m.name} (Lv ${actorLevel(m)})`).join(", ");
  } catch { return ""; }
}

/** LLM flavor is on only when explicitly enabled AND a sidecar is configured. */
function flavorOn() {
  return !!safeSetting(SETTINGS.llmFlavor, false) && sidecarConfigured();
}
function sidecarConfigured() {
  return !!String(safeSetting(SETTINGS.sidecarUrl, "")).trim();
}

function randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function clampInt(v, lo, hi) { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }
function round2(n) { return Math.round(n * 100) / 100; }
function clean(s, max = 400) { return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max); }
function safeSetting(key, fallback) { try { return game.settings.get(MODULE_ID, key); } catch { return fallback; } }
function errText(err) {
  if (err?.name === "AbortError") return "timed out (client)";
  return err?.message || String(err ?? "unknown error");
}
