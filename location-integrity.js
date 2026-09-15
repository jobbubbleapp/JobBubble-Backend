'use strict';

const STREET_TYPES = new Map([
  ['st','st'],['street','st'],['ave','ave'],['avenue','ave'],['rd','rd'],['road','rd'],
  ['blvd','blvd'],['boulevard','blvd'],['dr','dr'],['drive','dr'],['ln','ln'],['lane','ln'],
  ['way','way'],['ct','ct'],['court','ct'],['pl','pl'],['place','pl'],['pkwy','pkwy'],
  ['parkway','pkwy'],['hwy','hwy'],['highway','hwy'],['cir','cir'],['circle','cir'],
  ['ter','ter'],['terrace','ter']
]);

const DIRECTION_WORDS = new Map([
  ['north','n'],['south','s'],['east','e'],['west','w'],
  ['northeast','ne'],['north east','ne'],['northwest','nw'],['north west','nw'],
  ['southeast','se'],['south east','se'],['southwest','sw'],['south west','sw'],
  ['n','n'],['s','s'],['e','e'],['w','w'],['ne','ne'],['nw','nw'],['se','se'],['sw','sw']
]);

const STATE_NAMES = new Map([
  ['alabama','AL'],['alaska','AK'],['arizona','AZ'],['arkansas','AR'],['california','CA'],
  ['colorado','CO'],['connecticut','CT'],['delaware','DE'],['florida','FL'],['georgia','GA'],
  ['hawaii','HI'],['idaho','ID'],['illinois','IL'],['indiana','IN'],['iowa','IA'],['kansas','KS'],
  ['kentucky','KY'],['louisiana','LA'],['maine','ME'],['maryland','MD'],['massachusetts','MA'],
  ['michigan','MI'],['minnesota','MN'],['mississippi','MS'],['missouri','MO'],['montana','MT'],
  ['nebraska','NE'],['nevada','NV'],['new hampshire','NH'],['new jersey','NJ'],['new mexico','NM'],
  ['new york','NY'],['north carolina','NC'],['north dakota','ND'],['ohio','OH'],['oklahoma','OK'],
  ['oregon','OR'],['pennsylvania','PA'],['rhode island','RI'],['south carolina','SC'],
  ['south dakota','SD'],['tennessee','TN'],['texas','TX'],['utah','UT'],['vermont','VT'],
  ['virginia','VA'],['washington','WA'],['west virginia','WV'],['wisconsin','WI'],['wyoming','WY'],
  ['district of columbia','DC']
]);

function cleanText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWords(value) {
  let out = cleanText(value).toLowerCase()
    .replace(/[.]/g, '')
    .replace(/[^a-z0-9#\-, ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Longest directional forms first so "south east" is not partially rewritten.
  const replacements = Array.from(DIRECTION_WORDS.entries())
    .filter(([from]) => from.length > 2)
    .sort((a,b) => b[0].length - a[0].length);
  for (const [from,to] of replacements) {
    out = out.replace(new RegExp('\\b' + from.replace(/ /g,'\\s+') + '\\b','g'), to);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function extractStreetAddress(text) {
  const plain = cleanText(String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&'));
  if (!plain) return null;

  const dir = '(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West|Northeast|Northwest|Southeast|Southwest|North\\s+East|North\\s+West|South\\s+East|South\\s+West)';
  const type = '(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway|cir|circle|ter|terrace)';
  const rx = new RegExp(
    '\\b\\d{1,6}[A-Za-z]?\\s+(?:' + dir + '\\s+)?[A-Za-z0-9.\'#&\\- ]{1,55}?\\s' +
    type + '\\b(?:\\s+' + dir + ')?(?:\\s*(?:,|#|suite|ste|unit)\\s*[A-Za-z0-9.\\- ]{0,30})?',
    'i'
  );
  const match = plain.match(rx);
  return match ? match[0].trim() : null;
}

function directionToken(token) {
  return DIRECTION_WORDS.get(String(token || '').toLowerCase()) || null;
}

function streetSignature(value) {
  const normalized = normalizeWords(value);
  const firstSegment = normalized.split(',')[0].trim();
  const tokens = firstSegment.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const house = (tokens[0].match(/^\d{1,6}[a-z]?$/) || [])[0] || '';
  if (!house) return null;

  let typeIndex = -1;
  for (let i = 1; i < tokens.length; i++) {
    if (STREET_TYPES.has(tokens[i])) { typeIndex = i; break; }
  }
  if (typeIndex < 0) return null;

  const type = STREET_TYPES.get(tokens[typeIndex]);
  const dirs = new Set();
  const name = [];
  for (let i = 1; i < tokens.length; i++) {
    if (i === typeIndex) continue;
    const d = directionToken(tokens[i]);
    if (d) dirs.add(d);
    else if (!['suite','ste','unit'].includes(tokens[i]) && !tokens[i].startsWith('#')) name.push(tokens[i]);
  }
  return { house, type, dirs: Array.from(dirs).sort(), name };
}

function requestedState(address) {
  const x = normalizeWords(address);
  for (const [name, code] of STATE_NAMES) {
    if (new RegExp('(?:^|,|\\s)' + name.replace(/ /g,'\\s+') + '(?:,|\\s|$)', 'i').test(x)) return code;
  }
  const segments = cleanText(address).split(',').map((s) => s.trim()).filter(Boolean);
  for (const segment of segments.slice(1)) {
    const m = segment.match(/\b([A-Z]{2})\b/);
    if (m && Array.from(STATE_NAMES.values()).includes(m[1])) return m[1];
  }
  return '';
}

function requestedPostcode(address) {
  const m = cleanText(address).match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : '';
}

function resultStreetText(result) {
  const line1 = cleanText(result?.address_line1 || '');
  if (line1 && /\d/.test(line1)) return line1;
  const house = cleanText(result?.housenumber || result?.house_number || '');
  const street = cleanText(result?.street || result?.road || '');
  if (house && street) return `${house} ${street}`;
  const formatted = cleanText(result?.formatted || '');
  return formatted.split(',')[0].trim();
}

function sameTokenSet(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function geocoderResultMatchesAddress(address, result) {
  const want = streetSignature(address);
  const got = streetSignature(resultStreetText(result));
  if (!want || !got) return false;

  if (want.house !== got.house) return false;
  if (want.type !== got.type) return false;

  const wantedName = new Set(want.name);
  const gotName = new Set(got.name);
  if (!wantedName.size || Array.from(wantedName).some((token) => !gotName.has(token))) return false;

  // Directionals are identity-bearing parts of many US street names. Never accept
  // SE as SW, N as S, etc. If the provider omitted a directional but the geocoder
  // had to add one, the address is ambiguous and must remain approximate.
  if (!sameTokenSet(want.dirs, got.dirs)) return false;

  const wantState = requestedState(address);
  const gotState = String(result?.state_code || '').toUpperCase() || requestedState(result?.formatted || '');
  if (wantState && gotState && wantState !== gotState) return false;

  const wantZip = requestedPostcode(address);
  const gotZip = String(result?.postcode || '').match(/^\d{5}/)?.[0] || requestedPostcode(result?.formatted || '');
  if (wantZip && gotZip && wantZip !== gotZip) return false;

  return true;
}

module.exports = {
  extractStreetAddress,
  geocoderResultMatchesAddress,
  streetSignature,
  resultStreetText
};
