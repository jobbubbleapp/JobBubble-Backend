'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractStreetAddress,
  extractContextualStreetAddress,
  geocoderResultMatchesAddress,
  streetSignature,
  canRefineAreaToStreet
} = require('../location-integrity');

test('preserves directional suffix from posting text', () => {
  const text = 'Senior Banker location: 1803 112th St SE, Everett, WA 98208. Apply today.';
  assert.equal(extractStreetAddress(text), '1803 112th St SE');
});

test('preserves directional prefix from posting text', () => {
  const text = 'Worksite: 425 N Main Street, Spokane, WA 99201';
  assert.equal(extractStreetAddress(text), '425 N Main Street');
});

test('extracts The Muse pay-transparency workplace line with SE intact', () => {
  const html = `
    <html><body>
      <h1>Senior Banker</h1>
      <p>Pay Transparency details</p>
      <div>US - WA - Everett - 1803 112th St Se - SILVER LAKE BC (WA4138)</div>
      <footer>Company information</footer>
    </body></html>`;
  assert.equal(extractContextualStreetAddress(html, 'Everett, WA'), '1803 112th St Se');
});

test('extracts explicit work-location address from visible posting text', () => {
  const html = '<div>Work location: Everett, WA — 1803 112th Street Southeast. Apply now.</div>';
  assert.equal(extractContextualStreetAddress(html, 'Everett, WA'), '1803 112th Street Southeast');
});

test('does not treat an unrelated footer/contact address as the job workplace', () => {
  const html = '<main>Job in Everett, WA. Great opportunity.</main><footer>1803 112th St SE, Everett, WA</footer>';
  assert.equal(extractContextualStreetAddress(html, 'Everett, WA'), null);
});

test('area-only provider coordinates cannot be promoted to an arbitrary street branch', () => {
  assert.equal(canRefineAreaToStreet({
    location_precision: 'area',
    location_match_provider: 'The Muse search area'
  }), false);
  assert.equal(canRefineAreaToStreet({
    location_precision: 'area',
    location_match_provider: 'Adzuna area estimate'
  }), false);
});

test('specific non-area provider evidence can still use workplace refinement', () => {
  assert.equal(canRefineAreaToStreet({
    location_precision: 'likely',
    location_match_provider: 'Provider branch candidate'
  }), true);
});

test('accepts equivalent expanded directional from geocoder', () => {
  const result = {
    housenumber: '1803',
    street: '112th Street Southeast',
    state_code: 'WA',
    postcode: '98208',
    formatted: '1803 112th Street Southeast, Everett, WA 98208, United States'
  };
  assert.equal(
    geocoderResultMatchesAddress('1803 112th St SE, Everett, WA 98208', result),
    true
  );
});

test('rejects SE to SW geocoder corruption', () => {
  const wrong = {
    housenumber: '1803',
    street: '112th Street Southwest',
    state_code: 'WA',
    postcode: '98204',
    formatted: '1803 112th Street Southwest, Everett, WA 98204, United States'
  };
  assert.equal(
    geocoderResultMatchesAddress('1803 112th St SE, Everett, WA 98208', wrong),
    false
  );
});

test('rejects wrong house number even on the same street', () => {
  const wrong = {
    housenumber: '1730',
    street: '112th Street Southeast',
    state_code: 'WA',
    postcode: '98208'
  };
  assert.equal(geocoderResultMatchesAddress('1803 112th St SE, Everett, WA 98208', wrong), false);
});

test('rejects state mismatch', () => {
  const wrong = {
    housenumber: '1803',
    street: '112th Street Southeast',
    state_code: 'OR',
    postcode: '98208'
  };
  assert.equal(geocoderResultMatchesAddress('1803 112th St SE, Everett, WA 98208', wrong), false);
});

test('rejects ambiguous geocoder-added directional when provider omitted it', () => {
  const result = {
    housenumber: '1803',
    street: '112th Street Southwest',
    state_code: 'WA'
  };
  assert.equal(geocoderResultMatchesAddress('1803 112th St, Everett, WA', result), false);
});

test('street signature treats expanded and abbreviated directionals equivalently', () => {
  assert.deepEqual(
    streetSignature('1803 112th Street Southeast'),
    streetSignature('1803 112th St SE')
  );
});
