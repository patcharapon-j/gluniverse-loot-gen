/** Setting registration for GLUniverse — Loot Generator. */

import { MODULE_ID, SETTINGS } from "./const.js";
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
function registerSettingsFormEnhancers() {
  Hooks.on("renderSettingsConfig", (_app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root?.querySelector) return;
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
