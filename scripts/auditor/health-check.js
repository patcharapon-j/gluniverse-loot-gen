/**
 * HealthCheck — composes the active system adapter's sheet reader + progression
 * yardstick with the wealth ledger into a per-PC audit report with two
 * independent readouts:
 *
 *   1. progression  — actual gear vs. the system's expectation. On PF2e this is
 *      the math-critical ABP/rune curve; on D&D 5e it is attunement usage +
 *      magic-item rarity by tier (all soft — 5e has no mandatory magic).
 *   2. wealth-drift — live sheet net worth vs. the expected wealth curve.
 *
 * The two are deliberately NOT blended into one score: a PC can be gp-rich yet
 * missing key gear, and that's the case the split surfaces. The orchestration is
 * system-neutral; everything system-specific comes from the adapter.
 */

import { SEVERITY } from "../const.js";
import { getAdapter } from "../systems/registry.js";
import { WealthLedger } from "./ledger.js";

/**
 * Build the full party report. Pure read — never mutates actors.
 * Returns { ok, reason?, party, members[] }.
 */
export function buildReport(options = {}) {
  const adapter = getAdapter();
  if (!adapter) return { ok: false, reason: "GLLG.audit.noSystem", members: [] };
  const notReady = adapter.notReadyReason?.();
  if (notReady) return { ok: false, reason: notReady, members: [] };

  const tolerance = Number(options.tolerancePct ?? 25);
  const { partyActor, members } = adapter.resolveParty();
  if (!members.length) return { ok: false, reason: "GLLG.audit.noParty", members: [] };

  const memberReports = members.map(a => auditMember(adapter, a, tolerance));

  // Party-level aggregates.
  const levels = memberReports.map(m => m.level);
  const avgLevel = levels.length ? Math.round(levels.reduce((s, n) => s + n, 0) / levels.length) : 1;
  const counts = { critical: 0, behind: 0, ontrack: 0, ahead: 0 };
  for (const m of memberReports) counts[m.worst] = (counts[m.worst] || 0) + 1;
  const totalNet = memberReports.reduce((s, m) => s + m.wealth.net, 0);
  const totalExpected = memberReports.reduce((s, m) => s + m.wealth.expected, 0);

  return {
    ok: true,
    system: adapter.id,
    party: {
      name: partyActor?.name ?? game.i18n.localize("GLLG.audit.defaultPartyName"),
      size: memberReports.length,
      avgLevel,
      counts,
      wealth: {
        net: totalNet,
        expected: totalExpected,
        deltaPct: totalExpected ? Math.round(((totalNet - totalExpected) / totalExpected) * 100) : 0,
        severity: driftSeverity(totalNet, totalExpected, tolerance)
      }
    },
    members: memberReports
  };
}

function auditMember(adapter, actor, tolerance) {
  const level = adapter.actorLevel(actor);
  const { readouts, worst, missing } = adapter.progressionAudit(actor, level);

  const net = adapter.netWorthGp(actor);
  const expectedW = adapter.expectedWealthPerPC(level);
  const recorded = WealthLedger.totalAwarded(actor.id);

  return {
    id: actor.id,
    name: actor.name,
    img: actor.img,
    level,
    // "fundamentals" is the historical field name the dashboard reads; it now
    // carries whatever progression readouts the active system produces.
    fundamentals: readouts,
    worst,
    missing,
    wealth: {
      net,
      expected: expectedW,
      deltaPct: expectedW ? Math.round(((net - expectedW) / expectedW) * 100) : 0,
      recorded,
      severity: driftSeverity(net, expectedW, tolerance)
    }
  };
}

function driftSeverity(net, expected, tolerance) {
  if (!expected) return SEVERITY.ON_TRACK;
  const pct = ((net - expected) / expected) * 100;
  if (pct > tolerance) return SEVERITY.AHEAD;
  if (pct < -tolerance) return SEVERITY.BEHIND;
  return SEVERITY.ON_TRACK;
}
