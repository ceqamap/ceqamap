import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StyleSpecification } from 'maplibre-gl';
import { PALETTES, paperify, roleFor } from './paperify.ts';

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
    const by = Object.fromEntries(out.layers.map((l) => [l.id, l])) as Record<string, any>;
    assert.equal(by.background.paint['background-color'], PALETTES.paper.background);
    assert.equal(by.water.paint['fill-color'], PALETTES.paper.water);
    assert.equal(by.water.paint['fill-pattern'], undefined);
    assert.equal(by.poi_r1.layout.visibility, 'none');
    assert.equal(by.mystery.paint['circle-color'], '#f00');
  });
});
