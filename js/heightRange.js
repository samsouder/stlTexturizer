/* Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { THREE } from './threeCompat.js';

function fadeDistance(settings) {
  const resolution = Math.max(settings.refineLength || 1, 1e-6);
  return settings.heightMin != null && settings.heightMax != null
    ? Math.max(1e-6, Math.min(resolution, (settings.heightMax - settings.heightMin) / 2))
    : resolution;
}

// Height is measured from the lowest point of the original, oriented model.
// At an interior limit, taper to zero over one output edge length so that
// textured and untouched triangles meet without a crack.
export function heightWeight(z, bounds, settings) {
  const h = z - bounds.min.z;
  const min = settings.heightMin, max = settings.heightMax;
  if ((min != null && h < min) || (max != null && h > max)) return 0;
  const fade = fadeDistance(settings);
  let w = 1;
  if (min != null && min > 0) w = Math.min(w, Math.max(0, Math.min(1, (h - min) / fade)));
  if (max != null && max < bounds.size.z) w = Math.min(w, Math.max(0, Math.min(1, (max - h) / fade)));
  return w;
}

// Cut triangles at the height planes before displacement. Without these cuts,
// interpolation across an edge would carry displacement outside the range.
// All per-corner attributes and source-face IDs follow the generated triangles.
export function splitAtHeightLimits(geometry, parents, bounds, settings) {
  const { heightMin: min, heightMax: max } = settings;
  const fade = fadeDistance(settings);
  // Also cut at the inner edge of the fade (and the midpoint of a narrow
  // band), so even a band narrower than an original triangle gets samples.
  const candidates = [min, max];
  if (min != null && min > 0) candidates.push(Math.min(min + fade, max ?? bounds.size.z));
  if (max != null && max < bounds.size.z) candidates.push(Math.max(max - fade, min ?? 0));
  if (min != null && max != null && max - min <= 2 * fade) candidates.push((min + max) / 2);
  const planes = [...new Set(candidates.filter(h => h != null && h > 0 && h < bounds.size.z))]
    .sort((a, b) => a - b).map(h => bounds.min.z + h);
  if (!planes.length) return { geometry, parents };
  const attrs = Object.entries(geometry.attributes);
  const replacements = new Map();
  let addedFaces = 0;
  const pos = geometry.attributes.position;
  const copyVertex = i => Object.fromEntries(attrs.map(([name, attr]) =>
    [name, Array.from({ length: attr.itemSize }, (_, k) => attr.array[i * attr.itemSize + k])]));
  const interpolate = (a, b, t, plane) => {
    const v = {};
    for (const [name, attr] of attrs) v[name] = Array.from({ length: attr.itemSize }, (_, k) => a[name][k] + t * (b[name][k] - a[name][k]));
    v.position[2] = plane;
    if (v.normal) {
      const length = Math.hypot(...v.normal) || 1;
      v.normal = v.normal.map(n => n / length);
    }
    return v;
  };
  const clip = (poly, plane, above) => {
    const result = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = a.position[2] - plane, db = b.position[2] - plane;
      const ina = above ? da >= 0 : da <= 0, inb = above ? db >= 0 : db <= 0;
      if (ina) result.push(a);
      if (ina !== inb && da !== 0 && db !== 0) result.push(interpolate(a, b, da / (da - db), plane));
    }
    return result;
  };
  for (let face = 0; face < pos.count / 3; face++) {
    const z0 = pos.getZ(face * 3), z1 = pos.getZ(face * 3 + 1), z2 = pos.getZ(face * 3 + 2);
    if (!planes.some(plane => Math.min(z0, z1, z2) < plane && Math.max(z0, z1, z2) > plane)) continue;
    let polygons = [[copyVertex(face * 3), copyVertex(face * 3 + 1), copyVertex(face * 3 + 2)]];
    for (const plane of planes) {
      const next = [];
      for (const poly of polygons) {
        const zs = poly.map(v => v.position[2]);
        if (Math.min(...zs) < plane && Math.max(...zs) > plane) {
          next.push(clip(poly, plane, false), clip(poly, plane, true));
        } else next.push(poly);
      }
      polygons = next;
    }
    const triangles = [];
    for (const poly of polygons) for (let i = 1; i + 1 < poly.length; i++) triangles.push(poly[0], poly[i], poly[i + 1]);
    replacements.set(face, triangles);
    addedFaces += triangles.length / 3 - 1;
  }
  if (!addedFaces) return { geometry, parents };
  const faceCount = pos.count / 3 + addedFaces;
  const out = Object.fromEntries(attrs.map(([name, attr]) => [name, new attr.array.constructor(faceCount * 3 * attr.itemSize)]));
  const parentOut = new Int32Array(faceCount);
  let vertex = 0, faceOut = 0;
  for (let face = 0; face < pos.count / 3; face++) {
    const replacement = replacements.get(face);
    if (replacement) {
      for (const v of replacement) {
        for (const [name, attr] of attrs) out[name].set(v[name], vertex * attr.itemSize);
        vertex++;
      }
      for (let i = 0; i < replacement.length / 3; i++) parentOut[faceOut++] = parents[face];
    } else {
      for (const [name, attr] of attrs) {
        const offset = face * 3 * attr.itemSize;
        out[name].set(attr.array.subarray(offset, offset + 3 * attr.itemSize), vertex * attr.itemSize);
      }
      vertex += 3;
      parentOut[faceOut++] = parents[face];
    }
  }
  const result = new THREE.BufferGeometry();
  for (const [name, attr] of attrs) result.setAttribute(name, new THREE.BufferAttribute(out[name], attr.itemSize, attr.normalized));
  return { geometry: result, parents: parentOut };
}
