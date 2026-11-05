/* Copyright (c) 2026 CNCKitchen (Stefan Hermann) and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { heightWeight, splitAtHeightLimits } from '../js/heightRange.js';
import { runExportPipeline } from '../js/exportPipeline.js';
import { runPreviewPipeline } from '../js/previewPipeline.js';
import { countEdgeDefects } from '../js/meshRepair.js';

const bounds = { min: new THREE.Vector3(-5, -5, -5), max: new THREE.Vector3(5, 5, 5), size: new THREE.Vector3(10, 10, 10), center: new THREE.Vector3() };
const settings = { heightMin: 2, heightMax: 8, refineLength: 1 };

test('height range uses the model bottom and fades only at interior limits', () => {
  assert.equal(heightWeight(-4, bounds, settings), 0);
  assert.equal(heightWeight(-3, bounds, settings), 0);
  assert.equal(heightWeight(-2.5, bounds, settings), 0.5);
  assert.equal(heightWeight(0, bounds, settings), 1);
  assert.equal(heightWeight(3, bounds, settings), 0);
  assert.equal(heightWeight(4, bounds, settings), 0);
  assert.equal(heightWeight(-5, bounds, { heightMin: 0, heightMax: 10 }), 1);
  assert.equal(heightWeight(5, bounds, {}), 1);
});

test('height cuts preserve attributes, winding, area and parent mapping', () => {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -5, 4, 0, 5, 0, 0, 5], 3));
  geo.setAttribute('weight', new THREE.Float32BufferAttribute([0, 1, 1], 1));
  const cut = splitAtHeightLimits(geo, new Int32Array([7]), bounds, settings);
  const p = cut.geometry.attributes.position.array, w = cut.geometry.attributes.weight.array;
  assert.ok(cut.parents.length > 1);
  assert.ok([...cut.parents].every(n => n === 7));
  let area = 0;
  for (let i = 0; i < p.length; i += 9) {
    const zs = [p[i+2], p[i+5], p[i+8]];
    for (const plane of [-3, 3]) assert.ok(!(Math.min(...zs) < plane && Math.max(...zs) > plane));
    const a = new THREE.Vector3().fromArray(p, i), b = new THREE.Vector3().fromArray(p, i+3), c = new THREE.Vector3().fromArray(p, i+6);
    const cross = b.sub(a).cross(c.sub(a));
    assert.ok(cross.y < 0); // original winding
    area += cross.length() / 2;
  }
  assert.ok(Math.abs(area - 20) < 1e-5);
  for (let i = 0; i < w.length; i++) assert.ok(Math.abs(w[i] - (p[i*3+2] + 5) / 10) < 1e-6);
});

test('export pipeline displaces the selected band and leaves exterior cube faces in place', async () => {
  const geo = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  const opts = { ...settings, mappingMode: 5, scaleU: 5, scaleV: 5, amplitude: 1, offsetU: 0, offsetV: 0, rotation: 0,
    maxTriangles: 100000, bottomAngleLimit: 0, topAngleLimit: 0, mappingBlend: 1, seamBandWidth: 0.5,
    blendNormalSmoothing: 0, boundaryFalloff: 0, regularizeEnabled: false, harvestFlatFaces: false, preserveUntextured: true };
  const result = await runExportPipeline({ mode: 'bake', positions: geo.attributes.position.array,
    imageData: { data: new Uint8ClampedArray([255, 255, 255, 255]) }, imgWidth: 1, imgHeight: 1, bounds, settings: opts });
  let moved = 0, exterior = 0;
  for (let i = 0; i < result.positions.length; i += 3) {
    const x = result.positions[i], y = result.positions[i+1], z = result.positions[i+2];
    if (z < -3.0001 || z > 3.0001) {
      exterior++;
      assert.ok(Math.abs(x) <= 5.0001 && Math.abs(y) <= 5.0001 && Math.abs(z) <= 5.0001);
    }
    if (z > -2.9 && z < 2.9 && (Math.abs(x) > 5.01 || Math.abs(y) > 5.01)) moved++;
  }
  assert.ok(exterior > 0);
  assert.ok(moved > 0, 'some vertices within the band must move');
  assert.equal(result.faceParentId.length, result.positions.length / 9);
  const displaced = new THREE.BufferGeometry();
  displaced.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
  const defects = countEdgeDefects(displaced);
  assert.equal(defects.open, 0);
  assert.equal(defects.nonManifold, 0);
});

test('a band narrower than the export resolution still receives displacement', async () => {
  const geo = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  const opts = { ...settings, heightMin: 4.91, heightMax: 5.09, refineLength: 2,
    mappingMode: 5, scaleU: 5, scaleV: 5, amplitude: 1, offsetU: 0, offsetV: 0, rotation: 0,
    maxTriangles: 100000, bottomAngleLimit: 0, topAngleLimit: 0, mappingBlend: 1, seamBandWidth: 0.5,
    blendNormalSmoothing: 0, boundaryFalloff: 0, regularizeEnabled: false, harvestFlatFaces: false };
  const result = await runExportPipeline({ mode: 'bake', positions: geo.attributes.position.array,
    imageData: { data: new Uint8ClampedArray([255, 255, 255, 255]) }, imgWidth: 1, imgHeight: 1, bounds, settings: opts });
  let moved = 0;
  for (let i = 0; i < result.positions.length; i += 3) {
    const [x, y, z] = result.positions.subarray(i, i + 3);
    if (z > -0.09 && z < 0.09 && (Math.abs(x) > 5.001 || Math.abs(y) > 5.001)) moved++;
  }
  assert.ok(moved > 0);
});


test('preview mesh includes samples inside a narrow height band', async () => {
  const geo = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  const result = await runPreviewPipeline({ positions: geo.attributes.position.array,
    normals: geo.attributes.normal.array, floorEdge: 2, maxEdge: 2, triBudget: 100000,
    regularize: false, bounds, heightSettings: { heightMin: 4.91, heightMax: 5.09, refineLength: 2 } });
  assert.ok(Array.from(result.positions).some((value, i) => i % 3 === 2 && Math.abs(value) < 0.001));
  assert.equal(result.faceParentId.length, result.positions.length / 9);
});

test('decimated export remains watertight and retains the height boundary', async () => {
  const geo = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  const opts = { ...settings, mappingMode: 5, scaleU: 5, scaleV: 5, amplitude: 0.3, offsetU: 0, offsetV: 0, rotation: 0,
    maxTriangles: 250, bottomAngleLimit: 0, topAngleLimit: 0, mappingBlend: 1, seamBandWidth: 0.5,
    blendNormalSmoothing: 0, boundaryFalloff: 0, regularizeEnabled: false, harvestFlatFaces: true, harvestTol: 0.005,
    preserveUntextured: true };
  const result = await runExportPipeline({ positions: geo.attributes.position.array,
    imageData: { data: new Uint8ClampedArray([255, 255, 255, 255]) }, imgWidth: 1, imgHeight: 1, bounds, settings: opts });
  assert.equal(result.runDecimation, true);
  assert.equal(result.repairStats.open, 0);
  assert.equal(result.repairStats.nonManifold, 0);
  for (let i = 0; i < result.positions.length; i += 3) {
    const [x, y, z] = result.positions.subarray(i, i + 3);
    if (z < -3.0001 || z > 3.0001) assert.ok(Math.abs(x) <= 5.0001 && Math.abs(y) <= 5.0001 && Math.abs(z) <= 5.0001);
  }
});
