/**
 * Icon-note helper — builds the GM-only "icon prompt" that rides along in every
 * generated item's description (DESIGN: GMs swap art after the fact). The block
 * is a concise, copy-pasteable prompt the GM can hand to an image generator to
 * mint a fitting token/icon for the item.
 *
 * Two sources feed it: an explicit `hint` the LLM may author (workshop
 * `iconPrompt` / decorator `icon`), else a subject synthesized from the item's
 * own facts (name, type, rarity, traits, flavor). Always returns something —
 * even a plain compendium pick gets a usable prompt.
 */

/** Build the plain-text icon-generation prompt for an item. */
export function iconPromptText({ name, type, rarity, traits, flavor, hint } = {}) {
  const subject = hint ? clean(hint, 240) : synthSubject({ name, type, rarity, traits, flavor });
  return `Square fantasy RPG item icon of ${subject}. Single centered subject, dark neutral background, painterly digital art, dramatic rim lighting, crisp high detail, no text, no border.`;
}

/**
 * Wrap an icon prompt in the GM-note HTML block folded into a description. Kept
 * visually distinct (a labelled aside) and HTML-escaped. Returns "" if blank.
 */
export function iconNoteHtml(info = {}) {
  const prompt = iconPromptText(info);
  if (!prompt) return "";
  return `<aside class="gllg-icon-note" data-visibility="gm">`
    + `<p class="gllg-icon-note-head"><i class="fa-solid fa-palette"></i> <strong>GM — icon prompt</strong></p>`
    + `<p class="gllg-icon-note-body">${esc(prompt)}</p>`
    + `</aside>`;
}

/* ------------------------------ helpers ------------------------------ */

function synthSubject({ name, type, rarity, traits, flavor } = {}) {
  const parts = [];
  const nm = clean(name, 80);
  if (nm) parts.push(`"${nm}"`);
  const kind = typeNoun(type);
  if (kind) parts.push(`a ${kind}`);
  const r = clean(rarity, 20);
  if (r && r !== "common") parts.push(`${r} quality`);
  const tr = Array.isArray(traits) ? traits.map(t => clean(t, 24)).filter(Boolean).slice(0, 3) : [];
  if (tr.length) parts.push(`evoking ${tr.join(", ")}`);
  const fl = clean(flavor, 140);
  if (fl) parts.push(fl);
  const subject = parts.join(", ");
  return subject || "a mysterious magical treasure";
}

function typeNoun(type) {
  switch (String(type ?? "").toLowerCase()) {
    case "weapon": return "weapon";
    case "armor": return "suit of armor";
    case "consumable": return "consumable item (potion, scroll, or talisman)";
    case "treasure": return "valuable treasure";
    case "shield": return "shield";
    case "equipment": return "piece of adventuring gear";
    default: return "magic item";
  }
}

function clean(s, max) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
