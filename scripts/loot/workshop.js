/**
 * Loot Workshop — the GM asks the LLM for bespoke loot directly (the `/grill-me`
 * command and the workshop dialog both land here). Unlike the Decorator, which
 * only reskins compendium picks, the workshop has the `claude -p` sidecar AUTHOR
 * whole custom items (name, description, level, price, traits, flavor). The
 * result is a normal proposal — it rides the same review card and Materializer,
 * which creates the custom picks as editable PF2e `equipment` documents.
 *
 * Like the Decorator this never blocks the game: no sidecar / timeout / bad JSON
 * just surfaces a notification and returns null. Custom items are always priced
 * + GM-reviewed before anything is created, so the worst case is a discarded
 * draft.
 */

import { MODULE_ID, SETTINGS, TARGET } from "../const.js";
import { resolveParty, actorLevel } from "../pf2e/actor-reader.js";

const REQUEST_TIMEOUT_MS = 45000; // workshop authoring runs longer than flavor

/** The workshop needs the sidecar; it's available once a URL is configured. */
export function workshopEnabled() {
  return !!String(safeSetting(SETTINGS.sidecarUrl, "")).trim();
}

/**
 * Run a workshop request and return a review-ready proposal (or null on any
 * failure, after notifying). Does NOT post the card — the caller does, so this
 * module never has to import the review card (avoids a cycle).
 */
export async function runWorkshop(params) {
  if (!workshopEnabled()) {
    ui.notifications?.warn("GLLG: the LLM sidecar isn't configured — set the Flavor Sidecar URL in module settings.");
    return null;
  }
  return requestAndBuild(normalizeParams(params));
}

/** Re-roll a workshop proposal from the params it was built with. */
export async function rerunWorkshop(proposal) {
  return requestAndBuild(normalizeParams(proposal?.workshop ?? {}));
}

/* ------------------------------ orchestration ------------------------------ */

async function requestAndBuild(params) {
  let specs;
  try {
    specs = await callWorkshop(params);
  } catch (err) {
    console.error(`${MODULE_ID} | workshop request failed`, err);
    ui.notifications?.error("GLLG: the loot workshop request failed (see console).");
    return null;
  }
  if (!specs?.length) {
    ui.notifications?.warn("GLLG: the workshop returned no items — try a more specific request.");
    return null;
  }
  return buildWorkshopProposal(params, specs);
}

function normalizeParams(p = {}) {
  const count = clampInt(p.count, 1, 8, 1);
  const lvlNum = parseInt(p.level, 10);                 // blank / "party level" → null
  const level = Number.isFinite(lvlNum) ? Math.max(0, Math.min(25, lvlNum)) : null;
  return {
    prompt: String(p.prompt ?? "").trim().slice(0, 1500),
    count,
    level,
    rarity: p.rarity || "any",
    notes: String(p.notes ?? "").trim().slice(0, 600),
    label: String(p.label ?? "").trim() || "Custom loot"
  };
}

/* ------------------------------ sidecar transport ------------------------------ */

async function callWorkshop(params) {
  const base = String(safeSetting(SETTINGS.sidecarUrl, "")).trim().replace(/\/+$/, "");
  if (!base) throw new Error("no sidecar configured");
  const secret = String(safeSetting(SETTINGS.sidecarSecret, "")).trim();

  const payload = {
    prompt: params.prompt,
    count: params.count,
    level: params.level,
    rarity: params.rarity,
    campaign: String(safeSetting(SETTINGS.campaignContext, "") ?? "").trim(),
    notes: params.notes,
    party: partyBlurb()
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/workshop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "x-gllg-secret": secret } : {})
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`sidecar HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data?.items) ? data.items : [];
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ proposal assembly ------------------------------ */

function buildWorkshopProposal(params, specs) {
  const { level: partyLevel, size: partySize } = partyContext();
  const picks = [];
  const reasoning = [];

  specs.forEach((raw, i) => {
    const spec = sanitizeSpec(raw);
    if (!spec.name) return;
    const itemData = buildCustomItemData(spec);
    picks.push({
      uuid: `gllg-custom-${i}`,   // synthetic id (remove/dedupe in the card)
      custom: true,
      itemData,
      name: spec.name,
      img: itemData.img,
      type: spec.type,
      level: spec.level,
      gp: round2(spec.price),
      qty: 1,
      rarity: spec.rarity,
      tier: spec.type === "consumable" ? "consumable"
        : spec.rarity && spec.rarity !== "common" ? "unusual" : "core",
      reason: "Custom workshop item",
      flavor: spec.flavor || "",
      provenance: spec.provenance || "",
      forActorId: null, forActorName: null
    });
    reasoning.push(`Authored "${spec.name}" (Lv ${spec.level} ${spec.type}, ${round2(spec.price)} gp).`);
  });

  const totalGp = round2(picks.reduce((s, x) => s + x.gp, 0));
  const target = TARGET.LOOT_ACTOR;
  return {
    id: `gllg-workshop-${Date.now()}`,
    context: "workshop",
    label: params.label,
    level: params.level ?? partyLevel,
    partySize,
    target,
    request: { context: "workshop", meta: { workshop: true } }, // minimal serializable stub
    parcels: [{ id: "workshop-0", label: params.label, target, items: picks, currencyGp: 0, totalGp }],
    reasoning,
    totalGp,
    itemCount: picks.length,
    currencyGp: 0,
    workshop: { prompt: params.prompt, count: params.count, level: params.level, rarity: params.rarity, notes: params.notes, label: params.label }
  };
}

/**
 * Turn a sanitized spec into ready-to-create PF2e item data. Everything is built
 * as a universal `equipment` document (the most permissive physical-item type,
 * robust across PF2e versions); the LLM's suggested category is noted in the
 * description so the GM can convert it if they want a true consumable/treasure.
 * Flavor + provenance are folded into the description here (custom items carry
 * their own flavor — the Materializer leaves them as-is).
 */
function buildCustomItemData(spec) {
  const parts = [];
  if (spec.flavor) parts.push(`<p><em>${esc(spec.flavor)}</em></p>`);
  if (spec.description) parts.push(`<p>${esc(spec.description)}</p>`);
  if (spec.provenance) parts.push(`<p><strong>Provenance:</strong> ${esc(spec.provenance)}</p>`);
  const cat = spec.type && spec.type !== "equipment" ? `Suggested category: ${esc(spec.type)}. ` : "";
  parts.push(`<p><em>${cat}Custom item designed in the GLLG Loot Workshop.</em></p>`);

  const rarity = spec.rarity || "common";
  return {
    name: spec.name,
    type: "equipment",
    img: defaultImg(spec.type),
    system: {
      description: { value: parts.join(""), gm: "" },
      level: { value: spec.level ?? 0 },
      price: { value: { gp: Math.max(0, Number(spec.price) || 0) } },
      quantity: 1,
      bulk: { value: bulkToNumber(spec.bulk) },
      traits: { value: Array.isArray(spec.traits) ? spec.traits.slice(0, 12) : [], rarity, otherTags: [] }
    }
  };
}

/** Defensive client-side re-clamp (the sidecar already sanitizes, but trust nothing). */
function sanitizeSpec(raw) {
  const type = (() => {
    const s = String(raw?.type ?? "").toLowerCase();
    if (s.includes("consum")) return "consumable";
    if (/(treasure|gem|art|valuable|currency|coin|jewel)/.test(s)) return "treasure";
    return "equipment";
  })();
  const rarity = ["common", "uncommon", "rare", "unique"].includes(String(raw?.rarity ?? "").toLowerCase())
    ? String(raw.rarity).toLowerCase() : "common";
  return {
    name: String(raw?.name ?? "").trim().slice(0, 120),
    type,
    level: clampInt(raw?.level, 0, 25, 0),
    rarity,
    price: clampPrice(raw?.price),
    bulk: raw?.bulk,
    traits: Array.isArray(raw?.traits) ? raw.traits : [],
    usage: String(raw?.usage ?? "").slice(0, 60),
    description: String(raw?.description ?? "").slice(0, 1500),
    flavor: String(raw?.flavor ?? "").slice(0, 280),
    provenance: String(raw?.provenance ?? "").slice(0, 200)
  };
}

/* ------------------------------ helpers ------------------------------ */

function partyContext() {
  try {
    const { members } = resolveParty();
    const levels = members.map(actorLevel);
    const level = levels.length ? Math.round(levels.reduce((s, n) => s + n, 0) / levels.length) : 1;
    return { level, size: members.length || 4 };
  } catch { return { level: 1, size: 4 }; }
}

function partyBlurb() {
  try {
    const { members } = resolveParty();
    return members.slice(0, 8).map(m => `${m.name} (Lv ${actorLevel(m)})`).join(", ");
  } catch { return ""; }
}

function defaultImg(type) {
  if (type === "consumable") return "icons/svg/tankard.svg";
  if (type === "treasure") return "icons/svg/coins.svg";
  return "icons/svg/item-bag.svg";
}

function bulkToNumber(b) {
  if (typeof b === "number" && Number.isFinite(b)) return Math.max(0, b);
  const s = String(b ?? "").trim().toLowerCase();
  if (!s || s === "—" || s === "-" || s === "0" || s === "negligible") return 0;
  if (s === "l" || s === "light") return 0.1;
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
function clampPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}
function round2(n) { return Math.round(n * 100) / 100; }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeSetting(key, fallback) {
  try { return game.settings.get(MODULE_ID, key); } catch { return fallback; }
}
