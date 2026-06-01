/**
 * LLM progress card — a lightweight, whispered chat message that signals the GM
 * that an LLM sidecar request is in flight (authoring/flavoring can take several
 * seconds). It is purely cosmetic feedback: posted before the call, deleted once
 * the work resolves (success or failure). Every path is wrapped so a charting
 * hiccup can never block the loot loop.
 */

import { MODULE_ID } from "../const.js";

/** Post a whispered "working…" card and return the ChatMessage (or null). */
export async function beginProgress({ title = "Working…", detail = "" } = {}) {
  try {
    return await ChatMessage.create({
      content: renderProgress(title, detail),
      whisper: ChatMessage.getWhisperRecipients?.("GM") ?? [],
      flags: { [MODULE_ID]: { progress: true } }
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | progress card failed to post`, err);
    return null;
  }
}

/** Remove a progress card once its work is done. Safe on null / already-deleted. */
export async function endProgress(message) {
  try { await message?.delete(); } catch { /* already gone — ignore */ }
}

function renderProgress(title, detail) {
  return `<div class="gllg-card gllg-progress" data-progress="1">
    <header class="gllg-card-head">
      <div class="gllg-card-title"><i class="fa-solid fa-wand-sparkles fa-beat-fade"></i> ${esc(title)}</div>
      ${detail ? `<div class="gllg-card-sub">${esc(detail)}</div>` : ""}
    </header>
    <div class="gllg-progress-body">
      <span class="gllg-spinner"><i class="fa-solid fa-circle-notch fa-spin"></i></span>
      <span class="gllg-progress-text">Contacting the LLM sidecar — this can take a few seconds…</span>
    </div>
  </div>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
