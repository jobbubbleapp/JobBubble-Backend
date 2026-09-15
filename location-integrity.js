'use strict';

const STREET_TYPES = new Map([
  ['st','st'],['street','st'],['ave','ave'],['avenue','ave'],['rd','rd'],['road','rd'],
  ['blvd','blvd'],['boulevard','blvd'],['dr','dr'],['drive','dr'],['ln','ln'],['lane','lane'],
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

// Longest alternatives first. This prevents "Southeast" from being accepted as just
// "S" and prevents "SW" from being accepted as just "S".
const DIR_PATTERN = '(?:North\\s+East|North\\s+West|South\\s+East|South\\s+West|Northeast|Northwest|Southeast|Southwest|NE|NW|SE|SW|North|South|East|West|N|S|E|W)';
const TYPE_PATTERN = '(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway|cir|circle|ter|terrace)';
const STREET_PATTERN = '\\b\\d{1,6}[A-Za-z]?\\s+(?:' + DIR_PATTERN + '\\s+)?[A-Za-z0-9.\'#&\\- ]{1,55}?\\s' + TYPE_PATTERN + '\\b(?:\\s+' + DIR_PATTERN + ')?(?:\\s*(?:#|suite|ste|unit)\\s*[A-Za-z0-9.\\- ]{1,30})?';

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
  const replacements = Array.from(DIRECTION_WORDS.entries())
    .filter(([from]) => from.length > 2)
    .sort((a,b) => b[0].length - a[0].length);
  for (const [from,to] of replacements) {
    out = out.replace(new RegExp('\\b' + from.replace(/ /g,'\\s+') + '\\b','g'), to);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function visibleText(value) {
  return cleanText(String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'"));
}

function extractStreetAddress(text) {
  const plain = visibleText(text);
  if (!plain) return null;
  const match = plain.match(new RegExp(STREET_PATTERN, 'i'));
  return match ? match[0].trim() : null;
}

function extractStreetAddressMatches(text) {
  const plain = visibleText(text);
  const rx = new RegExp(STREET_PATTERN, 'ig');
  const matches = [];
  let match;
  while ((match = rx.exec(plain)) && matches.length < 40) {
    matches.push({ address: match[0].trim(), index: match.index, plain });
    if (match.index === rx.lastIndex) rx.lastIndex++;
  }
  return matches;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractContextualStreetAddress(pageText, jobLocation) {
  const matches = extractStreetAddressMatches(pageText);
  if (!matches.length) return null;

  const pieces = cleanText(jobLocation).split(',').map((x) => x.trim()).filter(Boolean);
  const city = pieces[0] || '';
  const state = requestedState(jobLocation) || (pieces[1] && /^[A-Za-z]{2}$/.test(pieces[1]) ? pieces[1].toUpperCase() : '');
  const cityRx = city ? new RegExp('\\b' + escapeRegex(city) + '\\b', 'i') : null;
  const stateRx = state ? new RegExp('\\b' + escapeRegex(state) + '\\b', 'i') : null;

  let best = null;
  for (const match of matches) {
    const start = Math.max(0, match.index - 240);
    const end = Math.min(match.plain.length, match.index + match.address.length + 180);
    const context = match.plain.slice(start, end);
    const hasCity = !cityRx || cityRx.test(context);
    const hasState = !stateRx || stateRx.test(context);
    if (!hasCity || !hasState) continue;

    let score = 0;
    if (cityRx && cityRx.test(context)) score += 30;
    if (stateRx && stateRx.test(context)) score += 20;
    if (/\b(?:work\s*location|worksite|job\s*location|site\s*address|office\s*address|financial\s*center|pay\s*transparency|client-provided\s*location)\b/i.test(context)) score += 35;
    if (city && state) {
      const museMarker = new RegExp('\\bUS\\s*-\\s*' + escapeRegex(state) + '\\s*-\\s*' + escapeRegex(city) + '\\s*-', 'i');
      if (museMarker.test(context)) score += 60;
    }
    if (!best || score > best.score) best = { address: match.address, score };
  }

  // Do not promote an arbitrary footer/contact address. Visible-page fallback is
  // accepted only when the address is tied to explicit workplace/location context.
  return best && best.score >= 65 ? best.address : null;
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
  if (!sameTokenSet(want.dirs, got.dirs)) return false;

  const wantState = requestedState(address);
  const gotState = String(result?.state_code || '').toUpperCase() || requestedState(result?.formatted || '');
  if (wantState && gotState && wantState !== gotState) return false;

  const wantZip = requestedPostcode(address);
  const gotZip = String(result?.postcode || '').match(/^\d{5}/)?.[0] || requestedPostcode(result?.formatted || '');
  if (wantZip && gotZip && wantZip !== gotZip) return false;
  return true;
}

function canRefineAreaToStreet(job) {
  const precision = String(job?.location_precision || '').toLowerCase();
  const provider = String(job?.location_match_provider || '').toLowerCase();
  if (!precision || precision === 'area') return false;
  if (/search area|area estimate|geoapify area/.test(provider)) return false;
  return true;
}

module.exports = {
  extractStreetAddress,
  extractContextualStreetAddress,
  geocoderResultMatchesAddress,
  streetSignature,
  resultStreetText,
  canRefineAreaToStreet
};
