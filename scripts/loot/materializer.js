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
      await handOutToChat(work, proposal);
      created.push({ type: "chat", name: work.label });
    } else if (target === TARGET.DIRECT) {
      await directToSheets(work, recipient, created);
    } else {
      const actor = await makeLootActor(work, proposal);
      if (actor) created.push({ type: "loot-actor", name: actor.name, uuid: actor.uuid });
    }
  }

  await recordToLedger(proposal, recipient?.id ?? null);
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

async function makeLootActor(parcel, proposal) {
  let actor;
  try {
    actor = await Actor.create({
      name: parcel.label || proposal.label || "Loot",
      type: "loot",
      img: "icons/containers/chest/chest-worn-oak-tan.webp",
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
    const doc = await safeFromUuid(pick.uuid);
    if (!doc) continue;
    const data = doc.toObject();
    if (pick.qty && pick.qty > 1) foundry.utils.setProperty(data, "system.quantity", pick.qty);
    itemData.push(data);
  }
  if (itemData.length) {
    try { await actor.createEmbeddedDocuments("Item", itemData); }
    catch (err) { console.error(`${MODULE_ID} | failed to add items to loot actor`, err); }
  }

  // Coins.
  if (parcel.currencyGp > 0) await addCoins(actor, parcel.currencyGp);

  return actor;
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
    const doc = await safeFromUuid(pick.uuid);
    if (!doc) continue;
    const data = doc.toObject();
    if (pick.qty && pick.qty > 1) foundry.utils.setProperty(data, "system.quantity", pick.qty);
    let bucket = byActor.get(actor.id);
    if (!bucket) byActor.set(actor.id, (bucket = { actor, itemData: [] }));
    bucket.itemData.push(data);
  }

  for (const { actor, itemData } of byActor.values()) {
    try {
      await actor.createEmbeddedDocuments("Item", itemData);
      created.push({ type: "direct", name: `${itemData.length} item(s) → ${actor.name}` });
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
    return { type: "heirloom", name: `${pick.name} → ${item.name} (${actor.name})` };
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
  const lines = (parcel.items ?? []).map(p =>
    `<li>@UUID[${p.uuid}]{${p.name}} <span class="gllg-gp">${fmtGp(p.gp)} gp</span></li>`).join("");
  const coins = parcel.currencyGp > 0 ? `<p class="gllg-coins">+ ${fmtGp(parcel.currencyGp)} gp coins</p>` : "";
  const content = `<div class="gllg-handout">
    <h3>${escapeHtml(parcel.label || proposal.label || "Reward")}</h3>
    <ul>${lines}</ul>${coins}
    <p class="gllg-hint">Drag items onto a sheet to assign.</p>
  </div>`;
  try {
    await ChatMessage.create({ content, whisper: ChatMessage.getWhisperRecipients?.("GM") ?? [] });
  } catch (err) { console.error(`${MODULE_ID} | hand-out chat failed`, err); }
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
