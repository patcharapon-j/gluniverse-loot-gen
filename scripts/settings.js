/** Setting registration for GLUniverse — Loot Generator. */

import { MODULE_ID, SETTINGS, SOURCE_MODE } from "./const.js";
import { LlmLogViewer } from "./apps/llm-log.js";

export function registerSettings() {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, data);

  // --- World config ---
  reg(SETTINGS.shoppingAccess, {
    name: "GLLG.settings.shoppingAccess.name",
    hint: "GLLG.settings.shoppingAccess.hint",
    scope: "world", config: true, type: String, default: "limited",
    choices: {
      free: "GLLG.settings.shoppingAccess.free",
      limited: "GLLG.settings.shoppingAccess.limited",
      none: "GLLG.settings.shoppingAccess.none"
    }
  });

  reg(SETTINGS.variantABP, {
    name: "GLLG.settings.variantABP.name",
    hint: "GLLG.settings.variantABP.hint",
    scope: "world", config: true, type: Boolean, default: false
  });

  reg(SETTINGS.proficiencyWithoutLevel, {
    name: "GLLG.settings.proficiencyWithoutLevel.name",
    hint: "GLLG.settings.proficiencyWithoutLevel.hint",
    scope: "world", config: true, type: Boolean, default: false
  });

  reg(SETTINGS.driftTolerancePct, {
    name: "GLLG.settings.driftTolerance.name",
    hint: "GLLG.settings.driftTolerance.hint",
    scope: "world", config: true, type: Number, default: 25,
    range: { min: 5, max: 75, step: 5 }
  });

  reg(SETTINGS.partyActorId, {
    name: "GLLG.settings.partyActor.name",
    hint: "GLLG.settings.partyActor.hint",
    scope: "world", config: true, type: String, default: ""
  });

  reg(SETTINGS.heirloomMode, {
    name: "GLLG.settings.heirloomMode.name",
    hint: "GLLG.settings.heirloomMode.hint",
    scope: "world", config: true, type: Boolean, default: false
  });

  reg(SETTINGS.heirloomArmor, {
    name: "GLLG.settings.heirloomArmor.name",
    hint: "GLLG.settings.heirloomArmor.hint",
    scope: "world", config: true, type: Boolean, default: false
  });

  reg(SETTINGS.etchRunes, {
    name: "GLLG.settings.etchRunes.name",
    hint: "GLLG.settings.etchRunes.hint",
    scope: "world", config: true, type: Boolean, default: true
  });

  // --- D&D 5e (Plutonium) sourcing ---
  reg(SETTINGS.dnd5eSourceMode, {
    name: "GLLG.settings.dnd5eSourceMode.name",
    hint: "GLLG.settings.dnd5eSourceMode.hint",
    scope: "world", config: true, type: String, default: SOURCE_MODE.AUTO,
    choices: {
      [SOURCE_MODE.AUTO]: "GLLG.settings.dnd5eSourceMode.auto",
      [SOURCE_MODE.PLUTONIUM]: "GLLG.settings.dnd5eSourceMode.plutonium",
      [SOURCE_MODE.INTERNAL]: "GLLG.settings.dnd5eSourceMode.internal"
    }
  });

  reg(SETTINGS.dnd5eSourcePack, {
    name: "GLLG.settings.dnd5eSourcePack.name",
    hint: "GLLG.settings.dnd5eSourcePack.hint",
    scope: "world", config: true, type: String, default: ""
  });

  reg(SETTINGS.dnd5eSourceBooks, {
    name: "GLLG.settings.dnd5eSourceBooks.name",
    hint: "GLLG.settings.dnd5eSourceBooks.hint",
    scope: "world", config: true, type: String, default: ""
  });

  reg(SETTINGS.dnd5eAutoImport, {
    name: "GLLG.settings.dnd5eAutoImport.name",
    hint: "GLLG.settings.dnd5eAutoImport.hint",
    scope: "world", config: true, type: Boolean, default: false
  });

  // --- LLM flavor sidecar (DESIGN §14) ---
  reg(SETTINGS.llmFlavor, {
    name: "GLLG.settings.llmFlavor.name",
    hint: "GLLG.settings.llmFlavor.hint",
    scope: "world", config: true, type: Boolean, default: false
  });

  reg(SETTINGS.sidecarUrl, {
    name: "GLLG.settings.sidecarUrl.name",
    hint: "GLLG.settings.sidecarUrl.hint",
    scope: "world", config: true, type: String, default: "/gllg-sidecar"
  });

  reg(SETTINGS.sidecarSecret, {
    name: "GLLG.settings.sidecarSecret.name",
    hint: "GLLG.settings.sidecarSecret.hint",
    scope: "world", config: true, type: String, default: ""
  });

  // Free text so it never goes stale as new Claude models ship: accepts a CLI
  // alias ("opus"/"sonnet"/"haiku") or a full id ("claude-sonnet-4-6"). Blank
  // means "let the sidecar decide" (its GLLG_MODEL env / the claude CLI default).
  reg(SETTINGS.llmModel, {
    name: "GLLG.settings.llmModel.name",
    hint: "GLLG.settings.llmModel.hint",
    scope: "world", config: true, type: String, default: ""
  });

  reg(SETTINGS.campaignContext, {
    name: "GLLG.settings.campaignContext.name",
    hint: "GLLG.settings.campaignContext.hint",
    scope: "world", config: true, type: String, default: ""
  });

  // --- LLM call log (hidden; viewed through the menu below) ---
  reg(SETTINGS.llmLog, {
    scope: "client", config: false, type: Array, default: []
  });

  // A button in the module's settings section that opens the LLM call-log viewer.
  game.settings.registerMenu(MODULE_ID, "llmLogMenu", {
    name: "GLLG.llmlog.menuName",
    label: "GLLG.llmlog.menuLabel",
    hint: "GLLG.llmlog.menuHint",
    icon: "fa-solid fa-list-timeline",
    type: LlmLogViewer,
    restricted: true
  });

  // --- Persisted data (hidden) ---
  reg(SETTINGS.ledger, {
    scope: "world", config: false, type: Object, default: {}
  });

  // --- Client window state (hidden) ---
  reg(SETTINGS.auditorPosition, {
    scope: "client", config: false, type: Object, default: {}
  });
  reg(SETTINGS.auditorHidden, {
    scope: "client", config: false, type: Boolean, default: false
  });

  registerSettingsFormEnhancers();
}

/**
 * Foundry renders String settings as single-line text inputs. The campaign
 * context is a multi-line blurb (setting, tone, recurring villains…), so swap its
 * input for a roomy <textarea> whenever the settings window renders. Idempotent:
 * skips inputs that are already textareas.
 */
/** Settings only meaningful under a given system (hidden under the other). */
const PF2E_ONLY = [SETTINGS.variantABP, SETTINGS.proficiencyWithoutLevel, SETTINGS.heirloomMode, SETTINGS.heirloomArmor, SETTINGS.etchRunes];
const DND5E_ONLY = [SETTINGS.dnd5eSourceMode, SETTINGS.dnd5eSourcePack, SETTINGS.dnd5eSourceBooks, SETTINGS.dnd5eAutoImport];

function registerSettingsFormEnhancers() {
  Hooks.on("renderSettingsConfig", (_app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root?.querySelector) return;

    // Hide settings that don't apply to the active system, so the GM only sees
    // the knobs that matter for their game.
    const sys = game.system?.id;
    const hide = sys === "dnd5e" ? PF2E_ONLY : sys === "pf2e" ? DND5E_ONLY : [];
    for (const key of hide) {
      const el = root.querySelector(`[name="${MODULE_ID}.${key}"]`);
      const group = el?.closest(".form-group");
      if (group) group.style.display = "none";
    }

    const input = root.querySelector(`[name="${MODULE_ID}.${SETTINGS.campaignContext}"]`);
    if (!input || input.tagName === "TEXTAREA") return;

    const ta = document.createElement("textarea");
    ta.name = input.name;
    ta.value = input.value ?? "";
    ta.rows = 6;
    if (input.id) ta.id = input.id;
    if (input.dataset?.dtype) ta.dataset.dtype = input.dataset.dtype;
    ta.classList.add("gllg-settings-textarea");
    input.replaceWith(ta);
  });
}
