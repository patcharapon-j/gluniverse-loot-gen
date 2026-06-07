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
import { getAdapter } from "../systems/registry.js";
import { iconNoteHtml } from "./icon-note.js";
import { logLlmCall } from "./llm-log.js";
import { sourcesLabel } from "./creature-sources.js";
import { sanitizeRuneSet, buildRuneSet, runePriceOf, runeSetNames, themeRuneSlugs } from "../pf2e/runes.js";

function resolveParty() { return getAdapter()?.resolveParty() ?? { partyActor: null, members: [] }; }
function actorLevel(a) { return getAdapter()?.actorLevel(a) ?? 1; }

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
  const sources = normalizeSources(p.sources);
  const lootKind = LOOT_KINDS.has(p.lootKind) ? p.lootKind : "both";
  return {
    prompt: String(p.prompt ?? "").trim().slice(0, 1500),
    count,
    level,
    rarity: p.rarity || "any",
    notes: String(p.notes ?? "").trim().slice(0, 600),
    label: String(p.label ?? "").trim() || (sources.length ? `Loot from ${sourcesLabel(sources)}` : "Custom loot"),
    // Creature-sourced loot (DESIGN §7, §13): the model authors items found on /
    // harvested from these creatures. Empty → a plain free-text workshop request.
    sources,
    lootKind
  };
}

const LOOT_KINDS = new Set(["carried", "harvested", "both"]);

/** Re-clamp creature source descriptors (they ride in/out of the proposal flag). */
function normalizeSources(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 8).map(s => ({
    name: String(s?.name ?? "").trim().slice(0, 80),
    level: clampInt(s?.level, -1, 25, 0),
    rarity: String(s?.rarity ?? "common").toLowerCase().slice(0, 20),
    size: String(s?.size ?? "med").slice(0, 12),
    traits: Array.isArray(s?.traits) ? s.traits.map(t => String(t).slice(0, 40)).slice(0, 16) : [],
    gear: Array.isArray(s?.gear) ? s.gear.map(g => String(g).slice(0, 80)).slice(0, 12) : [],
    lore: String(s?.lore ?? "").slice(0, 300),
    count: clampInt(s?.count, 1, 99, 1)
  })).filter(s => s.name);
}

/* ------------------------------ sidecar transport ------------------------------ */

async function callWorkshop(params) {
  const base = String(safeSetting(SETTINGS.sidecarUrl, "")).trim().replace(/\/+$/, "");
  if (!base) throw new Error("no sidecar configured");
  const secret = String(safeSetting(SETTINGS.sidecarSecret, "")).trim();

  const payload = {
    prompt: params.prompt,
    count: params.count,
    // Omit level entirely when blank so the sidecar treats it as "AI decides".
    // (Sending an explicit null trips Number(null)===0 on the server side.)
    ...(params.level != null ? { level: params.level } : {}),
    rarity: params.rarity,
    // Creature sources (DESIGN §7, §13) — when present the model authors loot
    // found on / harvested from these creatures, provenance attributed per one.
    ...(params.sources?.length ? { sources: params.sources, lootKind: params.lootKind } : {}),
    campaign: String(safeSetting(SETTINGS.campaignContext, "") ?? "").trim(),
    notes: params.notes,
    party: partyBlurb(),
    // Which Claude model the sidecar should use (blank → sidecar's own default).
    model: String(safeSetting(SETTINGS.llmModel, "") ?? "").trim(),
    // Campaign variant rules that change item math — the model adjusts modifiers
    // and DCs to suit (e.g. Proficiency Without Level uses flatter numbers).
    rules: { proficiencyWithoutLevel: !!safeSetting(SETTINGS.proficiencyWithoutLevel, false) },
    // Live system vocabulary so the model encodes against the actual system
    // (PF2e traits/usages, or D&D 5e rarities/properties). Includes `system`.
    ...(getAdapter()?.traitVocab?.() ?? {
      system: "pf2e",
      pf2e: {
        damageTypes: keysOf(cfg().damageTypes),
        usages: keysOf(cfg().usages),
        rarities: keysOf(cfg().rarityTraits, ["common", "uncommon", "rare", "unique"])
      }
    })
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
    const modelNote = payload.model ? ` · model ${payload.model}` : "";
    logLlmCall({ kind: "workshop", endpoint: "/workshop", ok: true, status: res.status,
      ms: Date.now() - t0, detail: `requested ${params.count}, authored ${items.length}${modelNote}` });
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
    const { data: itemData, runeInfo } = buildCustomItemData(spec, params.prompt, params.sources);
    const gp = round2(runeInfo?.totalGp ?? spec.price);
    picks.push({
      uuid: `gllg-custom-${i}`,   // synthetic id (remove/dedupe in the card)
      custom: true,
      itemData,
      name: spec.name,
      img: itemData.img,
      type: spec.type,
      level: spec.level,
      gp,
      qty: 1,
      rarity: spec.rarity,
      tier: runeInfo ? "runed"
        : spec.type === "consumable" ? "consumable"
        : spec.rarity && spec.rarity !== "common" ? "unusual" : "core",
      reason: "Custom workshop item",
      flavor: spec.flavor || "",
      provenance: spec.provenance || "",
      // Etched rune set (already baked into itemData) — surfaced for the card.
      runes: runeInfo?.runes,
      runeNames: runeInfo?.names,
      forActorId: null, forActorName: null
    });
    const runeNote = runeInfo?.names?.length ? ` — etched ${runeInfo.names.join(" · ")}` : "";
    reasoning.push(`Authored "${spec.name}" (Lv ${spec.level} ${spec.type}, ${gp} gp)${runeNote}.`);
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
    workshop: {
      prompt: params.prompt, count: params.count, level: params.level, rarity: params.rarity,
      notes: params.notes, label: params.label, sources: params.sources, lootKind: params.lootKind
    }
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
function buildCustomItemData(spec, prompt, sources) {
  const description = buildDescription(spec);
  const wf = { workshop: true, prompt: String(prompt ?? "").slice(0, 500) };
  // Record which creatures this loot was derived from, so the origin is
  // traceable on the item itself (the GM can also see it in the provenance line).
  if (Array.isArray(sources) && sources.length) {
    wf.sources = sources.map(s => String(s?.name ?? "").slice(0, 80)).filter(Boolean).slice(0, 8);
  }
  const flags = { [MODULE_ID]: wf };

  // D&D 5e items have an entirely different data model (no runes; rarity +
  // attunement instead) — build them via the 5e path.
  if (getAdapter()?.id === "dnd5e") return buildDnd5eItemData(spec, description, flags);

  // Resolve a legal, RAW-priced rune set for a weapon/armor (null otherwise), so
  // a bespoke magic blade/armor actually carries its runes on the sheet — not
  // just prose. The set is baked into system.runes and the base price below.
  const runeInfo = getAdapter()?.capabilities?.etch ? resolveSpecRunes(spec) : null;

  const data = {
    name: spec.name,
    type: spec.type,
    img: defaultImg(spec.type),
    system: buildSystemForType(spec, description, runeInfo),
    flags
  };
  const validated = validateItemData(data);
  if (validated) return { data: validated, runeInfo };

  // The richer type wouldn't validate on this PF2e build — degrade to equipment
  // (which can't hold runes, so drop them too).
  const fallback = {
    name: spec.name,
    type: "equipment",
    img: defaultImg("equipment"),
    system: buildSystemForType({ ...spec, type: "equipment" }, description, null),
    flags
  };
  return { data: validateItemData(fallback) ?? fallback, runeInfo: null };
}

/* ------------------------------ D&D 5e authoring ------------------------------ */

const DND5E_RARITIES = new Set(["common", "uncommon", "rare", "very rare", "legendary", "artifact"]);
const DIE_FACES = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12 };

/** Normalize a model-supplied rarity to a canonical 5e rarity. */
function normDnd5eRarity(r) {
  let s = String(r ?? "").trim().toLowerCase();
  if (s === "veryrare" || s === "very-rare") s = "very rare";
  return DND5E_RARITIES.has(s) ? s : "common";
}

/** Map a workshop type label to a D&D 5e item type. */
function normDnd5eType(spec) {
  switch (spec.type) {
    case "weapon": return "weapon";
    case "armor": return "equipment";          // 5e armor is an "equipment" item with an armor type
    case "consumable": return "consumable";
    case "treasure": return "loot";
    default: return isToolName(spec.name) ? "tool" : "equipment";
  }
}
function isToolName(name) {
  return /\b(tools?|kit|supplies|instrument|deck|dice|set)\b/i.test(String(name ?? ""));
}

/**
 * Build a D&D 5e item from a workshop spec. Only the core, system-neutral fields
 * are authored (name, description, price, rarity, attunement, magical flag, a
 * minimal type/damage block); the live dnd5e DataModel — via validateItemData —
 * fills every mechanical default and strips anything invalid, so the GM gets a
 * real, editable item. No runes (5e has none).
 */
function buildDnd5eItemData(spec, description, flags) {
  const rarity = normDnd5eRarity(spec.rarity);
  const magic = rarity !== "common" || !!spec.attunement || isMagicalName(spec.name);
  const type = normDnd5eType(spec);

  const system = {
    description: { value: description },
    price: { value: Math.max(0, Number(spec.price) || 0), denomination: "gp" },
    quantity: 1,
    rarity,
    identified: true,
    attunement: spec.attunement ? "required" : "",
    properties: magic ? ["mgc"] : []
  };

  if (type === "weapon") {
    const ranged = /bow|crossbow|sling|dart|firearm|gun|pistol|javelin/i.test(spec.name) || /ranged/i.test(spec.category ?? "");
    const martial = /martial/i.test(spec.category ?? "") || true; // default martial; GM can change
    system.type = { value: `${martial ? "martial" : "simple"}${ranged ? "R" : "M"}`, baseItem: normalizeSlug(spec.baseItem) || "" };
    const faces = DIE_FACES[String(spec.damageDie ?? "").toLowerCase()] ?? 8;
    const dt = String(spec.damageType ?? "slashing").toLowerCase();
    // v4 damage shape; the DataModel migrates older shapes if needed.
    system.damage = { base: { number: 1, denomination: faces, types: [dt] } };
  } else if (spec.type === "armor") {
    const cat = /heavy/i.test(spec.category ?? "") ? "heavy" : /medium/i.test(spec.category ?? "") ? "medium" : "light";
    const baseAc = cat === "heavy" ? 16 : cat === "medium" ? 14 : 11;
    system.type = { value: cat, baseItem: normalizeSlug(spec.baseItem) || "" };
    system.armor = { value: Number(spec.acBonus) || baseAc };
  }

  const data = { name: spec.name, type, img: defaultImg5e(type), system, flags };
  return { data: validateItemData(data) ?? data, runeInfo: null };
}

function isMagicalName(name) {
  return /\b(of|enchanted|magic|magical|arcane|holy|cursed|\+\d)\b/i.test(String(name ?? ""));
}
function defaultImg5e(type) {
  switch (type) {
    case "weapon": return "icons/svg/sword.svg";
    case "consumable": return "icons/svg/tankard.svg";
    case "loot": return "icons/svg/coins.svg";
    case "tool": return "icons/svg/anchor.svg";
    default: return "icons/svg/item-bag.svg";
  }
}

/* ------------------------------ rune etching ------------------------------ */

const RANGED_WEAPON_GROUPS = new Set(["bow", "dart", "sling", "firearm", "crossbow"]);
const METAL_ARMOR_GROUPS = new Set(["plate", "chain", "composite"]);
const VERSATILE_DAMAGE = { b: "bludgeoning", p: "piercing", s: "slashing" };

/**
 * Resolve a legal, RAW-priced rune set for a custom weapon/armor spec, or null.
 *   1. Honour an explicit `spec.runes` the model authored (sanitized to legal).
 *   2. Otherwise, if the item is magical, derive a level-appropriate, themed set
 *      so its magic shows up mechanically (the GM still reviews & can edit).
 * When runes apply we split the authored price into a base price (written to the
 * item) + the rune cost the PF2e system re-adds, so the sheet total ≈ the model's
 * fair value and runes are never double-counted.
 */
function resolveSpecRunes(spec) {
  if (spec.type !== "weapon" && spec.type !== "armor") return null;
  const meta = specRuneMeta(spec);
  if (!meta) return null;

  let runes = spec.runes ? sanitizeRuneSet(meta, spec.runes) : null;
  const total = Math.max(0, Number(spec.price) || 0);
  if (!runes && isMagical(meta.traits)) {
    const set = buildRuneSet(meta, { level: spec.level, maxGp: total, themeSlugs: themeRuneSlugs({ traits: meta.traits }) });
    if (set) runes = set.runes;
  }
  if (!runes) return null;

  const runeGp = runePriceOf(meta, runes);
  const basePrice = Math.max(0, round2(total - runeGp));
  return { meta, runes, basePrice, totalGp: round2(basePrice + runeGp), names: runeSetNames(meta, runes) };
}

/** Build the eligibility descriptor for a weapon/armor spec (validated fields). */
function specRuneMeta(spec) {
  const traits = withInferredTraits(spec.type, validTraitsFor(spec.type, spec.traits), spec.name);
  if (spec.type === "weapon") {
    const group = validWeaponGroup(spec.group);
    return {
      kind: "weapon",
      baseItem: validWeaponBaseItem(spec),
      damage: weaponDamageTypes(validDamageType(spec.damageType) ?? "slashing", traits),
      melee: !(RANGED_WEAPON_GROUPS.has(group) || traits.includes("ranged")),
      thrown: traits.some(t => t === "thrown" || t.startsWith("thrown-")),
      traits
    };
  }
  if (spec.type === "armor") {
    return {
      kind: "armor",
      category: validArmorCategory(spec.category),
      material: METAL_ARMOR_GROUPS.has(validArmorGroup(spec.group)) ? "metal" : null,
      traits
    };
  }
  return null;
}

/** Damage types a weapon can deal: its primary type plus any versatile traits. */
function weaponDamageTypes(primary, traits) {
  const out = new Set();
  if (primary) out.add(primary);
  for (const t of traits) {
    const m = /^versatile-(b|p|s)$/.exec(t);
    if (m) out.add(VERSATILE_DAMAGE[m[1]]);
  }
  return [...out];
}

function isMagical(traits) {
  return Array.isArray(traits) && (traits.includes("magical") || traits.some(t => TRADITION_TRAITS.has(t)));
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
function buildSystemForType(spec, description, runeInfo = null) {
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
      value: withInferredTraits(spec.type, validTraitsFor(spec.type, spec.traits), spec.name),
      rarity: validRarity(spec.rarity), otherTags: []
    }
  };

  switch (spec.type) {
    case "weapon":
      return {
        ...base,
        // Runed items split price into base + rune cost (the system re-adds runes).
        ...(runeInfo ? { price: { value: { gp: runeInfo.basePrice } } } : {}),
        category: validWeaponCategory(spec.category), group: validWeaponGroup(spec.group),
        baseItem: validWeaponBaseItem(spec),
        damage: {
          dice: 1, // base die count; striking runes add dice via system.runes
          die: validDamageDie(spec.damageDie) ?? "d6",
          damageType: validDamageType(spec.damageType) ?? "slashing",
          modifier: 0, persistent: null
        },
        bonus: { value: 0 }, bonusDamage: { value: 0 }, splashDamage: { value: 0 },
        range: null, reload: { value: null },
        runes: runeInfo ? runeInfo.runes : { potency: 0, striking: 0, property: [] },
        usage: { value: mapUsage(spec.usage, "weapon") }
      };
    case "armor":
      // The system fixes armor usage to the armor slot — don't author it.
      return {
        ...base,
        ...(runeInfo ? { price: { value: { gp: runeInfo.basePrice } } } : {}),
        category: validArmorCategory(spec.category), group: validArmorGroup(spec.group),
        baseItem: validArmorBaseItem(spec),
        acBonus: 1, strength: null, dexCap: 4, checkPenalty: 0, speedPenalty: 0,
        runes: runeInfo ? runeInfo.runes : { potency: 0, resilient: 0, property: [] }
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
  const dnd5e = getAdapter()?.id === "dnd5e";
  return {
    name: String(raw?.name ?? "").trim().slice(0, 120),
    type: normType(raw?.type),
    level: clampInt(raw?.level, 0, 25, 0),
    // Keep the system's own rarity vocabulary (PF2e: common/uncommon/rare/unique;
    // 5e: …/very rare/legendary/artifact) so it survives into the item builder.
    rarity: dnd5e ? normDnd5eRarity(raw?.rarity) : validRarity(raw?.rarity),
    price: clampPrice(raw?.price),
    bulk: raw?.bulk,
    usage: String(raw?.usage ?? "").slice(0, 60),
    traits: Array.isArray(raw?.traits) ? raw.traits : [],
    category: String(raw?.category ?? "").slice(0, 40),
    group: String(raw?.group ?? raw?.weaponGroup ?? raw?.armorGroup ?? "").slice(0, 40),
    baseItem: String(raw?.baseItem ?? raw?.base ?? raw?.baseType ?? "").slice(0, 60),
    damageType: raw?.damageType ?? raw?.damagetype ?? null,
    damageDie: raw?.damageDie ?? raw?.die ?? null,
    // 5e-only: attunement requirement + an armor class for armor specs.
    attunement: raw?.attunement === true || /require|attun/i.test(String(raw?.attunement ?? "")),
    acBonus: raw?.acBonus ?? raw?.ac ?? raw?.armorClass ?? null,
    runes: extractRawRunes(raw),
    description: cleanText(raw?.description, 1500),
    flavor: cleanText(raw?.flavor, 280),
    provenance: cleanText(raw?.provenance, 200),
    iconHint: cleanText(raw?.iconPrompt ?? raw?.icon ?? raw?.iconHint, 240)
  };
}

/**
 * Pull a raw rune descriptor out of a spec, accepting either a nested `runes`
 * object or flattened top-level fields. Left unsanitized here — `sanitizeRuneSet`
 * (which knows the base item) enforces legality at build time.
 */
function extractRawRunes(raw) {
  const r = raw?.runes;
  if (r && typeof r === "object" && !Array.isArray(r)) return r;
  const flat = {};
  if (raw?.potency != null) flat.potency = raw.potency;
  if (raw?.striking != null) flat.striking = raw.striking;
  if (raw?.resilient != null) flat.resilient = raw.resilient;
  const props = Array.isArray(raw?.property) ? raw.property
    : Array.isArray(raw?.propertyRunes) ? raw.propertyRunes : null;
  if (props) flat.property = props;
  return Object.keys(flat).length ? flat : null;
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

/* Canonical PF2e combat traits a base weapon carries, keyed by base-weapon name.
   Used ONLY as a safety net: a custom weapon can have whatever traits the model
   chose, so we never override or remove those — we infer from the name purely to
   backfill when the model returned a weapon with NO combat trait at all, so a
   forged weapon is never trait-less. Sourced from the Core Rulebook weapon tables. */
const WEAPON_BASE_TRAITS = {
  dagger: ["agile", "finesse", "thrown-10", "versatile-s"],
  "main-gauche": ["agile", "disarm", "finesse", "versatile-s"],
  kukri: ["agile", "finesse", "trip"],
  sickle: ["agile", "finesse", "trip"],
  rapier: ["deadly-d8", "disarm", "finesse"],
  "short-sword": ["agile", "finesse", "versatile-s"],
  shortsword: ["agile", "finesse", "versatile-s"],
  longsword: ["versatile-p"],
  "bastard-sword": ["two-hand-d12"],
  greatsword: ["versatile-p"],
  scimitar: ["forceful", "sweep"],
  falchion: ["forceful", "sweep"],
  katana: ["deadly-d8", "two-hand-d10", "versatile-p"],
  glaive: ["deadly-d8", "forceful", "reach"],
  halberd: ["reach", "versatile-s"],
  scythe: ["deadly-d10", "trip"],
  longspear: ["reach"],
  spear: ["thrown-20"],
  shortspear: ["thrown-20"],
  trident: ["thrown-20"],
  battleaxe: ["sweep"],
  "battle-axe": ["sweep"],
  greataxe: ["sweep"],
  "hand-axe": ["agile", "sweep", "thrown-10"],
  handaxe: ["agile", "sweep", "thrown-10"],
  hatchet: ["agile", "sweep", "thrown-10"],
  warhammer: ["shove"],
  "war-hammer": ["shove"],
  "light-hammer": ["agile", "thrown-20"],
  maul: ["shove"],
  club: ["thrown-10"],
  greatclub: ["backswing", "shove"],
  mace: ["shove"],
  morningstar: ["versatile-p"],
  flail: ["disarm", "sweep", "trip"],
  "war-flail": ["disarm", "sweep", "trip"],
  whip: ["disarm", "finesse", "nonlethal", "reach", "trip"],
  pick: ["fatal-d10"],
  warpick: ["fatal-d10"],
  "war-pick": ["fatal-d10"],
  staff: ["two-hand-d8"],
  quarterstaff: ["two-hand-d8"],
  longbow: ["deadly-d10", "propulsive", "volley-30"],
  "composite-longbow": ["deadly-d10", "propulsive", "volley-30"],
  shortbow: ["deadly-d10", "propulsive"],
  "composite-shortbow": ["deadly-d10", "propulsive"],
  crossbow: [],
  "hand-crossbow": ["agile"],
  sling: ["propulsive"],
  dart: ["agile", "thrown-20"],
  javelin: ["thrown-30"]
};
// Longest keys first so "composite-longbow" wins over "longbow", etc.
const WEAPON_BASE_KEYS = Object.keys(WEAPON_BASE_TRAITS).sort((a, b) => b.length - a.length);

/* Prefix set used to detect whether the model already supplied any weapon-specific
   (combat) trait, so we only infer when it gave none. */
const COMBAT_TRAIT_PREFIXES = [
  "agile", "finesse", "reach", "thrown", "versatile", "deadly", "fatal", "two-hand",
  "sweep", "forceful", "shove", "trip", "disarm", "parry", "propulsive", "volley",
  "backswing", "nonlethal", "grapple", "free-hand", "modular", "jousting", "brace",
  "razing", "concussive", "scatter", "kickback", "repeating", "capacity", "double-barrel",
  "fatal-aim", "tethered", "twin", "monk", "combination"
];
const isCombatTrait = slug =>
  COMBAT_TRAIT_PREFIXES.some(p => slug === p || slug.startsWith(p + "-"));

/** Match an item name to one of the supplied base-item keys (longest first). */
function matchBaseKey(name, keys) {
  const slug = normalizeSlug(name);
  if (!slug) return null;
  for (const key of keys) {
    const hit = key.includes("-")
      ? (slug === key || slug.startsWith(key + "-") || slug.includes("-" + key) || slug.endsWith(key))
      : slug.split("-").includes(key);
    if (hit) return key;
  }
  return null;
}

/** Infer canonical combat traits from a weapon's name (base-weapon lookup). */
function inferWeaponTraits(name) {
  const key = matchBaseKey(name, WEAPON_BASE_KEYS);
  return key ? WEAPON_BASE_TRAITS[key] : [];
}

/* Common base ARMORS, longest key first. Mapping a forged armor to a real base
   armor lets it inherit proper PF2e mechanics, just like weapons. */
const ARMOR_BASE_KEYS = [
  "explorers-clothing", "studded-leather", "chain-shirt", "chain-mail",
  "scale-mail", "splint-mail", "half-plate", "full-plate", "breastplate",
  "padded", "leather", "hide", "plate", "chainmail"
];
// Name token -> canonical PF2e base slug, only where they differ. Other names
// are tried as-is (and de-hyphenated) and kept only if the live CONFIG has them.
const BASE_ITEM_REMAP = {
  // weapons
  "hand-axe": "hatchet", handaxe: "hatchet",
  "war-pick": "pick", warpick: "pick",
  // armor
  plate: "full-plate", chainmail: "chain-mail"
};

/**
 * Resolve a real PF2e base-item slug for a weapon/armor, so it isn't a rootless
 * custom item (the GM asked that forged gear set a proper base unless truly
 * novel). The model's own baseItem wins when valid; otherwise we infer from the
 * item's NAME. Everything is checked against the live CONFIG pool, so we never
 * write an unknown base — a genuinely novel item simply keeps `null`.
 */
function resolveBaseItem(given, name, baseKeys, poolObj) {
  const pool = new Set(keysOf(poolObj));
  const g = normalizeSlug(given);
  if (g && (!pool.size || pool.has(g))) return g;
  const key = matchBaseKey(name, baseKeys);
  if (!key) return null;
  const candidates = [BASE_ITEM_REMAP[key], key, key.replace(/-/g, "")].filter(Boolean);
  if (!pool.size) return candidates[0]; // not under Foundry / config absent → trust the guess
  for (const c of candidates) if (pool.has(c)) return c;
  return null;
}
function validWeaponBaseItem(spec) {
  return resolveBaseItem(spec.baseItem, spec.name, WEAPON_BASE_KEYS, cfg().baseWeapons) ?? null;
}
function validArmorBaseItem(spec) {
  return resolveBaseItem(spec.baseItem, spec.name, ARMOR_BASE_KEYS, cfg().baseArmors) ?? null;
}

/**
 * Guarantee an item carries appropriate baseline traits.
 *  - A tradition or school trait strictly implies "magical", so add it when the
 *    model named one but forgot the umbrella trait — unless the item is alchemical
 *    (the non-magical counterpart). Treasure is never auto-tagged magical.
 *  - WEAPONS: if the model returned no weapon-specific combat trait, infer the
 *    canonical ones from the weapon's name so a forged weapon is never trait-less.
 */
function withInferredTraits(type, traits, name = "") {
  if (type === "treasure") return traits;
  const out = [...traits];
  const has = new Set(out);
  const magicEvident = out.some(t => TRADITION_TRAITS.has(t) || MAGIC_SCHOOL_TRAITS.has(t));
  if (magicEvident && !has.has("magical") && !has.has("alchemical")) {
    out.push("magical");
    has.add("magical");
  }
  if (type === "weapon" && !out.some(isCombatTrait)) {
    for (const t of inferWeaponTraits(name)) {
      if (!has.has(t)) { out.push(t); has.add(t); }
    }
  }
  return out;
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
