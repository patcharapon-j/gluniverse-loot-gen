/**
 * Loot Workshop dialog — the GM-facing surface of the `/grill-me` command. The
 * GM describes the loot they want in free text; the LLM sidecar authors bespoke
 * items, which arrive as a normal proposal on the review card. Deliberately thin
 * (mirrors generate-dialog): it only gathers inputs and hands off to runWorkshop.
 */

import { runWorkshop, workshopEnabled } from "../loot/workshop.js";
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

  const result = await DialogV2.wait({
    window: { title: "Loot Workshop", icon: "fa-solid fa-hammer", resizable: true },
    position: { width: 480 },
    classes: ["gllg", "gllg-generate", "gllg-workshop"],
    content: buildForm(presetPrompt),
    rejectClose: false,
    buttons: [
      {
        action: "go", label: "Forge", icon: "fa-solid fa-wand-sparkles", default: true,
        callback: (_ev, btn) => readForm(btn.form)
      },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
    ]
  }).catch(() => null);

  if (!result || result === "cancel") return;
  if (!result.prompt) return ui.notifications?.warn("GLLG: describe the loot you want first.");

  const progress = await beginProgress({ title: "Forging custom loot…", detail: "Loot Workshop" });
  let proposal;
  try {
    proposal = await runWorkshop(result);
  } finally {
    await endProgress(progress);
  }
  if (proposal) await postReviewCard(proposal);
}

/* -------------------------------- form -------------------------------- */

function buildForm(presetPrompt) {
  const rarity = ["any", "common", "uncommon", "rare", "unique"]
    .map(v => `<option value="${v}">${capitalize(v)}</option>`).join("");
  return `<div class="gllg-genform">
    <div class="gllg-field"><label>Describe the loot</label>
      <textarea name="prompt" rows="4" placeholder="e.g. a sinister relic for the cult's vault — something that whispers to whoever holds it">${esc(presetPrompt)}</textarea></div>
    <div class="gllg-row">
      <div class="gllg-field"><label>How many</label><input type="number" name="count" value="1" min="1" max="8"></div>
      <div class="gllg-field"><label>Item level <span class="gllg-dim">(blank = AI decides)</span></label><input type="number" name="level" min="0" max="25" placeholder="AI decides"></div>
      <div class="gllg-field"><label>Rarity</label><select name="rarity">${rarity}</select></div>
    </div>
    <p class="gllg-dim">The LLM authors real PF2e items — correct item type, valid traits, a fair price for their level, and any dice/DCs encoded as clickable Foundry rolls (scaled to your variant rules, e.g. Proficiency Without Level). Each is validated against your PF2e build before it appears, and carries a GM-only icon prompt in its notes for quick art. Leave <em>Item level</em> blank to let the AI choose a level that fits each item from your prompt and the party. You review, tweak the destination, reroll, or drop them like any other loot; your campaign context (module settings) is fed in automatically.</p>
  </div>`;
}

function readForm(form) {
  const get = n => form?.elements?.[n]?.value ?? "";
  return {
    prompt: get("prompt").trim(),
    count: parseInt(get("count"), 10) || 1,
    level: get("level"),     // string — empty means party level
    rarity: get("rarity") || "any"
  };
}

/* -------------------------------- helpers -------------------------------- */

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
