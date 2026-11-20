import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StyleSpecification } from 'maplibre-gl';
import { labelOverlay, PALETTES, paperify, roleFor } from './paperify.ts';

type Layer = { paint: Record<string, unknown>; layout?: Record<string, unknown> };

describe('paperify', () => {
  it('assigns roles from OpenMapTiles layer ids and source layers', () => {
    assert.equal(roleFor({ id: 'background', type: 'background' }), 'background');
    assert.equal(roleFor({ id: 'water', type: 'fill', 'source-layer': 'water' }), 'water');
    assert.equal(roleFor({ id: 'highway_motorway', type: 'line', 'source-layer': 'transportation' }), 'roadMajor');
    assert.equal(roleFor({ id: 'highway_minor', type: 'line', 'source-layer': 'transportation' }), 'roadMinor');
    assert.equal(roleFor({ id: 'place_city', type: 'symbol' }), 'labelStrong');
    assert.equal(roleFor({ id: 'place_village', type: 'symbol' }), 'label');
    assert.equal(roleFor({ id: 'mystery', type: 'circle' }), null);
  });

  it('recolors known layers, hides POIs, and leaves unknown layers alone', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
        {
          id: 'water',
          type: 'fill',
          source: 'x',
          'source-layer': 'water',
          paint: { 'fill-color': '#00f', 'fill-pattern': 'p' },
        },
        { id: 'poi_r1', type: 'symbol', source: 'x', 'source-layer': 'poi' },
        { id: 'mystery', type: 'circle', source: 'x', paint: { 'circle-color': '#f00' } },
      ],
    } as unknown as StyleSpecification;
    const out = paperify(style, 'paper');
    const by = Object.fromEntries(out.layers.map((l) => [l.id, l])) as Record<string, Layer>;
    assert.equal(by.background.paint['background-color'], PALETTES.paper.background);
    assert.equal(by.water.paint['fill-color'], PALETTES.paper.water);
    assert.equal(by.water.paint['fill-pattern'], undefined);
    assert.equal(by.poi_r1.layout?.visibility, 'none');
    assert.equal(by.mystery.paint['circle-color'], '#f00');
  });

  it('builds a label overlay that keeps names, major roads and boundaries only', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [
        { id: 'background', type: 'background' },
        { id: 'water', type: 'fill', source: 'x', 'source-layer': 'water' },
        { id: 'highway_motorway', type: 'line', source: 'x', paint: { 'line-color': '#fff', 'line-width': 2 } },
        { id: 'highway_minor', type: 'line', source: 'x' },
        { id: 'boundary_state', type: 'line', source: 'x' },
        { id: 'place_city', type: 'symbol', source: 'x', layout: { 'text-field': '{name}', 'icon-image': 'dot' } },
        { id: 'poi_r1', type: 'symbol', source: 'x', layout: { 'text-field': '{name}' } },
      ],
    } as unknown as StyleSpecification;
    const out = labelOverlay(style) as unknown as (Layer & { id: string })[];
    assert.deepEqual(out.map((l) => l.id), ['labels-highway_motorway', 'labels-boundary_state', 'labels-place_city']);
    assert.equal(out[2].paint['text-color'], '#ffffff');
    assert.equal(out[2].layout?.['icon-image'], undefined);
    assert.equal(out[0].paint['line-width'], 2);
  });
});
