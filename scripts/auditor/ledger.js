/**
 * WealthLedger — a persisted, per-PC record of loot awarded over time.
 *
 * The auditor's "wealth-drift" readout primarily compares each PC's live sheet
 * net worth to the expected curve (works on any existing party, today). The
 * ledger is the *forward-looking* precision layer: once the generator starts
 * materializing loot it records each award here, so drift can be attributed to
 * "what we actually handed out" rather than inferred from the sheet alone.
 *
 * Stored as a single world setting: { [actorId]: { entries: [...], total } }.
 */

import { MODULE_ID, SETTINGS, HOOKS } from "../const.js";

export const WealthLedger = {
  /** The full ledger object (never mutate the returned reference in place). */
  all() {
    try { return foundry.utils.duplicate(game.settings.get(MODULE_ID, SETTINGS.ledger) || {}); }
    catch { return {}; }
  },

  /** Entries for one actor. */
  forActor(actorId) {
    const led = this.all();
    return led[actorId]?.entries ?? [];
  },

  /** Total gp recorded as awarded to one actor. */
  totalAwarded(actorId) {
    const led = this.all();
    return Number(led[actorId]?.total) || 0;
  },

  /**
   * Record an award. `entry` = { gp, label?, level?, source?, kind? }.
   * kind: "permanent" | "consumable" | "currency" (optional, for later breakdowns).
   */
  async record(actorId, entry) {
    if (!game.user?.isGM) return;
    const led = this.all();
    const slot = led[actorId] ??= { entries: [], total: 0 };
    const gp = Number(entry?.gp) || 0;
    slot.entries.push({
      gp,
      label: entry?.label ?? "",
      level: entry?.level ?? null,
      source: entry?.source ?? "",
      kind: entry?.kind ?? "currency",
      ts: Date.now()
    });
    slot.total = (Number(slot.total) || 0) + gp;
    await this._save(led);
  },

  /** Record the same award split across several actors (e.g. a shared hoard). */
  async recordMany(actorIds, entry) {
    if (!game.user?.isGM || !actorIds?.length) return;
    const share = (Number(entry?.gp) || 0) / actorIds.length;
    for (const id of actorIds) await this.record(id, { ...entry, gp: share });
  },

  /** Wipe one actor's ledger (or the whole thing when no id is given). */
  async clear(actorId) {
    if (!game.user?.isGM) return;
    if (!actorId) { await this._save({}); return; }
    const led = this.all();
    delete led[actorId];
    await this._save(led);
  },

  async _save(led) {
    await game.settings.set(MODULE_ID, SETTINGS.ledger, led);
    Hooks.callAll(HOOKS.ledgerChanged, led);
  }
};
