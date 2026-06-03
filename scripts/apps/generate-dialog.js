/**
 * Generate dialog — the GM-facing trigger for the loot pipeline. Collects a
 * context + size + optional theme, builds a LootRequest via the adapters, runs
 * the cascade, and posts the review card. Deliberately thin: all the logic lives
 * in the adapters/cascade; this just gathers inputs.
 *
 * The form is context-aware — choosing a context shows only the inputs that
 * apply to it (threat for combat, cache tier for exploration/dungeon, reward
 * tier for quests, room count for dungeons).
 */

import { CONTEXT, THREAT, CACHE_TIER, QUEST_TIER, SHOP_TIER } from "../const.js";
import { BIOMES, FACTIONS } from "../loot/vocab.js";
import { buildRequest } from "../loot/adapters.js";
import { proposeLoot } from "../loot/cascade.js";
import { decorateProposal, flavorEnabled } from "../loot/decorator.js";
import { workshopEnabled } from "../loot/workshop.js";
import { postReviewCard } from "./review-card.js";
import { beginProgress, endProgress } from "./progress.js";

export async function openGenerateDialog(presetContext) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2) {
    ui.notifications?.error("GLLG: DialogV2 unavailable — use the console API instead.");
    return;
  }

  // Wire the context-aware show/hide once this dialog renders.
  const onRender = (_app, el) => {
    const root = el instanceof HTMLElement ? el : el?.[0];
    if (!root?.querySelector?.(".gllg-genform")) return;
    Hooks.off("renderDialogV2", onRender);
    wireContextAware(root);
  };
  Hooks.on("renderDialogV2", onRender);

  const result = await DialogV2.wait({
    window: { title: "Generate Loot", icon: "fa-solid fa-wand-sparkles", resizable: true },
    position: { width: 460 },
    classes: ["gllg", "gllg-generate"],
    content: buildForm(presetContext),
    rejectClose: false,
    buttons: [
      {
        action: "go", label: "Generate", icon: "fa-solid fa-dice", default: true,
        callback: (_ev, btn) => readForm(btn.form)
      },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
    ]
  }).catch(() => null);

  Hooks.off("renderDialogV2", onRender); // safety if closed before it matched
  if (!result || result === "cancel") return;
  await runGeneration(result);
}

/* -------------------------------- form -------------------------------- */

function buildForm(presetContext) {
  const ctx = sel("context", Object.values(CONTEXT), presetContext ?? CONTEXT.COMBAT, capitalize);
  const threat = sel("threat", ["auto", ...Object.values(THREAT)], "auto", capitalize);
  const cacheTier = sel("cacheTier", Object.values(CACHE_TIER), "standard", capitalize);
  const questTier = sel("questTier", Object.values(QUEST_TIER), "standard", capitalize);
  const shopTier = sel("shopTier", Object.values(SHOP_TIER), SHOP_TIER.SHOP, capitalize);
  const kind = sel("kind", ["any", "permanent", "consumable"], "any", capitalize);
  const biome = sel("biome", ["", ...Object.keys(BIOMES)], "", k => k ? localize(BIOMES[k]) : "— none —");
  const faction = sel("faction", ["", ...Object.keys(FACTIONS)], "", k => k ? localize(FACTIONS[k]) : "— none —");

  // data-for lists the contexts each field applies to ("all" = every context).
  const BUDGET = "combat exploration dungeon quest"; // every budget-driven context (not single)
  return `<div class="gllg-genform">
    <div class="gllg-field" data-for="all"><label>Context</label>${ctx}</div>
    <div class="gllg-field" data-for="combat"><label>Threat <span class="gllg-dim">(auto reads selected tokens)</span></label>${threat}</div>
    <div class="gllg-field" data-for="exploration dungeon"><label>Cache tier</label>${cacheTier}</div>
    <div class="gllg-field" data-for="quest"><label>Reward tier</label>${questTier}</div>
    <div class="gllg-field" data-for="shop"><label>Shop tier <span class="gllg-dim">(peddler → emporium = size &amp; reach)</span></label>${shopTier}</div>
    <div class="gllg-field" data-for="dungeon"><label>Rooms</label><input type="number" name="rooms" value="5" min="1" max="20"></div>
    <div class="gllg-field" data-for="${BUDGET} shop"><label>Number of items <span class="gllg-dim">(blank = auto by ${"tier/budget"})</span></label><input type="number" name="items" min="1" max="40" placeholder="auto"></div>
    <div class="gllg-field" data-for="single"><label>Item kind</label>${kind}</div>
    <div class="gllg-field" data-for="single"><label>Item level <span class="gllg-dim">(blank = party level)</span></label><input type="number" name="itemLevel" min="0" max="25" placeholder="party level"></div>
    <div class="gllg-field" data-for="all"><label>Biome</label>${biome}</div>
    <div class="gllg-field" data-for="all"><label>Faction</label>${faction}</div>
    <div class="gllg-field" data-for="all"><label>Additional context / shop concept <span class="gllg-dim">(optional — fed to the LLM; for shops it stocks to match)</span></label><textarea name="extraContext" rows="2" placeholder="loot: 'recovered from the drowned shrine of Gozreh' · shop: 'black-market potion dealer in the sewers — poisons & illicit elixirs'"></textarea></div>
    ${llmToggle()}
    <div class="gllg-row">
      <div class="gllg-field" data-for="all"><label>Party level <span class="gllg-dim">(blank = auto)</span></label><input type="number" name="level" min="1" max="20" placeholder="auto"></div>
      <div class="gllg-field" data-for="${BUDGET}"><label>Party size <span class="gllg-dim">(blank = auto)</span></label><input type="number" name="size" min="1" max="8" placeholder="auto"></div>
    </div>
    <p class="gllg-dim">Leave level/size blank to read them from the resolved party. Combat reads traits from your selected (defeated) tokens.</p>
  </div>`;
}

/**
 * Optional LLM-flavor toggle. Defaults on when the sidecar is configured (so the
 * GM keeps flavor), but lets them switch it off for a quick, LLM-free roll. When
 * no sidecar is configured the toggle is disabled with a hint, since there is
 * nothing to call.
 */
function llmToggle() {
  const on = flavorEnabled();
  const hint = on
    ? "(uncheck for a quick roll — no LLM call)"
    : "(enable the LLM sidecar in module settings to use)";
  return `<div class="gllg-field gllg-llm-toggle" data-for="all">
    <label class="gllg-check"><input type="checkbox" name="useLlm" ${on ? "checked" : "disabled"}>
      <span>Use LLM flavor &amp; provenance <span class="gllg-dim">${hint}</span></span></label>
  </div>`;
}

function readForm(form) {
  const get = n => form?.elements?.[n]?.value ?? "";
  const context = get("context") || CONTEXT.COMBAT;
  const tier = context === CONTEXT.QUEST ? (get("questTier") || "standard") : (get("cacheTier") || "standard");
  return {
    context,
    tier,
    threat: get("threat") || "auto",
    rooms: Number(get("rooms")) || 5,
    shopTier: get("shopTier") || "shop",
    items: get("items"),       // strings — empty means "auto"
    kind: get("kind") || "any",
    itemLevel: get("itemLevel"),
    biome: get("biome") || "",
    faction: get("faction") || "",
    extraContext: get("extraContext") || "",
    useLlm: !!form?.elements?.["useLlm"]?.checked,
    level: get("level"),
    size: get("size")
  };
}

/* ----------------------- context-aware visibility ----------------------- */

function wireContextAware(root) {
  const ctx = root.querySelector('[name="context"]');
  const apply = () => updateVisibility(root, ctx?.value);
  ctx?.addEventListener("change", apply);
  apply();
}

function updateVisibility(root, context) {
  for (const field of root.querySelectorAll(".gllg-field[data-for]")) {
    const list = (field.dataset.for || "").split(/\s+/);
    field.style.display = (list.includes("all") || list.includes(context)) ? "" : "none";
  }
}

/* ------------------------------ generation ------------------------------ */

async function runGeneration(r) {
  const opts = { tags: {} };
  if (r.biome) opts.tags.biomes = [r.biome];
  if (r.faction) opts.tags.factions = [r.faction]; // applies in every context via the tag merge

  if (r.context === CONTEXT.SHOP) {
    opts.tier = r.shopTier || "shop";
    opts.useLlm = !!r.useLlm;                 // rides in meta → drives keeper + signatures
    const n = parseInt(r.items, 10);
    if (Number.isFinite(n) && n > 0) opts.maxItems = Math.min(40, n);
  } else if (r.context === CONTEXT.SINGLE) {
    opts.kind = r.kind || "any";
    const il = parseInt(r.itemLevel, 10);
    if (Number.isFinite(il)) opts.itemLevel = Math.min(25, Math.max(0, il));
  } else {
    if (r.context === CONTEXT.COMBAT && r.threat && r.threat !== "auto") opts.threat = r.threat;
    if (r.context !== CONTEXT.COMBAT) opts.tier = r.tier;
    if (r.context === CONTEXT.DUNGEON) opts.rooms = r.rooms;
    const n = parseInt(r.items, 10);
    if (Number.isFinite(n) && n > 0) opts.maxItems = Math.min(30, n);
  }

  // Optional GM overrides — only applied when filled (blank = auto-detect).
  const lvl = parseInt(r.level, 10);
  if (Number.isFinite(lvl) && lvl > 0) opts.partyLevel = Math.min(20, lvl);
  const size = parseInt(r.size, 10);
  if (Number.isFinite(size) && size > 0) opts.partySize = size;

  let request;
  try { request = buildRequest(r.context, opts); }
  catch (e) { return ui.notifications?.error(`GLLG: ${e.message}`); }

  // Per-generation context note rides in meta (plain object → survives the flag)
  // so the decorator can hand it to the LLM alongside the world campaign blurb.
  const note = String(r.extraContext ?? "").trim();
  if (note) request.meta.extraContext = note.slice(0, 600);

  // Shops are budget-neutral, so a 0 budget is expected there — only warn for
  // the budget-driven contexts.
  if (!request.budgetGp && r.context !== CONTEXT.SINGLE && r.context !== CONTEXT.SHOP) {
    ui.notifications?.warn("GLLG: computed budget is 0 — check party level and (for combat) your token selection.");
  }

  const isShop = r.context === CONTEXT.SHOP;
  const useLlm = !!r.useLlm && (flavorEnabled() || (isShop && workshopEnabled()));

  // LLM enrichment can take a few seconds — show a working card while it runs.
  // For shops the LLM also drives the STOCK itself (the buyer profile, DESIGN
  // §18), which happens inside proposeLoot, so the progress card must wrap both
  // the proposal and the decoration when the LLM is in play.
  let proposal;
  if (useLlm) {
    const progress = await beginProgress({
      title: isShop ? "Stocking the shop…" : "Adding LLM flavor…",
      detail: r.context === CONTEXT.SHOP ? "Shop proposal" : "Loot proposal"
    });
    try {
      proposal = await proposeLoot(request);
      await decorateProposal(proposal);          // optional LLM layer; graceful if it fails
    } finally { await endProgress(progress); }
  } else {
    proposal = await proposeLoot(request);
  }
  await postReviewCard(proposal);
  const noun = isShop ? "shop" : "loot";
  ui.notifications?.info(`GLLG: ${noun} proposal posted to chat (${proposal.itemCount} items, ${Math.round(proposal.totalGp)} gp).`);
}

/* -------------------------------- helpers -------------------------------- */

function sel(name, values, selected, labelFn) {
  const opts = values.map(v =>
    `<option value="${attr(v)}" ${v === selected ? "selected" : ""}>${esc(labelFn ? labelFn(v) : v)}</option>`).join("");
  return `<select name="${attr(name)}">${opts}</select>`;
}
function localize(key) { return game.i18n?.localize?.(key) ?? key; }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function attr(s) { return esc(s).replace(/`/g, "&#96;"); }
