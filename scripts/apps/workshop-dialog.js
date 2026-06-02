/**
 * Loot Workshop dialog — the GM-facing surface of the `/grill-me` command. The
 * GM describes the loot they want in free text; the LLM sidecar authors bespoke
 * items, which arrive as a normal proposal on the review card. Deliberately thin
 * (mirrors generate-dialog): it only gathers inputs and hands off to runWorkshop.
 *
 * Creature-sourced mode (DESIGN §7, §13): if the GM has creature tokens selected,
 * the dialog reads them and offers to base the loot ON / FROM those creatures —
 * carried gear, keepsakes, or harvested monster parts — with the free-text prompt
 * demoted to optional extra steering. The selection is read live, so picking
 * different tokens while the dialog is open updates the creature list.
 */

import { runWorkshop, workshopEnabled } from "../loot/workshop.js";
import {
  readCreatureSources, topSourceLevel, totalSourceCount, sourcesLabel
} from "../loot/creature-sources.js";
import { postReviewCard } from "./review-card.js";
import { beginProgress, endProgress } from "./progress.js";

export async function openWorkshopDialog(presetPrompt = "") {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications?.error("GLLG: DialogV2 unavailable — use the console API instead.");
    return;
  }
  if (!workshopEnabled()) {
    ui.notifications?.warn("GLLG: the Loot Workshop needs the LLM sidecar — set the Flavor Sidecar URL in module settings.");
    return;
  }

  const sources = readCreatureSources();

  // Live-refresh the creature block whenever the canvas selection changes while
  // the dialog is open (debounced one frame so a multi-token marquee coalesces).
  let refreshTimer = null;
  const onControl = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const root = document.querySelector(".gllg-workshop .gllg-creatures");
      if (root) renderCreatureBlock(root, readCreatureSources());
    }, 30);
  };
  const onRender = (_app, el) => {
    const node = el instanceof HTMLElement ? el : el?.[0];
    if (!node?.querySelector?.(".gllg-creatures")) return; // not our dialog
    Hooks.off("renderDialogV2", onRender);
    wireCreatureMode(node);
  };
  Hooks.on("renderDialogV2", onRender);
  Hooks.on("controlToken", onControl);

  let result;
  try {
    result = await DialogV2.wait({
      window: { title: "Loot Workshop", icon: "fa-solid fa-hammer", resizable: true },
      position: { width: 480 },
      classes: ["gllg", "gllg-generate", "gllg-workshop"],
      content: buildForm(presetPrompt, sources),
      rejectClose: false,
      buttons: [
        {
          action: "go", label: "Forge", icon: "fa-solid fa-wand-sparkles", default: true,
          callback: (_ev, btn) => readForm(btn.form)
        },
        { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
      ]
    }).catch(() => null);
  } finally {
    Hooks.off("renderDialogV2", onRender);
    Hooks.off("controlToken", onControl);
    clearTimeout(refreshTimer);
  }

  if (!result || result === "cancel") return;
  if (!result.prompt && !result.useCreatures) {
    return ui.notifications?.warn("GLLG: describe the loot you want, or select creature tokens to base it on.");
  }

  const detail = result.useCreatures && result.sources?.length
    ? `Loot from ${sourcesLabel(result.sources)}` : "Loot Workshop";
  const progress = await beginProgress({ title: "Forging custom loot…", detail });
  let proposal;
  try {
    proposal = await runWorkshop(result);
  } finally {
    await endProgress(progress);
  }
  if (proposal) await postReviewCard(proposal);
}

/* -------------------------------- form -------------------------------- */

function buildForm(presetPrompt, sources) {
  const rarity = ["any", "common", "uncommon", "rare", "unique"]
    .map(v => `<option value="${v}">${capitalize(v)}</option>`).join("");
  const lootKind = [
    ["both", "Both (carried gear + harvested parts)"],
    ["carried", "Carried gear / keepsakes only"],
    ["harvested", "Harvested monster parts only"]
  ].map(([v, lbl]) => `<option value="${v}">${esc(lbl)}</option>`).join("");

  // Default count/level from the selection (Q4): count = #creatures (cap 8),
  // level = the toughest creature's level. Both stay GM-overridable.
  const count = sources.length ? Math.min(8, Math.max(1, totalSourceCount(sources))) : 1;
  const lvl = sources.length ? topSourceLevel(sources) : null;

  return `<div class="gllg-genform gllg-workshop-form">
    <div class="gllg-creatures">${creatureBlockInner(sources)}</div>
    <div class="gllg-field gllg-lootkind" data-creature-only style="${sources.length ? "" : "display:none"}">
      <label>Loot kind</label><select name="lootKind">${lootKind}</select>
    </div>
    <div class="gllg-field"><label>Describe the loot <span class="gllg-dim gllg-prompt-hint">${sources.length ? "(optional — extra steering on top of the creatures)" : ""}</span></label>
      <textarea name="prompt" rows="3" placeholder="e.g. a sinister relic for the cult's vault — something that whispers to whoever holds it">${esc(presetPrompt)}</textarea></div>
    <div class="gllg-row">
      <div class="gllg-field"><label>How many</label><input type="number" name="count" value="${count}" min="1" max="8"></div>
      <div class="gllg-field"><label>Item level <span class="gllg-dim">(blank = AI decides)</span></label><input type="number" name="level" min="0" max="25" value="${lvl ?? ""}" placeholder="AI decides"></div>
      <div class="gllg-field"><label>Rarity</label><select name="rarity">${rarity}</select></div>
    </div>
    <p class="gllg-dim">The LLM authors real PF2e items — correct item type, valid traits, a fair price for their level, and any dice/DCs encoded as clickable Foundry rolls (scaled to your variant rules, e.g. Proficiency Without Level). Each is validated against your PF2e build before it appears, and carries a GM-only icon prompt in its notes for quick art. With creatures selected, items are authored as loot found on or harvested from them — harvested parts include a clickable harvest check. You review, tweak the destination, reroll, or drop them like any other loot; your campaign context (module settings) is fed in automatically.</p>
  </div>`;
}

/** The toggle + chip list (or the "select creatures" hint). Re-rendered live. */
function creatureBlockInner(sources) {
  if (!sources.length) {
    return `<input type="checkbox" name="useCreatures" hidden>
      <p class="gllg-dim gllg-creature-empty"><i class="fa-solid fa-paw"></i> Select one or more creature tokens to base loot on them (found on / harvested from). Otherwise this forges loot from your description alone.</p>`;
  }
  const chips = sources.map(s => {
    const sub = [s.level >= 0 ? `Lv ${s.level}` : null, s.rarity !== "common" ? s.rarity : null]
      .filter(Boolean).join(" · ");
    const n = s.count > 1 ? ` ×${s.count}` : "";
    return `<span class="gllg-creature-chip" title="${attr(chipTitle(s))}">${esc(s.name)}${n}${sub ? ` <span class="gllg-dim">(${esc(sub)})</span>` : ""}</span>`;
  }).join("");
  return `<label class="gllg-check gllg-creature-toggle">
      <input type="checkbox" name="useCreatures" checked>
      <span>Base loot on selected creatures <span class="gllg-dim">(${totalSourceCount(sources)})</span></span>
    </label>
    <div class="gllg-creature-chips">${chips}</div>`;
}

function chipTitle(s) {
  const bits = [];
  if (s.traits?.length) bits.push(`Traits: ${s.traits.join(", ")}`);
  if (s.gear?.length) bits.push(`Carries: ${s.gear.join(", ")}`);
  if (s.lore) bits.push(s.lore);
  return bits.join("\n");
}

/** Replace the creature block in place (live selection change) + re-wire visibility. */
function renderCreatureBlock(container, sources) {
  container.innerHTML = creatureBlockInner(sources);
  const root = container.closest(".gllg-workshop-form") ?? container.parentElement;
  if (root) applyCreatureVisibility(root);
}

/* ----------------------- creature-mode visibility ----------------------- */

function wireCreatureMode(node) {
  const root = node.querySelector(".gllg-workshop-form") ?? node;
  root.addEventListener("change", ev => {
    if (ev.target?.name === "useCreatures") applyCreatureVisibility(root);
  });
  applyCreatureVisibility(root);
}

/** Show the loot-kind selector + the "optional" prompt hint only in creature mode. */
function applyCreatureVisibility(root) {
  const cb = root.querySelector('[name="useCreatures"]');
  const on = !!cb && !cb.hidden && cb.checked;
  for (const el of root.querySelectorAll("[data-creature-only]")) {
    el.style.display = on ? "" : "none";
  }
  const hint = root.querySelector(".gllg-prompt-hint");
  if (hint) hint.textContent = on ? "(optional — extra steering on top of the creatures)" : "";
}

function readForm(form) {
  const get = n => form?.elements?.[n]?.value ?? "";
  const cb = form?.elements?.["useCreatures"];
  const useCreatures = !!cb && !cb.hidden && cb.checked;
  // Re-read the live selection at submit so the sources match what's selected now.
  const sources = useCreatures ? readCreatureSources() : [];
  return {
    prompt: get("prompt").trim(),
    count: parseInt(get("count"), 10) || 1,
    level: get("level"),     // string — empty means party level / AI decides
    rarity: get("rarity") || "any",
    useCreatures: useCreatures && sources.length > 0,
    lootKind: get("lootKind") || "both",
    sources
  };
}

/* -------------------------------- helpers -------------------------------- */

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function attr(s) { return esc(s).replace(/`/g, "&#96;").replace(/\n/g, "&#10;"); }
