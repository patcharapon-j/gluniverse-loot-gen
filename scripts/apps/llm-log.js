/**
 * LLM Log viewer — an ApplicationV2 window listing recent sidecar calls, opened
 * from the module-settings menu (Configure Settings → GLUniverse Loot Generator
 * → "View LLM Call Log"). Read-only apart from Refresh and Clear. GM-only via the
 * registered menu's `restricted: true`.
 */

import { getLlmLog, clearLlmLog } from "../loot/llm-log.js";

const ApplicationV2 = foundry.applications?.api?.ApplicationV2 ?? class {};

export class LlmLogViewer extends ApplicationV2 {
  /** ApplicationV2 binds action handlers with `this` = the app instance. */
  static async onRefresh() { await this.render(); }
  static async onClear() { clearLlmLog(); await this.render(); }

  static DEFAULT_OPTIONS = {
    id: "gllg-llm-log",
    classes: ["gllg", "gllg-llm-log"],
    window: { title: "GLLG.llmlog.title", icon: "fa-solid fa-list-timeline", resizable: true },
    position: { width: 680, height: 580 },
    actions: { refresh: LlmLogViewer.onRefresh, clear: LlmLogViewer.onClear }
  };

  async _renderHTML() { return renderLog(getLlmLog()); }
  _replaceHTML(result, content) { content.innerHTML = result; }
}

/* -------------------------------- rendering -------------------------------- */

function renderLog(entries) {
  const rows = entries.length
    ? entries.map(rowHtml).join("")
    : `<div class="gllg-empty">No LLM calls recorded yet. Generate loot with flavor on, or use the Loot Workshop.</div>`;
  return `<div class="gllg-llmlog-wrap">
    <div class="gllg-llmlog-bar">
      <span class="gllg-llmlog-count">${entries.length} call${entries.length === 1 ? "" : "s"} logged</span>
      <span class="gllg-llmlog-actions">
        <button type="button" data-action="refresh" class="gllg-llmlog-btn"><i class="fa-solid fa-rotate"></i> Refresh</button>
        <button type="button" data-action="clear" class="gllg-llmlog-btn"><i class="fa-solid fa-trash"></i> Clear</button>
      </span>
    </div>
    <div class="gllg-llmlog-list">${rows}</div>
  </div>`;
}

function rowHtml(e) {
  const ok = e.ok;
  const badge = ok
    ? `<span class="gllg-llmlog-ok"><i class="fa-solid fa-circle-check"></i> ok</span>`
    : `<span class="gllg-llmlog-fail"><i class="fa-solid fa-circle-exclamation"></i> fail</span>`;
  const status = e.status != null ? ` · HTTP ${esc(e.status)}` : "";
  const secs = (e.ms / 1000).toFixed(1);
  const line2 = e.error
    ? `<div class="gllg-llmlog-err">${esc(e.error)}</div>`
    : e.detail ? `<div class="gllg-llmlog-detail">${esc(e.detail)}</div>` : "";
  return `<div class="gllg-llmlog-row ${ok ? "is-ok" : "is-fail"}">
    <div class="gllg-llmlog-head">
      ${badge}
      <span class="gllg-llmlog-kind">${esc(e.endpoint || e.kind)}</span>
      <span class="gllg-llmlog-meta">${esc(fmtTime(e.ts))} · ${secs}s${status}</span>
    </div>
    ${line2}
  </div>`;
}

function fmtTime(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
