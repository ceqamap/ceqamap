import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findLandmark, type Gazetteer, nameMentions, parseGnis } from '../src/lib/landmarks.ts';

const SD = { counties: ['san diego'], isPlaceName: (k: string) => k === 'san diego' || k === 'oceanside' };

const g: Gazetteer = {
  source: 'test',
  names: {
    'shelter island': [{ n: 'Shelter Island', c: 'Island', k: 'san diego', lon: -117.2266, lat: 32.7155 }],
    'la playa': [{ n: 'La Playa', c: 'Beach', k: 'san diego', lon: -117.231, lat: 32.718 }],
    'ocean beach': [{ n: 'Ocean Beach', c: 'Populated Place', k: 'san diego', lon: -117.2495, lat: 32.7473 }],
    'san pedro': [{ n: 'San Pedro', c: 'Populated Place', k: 'los angeles', lon: -118.29, lat: 33.736 }],
    'red hill': [
      { n: 'Red Hill', c: 'Summit', k: 'san diego', lon: -117.0, lat: 33.0 },
      { n: 'Red Hill', c: 'Summit', k: 'san diego', lon: -116.5, lat: 32.8 },
    ],
    'otay mountain': [{ n: 'Otay Mountain', c: 'Summit', k: 'san diego', lon: -116.8446, lat: 32.5946 }],
    'palomar mountain': [{ n: 'Palomar Mountain', c: 'Summit', k: 'san diego', lon: -116.86, lat: 33.36 }],
  },
};

describe('nameMentions', () => {
  it('finds Title Case runs, with connectors inside but not at the ends', () => {
    const m = nameMentions(['place sand at La Playa Beach, Shelter Island.']).map((x) => x.text);
    assert.ok(m.includes('La Playa Beach'));
    assert.ok(m.includes('La Playa'));
    assert.ok(m.includes('Shelter Island'));
    assert.ok(!m.some((x) => x.includes(',')));
  });

  it('skips street and agency names', () => {
    const m = nameMentions(['SAN PEDRO STREET SCHOOL near El Toro Road; San Joaquin Hills Corridor Agency']).map(
      (x) => x.text,
    );
    assert.ok(!m.includes('SAN PEDRO'));
    assert.ok(!m.includes('El Toro'));
    assert.ok(!m.includes('San Joaquin Hills'));
  });
});

describe('findLandmark', () => {
  it('places the yacht club dredging project at La Playa / Shelter Island', () => {
    const r = findLandmark(
      [
        'Right of Entry License Agreement to Southwestern Yacht Club for Maintenance Dredging',
        'The San Diego Unified Port District proposes ... beach nourishment at La Playa Beach, Shelter Island.',
      ],
      g,
      SD,
    );
    assert.equal(r.kind, 'placed');
    if (r.kind === 'placed') assert.equal(r.placement.featureClass, 'Beach');
  });

  it('prefers a specific site over a community', () => {
    const r = findLandmark(['Ocean Beach pier work near Shelter Island'], g, SD);
    assert.equal(r.kind === 'placed' && r.placement.name, 'Shelter Island');
  });

  it('ignores features outside the listed counties', () => {
    assert.equal(findLandmark(['San Pedro Bluffs'], g, SD).kind, 'none');
  });

  it('skips a name shared by distant features in the county', () => {
    assert.equal(findLandmark(['Red Hill Transfer Station'], g, SD).kind, 'ambiguous');
  });

  it('skips projects naming places far apart', () => {
    assert.equal(findLandmark(['Fire roads from Otay Mountain to Palomar Mountain'], g, SD).kind, 'multi-site');
  });

  it('needs a listed county and stays near a listed city', () => {
    assert.equal(findLandmark(['Shelter Island'], g, { ...SD, counties: [] }).kind, 'none');
    const far = findLandmark(['Shelter Island'], g, { ...SD, distanceToCityKm: () => 30 });
    assert.equal(far.kind, 'far-from-city');
  });
});

describe('parseGnis', () => {
  it('keeps multi-word, point-like California features', () => {
    const text = [
      'feature_id|feature_name|feature_class|state_name|state_numeric|county_name|county_numeric|prim_lat_dec|prim_long_dec',
      '1|Shelter Island|Island|California|06|San Diego|073|32.7155|-117.2266',
      '2|Alpine|Populated Place|California|06|San Diego|073|32.835|-116.766',
      '3|Sweetwater River|Stream|California|06|San Diego|073|32.65|-117.1',
      '4|Lost Spring|Spring|California|06|Inyo|027|0|0',
    ].join('\n');
    const r = parseGnis(text, 'test');
    assert.deepEqual(Object.keys(r.names), ['shelter island']);
    assert.equal(r.names['shelter island'][0].k, 'san diego');
  });
});
