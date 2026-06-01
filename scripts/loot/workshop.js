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
import { iconNoteHtml } from "./icon-note.js";
import { logLlmCall } from "./llm-log.js";

// Authoring scales with how many items the model writes — a single item is
// quick, but a batch can take a while. The cap keeps a runaway request bounded.
// These must stay >= the sidecar's own per-call timeout (server.mjs) or the
// browser aborts a request the sidecar would have answered (the 502 case).
const REQUEST_TIMEOUT_BASE_MS = 60000;     // first item
const REQUEST_TIMEOUT_PER_ITEM_MS = 30000; // each additional item
const REQUEST_TIMEOUT_MAX_MS = 240000;     // hard ceiling

function workshopTimeoutMs(count) {
  const extra = Math.max(0, (Math.trunc(Number(count)) || 1) - 1);
  return Math.min(REQUEST_TIMEOUT_MAX_MS, REQUEST_TIMEOUT_BASE_MS + extra * REQUEST_TIMEOUT_PER_ITEM_MS);
}

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
    party: partyBlurb(),
    // Campaign variant rules that change item math — the model adjusts modifiers
    // and DCs to suit (e.g. Proficiency Without Level uses flatter numbers).
    rules: { proficiencyWithoutLevel: !!safeSetting(SETTINGS.proficiencyWithoutLevel, false) },
    // Live PF2e vocabulary so the model encodes against the actual system.
    pf2e: {
      damageTypes: keysOf(cfg().damageTypes),
      usages: keysOf(cfg().usages),
      rarities: keysOf(cfg().rarityTraits, ["common", "uncommon", "rare", "unique"])
    }
  };

  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), workshopTimeoutMs(params.count));
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
    const items = Array.isArray(data?.items) ? data.items : [];
    logLlmCall({ kind: "workshop", endpoint: "/workshop", ok: true, status: res.status,
      ms: Date.now() - t0, detail: `requested ${params.count}, authored ${items.length}` });
    return items;
  } catch (err) {
    logLlmCall({ kind: "workshop", endpoint: "/workshop", ok: false, ms: Date.now() - t0,
      detail: `requested ${params.count}`, error: errText(err) });
    throw err;
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
    const itemData = buildCustomItemData(spec, params.prompt);
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
  // When the GM left the level blank, the LLM chose a level per item — reflect
  // that on the card by averaging the authored levels rather than assuming party.
  const proposalLevel = params.level ?? deriveProposalLevel(picks, partyLevel);
  return {
    id: `gllg-workshop-${Date.now()}`,
    context: "workshop",
    label: params.label,
    level: proposalLevel,
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
 * Turn a sanitized spec into ready-to-create item data of the CORRECT PF2e item
 * type, then validate it against the live PF2e DataModel — which fills the deep
 * mechanical defaults and cleans anything invalid. Only the core fields are
 * authored (level, price, rarity, traits, bulk, usage, description); any dice or
 * DCs ride in the description as Foundry enrichers the model wrote. If a richer
 * type won't validate, it falls back to a generic `equipment` item so the pick
 * is never lost. No hardcoded flavor — every player-facing string is authored.
 */
function buildCustomItemData(spec, prompt) {
  const description = buildDescription(spec);
  const flags = { [MODULE_ID]: { workshop: true, prompt: String(prompt ?? "").slice(0, 500) } };

  const data = {
    name: spec.name,
    type: spec.type,
    img: defaultImg(spec.type),
    system: buildSystemForType(spec, description),
    flags
  };
  const validated = validateItemData(data);
  if (validated) return validated;

  // The richer type wouldn't validate on this PF2e build — degrade to equipment.
  const fallback = {
    name: spec.name,
    type: "equipment",
    img: defaultImg("equipment"),
    system: buildSystemForType({ ...spec, type: "equipment" }, description),
    flags
  };
  return validateItemData(fallback) ?? fallback;
}

/** Assemble the description: authored flavor + body (with enrichers) + provenance. */
function buildDescription(spec) {
  const parts = [];
  if (spec.flavor) parts.push(`<p><em>${esc(spec.flavor)}</em></p>`);
  // esc() preserves Foundry enrichers ([[/r …]], @Damage[…], @Check[…]) — none of
  // their characters are HTML-escaped — while neutralizing stray markup.
  if (spec.description) parts.push(`<p>${esc(spec.description)}</p>`);
  if (spec.provenance) parts.push(`<p><em>${esc(spec.provenance)}</em></p>`);
  return parts.join("");
}

/** Build the system object for a given item type, core fields + safe defaults. */
function buildSystemForType(spec, description) {
  const gmNote = iconNoteHtml({
    name: spec.name, type: spec.type, rarity: spec.rarity,
    traits: spec.traits, flavor: spec.flavor, hint: spec.iconHint
  });
  const base = {
    description: { value: description, gm: gmNote },
    level: { value: clampInt(spec.level, 0, 25, 0) },
    price: { value: { gp: Math.max(0, Number(spec.price) || 0) } },
    quantity: 1,
    bulk: { value: bulkToNumber(spec.bulk) },
    traits: {
      value: withInferredTraits(spec.type, validTraitsFor(spec.type, spec.traits)),
      rarity: validRarity(spec.rarity), otherTags: []
    }
  };

  switch (spec.type) {
    case "weapon":
      return {
        ...base,
        category: validWeaponCategory(spec.category), group: validWeaponGroup(spec.group), baseItem: null,
        damage: {
          dice: 1,
          die: validDamageDie(spec.damageDie) ?? "d6",
          damageType: validDamageType(spec.damageType) ?? "slashing",
          modifier: 0, persistent: null
        },
        bonus: { value: 0 }, bonusDamage: { value: 0 }, splashDamage: { value: 0 },
        range: null, reload: { value: null },
        runes: { potency: 0, striking: 0, property: [] },
        usage: { value: mapUsage(spec.usage, "weapon") }
      };
    case "armor":
      // The system fixes armor usage to the armor slot — don't author it.
      return {
        ...base,
        category: validArmorCategory(spec.category), group: validArmorGroup(spec.group), baseItem: null,
        acBonus: 1, strength: null, dexCap: 4, checkPenalty: 0, speedPenalty: 0,
        runes: { potency: 0, resilient: 0, property: [] }
      };
    case "consumable":
      return {
        ...base,
        category: "other",
        uses: { value: 1, max: 1, autoDestroy: true },
        damage: null, spell: null, stackGroup: null,
        usage: { value: mapUsage(spec.usage, "consumable") }
      };
    case "treasure":
      return { ...base, stackGroup: null };
    case "equipment":
    default:
      return { ...base, usage: { value: mapUsage(spec.usage, "equipment") } };
  }
}

/**
 * Construct the data through the live PF2e Item DataModel: this validates it,
 * fills every default we omitted, and strips invalid fields. Returns the cleaned
 * source, or null when even cleaning throws (caller falls back). Never persists.
 */
function validateItemData(data) {
  try {
    const Cls = globalThis.CONFIG?.Item?.documentClass ?? globalThis.Item;
    if (!Cls) return data; // not running under Foundry — trust the hand-built data
    const tmp = new Cls(foundry.utils.duplicate(data));
    const obj = tmp.toObject();
    if (!obj.img && data.img) obj.img = data.img;
    obj.flags = foundry.utils.mergeObject(obj.flags ?? {}, data.flags ?? {}, { inplace: false });
    return obj;
  } catch (err) {
    console.warn(`${MODULE_ID} | custom "${data?.type}" item failed PF2e validation`, err);
    return null;
  }
}

/** Defensive client-side sanitize of one raw spec from the sidecar. */
function sanitizeSpec(raw) {
  return {
    name: String(raw?.name ?? "").trim().slice(0, 120),
    type: normType(raw?.type),
    level: clampInt(raw?.level, 0, 25, 0),
    rarity: validRarity(raw?.rarity),
    price: clampPrice(raw?.price),
    bulk: raw?.bulk,
    usage: String(raw?.usage ?? "").slice(0, 60),
    traits: Array.isArray(raw?.traits) ? raw.traits : [],
    category: String(raw?.category ?? "").slice(0, 40),
    group: String(raw?.group ?? raw?.weaponGroup ?? raw?.armorGroup ?? "").slice(0, 40),
    damageType: raw?.damageType ?? raw?.damagetype ?? null,
    damageDie: raw?.damageDie ?? raw?.die ?? null,
    description: cleanText(raw?.description, 1500),
    flavor: cleanText(raw?.flavor, 280),
    provenance: cleanText(raw?.provenance, 200),
    iconHint: cleanText(raw?.iconPrompt ?? raw?.icon ?? raw?.iconHint, 240)
  };
}

/* ------------------------------ PF2e vocabulary ------------------------------ */

function cfg() { return globalThis.CONFIG?.PF2E ?? {}; }
function keysOf(obj, fallback = []) {
  if (obj && typeof obj === "object") {
    const k = Object.keys(obj);
    if (k.length) return k;
  }
  return fallback;
}

/** Map any LLM type label to one of the PF2e item types we build. */
function normType(t) {
  const s = String(t ?? "").toLowerCase();
  if (s.includes("weapon")) return "weapon";
  if (s.includes("armor") || s.includes("armour")) return "armor";
  if (/(consum|potion|elixir|scroll|\boil\b|talisman|mutagen|poison|snare|drug|ammunition|\bammo\b)/.test(s)) return "consumable";
  if (/(treasure|gem|jewel|valuable|currency|coin|art object|artwork)/.test(s)) return "treasure";
  return "equipment"; // rings, staves, wands, worn/wondrous gear, shields, etc.
}

/* Magic/tradition/energy traits are valid on items of any type but often live in
   a different CONFIG bucket than the item-type pool — so the type pool alone
   would wrongly strip a magic weapon's "arcane"/"evocation"/"fire". Union these
   in so appropriate traits survive validation. */
const TRADITION_TRAITS = new Set(["arcane", "divine", "occult", "primal"]);
const MAGIC_SCHOOL_TRAITS = new Set([
  "abjuration", "conjuration", "divination", "enchantment",
  "evocation", "illusion", "necromancy", "transmutation"
]);
const UNIVERSAL_ITEM_TRAITS = new Set([
  "magical", ...TRADITION_TRAITS, ...MAGIC_SCHOOL_TRAITS,
  // energy / damage descriptors commonly carried by magic gear
  "acid", "cold", "electricity", "fire", "force", "mental", "poison", "sonic",
  "vitality", "void", "spirit", "positive", "negative", "bleed", "light", "holy", "unholy",
  // item-wide descriptors
  "invested", "cursed", "alchemical", "consumable", "apex", "artifact",
  "intelligent", "saggorak", "tattoo"
]);

/** Keep traits valid for this item type (plus the universal magic set) on the live system. */
function validTraitsFor(type, traits) {
  if (!Array.isArray(traits)) return [];
  const c = cfg();
  const pool = type === "weapon" ? c.weaponTraits
    : type === "armor" ? c.armorTraits
    : type === "consumable" ? c.consumableTraits
    : c.equipmentTraits;
  const valid = keysOf(pool);
  // null = config absent → don't over-filter; else the type pool ∪ universal magic traits.
  const set = valid.length ? new Set([...valid, ...UNIVERSAL_ITEM_TRAITS]) : null;
  const out = [];
  for (const t of traits) {
    const slug = normalizeSlug(t);
    if (slug && (!set || set.has(slug))) out.push(slug);
  }
  return [...new Set(out)].slice(0, 16);
}

/**
 * Guarantee an item carries appropriate baseline traits. A tradition or school
 * trait strictly implies "magical", so add it when the model named one but
 * forgot the umbrella trait — unless the item is alchemical (which is the
 * non-magical counterpart). Treasure is never auto-tagged magical.
 */
function withInferredTraits(type, traits) {
  if (type === "treasure") return traits;
  const has = new Set(traits);
  const magicEvident = traits.some(t => TRADITION_TRAITS.has(t) || MAGIC_SCHOOL_TRAITS.has(t));
  if (magicEvident && !has.has("magical") && !has.has("alchemical")) {
    return [...traits, "magical"];
  }
  return traits;
}

function validRarity(r) {
  const set = new Set(keysOf(cfg().rarityTraits, ["common", "uncommon", "rare", "unique"]));
  const s = String(r ?? "").toLowerCase();
  return set.has(s) ? s : "common";
}

/* Weapon/armor category + group keep custom gear mechanically appropriate (they
   drive proficiency, crit specialization, and derived traits). Validate against
   the live CONFIG; fall back to a sensible default when the model omits or
   misnames one. */
function validFromConfig(value, pool, fallbacks) {
  const set = new Set(keysOf(pool));
  const s = normalizeSlug(value);
  if (set.has(s)) return s;
  if (!set.size) return fallbacks[0]; // config absent → trust our default
  for (const f of fallbacks) if (set.has(f)) return f;
  return keysOf(pool)[0];
}
function validWeaponCategory(c) { return validFromConfig(c, cfg().weaponCategories, ["martial", "simple"]); }
function validWeaponGroup(g) { return validFromConfig(g, cfg().weaponGroups, ["sword", "club"]); }
function validArmorCategory(c) { return validFromConfig(c, cfg().armorCategories, ["light", "medium"]); }
function validArmorGroup(g) { return validFromConfig(g, cfg().armorGroups, ["leather", "chain"]); }

function validDamageType(t) {
  const set = new Set(keysOf(cfg().damageTypes));
  const s = normalizeSlug(t);
  if (!set.size) return s || null; // no config → trust the model
  return set.has(s) ? s : null;
}

const DAMAGE_DICE = new Set(["d4", "d6", "d8", "d10", "d12"]);
function validDamageDie(d) {
  const s = String(d ?? "").toLowerCase().trim();
  return DAMAGE_DICE.has(s) ? s : null;
}

const WEAPON_USAGES = new Set(["worngloves", "held-in-one-hand", "held-in-one-plus-hands", "held-in-two-hands"]);
/** Resolve a usage to a slug the live system accepts; default safely if not. */
function mapUsage(usage, type) {
  const valid = new Set(keysOf(cfg().usages));
  let candidate = normalizeSlug(usage);
  if (!candidate || (valid.size && !valid.has(candidate)) || (type === "weapon" && !WEAPON_USAGES.has(candidate))) {
    candidate = pickUsage(String(usage ?? "").toLowerCase(), type);
  }
  if (valid.size && !valid.has(candidate)) return valid.has("held-in-one-hand") ? "held-in-one-hand" : keysOf(cfg().usages)[0];
  return candidate;
}
function pickUsage(u, type) {
  const twoHand = /\b(two|both|2)[ -]?hand/.test(u);
  if (type === "weapon") return twoHand ? "held-in-two-hands" : "held-in-one-hand";
  if (/glove/.test(u)) return "worngloves";
  if (/\b(worn|ring|amulet|necklace|cloak|belt|boots|gloves|helm|hat|crown|mask|cape|bracers|circlet)\b/.test(u)) return "worn";
  if (twoHand) return "held-in-two-hands";
  return "held-in-one-hand";
}

function normalizeSlug(s) {
  return String(s ?? "").toLowerCase().trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
function cleanText(s, max) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/* ------------------------------ helpers ------------------------------ */

/** Average of the AI-authored item levels (rounded), or the party level if none. */
function deriveProposalLevel(picks, fallback) {
  const levels = picks.map(p => Number(p.level)).filter(n => Number.isFinite(n));
  if (!levels.length) return fallback;
  return Math.round(levels.reduce((s, n) => s + n, 0) / levels.length);
}

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
  switch (type) {
    case "weapon": return "icons/svg/sword.svg";
    case "armor": return "icons/svg/statue.svg";
    case "consumable": return "icons/svg/tankard.svg";
    case "treasure": return "icons/svg/coins.svg";
    default: return "icons/svg/item-bag.svg";
  }
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

/** Human-friendly one-liner for the call log (distinguishes a client-side abort). */
function errText(err) {
  if (err?.name === "AbortError") return "timed out (client)";
  return err?.message || String(err ?? "unknown error");
}
