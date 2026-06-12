/**
 * AuditorDashboard — the gear health-check window.
 *
 * Build #1 / the keystone (DESIGN.md §4): a read-only dashboard that audits the
 * party's live sheets against the ABP curve and the wealth curve. Ships standalone
 * value before any generation exists. Full re-render on demand / on actor edits —
 * it's a low-frequency readout, so the imperative-DOM dance the HUDs use isn't
 * needed; CSS transitions carry the polish.
 */

import { MODULE_ID, SETTINGS, HOOKS, SEVERITY } from "../const.js";
import { buildReport } from "../auditor/health-check.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const SEVERITY_META = {
  [SEVERITY.CRITICAL]: { cls: "sev-critical", icon: "fa-triangle-exclamation", order: 0 },
  [SEVERITY.BEHIND]:   { cls: "sev-behind",   icon: "fa-arrow-trend-down",     order: 1 },
  [SEVERITY.ON_TRACK]: { cls: "sev-ontrack",  icon: "fa-check",                order: 2 },
  [SEVERITY.AHEAD]:    { cls: "sev-ahead",     icon: "fa-arrow-trend-up",       order: 3 }
};

export class AuditorDashboard extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;

  static async open() {
    if (!this.instance) this.instance = new this();
    await this.instance.render(true);
    return this.instance;
  }

  static toggle() {
    if (this.instance?.rendered) return this.instance.close();
    return this.open();
  }

  /** Re-audit and repaint (debounced — actor edits arrive in bursts). */
  static refresh() {
    if (!this.instance?.rendered) return;
    this._deb ??= foundry.utils.debounce(() => this.instance?.render(), 150);
    this._deb();
  }

  static DEFAULT_OPTIONS = {
    id: "gllg-auditor",
    classes: ["gllg", "gllg-auditor"],
    tag: "div",
    window: {
      title: "GLLG.audit.title",
      icon: "fa-solid fa-gem",
      resizable: true,
      minimizable: true
    },
    position: { width: 480, height: "auto" },
    actions: {
      refresh: AuditorDashboard.prototype._onRefresh,
      settings: AuditorDashboard.prototype._onOpenSettings,
      focusActor: AuditorDashboard.prototype._onFocusActor
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/auditor.hbs` }
  };

  async _prepareContext(options) {
    const ctx = await super._prepareContext(options);
    const tolerancePct = safeSetting(SETTINGS.driftTolerancePct, 25);
    const abp = safeSetting(SETTINGS.variantABP, false);
    const report = buildReport({ tolerancePct });

    Hooks.callAll(HOOKS.auditChanged, report);

    if (!report.ok) {
      return Object.assign(ctx, {
        ok: false,
        isGM: game.user?.isGM ?? false,
        reason: game.i18n.localize(report.reason || "GLLG.audit.noParty")
      });
    }

    return Object.assign(ctx, {
      ok: true,
      isGM: game.user?.isGM ?? false,
      abp,
      party: this._viewParty(report.party),
      members: report.members.map(m => this._viewMember(m))
    });
  }

  _viewParty(p) {
    return {
      name: p.name,
      size: p.size,
      avgLevel: p.avgLevel,
      counts: p.counts,
      hasIssues: (p.counts.critical + p.counts.behind) > 0,
      // Etched-glass registration serial — a quiet technical designator (§4.2).
      serial: `GLU·AUDIT // ${p.size}P · L${p.avgLevel}`,
      wealth: this._viewWealth(p.wealth)
    };
  }

  _viewMember(m) {
    const meta = SEVERITY_META[m.worst] ?? SEVERITY_META[SEVERITY.ON_TRACK];
    return {
      id: m.id,
      name: m.name,
      img: m.img,
      level: m.level,
      statusCls: meta.cls,
      statusIcon: meta.icon,
      // core axes first (math-critical), then soft; within that, worst first
      chips: m.fundamentals
        .map(f => this._viewChip(f))
        .sort((a, b) => (a.soft - b.soft) || (a.order - b.order)),
      missing: m.missing,
      wealth: this._viewWealth(m.wealth)
    };
  }

  _viewChip(f) {
    const meta = SEVERITY_META[f.severity] ?? SEVERITY_META[SEVERITY.ON_TRACK];
    const showTier = f.expectedTier > 0 || f.actualTier > 0;
    return {
      name: f.name,
      soft: f.soft ? 1 : 0,
      severity: f.severity,
      cls: meta.cls,
      icon: meta.icon,
      order: meta.order,
      // e.g. "+1 / +2" (have / need) when behind; just the value when on track
      value: showTier
        ? (f.actualLabel === f.expectedLabel ? f.actualLabel : `${f.actualLabel} → ${f.expectedLabel}`)
        : "—",
      tip: f.summary
    };
  }

  _viewWealth(w) {
    const meta = SEVERITY_META[w.severity] ?? SEVERITY_META[SEVERITY.ON_TRACK];
    // Bar: actual as a fraction of expected, capped at 100% with overflow flagged.
    const ratio = w.expected > 0 ? w.net / w.expected : 1;
    const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    return {
      net: fmtGp(w.net),
      expected: fmtGp(w.expected),
      recorded: w.recorded != null ? fmtGp(w.recorded) : null,
      deltaPct: w.deltaPct,
      deltaSign: w.deltaPct > 0 ? "+" : "",
      cls: meta.cls,
      pct,
      over: ratio > 1.0
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._applyPosition();
    // Stagger member cards in for a tactile entrance.
    const cards = this.element.querySelectorAll(".gllg-member");
    cards.forEach((c, i) => c.style.setProperty("--i", String(i)));
  }

  /* ------------------------------ actions ------------------------------ */

  _onRefresh() { this.render(); }

  _onOpenSettings() {
    game.settings.sheet.render(true);
    // Jump to this module's section if the API supports it.
    try { game.settings.sheet.activateTab?.("gluniverse-loot-gen"); } catch { /* ignore */ }
  }

  _onFocusActor(event, target) {
    const id = target?.dataset?.actorId;
    const actor = id && game.actors?.get(id);
    actor?.sheet?.render(true);
  }

  /* ------------------------------ position ------------------------------ */

  _applyPosition() {
    let pos = {};
    try { pos = game.settings.get(MODULE_ID, SETTINGS.auditorPosition) ?? {}; } catch { /* ignore */ }
    if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      this.setPosition({ left: pos.left, top: pos.top });
    }
  }

  _onPosition(position) {
    super._onPosition?.(position);
    this._savePos ??= foundry.utils.debounce(p => {
      try { game.settings.set(MODULE_ID, SETTINGS.auditorPosition, { left: Math.round(p.left), top: Math.round(p.top) }); }
      catch { /* ignore */ }
    }, 400);
    this._savePos(position);
  }
}

function safeSetting(key, fallback) {
  try { return game.settings.get(MODULE_ID, key); } catch { return fallback; }
}

/** Format a gp amount with thin thousands separators. */
function fmtGp(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString("en-US");
}
