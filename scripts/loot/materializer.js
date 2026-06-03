/**
 * Materializer — turns an approved proposal into real Foundry data and
 * decrements the single WealthLedger (DESIGN §10). It writes valid PF2e item
 * documents (hydrated from real compendium UUIDs) so sheets/auditor keep
 * reading correctly — no fake items.
 *
 * Sinks (build #4): a Loot actor per non-empty parcel, a chat hand-out card, or
 * direct-to-sheet — each pick lands on its target PC (the cascade tags
 * fundamentals/drift picks with forActorId) or on a GM-chosen recipient, with
 * coins following the recipient. Heirloom awakening is build #5.
 */

import { MODULE_ID, TARGET, PARTY_LEDGER_KEY } from "../const.js";
import { WealthLedger } from "../auditor/ledger.js";
import { resolveParty } from "../pf2e/actor-reader.js";
import { iconNoteHtml } from "./icon-note.js";

/**
 * Realize a proposal. Returns { ok, created:[{type, name, uuid?}], reason? }.
 * GM-only (creates actors / writes the ledger).
 */
export async function materialize(proposal) {
  if (!game.user?.isGM) return { ok: false, reason: "Only a GM can materialize loot." };
  if (!proposal?.parcels?.length) return { ok: false, reason: "Nothing to materialize." };

  // Resolve the fallback recipient once (used by direct-to-sheet for any pick
  // the cascade did not already tag with a forActorId, and for direct coins).
  const recipient = resolveRecipient(proposal);

  const created = [];
  for (const parcel of proposal.parcels) {
    // Heirloom picks awaken in place on a PC's signature item regardless of the
    // parcel's sink — they can never live in a chest (DESIGN §9).
    const items = parcel.items ?? [];
    const heirlooms = items.filter(p => p.heirloom);
    const normal = items.filter(p => !p.heirloom);
    for (const h of heirlooms) {
      const res = await awaken(h);
      if (res) created.push(res);
    }

    // The rest follow the parcel's target. Skip the sink if nothing remains.
    if (!normal.length && !(parcel.currencyGp > 0)) continue;
    const work = { ...parcel, items: normal };
    const target = work.target ?? proposal.target ?? TARGET.LOOT_ACTOR;
    if (target === TARGET.CHAT_CARD) {
      const msg = await handOutToChat(work, proposal);
      created.push({ type: "chat", name: work.label, uuid: msg?.uuid });
    } else if (target === TARGET.DIRECT) {
      await directToSheets(work, recipient, created);
    } else if (target === TARGET.MERCHANT) {
      const actor = await makeMerchantActor(work, proposal);
      if (actor) created.push({ type: "merchant", name: actor.name, uuid: actor.uuid });
    } else {
      const actor = await makeLootActor(work, proposal);
      if (actor) created.push({ type: "loot-actor", name: actor.name, uuid: actor.uuid });
    }
  }

  // Shops are budget-neutral (DESIGN §18): the party spends their own coin, so
  // stocking one never touches the wealth ledger. Everything else records.
  if (!proposal.shop) await recordToLedger(proposal, recipient?.id ?? null);
  return { ok: true, created };
}

/** The PC who receives direct/untagged loot: explicit pick, else first PC. */
function resolveRecipient(proposal) {
  const id = proposal.directActorId;
  let actor = id ? game.actors?.get(id) : null;
  if (!actor) actor = resolveParty().members[0] ?? null;
  return actor;
}

/* ------------------------------ loot actor ------------------------------ */

const LOOT_FOLDER_NAME = "Loot Gen";
const SHOP_FOLDER_NAME = "Shops";

/** Get (or lazily create) a named Actor folder so generated actors don't litter root. */
async function getActorFolder(name, color = "#7a5cff") {
  try {
    const existing = game.folders?.find(f => f.type === "Actor" && f.name === name);
    if (existing) return existing;
    return await Folder.create({ name, type: "Actor", color });
  } catch (err) {
    console.warn(`${MODULE_ID} | could not get/create the "${name}" folder; placing at root`, err);
    return null;
  }
}

async function makeLootActor(parcel, proposal) {
  let actor;
  try {
    const folder = await getActorFolder(LOOT_FOLDER_NAME);
    actor = await Actor.create({
      name: parcel.label || proposal.label || "Loot",
      type: "loot",
      img: "icons/containers/chest/chest-worn-oak-tan.webp",
      folder: folder?.id ?? null,
      flags: { [MODULE_ID]: { proposalId: proposal.id, context: proposal.context } }
    });
  } catch (err) {
    console.error(`${MODULE_ID} | failed to create loot actor`, err);
    ui.notifications?.error("GLLG: could not create the loot actor (see console).");
    return null;
  }

  // Hydrate each pick's real item document and embed it.
  const itemData = [];
  for (const pick of parcel.items ?? []) {
    const data = await hydratePick(pick);
    if (data) itemData.push(data);
  }
  if (itemData.length) {
    try { await actor.createEmbeddedDocuments("Item", itemData); }
    catch (err) { console.error(`${MODULE_ID} | failed to add items to loot actor`, err); }
  }

  // Coins.
  if (parcel.currencyGp > 0) await addCoins(actor, parcel.currencyGp);

  return actor;
}

/* ------------------------------ merchant (shop) ------------------------------ */

/**
 * Materialize a shop parcel as a buyable PF2e Merchant actor (DESIGN §18): a
 * Loot actor with `system.lootSheetType = "Merchant"`, default-Observer so the
 * party can browse and purchase (and sell back at the PF2e 50%). Stock is the
 * same hydrated, real-UUID item data as any other sink — no fake items. The
 * shopkeeper persona (when the LLM authored one) becomes the actor's bio. No
 * coins and no ledger write — a shop is budget-neutral.
 */
async function makeMerchantActor(parcel, proposal) {
  const keeper = proposal.shop?.keeper ?? null;
  const name = keeper?.shop || parcel.label || proposal.label || "Shop";

  // Created GM-only by default (Foundry's default ownership) so an upcoming shop
  // isn't spoiled the instant it's stocked. The GM grants players access — or
  // just shows the sheet — when the party actually arrives to browse and buy.
  let actor;
  try {
    const folder = await getActorFolder(SHOP_FOLDER_NAME, "#caa24a");
    actor = await Actor.create({
      name,
      type: "loot",
      img: "icons/svg/coins.svg",
      system: { lootSheetType: "Merchant" },
      folder: folder?.id ?? null,
      flags: { [MODULE_ID]: { proposalId: proposal.id, context: proposal.context, shop: true, keeper } }
    });
  } catch (err) {
    console.error(`${MODULE_ID} | failed to create merchant actor`, err);
    ui.notifications?.error("GLLG: could not create the shop actor (see console).");
    return null;
  }

  if (keeper) await applyKeeperBio(actor, keeper);

  const itemData = [];
  for (const pick of parcel.items ?? []) {
    const data = await hydratePick(pick);
    if (data) itemData.push(data);
  }
  if (itemData.length) {
    try { await actor.createEmbeddedDocuments("Item", itemData); }
    catch (err) { console.error(`${MODULE_ID} | failed to stock the shop`, err); }
  }
  return actor;
}

/** Write the shopkeeper persona into the merchant's description (best-effort). */
async function applyKeeperBio(actor, keeper) {
  const lines = [];
  if (keeper.name || keeper.shop) {
    const who = [keeper.name, keeper.shop ? `— ${keeper.shop}` : ""].filter(Boolean).join(" ");
    lines.push(`<p><strong>${escapeHtml(who)}</strong></p>`);
  }
  if (keeper.greeting) lines.push(`<p><em>“${escapeHtml(keeper.greeting)}”</em></p>`);
  if (keeper.bio) lines.push(`<p>${escapeHtml(keeper.bio)}</p>`);
  if (!lines.length) return;
  const html = lines.join("");

  // The PF2e loot actor's description has shifted between a bare string and a
  // { value } object across versions — match whatever shape the live actor has.
  const cur = actor.system?.details?.description;
  const path = (cur && typeof cur === "object") ? "system.details.description.value" : "system.details.description";
  try { await actor.update({ [path]: html }); }
  catch (err) { console.warn(`${MODULE_ID} | could not write shopkeeper bio`, err); }
}

/** Add gp to an actor, tolerating PF2e API differences across versions. */
async function addCoins(actor, gp) {
  const whole = Math.max(0, Math.round(gp));
  if (!whole) return;
  try {
    if (typeof actor.inventory?.addCoins === "function") {
      await actor.inventory.addCoins({ gp: whole });
      return;
    }
  } catch (err) { console.warn(`${MODULE_ID} | addCoins failed, leaving coins note`, err); }
  // Fallback: stash the intended amount in a flag so the GM can add it manually.
  try { await actor.setFlag(MODULE_ID, "pendingCoinsGp", whole); } catch { /* ignore */ }
}

/* ------------------------------ direct to sheet ------------------------------ */

/**
 * Place each pick straight onto a PC sheet: its own forActorId (fundamentals /
 * drift picks are already PC-targeted), else the GM-chosen recipient. Items are
 * batched per actor so each PC takes one write; coins follow the recipient.
 */
async function directToSheets(parcel, recipient, created) {
  const byActor = new Map(); // actorId → { actor, itemData[] }
  for (const pick of parcel.items ?? []) {
    const actor = (pick.forActorId ? game.actors?.get(pick.forActorId) : null) ?? recipient;
    if (!actor) { console.warn(`${MODULE_ID} | no recipient for ${pick.name}; skipped`); continue; }
    const data = await hydratePick(pick);
    if (!data) continue;
    let bucket = byActor.get(actor.id);
    if (!bucket) byActor.set(actor.id, (bucket = { actor, itemData: [] }));
    bucket.itemData.push(data);
  }

  for (const { actor, itemData } of byActor.values()) {
    try {
      await actor.createEmbeddedDocuments("Item", itemData);
      created.push({ type: "direct", name: `${itemData.length} item(s) → ${actor.name}`, uuid: actor.uuid });
    } catch (err) {
      console.error(`${MODULE_ID} | failed to grant items to ${actor.name}`, err);
    }
  }

  if (parcel.currencyGp > 0 && recipient) {
    await addCoins(recipient, parcel.currencyGp);
    created.push({ type: "coins", name: `${fmtGp(parcel.currencyGp)} gp → ${recipient.name}` });
  }
}

/* ------------------------------ heirloom awakening ------------------------------ */

const STRIKING_LEGACY = { 1: "striking", 2: "greaterStriking", 3: "majorStriking" };
const RESILIENT_LEGACY = { 1: "resilient", 2: "greaterResilient", 3: "majorResilient" };

/**
 * Raise a fundamental rune in place on a PC's signature item (DESIGN §9). The gp
 * was already booked as a normal rune-transfer cost (RAW), so only the sheet
 * edit happens here — never a new item. Returns a created-row or null.
 */
async function awaken(pick) {
  const actor = pick.forActorId ? game.actors?.get(pick.forActorId) : null;
  const item = actor && pick.forItemId ? actor.items?.get(pick.forItemId) : null;
  if (!actor || !item) {
    console.warn(`${MODULE_ID} | heirloom target missing for ${pick.name}; skipped`);
    return null;
  }
  const update = buildRuneUpdate(item, pick.axis, pick.targetTier);
  if (!update) return null;
  try {
    await item.update(update);
    return { type: "heirloom", name: `${pick.name} → ${item.name} (${actor.name})`, uuid: item.uuid };
  } catch (err) {
    console.error(`${MODULE_ID} | failed to awaken ${pick.name} in ${item.name}`, err);
    return null;
  }
}

/**
 * Build the in-place rune update for an axis, raising (never lowering) the tier.
 * Prefers the modern numeric `system.runes.*` model, falling back to the legacy
 * `system.{potency,striking,resiliency}Rune.value` strings for older systems.
 */
function buildRuneUpdate(item, axis, tier) {
  const t = Math.max(0, Math.trunc(Number(tier) || 0));
  if (!t) return null;
  const runes = item?.system?.runes;
  const modern = runes && typeof runes === "object";

  switch (axis) {
    case "attack":   // weapon potency
    case "defense":  // armor potency (same field name)
      return modern
        ? { "system.runes.potency": Math.max(Number(runes.potency) || 0, t) }
        : { "system.potencyRune.value": Math.max(Number(item?.system?.potencyRune?.value) || 0, t) };
    case "striking":
      return modern
        ? { "system.runes.striking": Math.max(Number(runes.striking) || 0, t) }
        : { "system.strikingRune.value": STRIKING_LEGACY[t] ?? "striking" };
    case "resilient":
      return modern
        ? { "system.runes.resilient": Math.max(Number(runes.resilient) || 0, t) }
        : { "system.resiliencyRune.value": RESILIENT_LEGACY[t] ?? "resilient" };
    default:
      return null;
  }
}

/* ------------------------------ chat hand-out ------------------------------ */

async function handOutToChat(parcel, proposal) {
  const lines = (parcel.items ?? []).map(p => {
    // Custom workshop items have no compendium UUID to @UUID-link to.
    const label = p.custom ? escapeHtml(p.name) : `@UUID[${p.uuid}]{${p.name}}`;
    return `<li>${label} <span class="gllg-gp">${fmtGp(p.gp)} gp</span></li>`;
  }).join("");
  const coins = parcel.currencyGp > 0 ? `<p class="gllg-coins">+ ${fmtGp(parcel.currencyGp)} gp coins</p>` : "";
  const shop = !!proposal.shop;
  const keeper = shop ? proposal.shop?.keeper : null;
  const header = keeper?.shop || parcel.label || proposal.label || (shop ? "Catalog" : "Reward");
  const greeting = keeper?.greeting ? `<p class="gllg-hint"><em>“${escapeHtml(keeper.greeting)}”</em></p>` : "";
  const hint = shop ? "Prices as listed — buy at list, sell at half." : "Drag items onto a sheet to assign.";
  const content = `<div class="gllg-handout">
    <h3>${escapeHtml(header)}</h3>${greeting}
    <ul>${lines}</ul>${coins}
    <p class="gllg-hint">${hint}</p>
  </div>`;
  try {
    return await ChatMessage.create({ content, whisper: ChatMessage.getWhisperRecipients?.("GM") ?? [] });
  } catch (err) { console.error(`${MODULE_ID} | hand-out chat failed`, err); return null; }
}

/* ------------------------------ ledger ------------------------------ */

/**
 * Record every materialized pick + currency to the WealthLedger, booking against
 * wherever it actually landed: a pick's own forActorId (fundamentals / drift)
 * first, then — for direct-to-sheet — the recipient PC, otherwise the shared
 * party bucket. This keeps wealth-drift accounting truthful (DESIGN §5).
 */
async function recordToLedger(proposal, recipientId) {
  for (const parcel of proposal.parcels) {
    const target = parcel.target ?? proposal.target ?? TARGET.LOOT_ACTOR;
    const fallbackId = target === TARGET.DIRECT && recipientId ? recipientId : PARTY_LEDGER_KEY;
    for (const pick of parcel.items ?? []) {
      await WealthLedger.record(pick.forActorId ?? fallbackId, {
        gp: pick.gp,
        label: pick.name,
        level: pick.level,
        source: proposal.context,
        kind: pick.type === "consumable" ? "consumable" : "permanent"
      });
    }
    if (parcel.currencyGp > 0) {
      await WealthLedger.record(fallbackId, {
        gp: parcel.currencyGp,
        label: "Coins",
        level: proposal.level,
        source: proposal.context,
        kind: "currency"
      });
    }
  }
}

/* ------------------------------ hydration ------------------------------ */

/**
 * Turn a proposal pick into ready-to-create item data. Two sources:
 *   - a real compendium UUID (the normal cascade path) → hydrate the document
 *     and fold the LLM flavor onto its name + description (DESIGN §14);
 *   - a bespoke `itemData` authored by the LLM workshop (`pick.custom`) → used
 *     as-is (it already carries its own flavor and name).
 * Returns null when the source item can't be resolved.
 */
async function hydratePick(pick) {
  let data;
  if (pick?.custom && pick.itemData) {
    data = foundry.utils.duplicate(pick.itemData);
  } else {
    const doc = await safeFromUuid(pick?.uuid);
    if (!doc) return null;
    data = doc.toObject();
    applyRunes(data, pick);     // etch the cascade's rune set onto a base weapon/armor
    applyFlavor(data, pick);    // compendium-backed picks get their flavor folded in
    applyIconNote(data, pick);  // …and a GM-only icon-generation prompt
  }
  if (pick.qty && pick.qty > 1) foundry.utils.setProperty(data, "system.quantity", pick.qty);
  return data;
}

/**
 * Append a GM-only icon-generation prompt to a hydrated compendium item's GM
 * notes (system.description.gm), so the GM has a ready prompt to mint fitting
 * art. Uses any LLM-authored hint (pick.iconHint) else synthesizes from the
 * item's own facts. Never disturbs the player-facing description or rules.
 */
function applyIconNote(data, pick) {
  const note = iconNoteHtml({
    name: data.name,
    type: data.type,
    rarity: foundry.utils.getProperty(data, "system.traits.rarity") ?? pick?.rarity,
    traits: foundry.utils.getProperty(data, "system.traits.value") ?? [],
    flavor: pick?.flavor ?? "",
    hint: pick?.iconHint ?? ""
  });
  if (!note) return data;
  const existing = foundry.utils.getProperty(data, "system.description.gm") ?? "";
  foundry.utils.setProperty(data, "system.description.gm", existing ? `${existing}${note}` : note);
  return data;
}

/**
 * Etch a cascade-built rune set (pick.runes) onto a hydrated base weapon/armor,
 * in place (DESIGN §9). Writes the modern numeric `system.runes` shape, falling
 * back to the legacy discrete rune fields for older PF2e builds. The PF2e system
 * derives the runed price and level from these, so we never touch price here —
 * the proposal already booked base + rune gp to the ledger. Never lowers an
 * existing rune (mundane bases start at 0, so this just sets them).
 */
function applyRunes(data, pick) {
  const r = pick?.runes;
  if (!r || (data.type !== "weapon" && data.type !== "armor")) return data;
  const isArmor = data.type === "armor";
  const property = (Array.isArray(r.property) ? r.property : []).filter(Boolean).slice(0, 4);
  const modern = data.system?.runes && typeof data.system.runes === "object";

  if (modern) {
    const runes = { ...data.system.runes };
    runes.potency = Math.max(Number(runes.potency) || 0, Number(r.potency) || 0);
    if (isArmor) runes.resilient = Math.max(Number(runes.resilient) || 0, Number(r.resilient) || 0);
    else runes.striking = Math.max(Number(runes.striking) || 0, Number(r.striking) || 0);
    runes.property = property;
    foundry.utils.setProperty(data, "system.runes", runes);
  } else {
    foundry.utils.setProperty(data, "system.potencyRune.value", Number(r.potency) || 0);
    if (isArmor) foundry.utils.setProperty(data, "system.resiliencyRune.value", RESILIENT_LEGACY[r.resilient] ?? null);
    else foundry.utils.setProperty(data, "system.strikingRune.value", STRIKING_LEGACY[r.striking] ?? null);
    property.forEach((slug, i) => foundry.utils.setProperty(data, `system.propertyRune${i + 1}.value`, slug));
  }
  return data;
}

/**
 * Fold a pick's LLM flavor/provenance onto a hydrated compendium item, in place.
 * The flavor + provenance are prepended to the item's description (the original
 * rules-text is kept intact below a divider), and a reskinned display name —
 * when the model offered one — replaces the item name with a note of the
 * original name preserved in the description for reference. Purely cosmetic:
 * price, level, rarity, and rules are never touched.
 */
function applyFlavor(data, pick) {
  const flavor = pick?.flavor ? String(pick.flavor).trim() : "";
  const prov = pick?.provenance ? String(pick.provenance).trim() : "";
  const newName = pick?.flavorName ? String(pick.flavorName).trim() : "";
  if (!flavor && !prov && !newName) return data;

  const originalName = data.name;
  const renamed = newName && newName !== originalName;
  if (renamed) data.name = newName;

  const blocks = [];
  if (flavor) blocks.push(`<p><em>${escapeHtml(flavor)}</em></p>`);
  if (prov) blocks.push(`<p><strong>Provenance:</strong> ${escapeHtml(prov)}</p>`);
  // Always leave a breadcrumb back to the original item (esp. when renamed).
  blocks.push(`<p><em>${renamed ? `Reskinned from “${escapeHtml(originalName)}”.` : `Original item: ${escapeHtml(originalName)}.`}</em></p>`);

  const header = `<div class="gllg-flavor-block">${blocks.join("")}</div><hr />`;
  const existing = foundry.utils.getProperty(data, "system.description.value") ?? "";
  foundry.utils.setProperty(data, "system.description.value", header + existing);
  return data;
}

/* ------------------------------ utilities ------------------------------ */

async function safeFromUuid(uuid) {
  try { return await fromUuid(uuid); } catch { return null; }
}
function fmtGp(n) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
