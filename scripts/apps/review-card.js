/**
 * Review card — the GM-gated preview between proposal and materialization
 * (DESIGN §6: propose → preview with reasoning → approve/swap/reroll → realize).
 *
 * The proposal rides in the chat message's module flag (plain-serializable), so
 * the controls keep working after a reload. All edits re-render the card by
 * updating the message content + flag. GM-only.
 */

import { MODULE_ID, TARGET } from "../const.js";
import { proposeLoot } from "../loot/cascade.js";
import { materialize } from "../loot/materializer.js";
import {
  getItemIndex, filterCandidates, weightFor, weightedPick
} from "../loot/item-selector.js";
import { decorateProposal, flavorEnabled } from "../loot/decorator.js";
import { resolveParty } from "../pf2e/actor-reader.js";
import { beginProgress, endProgress } from "./progress.js";

const TARGET_LABELS = {
  [TARGET.LOOT_ACTOR]: "Loot actor (chest)",
  [TARGET.CHAT_CARD]: "Chat hand-out",
  [TARGET.DIRECT]: "Direct to PC sheets"
};

const PERMANENT_TYPES = new Set(["weapon", "armor", "shield", "equipment"]);

/** Post a fresh review card for a proposal (whispered to the GM). */
export async function postReviewCard(proposal) {
  return ChatMessage.create({
    content: renderCard(proposal),
    whisper: ChatMessage.getWhisperRecipients?.("GM") ?? [],
    flags: { [MODULE_ID]: { proposal } }
  });
}

/** One delegated listener handles every card's buttons. Call once on ready. */
export function bindReviewCardActions() {
  document.addEventListener("click", onCardClick, true);
  document.addEventListener("change", onCardChange, true);
}

async function onCardClick(ev) {
  const btn = ev.target?.closest?.(".gllg-card button[data-action]");
  if (!btn) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (!game.user?.isGM) return ui.notifications?.warn("GLLG: only the GM can act on a loot proposal.");

  const msgId = btn.closest("[data-message-id]")?.dataset?.messageId;
  const message = msgId ? game.messages.get(msgId) : null;
  if (!message) return;
  const proposal = foundry.utils.duplicate(message.getFlag(MODULE_ID, "proposal") ?? null);
  if (!proposal) return ui.notifications?.warn("GLLG: this proposal has expired.");

  btn.disabled = true;
  try {
    switch (btn.dataset.action) {
      case "approve":   return await doApprove(message, proposal);
      case "reroll":    return await doReroll(message, proposal);
      case "reflavor":  return await doReflavor(message, proposal);
      case "cancel":    return await message.delete();
      case "remove":    return await doRemove(message, proposal, btn);
      case "swap":      return await doSwap(message, proposal, btn);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | review-card action failed`, err);
    ui.notifications?.error("GLLG: action failed (see console).");
  } finally {
    btn.disabled = false;
  }
}

/** Destination + recipient <select> changes — re-render with the new routing. */
async function onCardChange(ev) {
  const sel = ev.target?.closest?.(".gllg-card select[data-action]");
  if (!sel) return;
  if (!game.user?.isGM) return;

  const msgId = sel.closest("[data-message-id]")?.dataset?.messageId;
  const message = msgId ? game.messages.get(msgId) : null;
  if (!message) return;
  const proposal = foundry.utils.duplicate(message.getFlag(MODULE_ID, "proposal") ?? null);
  if (!proposal) return;

  if (sel.dataset.action === "set-target") {
    proposal.target = sel.value;
    for (const p of proposal.parcels) p.target = sel.value; // keep parcels in sync
  } else if (sel.dataset.action === "set-recipient") {
    proposal.directActorId = sel.value || null;
  } else {
    return;
  }
  await message.update({ content: renderCard(proposal), flags: { [MODULE_ID]: { proposal } } });
}

async function doApprove(message, proposal) {
  const res = await materialize(proposal);
  await message.update({
    content: renderDone(proposal, res),
    flags: { [MODULE_ID]: { proposal, materialized: true } }
  });
  if (res.ok) ui.notifications?.info(`GLLG: materialized ${res.created.length} container(s).`);
  else ui.notifications?.error(`GLLG: ${res.reason}`);
}

async function doReroll(message, proposal) {
  // Workshop proposals re-ask the LLM for fresh custom loot; everything else
  // re-runs the cascade against the same request.
  if (proposal.workshop) {
    const { rerunWorkshop } = await import("../loot/workshop.js");
    const progress = await beginProgress({ title: "Re-forging custom loot…", detail: "Loot Workshop" });
    let next;
    try { next = await rerunWorkshop(proposal); }
    finally { await endProgress(progress); }
    if (!next) return; // notified inside
    return message.update({ content: renderCard(next), flags: { [MODULE_ID]: { proposal: next } } });
  }
  const next = await proposeLoot(proposal.request);
  if (flavorEnabled()) {
    const progress = await beginProgress({ title: "Adding LLM flavor…", detail: next.label || "Loot proposal" });
    try { await decorateProposal(next); }   // re-flavor the fresh picks
    finally { await endProgress(progress); }
  } else {
    await decorateProposal(next); // no-op if disabled
  }
  await message.update({ content: renderCard(next), flags: { [MODULE_ID]: { proposal: next } } });
}

/** Re-request LLM flavor for the current picks without changing the loot. */
async function doReflavor(message, proposal) {
  if (!flavorEnabled()) return ui.notifications?.warn("GLLG: LLM flavor is disabled (see module settings).");
  const progress = await beginProgress({ title: "Re-flavoring…", detail: proposal.label || "Loot proposal" });
  try { await decorateProposal(proposal, { force: true }); }
  finally { await endProgress(progress); }
  await message.update({ content: renderCard(proposal), flags: { [MODULE_ID]: { proposal } } });
  ui.notifications?.info("GLLG: re-flavored the proposal.");
}

async function doRemove(message, proposal, btn) {
  const parcel = proposal.parcels.find(p => p.id === btn.dataset.parcelId);
  const idx = parcel?.items.findIndex(i => i.uuid === btn.dataset.uuid) ?? -1;
  if (parcel && idx >= 0) {
    const [removed] = parcel.items.splice(idx, 1);
    parcel.currencyGp = round2((parcel.currencyGp || 0) + removed.gp); // gp returns to coins
    recompute(parcel, proposal);
  }
  await message.update({ content: renderCard(proposal), flags: { [MODULE_ID]: { proposal } } });
}

async function doSwap(message, proposal, btn) {
  const parcel = proposal.parcels.find(p => p.id === btn.dataset.parcelId);
  const idx = parcel?.items.findIndex(i => i.uuid === btn.dataset.uuid) ?? -1;
  if (!parcel || idx < 0) return;
  const old = parcel.items[idx];
  const budget = old.gp + (parcel.currencyGp || 0);
  const repl = await rerollOnePick(proposal, old, budget);
  if (!repl) return ui.notifications?.warn("GLLG: no affordable replacement found.");
  parcel.items[idx] = repl;
  parcel.currencyGp = round2(budget - repl.gp);
  recompute(parcel, proposal);
  await message.update({ content: renderCard(proposal), flags: { [MODULE_ID]: { proposal } } });
}

/** Pick a fresh item of the same kind/level band within budget, avoiding dupes. */
async function rerollOnePick(proposal, old, budget) {
  const index = await getItemIndex();
  const used = new Set();
  for (const p of proposal.parcels) for (const it of p.items) used.add(it.uuid);
  used.delete(old.uuid);

  const level = proposal.level;
  const isCons = old.type === "consumable";
  const cands = filterCandidates(index, isCons
    ? { minLevel: Math.max(0, level - 3), maxLevel: Math.max(0, level - 1), maxGp: budget, types: new Set(["consumable"]), excludeUuids: used }
    : { minLevel: Math.max(0, level - 1), maxLevel: level + 2, maxGp: budget, types: PERMANENT_TYPES, excludeUuids: used });
  const tags = proposal.request?.tags;
  const item = weightedPick(cands, it => weightFor(it, { tags, preferLevel: isCons ? level - 2 : level + 1 }));
  if (!item) return null;
  return {
    uuid: item.uuid, name: item.name, img: item.img, type: item.type,
    level: item.level, gp: round2(item.gp), qty: 1, rarity: item.rarity,
    tier: old.tier, reason: "Swapped by GM",
    forActorId: old.forActorId ?? null, forActorName: old.forActorName ?? null
  };
}

/* -------------------------------- rendering -------------------------------- */

function renderCard(p) {
  const multi = p.parcels.length > 1;
  const parcels = p.parcels.map(parcel => renderParcel(parcel, multi)).join("");
  const reasons = (p.reasoning ?? []).map(r => `<li>${esc(r)}</li>`).join("");
  return `<div class="gllg-card" data-proposal-id="${esc(p.id)}">
    <header class="gllg-card-head">
      <div class="gllg-card-title"><i class="fa-solid fa-wand-sparkles"></i> ${esc(p.label || "Loot proposal")}</div>
      <div class="gllg-card-sub">${esc(p.context)} · Lv ${p.level} · ${p.itemCount} item(s) · ${gp(p.totalGp)} gp</div>
    </header>
    ${reasons ? `<details class="gllg-why" open><summary>Why these picks</summary><ul>${reasons}</ul></details>` : ""}
    <div class="gllg-parcels">${parcels}</div>
    ${renderRouting(p)}
    <footer class="gllg-card-actions">
      <button type="button" data-action="approve" class="gllg-btn gllg-go"><i class="fa-solid fa-check"></i> Approve</button>
      <button type="button" data-action="reroll" class="gllg-btn"><i class="fa-solid fa-dice"></i> Reroll all</button>
      ${flavorEnabled() && !p.workshop ? `<button type="button" data-action="reflavor" class="gllg-btn" title="Re-request LLM flavor"><i class="fa-solid fa-feather"></i> Reflavor</button>` : ""}
      <button type="button" data-action="cancel" class="gllg-btn gllg-ghost"><i class="fa-solid fa-xmark"></i> Cancel</button>
    </footer>
  </div>`;
}

/**
 * Destination picker: where the loot lands on approval. When sending direct to
 * sheets, a recipient picker chooses who gets any pick the cascade did not
 * already assign to a specific PC (fundamentals/drift carry their own target).
 */
function renderRouting(p) {
  const target = p.target ?? TARGET.LOOT_ACTOR;
  const opts = Object.entries(TARGET_LABELS).map(([v, label]) =>
    `<option value="${esc(v)}" ${v === target ? "selected" : ""}>${esc(label)}</option>`).join("");

  let recipient = "";
  if (target === TARGET.DIRECT) {
    const members = safeMembers();
    if (members.length) {
      const chosen = p.directActorId ?? members[0]?.id;
      const mo = members.map(m =>
        `<option value="${esc(m.id)}" ${m.id === chosen ? "selected" : ""}>${esc(m.name)}</option>`).join("");
      recipient = `<label class="gllg-route-lbl">Unassigned to</label>
        <select data-action="set-recipient" class="gllg-route-sel">${mo}</select>`;
    } else {
      recipient = `<span class="gllg-route-warn">No party PCs found</span>`;
    }
  }

  return `<div class="gllg-routing">
    <i class="fa-solid fa-location-arrow"></i>
    <label class="gllg-route-lbl">Send to</label>
    <select data-action="set-target" class="gllg-route-sel">${opts}</select>
    ${recipient}
  </div>`;
}

function safeMembers() {
  try { return resolveParty().members ?? []; } catch { return []; }
}

function renderParcel(parcel, showHead) {
  const rows = (parcel.items ?? []).map(it => renderItem(parcel, it)).join("");
  const coins = parcel.currencyGp > 0
    ? `<div class="gllg-coins-row"><i class="fa-solid fa-coins"></i> ${gp(parcel.currencyGp)} gp coins</div>` : "";
  const head = showHead
    ? `<div class="gllg-parcel-head">${esc(parcel.label || "")}<span class="gllg-parcel-tot">${gp(parcel.totalGp)} gp</span></div>` : "";
  return `<section class="gllg-parcel">
    ${head}
    <div class="gllg-items">${rows || '<div class="gllg-empty">No items</div>'}</div>
    ${coins}
  </section>`;
}

function renderItem(parcel, it) {
  const badge = `<span class="gllg-tier sev-${esc(it.tier)}">${esc(it.tier)}</span>`;
  const who = it.forActorName ? `<span class="gllg-for">→ ${esc(it.forActorName)}</span>` : "";
  const heir = it.heirloom
    ? `<div class="gllg-item-heir"><i class="fa-solid fa-wand-magic-sparkles"></i> awakens in ${esc(it.forItemName || "signature item")}</div>`
    : "";
  // Swapping a heirloom would replace it with an ordinary drop, and a custom
  // workshop item has no compendium equivalent to swap to — disallow both.
  const swap = (it.heirloom || it.custom) ? ""
    : `<button type="button" class="gllg-mini" data-action="swap" data-parcel-id="${esc(parcel.id)}" data-uuid="${esc(it.uuid)}" title="Swap for another"><i class="fa-solid fa-rotate"></i></button>`;
  return `<div class="gllg-item${it.heirloom ? " gllg-is-heir" : ""}">
    <img class="gllg-item-img" src="${esc(it.img || "icons/svg/item-bag.svg")}" alt="">
    <div class="gllg-item-main">
      <div class="gllg-item-name">${esc(it.name)} ${badge}${it.flavorName ? `<div class="gllg-flavorname">“${esc(it.flavorName)}”</div>` : ""}</div>
      <div class="gllg-item-meta">Lv ${it.level} · ${gp(it.gp)} gp ${who}</div>
      ${heir}
      ${it.reason ? `<div class="gllg-item-reason">${esc(it.reason)}</div>` : ""}
      ${it.flavor ? `<div class="gllg-item-flavor"><i class="fa-solid fa-quote-left"></i> ${esc(it.flavor)}</div>` : ""}
      ${it.provenance ? `<div class="gllg-item-prov">${esc(it.provenance)}</div>` : ""}
    </div>
    <div class="gllg-item-ctl">
      ${swap}
      <button type="button" class="gllg-mini" data-action="remove" data-parcel-id="${esc(parcel.id)}" data-uuid="${esc(it.uuid)}" title="Remove (gp → coins)"><i class="fa-solid fa-trash"></i></button>
    </div>
  </div>`;
}

function renderDone(p, res) {
  const list = (res.created ?? []).map(c =>
    `<li>${esc(c.name)} <span class="gllg-mini-tag">${esc(c.type)}</span></li>`).join("");
  return `<div class="gllg-card gllg-done" data-proposal-id="${esc(p.id)}">
    <header class="gllg-card-head">
      <div class="gllg-card-title"><i class="fa-solid fa-circle-check"></i> Loot materialized</div>
      <div class="gllg-card-sub">${esc(p.label || "")} · ${gp(p.totalGp)} gp recorded</div>
    </header>
    ${res.ok ? `<ul class="gllg-created">${list}</ul>` : `<p class="gllg-err">${esc(res.reason || "Failed")}</p>`}
  </div>`;
}

/* -------------------------------- helpers -------------------------------- */

function recompute(parcel, proposal) {
  parcel.totalGp = round2(parcel.items.reduce((s, x) => s + x.gp, 0) + (parcel.currencyGp || 0));
  proposal.itemCount = proposal.parcels.reduce((s, p) => s + p.items.length, 0);
  proposal.currencyGp = round2(proposal.parcels.reduce((s, p) => s + (p.currencyGp || 0), 0));
  proposal.totalGp = round2(proposal.parcels.reduce((s, p) => s + p.totalGp, 0));
}
function gp(n) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function round2(n) { return Math.round(n * 100) / 100; }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
