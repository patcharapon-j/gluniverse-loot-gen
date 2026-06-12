/** GLUniverse — Loot Generator : module entry point. */

import { MODULE_ID, HOOKS, CONTEXT } from "./const.js";
import { registerSettings, applyMotionTier } from "./settings.js";
// Register the system adapters (self-register on import; see scripts/systems/).
import "./systems/pf2e/adapter.js";
import "./systems/dnd5e/adapter.js";
import { getAdapter, systemSupported } from "./systems/registry.js";
import { AuditorDashboard } from "./apps/auditor.js";
import { WealthLedger } from "./auditor/ledger.js";
import { buildReport } from "./auditor/health-check.js";
import {
  buildRequest, combatRequest, explorationRequest, dungeonRequest, questRequest, shopRequest
} from "./loot/adapters.js";
import { proposeLoot } from "./loot/cascade.js";
import { proposeShop } from "./loot/shop.js";
import { materialize } from "./loot/materializer.js";
import { decorateProposal, flavorEnabled } from "./loot/decorator.js";
import { clearItemIndex } from "./loot/item-selector.js";
import { postReviewCard, bindReviewCardActions } from "./apps/review-card.js";
import { openGenerateDialog } from "./apps/generate-dialog.js";
import { openWorkshopDialog } from "./apps/workshop-dialog.js";
import { runWorkshop, workshopEnabled } from "./loot/workshop.js";

Hooks.once("init", () => {
  registerSettings();
  registerKeybindings();

  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = {
    AuditorDashboard, WealthLedger, buildReport, HOOKS,
    // Loot model (build #2) — request builders.
    loot: { buildRequest, combatRequest, explorationRequest, dungeonRequest, questRequest, shopRequest },
    // Generation pipeline (build #3+) — cascade → decorate → review card → materialize.
    generate: { openGenerateDialog, proposeLoot, decorateProposal, flavorEnabled, postReviewCard, materialize, clearItemIndex },
    // Loot Workshop (/grill-me) — LLM-authored custom loot.
    workshop: { openWorkshopDialog, runWorkshop, workshopEnabled },
    // Shop generator (DESIGN §18) — budget-neutral buyable Merchant actors.
    shop: { proposeShop, openShopDialog: () => openGenerateDialog(CONTEXT.SHOP) }
  };
});

Hooks.once("ready", () => {
  applyMotionTier();   // reflect the motion-tier preference onto <body>
  const adapter = getAdapter();
  if (!systemSupported()) {
    console.warn(`${MODULE_ID} | no loot adapter for the "${game.system?.id}" system — the module is idle.`);
  } else {
    console.log(`${MODULE_ID} | active adapter: ${adapter.label} (${adapter.id})`);
  }
  bindReviewCardActions();
});

/* The /grill-me chat command opens the Loot Workshop (GM-only). Returning false
   stops the slash text from posting to chat. Anything else is left for Foundry. */
Hooks.on("chatMessage", (_chatLog, message, _chatData) => {
  const m = /^\/grill-?me\b\s*([\s\S]*)$/i.exec(String(message ?? "").trim());
  if (!m) return true;
  if (!game.user?.isGM) {
    ui.notifications?.warn("GLLG: only the GM can open the Loot Workshop.");
    return false;
  }
  openWorkshopDialog(m[1]?.trim() || "");
  return false;
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
  group.tools["gllg-workshop"] = {
    name: "gllg-workshop",
    title: "GLLG.controls.workshop",
    icon: "fa-solid fa-hammer",
    button: true,
    onChange: () => openWorkshopDialog()
  };
  group.tools["gllg-shop"] = {
    name: "gllg-shop",
    title: "GLLG.controls.shop",
    icon: "fa-solid fa-shop",
    button: true,
    onChange: () => openGenerateDialog(CONTEXT.SHOP)
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
  game.keybindings.register(MODULE_ID, "workshop", {
    name: "GLLG.keybindings.workshop",
    editable: [{ key: "KeyW", modifiers: ["Alt"] }],
    onDown: () => { if (game.user?.isGM) openWorkshopDialog(); return true; },
    restricted: true
  });
  game.keybindings.register(MODULE_ID, "shop", {
    name: "GLLG.keybindings.shop",
    editable: [{ key: "KeyS", modifiers: ["Alt"] }],
    onDown: () => { if (game.user?.isGM) openGenerateDialog(CONTEXT.SHOP); return true; },
    restricted: true
  });
}
