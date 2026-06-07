/** Shared constants for GLUniverse — Loot Generator. */

export const MODULE_ID = "gluniverse-loot-gen";

/** Short scope/log prefix. */
export const PREFIX = "GLLG";

/** Namespaced hooks other modules / macros can listen to. */
export const HOOKS = {
  /** Fired (callAll) after the ledger records or recomputes an award: (state) => void */
  ledgerChanged: `${MODULE_ID}.ledgerChanged`,
  /** Fired (callAll) after the auditor recomputes party health: (report) => void */
  auditChanged: `${MODULE_ID}.auditChanged`
};

/** Setting keys. Scope (world/client) is declared in settings.js. */
export const SETTINGS = {
  // --- Auditor / ledger ---
  ledger: "ledger",                       // Object (world): persisted award ledger keyed by actor id
  partyActorId: "partyActorId",           // String (world): explicit party actor override (else auto-detect)
  shoppingAccess: "shoppingAccess",       // String (world): "free" | "limited" | "none" — core/unusual baseline
  variantABP: "variantABP",               // Boolean (world): campaign runs Automatic Bonus Progression
  proficiencyWithoutLevel: "proficiencyWithoutLevel", // Boolean (world): campaign uses the Proficiency Without Level variant (drops level from modifiers/DCs)
  driftTolerancePct: "driftTolerancePct", // Number (world): +/- % band before wealth-drift flags
  heirloomMode: "heirloomMode",           // Boolean (world): fundamental runes awaken in-place on signature items
  heirloomArmor: "heirloomArmor",         // Boolean (world): also awaken armor fundamentals (else weapons only)
  etchRunes: "etchRunes",                 // Boolean (world): etch appropriate rune sets onto generated weapon/armor loot

  // --- D&D 5e (Plutonium) sourcing ---
  dnd5eSourcePack: "dnd5eSourcePack",     // String (world): preferred source compendium collection id (blank = auto, Plutonium-first)
  dnd5eAutoImport: "dnd5eAutoImport",     // Boolean (world): let Plutonium auto-import catalogue content on demand when its API is available

  // --- LLM flavor sidecar (build #6, DESIGN §14) ---
  llmFlavor: "llmFlavor",                 // Boolean (world): request LLM provenance/flavor from the sidecar
  sidecarUrl: "sidecarUrl",               // String (world): base URL of the claude -p sidecar (same-origin path or full URL)
  sidecarSecret: "sidecarSecret",         // String (world, GM-only): shared secret sent as a header
  llmModel: "llmModel",                   // String (world): Claude model the sidecar should use (alias or full id; blank = sidecar default)
  campaignContext: "campaignContext",     // String (world): GM's campaign blurb fed to the LLM as baseline flavor context
  llmLog: "llmLog",                       // Array (client, hidden): recent LLM sidecar calls for the diagnostics viewer

  // --- Auditor window (client) ---
  auditorPosition: "auditorPosition",     // Object (client): {left,top}
  auditorHidden: "auditorHidden"          // Boolean (client): window hidden on this screen
};

/** Shopping-access → baseline share of budget spent on "core" items (AoN guidance). */
export const CORE_RATIO = { free: 0.5, limited: 0.75, none: 1.0 };

/** Ledger bucket for loot awarded to the party but not yet divvied to a PC. */
export const PARTY_LEDGER_KEY = "party";

/** Loot entry-point contexts (DESIGN §5). Each has a budget + tag adapter.
 *  SINGLE is an ad-hoc mode: one item at a chosen level/theme, not budget-driven.
 *  SHOP is a budget-NEUTRAL mode (DESIGN §18): it stocks a buyable Merchant actor
 *  sized by shop tier, never touching the WealthLedger (players spend their own gp). */
export const CONTEXT = {
  COMBAT: "combat",
  EXPLORATION: "exploration",
  DUNGEON: "dungeon",
  QUEST: "quest",
  SINGLE: "single",
  SHOP: "shop"
};

/** Where a generated find ultimately lands (DESIGN §10). */
export const TARGET = {
  LOOT_ACTOR: "loot-actor",   // a chest/hoard actor — preserves discovery
  CHAT_CARD: "chat-card",     // review + divvy
  DIRECT: "direct",           // straight to a sheet (heirloom awakening, some quest rewards)
  MERCHANT: "merchant-actor"  // a buyable PF2e Merchant actor (DESIGN §18 — shops)
};

/** Shop tiers (DESIGN §18) — how big/deep a stocked shop is. Each maps to an
 *  item-count band + level reach + core/unusual lean (see scripts/loot/shop.js). */
export const SHOP_TIER = {
  PEDDLER: "peddler",
  STALL: "stall",
  SHOP: "shop",
  EMPORIUM: "emporium"
};

/** Encounter threat bands (drive the combat budget slice). */
export const THREAT = {
  TRIVIAL: "trivial", LOW: "low", MODERATE: "moderate", SEVERE: "severe", EXTREME: "extreme"
};

/** Exploration cache tiers (→ % of level budget). */
export const CACHE_TIER = {
  MINOR: "minor", STANDARD: "standard", MAJOR: "major", HOARD: "hoard"
};

/** Quest reward tiers (GM-picked → % of level budget). */
export const QUEST_TIER = {
  MINOR: "minor", STANDARD: "standard", MAJOR: "major", GRAND: "grand"
};

/** Severity tiers used across the auditor readouts. */
export const SEVERITY = {
  CRITICAL: "critical", // math-breaking fundamental gap (e.g. missing striking)
  BEHIND: "behind",     // below the expected curve but not breaking
  ON_TRACK: "ontrack",  // within tolerance
  AHEAD: "ahead"        // above the expected curve
};
