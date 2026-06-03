/**
 * Selection profile — the shared "LLM buyer" engine (DESIGN §18).
 *
 * A free-text concept ("black-market potion dealer", "drowned shrine of
 * Gozreh") is turned by the sidecar into a *selection profile*: a description of
 * WHAT KINDS of items to favour — an item-type mix, per-trait weights, a rarity
 * lean, a short list of specifically-wanted items, and exclusions. The model
 * never names UUIDs or sets prices; the CODE owns reality, resolving the profile
 * against the live, priced compendium index.
 *
 * Both the shop generator (cascade → proposeShop) and the regular loot cascade
 * use this same engine — shops let it pick the whole shelf; loot lets it steer
 * the discretionary "fun" layer while the math-critical phases stay code-owned.
 *
 * Everything is graceful and fails closed: no brief / no sidecar / a malformed
 * answer all yield a null profile, and the caller falls back to plain theming.
 */

import { MODULE_ID, SETTINGS } from "../const.js";
import { filterCandidates, weightFor, weightedPick, mundaneBases } from "./item-selector.js";
import { buildRuneSet } from "../pf2e/runes.js";
import { logLlmCall } from "./llm-log.js";

export const PROFILE_TYPES = ["weapon", "armor", "equipment", "consumable", "treasure"];
const PERMANENT_TYPES = new Set(["weapon", "armor", "shield", "equipment"]);

const DEFAULT_TIMEOUT_MS = 90000; // client cap; must exceed the sidecar's own

/* ------------------------------ transport ------------------------------ */

/**
 * POST a payload to a sidecar profile endpoint (/shop-stock, /loot-plan) and
 * return a sanitized selection profile (or null). Generic: the caller builds the
 * endpoint-specific payload; this owns the fetch, auth, timeout, sanitize, and
 * the structured LLM log line. Throws on transport/HTTP error so the caller can
 * log-and-fall-back; returns null when no sidecar is configured.
 */
export async function requestSelectionProfile({ endpoint, payload, kind, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = String(safeSetting(SETTINGS.sidecarUrl, "")).trim().replace(/\/+$/, "");
  if (!base) return null;
  const secret = String(safeSetting(SETTINGS.sidecarSecret, "")).trim();

  const t0 = Date.now();
  const modelNote = payload?.model ? ` · model ${payload.model}` : "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(secret ? { "x-gllg-secret": secret } : {}) },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`sidecar HTTP ${res.status}`);
    const data = await res.json();
    const profile = sanitizeProfile(data?.profile ?? data);
    logLlmCall({ kind, endpoint, ok: true, status: res.status, ms: Date.now() - t0,
      detail: `planned ${profile?.wanted?.length ?? 0} named + mix${modelNote}` });
    return profile;
  } catch (err) {
    logLlmCall({ kind, endpoint, ok: false, ms: Date.now() - t0, detail: "profile plan", error: errText(err) });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Defensive client-side sanitize of a buyer profile (the server also clamps). */
export function sanitizeProfile(p) {
  if (!p || typeof p !== "object") return null;
  const typeMix = {};
  if (p.typeMix && typeof p.typeMix === "object") {
    for (const [k, v] of Object.entries(p.typeMix)) {
      const key = String(k).toLowerCase();
      if (PROFILE_TYPES.includes(key)) typeMix[key] = clamp(Number(v) || 0, 0, 1);
    }
  }
  const traitWeights = {};
  if (p.traitWeights && typeof p.traitWeights === "object") {
    for (const [k, v] of Object.entries(p.traitWeights)) {
      const slug = normSlug(k);
      if (slug) traitWeights[slug] = clamp(Number(v) || 1, 0.1, 8);
    }
  }
  const wanted = (Array.isArray(p.wanted) ? p.wanted : [])
    .map(s => clip(String(s ?? "").trim(), 60)).filter(Boolean).slice(0, 12);
  const exclude = (Array.isArray(p.exclude) ? p.exclude : [])
    .map(s => String(s ?? "").toLowerCase().trim().slice(0, 40)).filter(Boolean).slice(0, 12);
  const rarityLean = ["common", "uncommon", "rare"].includes(String(p.rarityLean ?? "").toLowerCase())
    ? String(p.rarityLean).toLowerCase() : null;
  const count = Number.isFinite(Number(p.count)) ? clampInt(p.count, 1, 40) : null;

  // A profile with no usable signal is no profile — fall back to theme.
  if (!Object.keys(typeMix).length && !Object.keys(traitWeights).length && !wanted.length && !rarityLean) return null;
  return { typeMix, traitWeights, wanted, exclude, rarityLean, count };
}

/* ------------------------------ resolution ------------------------------ */

/**
 * Resolve a buyer-named item to a REAL, priced, level-bounded compendium entry by
 * fuzzy name match. Exact (normalized) name wins; otherwise the best token
 * overlap above a threshold, cheapest on ties. Never returns an over-level or
 * already-used item, so a named want can't smuggle in illegal/overpowered stock.
 */
export function resolveWanted(index, name, { maxLevel, used }) {
  const want = nameTokens(name);
  if (!want.size) return null;
  const wantSlug = [...want].join("-");

  let exact = null, best = null, bestScore = 0;
  for (const it of index) {
    if (it.level > maxLevel || used.has(it.uuid)) continue;
    const slug = normSlug(it.name);
    if (slug === wantSlug) { if (!exact || it.gp < exact.gp) exact = it; continue; }
    const toks = nameTokens(it.name);
    let overlap = 0;
    for (const t of want) if (toks.has(t)) overlap++;
    const score = overlap / want.size;
    if (score > bestScore || (score === bestScore && best && it.gp < best.gp)) { bestScore = score; best = it; }
  }
  if (exact) return exact;
  return bestScore >= 0.5 ? best : null; // require at least half the words to match
}

const STOPWORDS = new Set(["of", "the", "a", "an", "and", "potion", "scroll", "elixir", "oil"]);
export function normSlug(s) {
  return String(s ?? "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function nameTokens(s) {
  return new Set(normSlug(s).split("-").filter(t => t && !STOPWORDS.has(t)));
}

/* ------------------------------ selection ------------------------------ */

/**
 * Fill one slot per the LLM buyer's profile (DESIGN §18): sample an item TYPE
 * from its typeMix, then weight the live candidates by the profile's trait
 * weights + rarity lean (rune-etching a weapon/armor slot as usual). Honours an
 * optional budget (maxGp) so the same picker serves both the budget-neutral shop
 * (Infinity) and the budget-driven cascade.
 */
export function pickByProfile(index, {
  profile, level, tags, used, maxLevel, unusualBias, etch, etchChance, themeSlugs,
  maxGp = Infinity, minLevel = 0
}) {
  const type = sampleType(profile.typeMix);
  if (etch && (type === "weapon" || type === "armor") && Math.random() < etchChance) {
    const runed = makeRuned(index, { level, tags, used, themeSlugs, kind: type, maxGp });
    if (runed) return runed;
  }
  const isCons = type === "consumable";
  const types = type ? new Set([type]) : PERMANENT_TYPES;
  const maxL = isCons ? Math.max(0, maxLevel - 1) : maxLevel;
  let cands = filterCandidates(index, { minLevel, maxLevel: maxL, maxGp, types, excludeUuids: used });
  cands = applyExclude(cands, profile.exclude);
  if (!cands.length) return null;
  const preferLevel = isCons ? Math.max(0, level - 1) : level;
  const item = weightedPick(cands, it => profileWeight(it, { profile, tags, preferLevel, unusualBias }));
  return item ? toPick(item, profileReason(item, profile)) : null;
}

/** Theme weight, multiplied by the profile's per-trait boosts. */
export function profileWeight(item, { profile, tags, preferLevel, unusualBias }) {
  let w = weightFor(item, { tags, preferLevel, unusualBias });
  const tw = profile.traitWeights || {};
  for (const t of item.traits || []) {
    const f = tw[t];
    if (f) w *= Math.max(0.1, Number(f) || 1);
  }
  return w;
}

/** Weighted-random one of the allowed item types from the buyer's typeMix. */
export function sampleType(typeMix) {
  const entries = Object.entries(typeMix || {})
    .map(([k, v]) => [String(k).toLowerCase(), Math.max(0, Number(v) || 0)])
    .filter(([k, v]) => PROFILE_TYPES.includes(k) && v > 0);
  if (!entries.length) return null;
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let r = Math.random() * total;
  for (const [k, v] of entries) { r -= v; if (r <= 0) return k; }
  return entries[entries.length - 1][0];
}

/** A "rarity lean" → an unusual-pool bias delta added to the baseline. */
export function rarityLeanBias(lean) {
  switch (String(lean ?? "").toLowerCase()) {
    case "rare": return 0.8;
    case "uncommon": return 0.4;
    case "common": return -0.2;
    default: return 0;
  }
}

/** Drop candidates whose traits or name hit any exclusion term. */
export function applyExclude(cands, exclude) {
  const terms = (Array.isArray(exclude) ? exclude : []).map(s => String(s).toLowerCase().trim()).filter(Boolean);
  if (!terms.length) return cands;
  const traitSet = new Set(terms);
  return cands.filter(it => {
    if ((it.traits || []).some(t => traitSet.has(String(t).toLowerCase()))) return false;
    const name = String(it.name).toLowerCase();
    return !terms.some(term => name.includes(term));
  });
}

function profileReason(item, profile) {
  const tw = profile.traitWeights || {};
  const hit = (item.traits || []).find(t => tw[t]);
  if (hit) return `Fits the concept (${hit})`;
  if (item.rarity && item.rarity !== "common") return "Restricted pick for the concept";
  return "Stocked to the concept";
}

/* ------------------------------ rune etching ------------------------------ */

/**
 * Etch a legal, level-appropriate rune set onto a themed mundane base (DESIGN
 * §9). Honours maxGp so the budget cascade never overspends; the shop passes
 * Infinity. Returns a ready proposal pick, or null when nothing affordable fits.
 */
export function makeRuned(index, { level, tags, used, themeSlugs, kind, maxGp = Infinity }) {
  const bases = mundaneBases(index, kind).filter(b => !used.has(b.uuid) && b.gp <= maxGp);
  if (!bases.length) return null;
  const base = weightedPick(bases, it => weightFor(it, { tags, preferLevel: 0 }));
  if (!base) return null;
  const runeBudget = maxGp === Infinity ? Infinity : maxGp - base.gp;
  const set = buildRuneSet(base.meta, { level, maxGp: runeBudget, themeSlugs });
  if (!set) return null;
  return {
    uuid: base.uuid, name: base.name, img: base.img, type: base.type,
    level: Math.max(base.level, set.addedLevel), gp: round2(base.gp + set.addedGp), qty: 1, rarity: base.rarity,
    tier: "runed",
    reason: `Etched ${(set.names ?? []).join(" ")} ${base.name}`.replace(/\s+/g, " ").trim(),
    runes: set.runes, runeNames: set.names,
    forActorId: null, forActorName: null
  };
}

/** Normalize a compendium index entry into a proposal pick. */
export function toPick(item, reason) {
  return {
    uuid: item.uuid, name: item.name, img: item.img, type: item.type,
    level: item.level, gp: round2(item.gp), qty: 1, rarity: item.rarity,
    tier: item.type === "consumable" ? "consumable"
      : (item.rarity && item.rarity !== "common" ? "unusual" : "core"),
    reason, forActorId: null, forActorName: null
  };
}

/* ------------------------------ helpers ------------------------------ */

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function clampInt(v, lo, hi) { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }
function round2(n) { return Math.round(n * 100) / 100; }
function clip(s, max) { return String(s ?? "").slice(0, max); }
function safeSetting(key, fallback) { try { return game.settings.get(MODULE_ID, key); } catch { return fallback; } }
function errText(err) {
  if (err?.name === "AbortError") return "timed out (client)";
  return err?.message || String(err ?? "unknown error");
}
