/**
 * Curated-but-extensible theming vocabulary (DESIGN §7, §17).
 *
 * Creature traits come from PF2e's own fixed list (read off tokens), so they
 * aren't enumerated here. Biomes and faction archetypes are GLLG's stable keys:
 * they keep the weighting maps and the future LLM prompt crisp. Keys are the
 * machine identity (used in flags/weights); the value is the localization key.
 * GMs may layer arbitrary `custom` tags at request time without touching this.
 */

/** ~12 biome/region archetypes. */
export const BIOMES = {
  arctic:      "GLLG.biome.arctic",
  coast:       "GLLG.biome.coast",
  desert:      "GLLG.biome.desert",
  forest:      "GLLG.biome.forest",
  swamp:       "GLLG.biome.swamp",
  mountain:    "GLLG.biome.mountain",
  plains:      "GLLG.biome.plains",
  underground: "GLLG.biome.underground",
  darklands:   "GLLG.biome.darklands",
  urban:       "GLLG.biome.urban",
  planar:      "GLLG.biome.planar",
  aquatic:     "GLLG.biome.aquatic"
};

/** ~12 faction/organization archetypes. */
export const FACTIONS = {
  cult:          "GLLG.faction.cult",
  thievesGuild:  "GLLG.faction.thievesGuild",
  knightlyOrder: "GLLG.faction.knightlyOrder",
  merchantHouse: "GLLG.faction.merchantHouse",
  arcaneAcademy: "GLLG.faction.arcaneAcademy",
  druidicCircle: "GLLG.faction.druidicCircle",
  undeadLegion:  "GLLG.faction.undeadLegion",
  fiendishPact:  "GLLG.faction.fiendishPact",
  giantClan:     "GLLG.faction.giantClan",
  pirateCrew:    "GLLG.faction.pirateCrew",
  royalCourt:    "GLLG.faction.royalCourt",
  wilderness:    "GLLG.faction.wilderness"
};

export function isBiome(key) {
  return Object.prototype.hasOwnProperty.call(BIOMES, key);
}
export function isFaction(key) {
  return Object.prototype.hasOwnProperty.call(FACTIONS, key);
}
