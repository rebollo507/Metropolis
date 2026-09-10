import { ZONE } from '../core/World.js';

/**
 * The zoning palette. Hues are the city-builder convention (green residential,
 * blue commercial, teal office, amber industry, orchid civic, mint parks) but
 * every entry is desaturated and value-separated so that eight of them can sit
 * next to each other under AgX tone mapping and still read apart — a saturated
 * primary rainbow turns to mud the moment it is composited at 40% over grass.
 *
 * `hatch` is [angle(rad), period(m), duty, cross] and drives the overlay's
 * per-zone texture so the districts are distinguishable in a greyscale print,
 * not only by hue.
 */

export const ZONE_NAME = {};
for (const [k, v] of Object.entries(ZONE)) ZONE_NAME[v] = k;

export const PALETTE = {
  NONE:     { hex: 0x000000, label: 'Unzoned',             alpha: 0.00, hatch: [0, 12, 0, 0] },
  RES_LOW:  { hex: 0xb6e34a, label: 'Residential · low',   alpha: 0.92, hatch: [0.79, 6.4, 0.34, 0] },
  RES_HIGH: { hex: 0x2f8f1f, label: 'Residential · high',  alpha: 1.00, hatch: [0.79, 4.4, 0.44, 0] },
  COM_LOW:  { hex: 0x3fb4e8, label: 'Commercial · low',    alpha: 0.95, hatch: [-0.79, 6.4, 0.34, 0] },
  COM_HIGH: { hex: 0x1b46b4, label: 'Commercial · high',   alpha: 1.00, hatch: [-0.79, 4.4, 0.44, 1] },
  OFFICE:   { hex: 0x00b7c9, label: 'Office',              alpha: 1.00, hatch: [0.0, 5.4, 0.32, 1] },
  IND:      { hex: 0xf5991a, label: 'Industrial',          alpha: 1.00, hatch: [1.31, 8.6, 0.48, 0] },
  PARK:     { hex: 0xd8efa4, label: 'Park & green',        alpha: 0.66, hatch: [0.26, 10.0, 0.20, 0] },
  CIVIC:    { hex: 0xcf5ce0, label: 'Civic',               alpha: 1.00, hatch: [1.57, 6.0, 0.40, 1] },
  ROAD:     { hex: 0x000000, label: 'Road',                alpha: 0.00, hatch: [0, 12, 0, 0] },
  WATER:    { hex: 0x000000, label: 'Water',               alpha: 0.00, hatch: [0, 12, 0, 0] },
  RESERVED: { hex: 0x000000, label: 'Reserved',            alpha: 0.00, hatch: [0, 12, 0, 0] },
};

/** Zones that actually carry land use (everything else is a mask, not a colour). */
export const PAINTABLE = [
  ZONE.RES_LOW, ZONE.RES_HIGH, ZONE.COM_LOW, ZONE.COM_HIGH,
  ZONE.OFFICE, ZONE.IND, ZONE.PARK, ZONE.CIVIC,
];

export const isLandUse = (z) => z >= ZONE.RES_LOW && z <= ZONE.CIVIC;

/** sRGB bytes for a zone id, pre-graded (slightly lifted so it survives alpha). */
export function rgbOf(zone) {
  const p = PALETTE[ZONE_NAME[zone]] || PALETTE.NONE;
  return [(p.hex >> 16) & 255, (p.hex >> 8) & 255, p.hex & 255];
}

export function alphaOf(zone) {
  const p = PALETTE[ZONE_NAME[zone]] || PALETTE.NONE;
  return p.alpha;
}

/** Legend rows, in display order — `ui` can render this verbatim. */
export function legend() {
  return PAINTABLE.map((z) => {
    const p = PALETTE[ZONE_NAME[z]];
    return { zone: z, key: ZONE_NAME[z], label: p.label, hex: p.hex, css: '#' + p.hex.toString(16).padStart(6, '0') };
  });
}

/** Flat float array [angle, period, duty, cross] * 12, uploaded as a uniform. */
export function hatchTable() {
  const out = new Float32Array(12 * 4);
  for (let z = 0; z < 12; z++) {
    const p = PALETTE[ZONE_NAME[z]] || PALETTE.NONE;
    out[z * 4] = p.hatch[0];
    out[z * 4 + 1] = p.hatch[1];
    out[z * 4 + 2] = p.hatch[2];
    out[z * 4 + 3] = p.hatch[3];
  }
  return out;
}

export default PALETTE;
