/**
 * Decorator — the optional LLM flavor/provenance layer (DESIGN §3 Decorator,
 * §14). It batches one request per proposal to a local `claude -p` sidecar and
 * stamps each pick with a sentence of provenance ("looted from the frost-giant
 * jarl's hoard…"). Pure cosmetic: the uuid/price/rules never change.
 *
 * Hard rule: this NEVER blocks or breaks the loot loop. Disabled, no sidecar,
 * timeout, bad JSON, HTTP error — every failure path returns the proposal
 * untouched so the item still drops with plain rules-text (DESIGN §14 fallback).
 */

import { MODULE_ID, SETTINGS } from "../const.js";
import { logLlmCall } from "./llm-log.js";

const REQUEST_TIMEOUT_MS = 60000; // client cap; the sidecar enforces its own, shorter

/** Flavor is on only when explicitly enabled and a sidecar URL is configured. */
export function flavorEnabled() {
  return !!safeSetting(SETTINGS.llmFlavor, false) && !!String(safeSetting(SETTINGS.sidecarUrl, "")).trim();
}

/**
 * Enrich a proposal's picks with LLM flavor in place (and return it). Batches
 * every pick into a single sidecar call (DESIGN §14: one call per hoard, never
 * per item). `force` re-flavors picks that already have text.
 */
export async function decorateProposal(proposal, { force = false } = {}) {
  if (!proposal || !flavorEnabled()) return proposal;

  // Collect the picks needing flavor, each tagged with a stable batch id.
  const targets = [];
  proposal.parcels?.forEach((parcel, pi) => {
    parcel.items?.forEach((pick, ii) => {
      if (pick.custom) return;            // workshop items author their own flavor
      if (!force && pick.flavor) return;
      const id = `p${pi}_${ii}`;
      targets.push({ id, pick });
    });
  });
  if (!targets.length) return proposal;

  const payload = {
    context: proposal.context,
    label: proposal.label,
    level: proposal.level,
    campaign: String(safeSetting(SETTINGS.campaignContext, "") ?? "").trim(),
    notes: String(proposal.request?.meta?.extraContext ?? "").trim(),
    // Which Claude model the sidecar should use (blank → sidecar's own default).
    model: String(safeSetting(SETTINGS.llmModel, "") ?? "").trim(),
    rules: { proficiencyWithoutLevel: !!safeSetting(SETTINGS.proficiencyWithoutLevel, false) },
    tags: pickTags(proposal.request?.tags),
    items: targets.map(({ id, pick }) => ({
      id,
      name: pick.name,
      type: pick.type,
      level: pick.level,
      rarity: pick.rarity,
      heirloom: !!pick.heirloom,
      runes: Array.isArray(pick.runeNames) && pick.runeNames.length ? pick.runeNames : undefined,
      for: pick.forActorName ?? null,
      reason: pick.reason ?? ""
    }))
  };

  let flavors;
  try {
    flavors = await callSidecar(payload);
  } catch (err) {
    console.warn(`${MODULE_ID} | flavor sidecar unavailable — dropping plain (no flavor)`, err);
    return proposal; // graceful: untouched
  }
  if (!flavors) return proposal;

  for (const { id, pick } of targets) {
    const f = flavors[id];
    if (!f) continue;
    if (typeof f === "string") { pick.flavor = clean(f); continue; }
    if (f.flavor) pick.flavor = clean(f.flavor);
    if (f.provenance) pick.provenance = clean(f.provenance);
    if (f.name) pick.flavorName = clean(f.name); // reskinned name (cosmetic; uuid unchanged)
    const iconHint = f.iconPrompt ?? f.icon ?? f.iconHint;
    if (iconHint) pick.iconHint = clean(iconHint); // GM-only icon-generation prompt
  }
  return proposal;
}

/* ------------------------------ sidecar transport ------------------------------ */

async function callSidecar(payload) {
  const base = String(safeSetting(SETTINGS.sidecarUrl, "")).trim().replace(/\/+$/, "");
  if (!base) return null;
  const secret = String(safeSetting(SETTINGS.sidecarSecret, "")).trim();

  const t0 = Date.now();
  const itemCount = Array.isArray(payload.items) ? payload.items.length : 0;
  const modelNote = payload.model ? ` · model ${payload.model}` : "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/flavor`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "x-gllg-secret": secret } : {})
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`sidecar HTTP ${res.status}`);
    const data = await res.json();
    logLlmCall({ kind: "flavor", endpoint: "/flavor", ok: true, status: res.status,
      ms: Date.now() - t0, detail: `${itemCount} item(s) flavored${modelNote}` });
    // Accept { flavors: {id:…} } or a bare map / array keyed by id.
    if (data?.flavors) return data.flavors;
    if (Array.isArray(data)) return Object.fromEntries(data.filter(d => d?.id).map(d => [d.id, d]));
    return data ?? null;
  } catch (err) {
    logLlmCall({ kind: "flavor", endpoint: "/flavor", ok: false, ms: Date.now() - t0,
      detail: `${itemCount} item(s)`, error: errText(err) });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ helpers ------------------------------ */

function pickTags(tags) {
  if (!tags) return {};
  return {
    traits: tags.traits ?? [],
    biomes: tags.biomes ?? [],
    factions: tags.factions ?? []
  };
}

/** Trim and hard-cap flavor length so a runaway model can't bloat a chat card. */
function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
}

function safeSetting(key, fallback) {
  try { return game.settings.get(MODULE_ID, key); } catch { return fallback; }
}

/** Human-friendly one-liner for the call log (distinguishes a client-side abort). */
function errText(err) {
  if (err?.name === "AbortError") return "timed out (client)";
  return err?.message || String(err ?? "unknown error");
}
