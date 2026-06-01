/**
 * HealthCheck — composes the sheet reader, the ABP yardstick, and the wealth
 * ledger into a per-PC audit report with two independent readouts:
 *
 *   1. fundamentals-gap  — actual gear runes/items vs the ABP curve. Math-critical.
 *   2. wealth-drift       — live sheet net worth vs the expected wealth curve.
 *
 * The two are deliberately NOT blended into one score: a PC can be gp-rich yet
 * missing a striking rune, and that's the dangerous case the split surfaces.
 */

import { SEVERITY } from "../const.js";
import {
  expectedFundamentals, TIER_LABELS, expectedWealthPerPC
} from "../pf2e/tables.js";
import {
  isPF2e, resolveParty, actorLevel, readFundamentals, netWorthGp
} from "../pf2e/actor-reader.js";
import { WealthLedger } from "./ledger.js";

/** The four math-critical axes (a total miss here breaks encounter math). */
const CORE_AXES = [
  { key: "attack", label: "GLLG.axis.attack", soft: false },
  { key: "striking", label: "GLLG.axis.striking", soft: false },
  { key: "defense", label: "GLLG.axis.defense", soft: false },
  { key: "resilient", label: "GLLG.axis.resilient", soft: false }
];
/** Soft axes: matter for the curve but don't break the core math. */
const SOFT_AXES = [
  { key: "perception", label: "GLLG.axis.perception", soft: true },
  { key: "skills", label: "GLLG.axis.skills", soft: true }
];

/**
 * Build the full party report. Pure read — never mutates actors.
 * Returns { ok, reason?, party, members[] }.
 */
export function buildReport(options = {}) {
  if (!isPF2e()) return { ok: false, reason: "GLLG.audit.notPF2e", members: [] };

  const tolerance = Number(options.tolerancePct ?? 25);
  const { partyActor, members } = resolveParty();
  if (!members.length) return { ok: false, reason: "GLLG.audit.noParty", members: [] };

  const memberReports = members.map(a => auditMember(a, tolerance));

  // Party-level aggregates.
  const levels = memberReports.map(m => m.level);
  const avgLevel = levels.length ? Math.round(levels.reduce((s, n) => s + n, 0) / levels.length) : 1;
  const counts = { critical: 0, behind: 0, ontrack: 0, ahead: 0 };
  for (const m of memberReports) counts[m.worst] = (counts[m.worst] || 0) + 1;
  const totalNet = memberReports.reduce((s, m) => s + m.wealth.net, 0);
  const totalExpected = memberReports.reduce((s, m) => s + m.wealth.expected, 0);

  return {
    ok: true,
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

function auditMember(actor, tolerance) {
  const level = actorLevel(actor);
  const expected = expectedFundamentals(level);
  const actual = readFundamentals(actor);

  const fundamentals = [];
  for (const axis of [...CORE_AXES, ...SOFT_AXES]) {
    const exp = expected[axis.key] ?? 0;
    const act = actual[axis.key] ?? 0;
    fundamentals.push(buildAxis(axis, exp, act));
  }

  const worst = worstSeverity(fundamentals.map(f => f.severity));
  const missing = fundamentals
    .filter(f => f.severity === SEVERITY.CRITICAL || f.severity === SEVERITY.BEHIND)
    .map(f => f.summary);

  const net = netWorthGp(actor);
  const expectedW = expectedWealthPerPC(level);
  const recorded = WealthLedger.totalAwarded(actor.id);

  return {
    id: actor.id,
    name: actor.name,
    img: actor.img,
    level,
    fundamentals,
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

function buildAxis(axis, expectedTier, actualTier) {
  const labels = TIER_LABELS[axis.key];
  const expLabel = labels ? labels[Math.min(expectedTier, labels.length - 1)] : String(expectedTier);
  const actLabel = labels ? labels[Math.min(actualTier, labels.length - 1)] : String(actualTier);

  let severity;
  if (actualTier >= expectedTier) {
    severity = actualTier > expectedTier ? SEVERITY.AHEAD : SEVERITY.ON_TRACK;
  } else if (!axis.soft && actualTier === 0 && expectedTier >= 1) {
    severity = SEVERITY.CRITICAL;          // a math-critical fundamental is entirely absent
  } else {
    severity = SEVERITY.BEHIND;            // present but a tier (or more) behind, or a soft gap
  }

  const name = game.i18n.localize(axis.label);
  let summary;
  if (severity === SEVERITY.CRITICAL) summary = game.i18n.format("GLLG.audit.missing", { axis: name, tier: expLabel });
  else if (severity === SEVERITY.BEHIND) summary = game.i18n.format("GLLG.audit.behindAxis", { axis: name, have: actLabel, need: expLabel });
  else summary = name;

  return {
    key: axis.key,
    name,
    soft: axis.soft,
    expectedTier,
    actualTier,
    expectedLabel: expLabel,
    actualLabel: actLabel,
    severity,
    summary
  };
}

function driftSeverity(net, expected, tolerance) {
  if (!expected) return SEVERITY.ON_TRACK;
  const pct = ((net - expected) / expected) * 100;
  if (pct > tolerance) return SEVERITY.AHEAD;
  if (pct < -tolerance) return SEVERITY.BEHIND;
  return SEVERITY.ON_TRACK;
}

const ORDER = [SEVERITY.CRITICAL, SEVERITY.BEHIND, SEVERITY.ON_TRACK, SEVERITY.AHEAD];
function worstSeverity(list) {
  for (const s of ORDER) if (list.includes(s)) return s;
  return SEVERITY.ON_TRACK;
}
