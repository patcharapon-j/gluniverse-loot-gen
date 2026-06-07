/**
 * Shared progression-audit grading. Adapters build their per-axis "readouts"
 * (expected vs. actual on each yardstick); this turns a tier comparison into a
 * severity + human summary so the dashboard renders every system uniformly.
 *
 * Tier semantics: a higher `actualTier` than `expectedTier` is AHEAD; equal is
 * ON_TRACK; below is BEHIND, unless a *hard* (non-soft) axis is entirely absent
 * when something was expected — that's CRITICAL (math-breaking on PF2e; on D&D
 * 5e nothing is math-critical, so the dnd5e adapter marks every axis soft).
 */

import { SEVERITY } from "../const.js";

const ORDER = [SEVERITY.CRITICAL, SEVERITY.BEHIND, SEVERITY.ON_TRACK, SEVERITY.AHEAD];

/** Severity for an expected/actual tier pair on a soft-or-hard axis. */
export function gradeTier(expectedTier, actualTier, soft) {
  if (actualTier >= expectedTier) {
    return actualTier > expectedTier ? SEVERITY.AHEAD : SEVERITY.ON_TRACK;
  }
  if (!soft && actualTier === 0 && expectedTier >= 1) return SEVERITY.CRITICAL;
  return SEVERITY.BEHIND;
}

/**
 * Build a complete readout row from an axis spec + expected/actual tiers and a
 * label table. `labels[axis.key]` is an array indexed by tier (["—","+1",…]).
 */
export function buildReadout(axis, expectedTier, actualTier, labels) {
  const lbl = labels?.[axis.key];
  const expLabel = lbl ? lbl[Math.min(expectedTier, lbl.length - 1)] : String(expectedTier);
  const actLabel = lbl ? lbl[Math.min(actualTier, lbl.length - 1)] : String(actualTier);
  const severity = gradeTier(expectedTier, actualTier, axis.soft);

  const name = localize(axis.label);
  let summary;
  if (severity === SEVERITY.CRITICAL) summary = format("GLLG.audit.missing", { axis: name, tier: expLabel });
  else if (severity === SEVERITY.BEHIND) summary = format("GLLG.audit.behindAxis", { axis: name, have: actLabel, need: expLabel });
  else summary = name;

  return {
    key: axis.key, name, soft: !!axis.soft,
    expectedTier, actualTier, expectedLabel: expLabel, actualLabel: actLabel,
    severity, summary
  };
}

/** Worst (most severe) of a list of severities. */
export function worstSeverity(list) {
  for (const s of ORDER) if (list.includes(s)) return s;
  return SEVERITY.ON_TRACK;
}

function localize(key) {
  try { return globalThis.game?.i18n?.localize(key) ?? key; } catch { return key; }
}
function format(key, data) {
  try { return globalThis.game?.i18n?.format(key, data) ?? key; } catch { return key; }
}
