/** GLUniverse — Loot Generator : module entry point. */

import { MODULE_ID, HOOKS } from "./const.js";
import { registerSettings } from "./settings.js";
import { AuditorDashboard } from "./apps/auditor.js";
import { WealthLedger } from "./auditor/ledger.js";
import { buildReport } from "./auditor/health-check.js";
import {
  buildRequest, combatRequest, explorationRequest, dungeonRequest, questRequest
} from "./loot/adapters.js";
import { proposeLoot } from "./loot/cascade.js";
import { materialize } from "./loot/materializer.js";
import { decorateProposal, flavorEnabled } from "./loot/decorator.js";
import { clearItemIndex } from "./loot/item-selector.js";
import { postReviewCard, bindReviewCardActions } from "./apps/review-card.js";
import { openGenerateDialog } from "./apps/generate-dialog.js";

Hooks.once("init", () => {
  registerSettings();
  registerKeybindings();

  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = {
    AuditorDashboard, WealthLedger, buildReport, HOOKS,
    // Loot model (build #2) — request builders.
    loot: { buildRequest, combatRequest, explorationRequest, dungeonRequest, questRequest },
    // Generation pipeline (build #3+) — cascade → decorate → review card → materialize.
    generate: { openGenerateDialog, proposeLoot, decorateProposal, flavorEnabled, postReviewCard, materialize, clearItemIndex }
  };
});

Hooks.once("ready", () => {
  if (game.system?.id !== "pf2e") {
    console.warn(`${MODULE_ID} | Pathfinder 2e system not active — the Loot Auditor is idle.`);
  }
  bindReviewCardActions();
});

/* The auditor reads live sheets, so any gear/level/coin change should repaint it.
   Refresh is debounced inside the app, so bursts (e.g. dropping a full kit) coalesce. */
for (const hook of ["updateActor", "createItem", "updateItem", "deleteItem"]) {
  Hooks.on(hook, doc => {
    // Only bother for character actors (the item hooks carry the parent actor).
    const actor = doc?.actor ?? doc;
    if (actor?.type && actor.type !== "character") return;
    AuditorDashboard.refresh();
  });
}

// v13+ scene controls (keyed objects; handlers use onChange).
Hooks.on("getSceneControlButtons", controls => {
  if (!game.user?.isGM) return;
  const group = controls.tokens ?? controls.notes ?? Object.values(controls)[0];
  if (!group?.tools) return;
  group.tools["gllg-auditor"] = {
    name: "gllg-auditor",
    title: "GLLG.controls.openAuditor",
    icon: "fa-solid fa-gem",
    button: true,
    onChange: () => AuditorDashboard.toggle()
  };
  group.tools["gllg-generate"] = {
    name: "gllg-generate",
    title: "GLLG.controls.generateLoot",
    icon: "fa-solid fa-wand-sparkles",
    button: true,
    onChange: () => openGenerateDialog()
  };
});

function registerKeybindings() {
  game.keybindings.register(MODULE_ID, "toggleAuditor", {
    name: "GLLG.keybindings.toggleAuditor",
    editable: [{ key: "KeyL", modifiers: ["Alt"] }],
    onDown: () => { AuditorDashboard.toggle(); return true; },
    restricted: false
  });
  game.keybindings.register(MODULE_ID, "generateLoot", {
    name: "GLLG.keybindings.generateLoot",
    editable: [{ key: "KeyG", modifiers: ["Alt"] }],
    onDown: () => { if (game.user?.isGM) openGenerateDialog(); return true; },
    restricted: true
  });
}
