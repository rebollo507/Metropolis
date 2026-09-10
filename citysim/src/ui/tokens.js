/**
 * The design system, as data.
 *
 * One type scale, one spacing scale, one radius set, one elevation model, one
 * accent. Everything the UI draws resolves to a token in here — nothing in a
 * component file is allowed to invent a colour or a size.
 *
 * Palette note: the chart series colours are the dataviz reference palette's
 * DARK steps, re-validated against *this* surface (#121820) rather than the
 * skill's default #1a1a19:
 *
 *   node scripts/validate_palette.js "#3987e5,#d95926,#199e70,#c98500" \
 *        --mode dark --surface "#121820"           → all checks PASS
 *   ... same three-slot set with --pairs all       → all checks PASS
 *
 * The RCI mapping (R=aqua-green, C=blue, I=orange) follows the entity, not its
 * rank, and matches the zoning module's own hue families without borrowing its
 * exact hexes — those failed the CVD gate (green↔orange ΔE 3.7 protan).
 */

export const TOKENS = {
  /* ---- type: one scale, 10 → 26, and only two weights (the shipped font
     families here carry Regular + Bold only, so 500/600 would synthesise
     unpredictably; hierarchy comes from size, colour and tracking) ---- */
  font: '"Liberation Sans", Carlito, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  type: { micro: 10, xs: 11, sm: 12, md: 13, lg: 15, xl: 18, hero: 26 },

  /* ---- spacing: base 4, with 2 and 6 for dense chrome ---- */
  space: [0, 2, 4, 6, 8, 12, 16, 20, 24, 32],

  /* ---- radius + elevation ---- */
  radius: { xs: 3, sm: 6, md: 10, lg: 14, pill: 999 },

  /* ---- colour ---- */
  ink: { 0: '#f2f6fb', 1: '#aebbcd', 2: '#7d8a9c', 3: '#5c6879' },
  accent: '#5cb3f2',
  accentInk: '#06121d',

  /** The effective chart surface: what a viewer sees through the panel glass. */
  surface: '#121820',

  /** dataviz status palette — fixed, never themed, always shipped with a label. */
  status: {
    good: '#0ca30c',
    warning: '#fab219',
    serious: '#ec835a',
    critical: '#d03b3b',
  },

  /** dataviz categorical slots, dark steps. Assigned in fixed order, never cycled. */
  series: ['#3987e5', '#d95926', '#199e70', '#c98500'],
};

/**
 * Zone identity — one definition, shared by the dock swatches, the overlay
 * legend and the inspector's tag, so "commercial" is the same blue everywhere.
 * These are the zoning module's own published hues (`zoning/Palette.js`).
 */
export const ZONE_COLOR = {
  1: '#b6e34a', 2: '#2f8f1f', 3: '#3fb4e8', 4: '#1b46b4',
  5: '#f5991a', 6: '#00b7c9', 7: '#d8efa4', 8: '#cf5ce0',
};
export const ZONE_SWATCH = {
  res_low: ZONE_COLOR[1], res_high: ZONE_COLOR[2], com_low: ZONE_COLOR[3],
  com_high: ZONE_COLOR[4], industrial: ZONE_COLOR[5], office: ZONE_COLOR[6],
  park: ZONE_COLOR[7], civic: ZONE_COLOR[8],
};

/** Demand / zone identity — colour follows the entity. */
export const RCI = {
  r: { key: 'r', label: 'Residential', color: '#199e70' },
  c: { key: 'c', label: 'Commercial', color: '#3987e5' },
  i: { key: 'i', label: 'Industrial', color: '#d95926' },
};

export default TOKENS;
