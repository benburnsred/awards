/**
 * Anime X Angas Awards — Google Sheets backend and admin dashboard (2026 onwards).
 *
 * Bound to a private Google Sheet (Extensions → Apps Script) holding one edition. Two web app deployments of
 * this same script (see README.md):
 *   Public — Execute as: Me · Who has access: Anyone. Accepts ballots from the public ballot page.
 *   Admin  — Execute as: User accessing · Who has access: Anyone with Google account.
 *            ?page=admin  admin dashboard: manage the official ballot, results, data check, settings, publish.
 *            Admins must be listed in the Committee tab with role admin and have edit access to the Sheet.
 *
 * Categories and nominees are agreed by the committee outside this tool (a shared spreadsheet) and entered in the
 * admin dashboard by an admin.
 *
 * Tabs (created by setup()):
 *   Settings   — key | value                 (title, date, vote_open, reveal_winners, …)
 *   Categories — id | name | description | type | method | max_picks | opens | closes | order | locked
 *                (opens/closes are unused: the voting window is the voting_opens / voting_closes settings)
 *                locked: TRUE once published with nominees — nominees and voting method can't change until unlocked
 *                type: vote (public ballot) or special (committee picks the winner, not on the ballot)
 *                method: tier, single, multi or rank (see METHODS)
 *   Nominees   — id | category_id | name | subtitle | image | image_search | link | winner
 *   Votes      — Timestamp | Voter | Code | Category | Nominee | Value | Points. Lives in this spreadsheet, or in a
 *                separate one (votes_sheet_id setting). VotesMapping maps each field to a column header there, so an
 *                existing sheet with its own headers can be used as the datasource.
 *   VotesMapping — field | column   (timestamp, voter, code, category, nominee, value, points)
 *   Codes      — optional voter codes: Code | Category | Used By | Used At
 *   Committee  — email | name | role   (who may open the admin dashboard: role admin; if nobody is admin, the first row is)
 *   Log        — Timestamp | Email | Action | Details
 *   Site       — written by Publish: the public pages read this tab (published to the web as CSV)
 */

// Tier list points and caps (max nominees per tier, 0 = no limit). Must match TIERS in vote/index.html.
const TIERS = {
  S: {points: 5, cap: 1},
  A: {points: 4, cap: 2},
  B: {points: 3, cap: 3},
  C: {points: 2, cap: 0},
  D: {points: 1, cap: 0}
};

// Voting methods a category can use. Points are always computed here, never trusted from the browser.
const METHODS = {
  tier: 'Tier list (S=5 … D=1 points)',
  single: 'Pick one',
  multi: 'Pick up to N',
  rank: 'Rank top N (1st place scores most)'
};

// true = anyone with the ballot link can fetch point totals (never names). Keep false until the ceremony.
const SHOW_RESULTS = false;

const TABS = {
  Settings: ['key', 'value'],
  Categories: ['id', 'name', 'description', 'type', 'method', 'max_picks', 'opens', 'closes', 'order', 'locked'],
  Nominees: ['id', 'category_id', 'name', 'subtitle', 'image', 'image_search', 'link', 'winner'],
  Votes: ['Timestamp', 'Voter', 'Code', 'Category', 'Nominee', 'Value', 'Points'],
  Codes: ['Code', 'Category', 'Used By', 'Used At'],
  VotesMapping: ['field', 'column'],
  Committee: ['email', 'name', 'role'],
  Log: ['Timestamp', 'Email', 'Action', 'Details']
};
const SITE_HEADERS = ['category', 'category_description', 'category_color', 'nominee', 'subtitle', 'image', 'image_search',
  'link', 'winner', 'result', 'image_style', 'category_image', 'category_id', 'nominee_id', 'category_type', 'method',
  'max_picks', 'opens', 'closes', 'locked'];
const VOTE_FIELDS = ['timestamp', 'voter', 'code', 'category', 'nominee', 'value', 'points'];
const DEFAULT_SETTINGS = [['title', 'Anime X Angas Awards 2026'], ['tagline', ''], ['date', ''], ['venue', ''],
  ['stream_url', ''], ['vote_url', '../vote/'], ['vote_open', 'TRUE'], ['reveal_winners', 'FALSE'], ['show_results', 'FALSE'],
  ['trophy_image', '../img/trophy.webp'], ['voting_opens', ''], ['voting_closes', ''], ['votes_sheet_id', ''], ['votes_tab', 'Votes'], ['facebook_url', 'https://www.facebook.com/AnimexAngas'],
  ['youtube_url', 'https://www.youtube.com/@AnimexAngas'], ['discord_url', 'https://discord.gg/AnimexAngas']];

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABS).forEach(name => {
    if (name !== 'Votes' && !ss.getSheetByName(name)) {
      const sh = ss.insertSheet(name);
      sh.appendRow(TABS[name]);
      sh.setFrozenRows(1);
    }
  });
  const settings = ss.getSheetByName('Settings');
  if (settings.getLastRow() < 2) settings.getRange(2, 1, DEFAULT_SETTINGS.length, 2).setValues(DEFAULT_SETTINGS);
  const mapping = ss.getSheetByName('VotesMapping');
  if (mapping.getLastRow() < 2) mapping.getRange(2, 1, VOTE_FIELDS.length, 2).setValues(VOTE_FIELDS.map((f, i) => [f, TABS.Votes[i]]));
  const committee = ss.getSheetByName('Committee');
  const me = Session.getEffectiveUser().getEmail();
  if (committee.getLastRow() < 2 && me) committee.appendRow([me, 'Owner', 'admin']);
  if (!ss.getSheetByName('Site')) ss.insertSheet('Site').appendRow(SITE_HEADERS);
}

/* ===== Sheet helpers ===== */

// Reading a tab is the slow part of every request, so each tab is read at most once per request and the copy is
// dropped whenever that tab is written. (Apps Script starts every request with fresh globals.)
const CACHE = {tables: {}, sheets: {}, votes: null};

function sheet(name) {
  if (!(name in CACHE.sheets)) CACHE.sheets[name] = SpreadsheetApp.getActive().getSheetByName(name);
  return CACHE.sheets[name];
}

// Tabs the ballot only reads are also kept in the script cache for a minute, shared by every run, so a rush of
// voters doesn't send the same reads to the Sheet fifty times at once (the Sheet was the bottleneck in load tests).
// Saving in the admin dashboard clears them; a hand edit in the Sheet shows up within a minute.
const SHARED_TABLES = ['Settings', 'Categories', 'Nominees', 'VotesMapping'];
function sharedGet(key) {
  try { const v = CacheService.getScriptCache().get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
function sharedPut(key, value) {
  try { const s = JSON.stringify(value); if (s.length < 90000) CacheService.getScriptCache().put(key, s, 60); } catch (e) {}
}
function sharedDrop(key) {
  try { CacheService.getScriptCache().remove(key); } catch (e) {}
}

function readTable(name) {
  const shared = SHARED_TABLES.indexOf(name) >= 0;
  if (!CACHE.tables[name] && shared) CACHE.tables[name] = sharedGet('table:' + name);
  if (!CACHE.tables[name]) {
    const values = sheet(name).getDataRange().getValues();
    const head = values.shift().map(String);
    CACHE.tables[name] = values.filter(r => r.some(v => v !== '')).map(r => {
      const o = {};
      head.forEach((h, i) => o[h] = r[i] instanceof Date ? r[i].toISOString() : typeof r[i] === 'boolean' ? (r[i] ? 'TRUE' : 'FALSE') : String(r[i]));
      return o;
    });
    if (shared) sharedPut('table:' + name, CACHE.tables[name]);
  }
  return CACHE.tables[name].map(o => Object.assign({}, o)); // copies, so callers can edit rows freely
}

function forget(name) {
  delete CACHE.tables[name];
  if (SHARED_TABLES.indexOf(name) >= 0) sharedDrop('table:' + name);
  if (name === 'VotesMapping' || name === 'Settings') sharedDrop('votes:head');
  if (name === 'Codes') sharedDrop('codes:inuse');
  if (name === 'Categories' || name === 'Nominees' || name === 'VotesMapping' || name === 'Settings') CACHE.votes = null;
}

function appendRow(name, row) {
  sheet(name).appendRow(row);
  forget(name);
}

function writeTable(name, headers, rows) {
  const sh = sheet(name);
  const data = [headers].concat(rows.map(o => headers.map(h => o[h] === undefined ? '' : cell(String(o[h])))));
  const old = sh.getLastRow();
  // Plain text, so Sheets doesn't turn "TRUE" into a checkbox or a date string into a date.
  sh.getRange(1, 1, data.length, headers.length).setNumberFormat('@').setValues(data);
  if (old > data.length) sh.getRange(data.length + 1, 1, old - data.length, Math.max(headers.length, sh.getLastColumn())).clearContent();
  forget(name);
}

// Stops typed text such as "=IMPORTXML(...)" from being stored as a formula in the Sheet.
function cell(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function newId() {
  return Utilities.getUuid().slice(0, 8);
}

function settingsMap() {
  const out = {};
  readTable('Settings').forEach(r => { if (r.key) out[r.key] = r.value; });
  return out;
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Busy — please try again');
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();   // the next voter in line must see this one's rows
    lock.releaseLock();
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ===== Votes datasource ===== */

// The votes tab, and which column header holds each field.
function votesSource() {
  if (CACHE.votes && CACHE.votes.src) return CACHE.votes.src;
  const s = settingsMap();
  const ss = s.votes_sheet_id ? SpreadsheetApp.openById(s.votes_sheet_id.trim()) : SpreadsheetApp.getActive();
  const tab = (s.votes_tab || 'Votes').trim();
  let sh = ss.getSheetByName(tab);
  if (!sh) {
    sh = ss.insertSheet(tab);
    sh.appendRow(TABS.Votes);
    sh.setFrozenRows(1);
  }
  const map = {};
  VOTE_FIELDS.forEach((f, i) => map[f] = TABS.Votes[i]);
  readTable('VotesMapping').forEach(r => { if (r.field && r.column) map[r.field.trim().toLowerCase()] = r.column.trim(); });
  let head = sharedGet('votes:head');
  if (!head || !head.length) {
    head = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim()) : [];
    sharedPut('votes:head', head);
  }
  CACHE.votes = {src: {ss: ss, sheet: sh, map: map, head: head}};
  return CACHE.votes.src;
}

// Every vote row as {timestamp, voter, code, category, nominee, value, points}. Category and nominee may be stored as
// ids or names; names are resolved to ids. Without a points column, a tier letter (S…D) scores its tier points
// and anything else counts as 1 point.
function readVotes() {
  const src = votesSource();
  if (CACHE.votes.rows) return CACHE.votes.rows;
  const idx = {};
  VOTE_FIELDS.forEach(f => idx[f] = src.head.indexOf(src.map[f]));
  // Lookups by id or lower-cased name, built once instead of searching for every vote row.
  const catBy = {}, nomBy = {};
  readTable('Categories').forEach(c => { catBy[c.id] = c; catBy[c.name.toLowerCase()] = c; });
  readTable('Nominees').forEach(n => { nomBy[n.category_id + '|' + n.id] = n; nomBy[n.category_id + '|' + n.name.toLowerCase()] = n; });
  const values = src.sheet.getDataRange().getValues().slice(1);
  CACHE.votes.rows = values.filter(r => r.some(v => v !== '')).map(r => {
    const o = {};
    VOTE_FIELDS.forEach(f => {
      const v = idx[f] >= 0 ? r[idx[f]] : '';
      o[f] = v instanceof Date ? v.toISOString() : String(v).replace(/^'/, '').trim();
    });
    const c = catBy[o.category] || catBy[o.category.toLowerCase()];
    if (c) o.category = c.id;
    const n = nomBy[o.category + '|' + o.nominee] || nomBy[o.category + '|' + o.nominee.toLowerCase()];
    if (n) o.nominee = n.id;
    if (o.points === '') o.points = String(TIERS[o.value.toUpperCase()] ? TIERS[o.value.toUpperCase()].points : 1);
    return o;
  });
  return CACHE.votes.rows;
}

// A sheet with its own (re-mapped) category/nominee columns gets readable names; the built-in layout stores ids.
function appendVotes(list) {
  const src = votesSource();
  if (src.map.category !== 'Category' || src.map.nominee !== 'Nominee') {
    const cats = readTable('Categories'), noms = readTable('Nominees');
    list = list.map(o => Object.assign({}, o, {
      category: cell((cats.find(c => c.id === o.category) || {}).name || o.category),
      nominee: cell((noms.find(n => n.id === o.nominee) || {}).name || o.nominee)}));
  }
  const rows = list.map(o => src.head.map(h => {
    const f = VOTE_FIELDS.find(k => src.map[k] === h);
    return f ? o[f] : '';
  }));
  src.sheet.getRange(src.sheet.getLastRow() + 1, 1, rows.length, src.head.length).setValues(rows);
  CACHE.votes.rows = null;
}

/* ===== Web app ===== */

function doGet(e) {
  const p = (e && e.parameter) || {};
  // ?page=committee is the retired committee page: old links land on the admin dashboard (admins only).
  if (p.page === 'admin' || p.page === 'committee') {
    return HtmlService.createHtmlOutputFromFile('Admin').setTitle('Awards Admin')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  if (p.state && (p.code || p.error)) return discordCallback(p);   // coming back from "Sign in with Discord"
  if (p.action === 'results') {
    if (!SHOW_RESULTS) return json({ok: false, error: 'Results will be revealed at the awards'});
    return json({ok: true, results: tally(p.category)});
  }
  return json({ok: true});
}

// Flood limit for the public ballot: at most `max` requests of one kind per minute across the whole site.
// Set well above a rush of real voters (load-tested with 50 at once); a script hammering the ballot gets "Busy"
// instead of filling the Votes sheet.
function overLimit(kind, max) {
  const cache = CacheService.getScriptCache(), key = 'rate:' + kind + ':' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 120);
  return n > max;
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ok: false, error: 'Invalid request'});
  }
  // The ballot asks this before voting starts, so a voter learns their name is taken before filling anything in.
  if (body && body.action === 'checkName') {
    if (overLimit('check', 120)) return json({ok: false, error: 'Busy — please try again'});
    const voter = cleanVoter(body.voter);
    if (!voter) return json({ok: false, error: 'Please enter your name'});
    try {
      return json({ok: true, taken: nameTaken(voter)});
    } catch (err) {
      console.error(err);
      return json({ok: false, error: 'Something went wrong — please try again'});
    }
  }
  // Discord sign-in, finished in the background: the ballot page sends the code Discord gave it and gets a pass back,
  // so voters never land on an Apps Script page (which shows Google's "created by a Google Apps Script user" bar).
  if (body && body.action === 'discord') {
    if (overLimit('discord', 60)) return json({ok: false, error: 'Busy — please try again'});
    try {
      return json(discordExchange(String(body.code || ''), String(body.redirect || '')));
    } catch (err) {
      console.error(err);
      return json({ok: false, error: 'Discord sign-in didn’t work. You can still vote without Discord.'});
    }
  }
  // 'vote' was the old one-category-at-a-time ballot; a page still open from before is asked to reload.
  if (body && body.action === 'vote') return json({ok: false, error: 'This ballot page is out of date. Please reload it.'});
  if (!body || body.action !== 'ballot') return json({ok: false, error: 'Invalid request'});
  if (overLimit('ballot', 120)) return json({ok: false, error: 'Busy — please try again'});
  try {
    return json(recordBallot(body));
  } catch (err) {
    console.error(err);
    return json({ok: false, error: err.message === 'Busy — please try again' ? err.message : 'Something went wrong — please try again'});
  }
}

/* ===== Public voting ===== */

// One voting window for the whole event: the voting_opens / voting_closes settings (either can be blank).
function isOpen(c, now) {
  if (c.type === 'special') return false;
  const s = settingsMap();
  if (s.voting_opens && now < new Date(s.voting_opens)) return false;
  if (s.voting_closes && now > new Date(s.voting_closes)) return false;
  return true;
}

function maxPicks(c, count) {
  const n = parseInt(c.max_picks, 10);
  return n > 0 ? Math.min(n, count) : Math.min(3, count);
}

// Returns [{nominee, value, points}] for a valid ballot, or throws with a message for the voter.
function scoreBallot(c, nomineeIds, placements) {
  const seen = {};
  for (const p of placements) {
    if (!p || nomineeIds.indexOf(p.nominee) < 0 || seen[p.nominee]) throw new Error('Invalid ballot');
    seen[p.nominee] = true;
  }
  const method = c.method || 'tier';
  if (method === 'tier') {
    const counts = {};
    return placements.map(p => {
      const t = TIERS[p.value];
      if (!t) throw new Error('Invalid ballot');
      counts[p.value] = (counts[p.value] || 0) + 1;
      if (t.cap && counts[p.value] > t.cap) throw new Error(p.value + ' tier allows only ' + t.cap);
      return {nominee: p.nominee, value: p.value, points: t.points};
    });
  }
  if (method === 'single') {
    if (placements.length !== 1) throw new Error('Pick exactly one nominee');
    return [{nominee: placements[0].nominee, value: 'pick', points: 1}];
  }
  const n = maxPicks(c, nomineeIds.length);
  if (placements.length > n) throw new Error('Pick at most ' + n);
  if (method === 'multi') return placements.map(p => ({nominee: p.nominee, value: 'pick', points: 1}));
  if (method === 'rank') return placements.map((p, i) => ({nominee: p.nominee, value: String(i + 1), points: n - i}));
  throw new Error('Invalid ballot');
}

function cleanVoter(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

// Every name that has voted, lower-cased. Only the voter column is read, which stays quick even with thousands
// of vote rows (reading the whole Votes tab made each save slower as votes piled up).
function voterNames() {
  const src = votesSource(), col = src.head.indexOf(src.map.voter), last = src.sheet.getLastRow();
  if (col < 0 || last < 2) return [];
  return src.sheet.getRange(2, col + 1, last - 1, 1).getValues().map(r => cleanVoter(String(r[0]).replace(/^'/, '')).toLowerCase());
}

// Names are compared ignoring capitals and extra spaces, so "Ben", "ben" and " BEN " are the same voter.
function nameTaken(voter) {
  return voterNames().indexOf(cleanVoter(voter).toLowerCase()) >= 0;
}

const NAME_TAKEN = 'This name has already voted. Votes can\'t be changed. If this is you and something is wrong, message the organisers.';

// One ballot per name for the whole event: every category is sent together, once. A name that already has votes
// is refused, so nobody can add to or change someone else's ballot. To redo a ballot, an organiser deletes that
// name's rows in the Votes tab, which frees the name.
// The ballot is checked first, outside the lock; only the name check and the write wait in line, so a rush of
// voters moves through quickly.
function recordBallot(b) {
  const ready = checkBallot(b);
  return ready.rows ? withLock(() => saveBallot(ready)) : ready;
}

function checkBallot(b) {
  const voter = cleanVoter(b.voter);
  let code = String(b.code || '').trim().toUpperCase().slice(0, 20);
  // "DC-…" codes mark a Discord sign-in and are only ever set here from a signed pass: a typed one is dropped,
  // so nobody can skip the voter-code check or pose as a Discord account by typing it.
  if (/^DC-/.test(code)) code = '';
  let discord = false;
  // Signed in with Discord: record a scrambled form of the account (the voter still chooses the name shown).
  if (b.dc) {
    const pass = readPass(b.dc);
    if (!pass) return {ok: false, error: 'Your Discord sign-in has expired. Sign in again, or vote without Discord.'};
    code = 'DC-' + pass.h;
    discord = true;
  }
  const items = Array.isArray(b.ballots) ? b.ballots.slice(0, 50) : [];
  if (!voter) return {ok: false, error: 'Please enter your name'};
  if (settingsMap().vote_open === 'FALSE') return {ok: false, error: 'Voting is closed'};
  if (!items.length) return {ok: false, error: 'Empty ballot'};

  const cats = readTable('Categories'), noms = readTable('Nominees'), now = new Date(), seen = {};
  const rows = [];
  for (const item of items) {
    const categoryId = String((item && item.category) || '');
    const c = cats.find(x => x.id === categoryId);
    if (!c || seen[categoryId]) return {ok: false, error: 'Invalid ballot'};
    seen[categoryId] = true;
    if (!isOpen(c, now)) return {ok: false, error: c.type === 'special' ? 'This award isn\'t voted on' : 'Voting is closed'};
    const placements = Array.isArray(item.placements) ? item.placements.slice(0, 100) : [];
    if (!placements.length) continue; // a category the voter skipped
    const nomineeIds = noms.filter(n => n.category_id === categoryId).map(n => n.id);
    let scored;
    try {
      scored = scoreBallot(c, nomineeIds, placements.map(p => ({nominee: String(p.nominee), value: String(p.tier || p.value || '')})));
    } catch (err) {
      return {ok: false, error: c.name + ': ' + err.message};
    }
    scored.forEach(s => rows.push({timestamp: now, voter: cell(voter), code: cell(code), category: categoryId,
      nominee: s.nominee, value: s.value, points: s.points}));
  }
  if (!rows.length) return {ok: false, error: 'Empty ballot'};
  return {voter: voter, code: code, discord: discord, rows: rows, now: now};
}

// Whether the Codes tab lists any voter codes, remembered for a minute so most saves skip reading it.
function codesInUse() {
  let v = sharedGet('codes:inuse');
  if (v === null) { v = sheet('Codes').getLastRow() > 1; sharedPut('codes:inuse', v); }
  return v;
}

function saveBallot(ready) {
  const voter = ready.voter, code = ready.code, discord = ready.discord, rows = ready.rows, now = ready.now;
  if (nameTaken(voter)) return {ok: false, error: NAME_TAKEN, taken: true};

  // Voter codes: if the Codes sheet lists any, a valid code that hasn't voted yet is required.
  const codeRows = codesInUse() ? sheet('Codes').getDataRange().getValues().slice(1) : [];
  if (codeRows.length && !discord) {
    const mine = codeRows.filter(r => String(r[0]).toUpperCase() === code);
    if (!code || !mine.some(r => !r[1])) return {ok: false, error: 'Unknown voter code'};
    if (mine.some(r => r[1])) return {ok: false, error: 'This code has already voted'};
    appendRow('Codes', [cell(code), 'all', cell(voter), now]);
  }
  appendVotes(rows);
  return {ok: true};
}

// {categoryId: {nomineeId: {points, voters, top}}} — top = first-place picks (S tier, rank 1 or a pick), for tie-breaks.
function tally(categoryId) {
  const out = {};
  readVotes().forEach(v => {
    if (categoryId && v.category !== categoryId) return;
    const c = out[v.category] = out[v.category] || {};
    const n = c[v.nominee] = c[v.nominee] || {points: 0, voters: 0, top: 0};
    n.points += Number(v.points) || 0;
    n.voters++;
    if (v.value === 'S' || v.value === '1' || v.value === 'pick') n.top++;
  });
  return categoryId ? (out[categoryId] || {}) : out;
}

/* ===== Admin dashboard (called from Admin.html with google.script.run) ===== */

// The signed-in person, {email, name, admin}, or an error if they're not in the Committee tab.
function currentMember() {
  const email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  const rows = readTable('Committee').filter(r => r.email.trim());
  const me = rows.find(r => r.email.trim().toLowerCase() === email);
  if (!email || !me) {
    throw new Error('Not on the admin list' + (email ? ' (' + email + ')' : ' — open the admin link, signed in to Google'));
  }
  const anyAdmin = rows.some(r => String(r.role).trim().toLowerCase() === 'admin');
  const admin = anyAdmin ? String(me.role).trim().toLowerCase() === 'admin' : rows[0] === me;
  return {email: email, name: me.name || email.split('@')[0], admin: admin};
}

// Admin dashboard functions: admins only.
function requireAdmin() {
  const m = currentMember();
  if (!m.admin) throw new Error('Admins only');
  return m.email;
}

function log(email, action, details) {
  appendRow('Log', [new Date(), email, action, cell(String(details || '').slice(0, 500))]);
}

function adminState() {
  const email = requireAdmin();
  const categories = readTable('Categories').sort((a, b) => Number(a.order) - Number(b.order));
  const counts = {};
  let votes = [], votesInfo;
  try {
    const src = votesSource();
    votes = readVotes();
    votesInfo = {url: src.ss.getUrl(), name: src.ss.getName(), tab: src.sheet.getName(), rows: votes.length,
      missing: VOTE_FIELDS.filter(f => src.head.indexOf(src.map[f]) < 0)};
  } catch (err) {
    votesInfo = {error: 'Can\'t open the votes sheet: ' + err.message};
  }
  votes.forEach(v => {
    counts[v.category] = counts[v.category] || {};
    counts[v.category][v.voter.toLowerCase()] = true;
  });
  return {
    email: email,
    methods: METHODS,
    settings: settingsMap(),
    categories: categories.map(c => Object.assign(c, {ballots: Object.keys(counts[c.id] || {}).length})),
    nominees: readTable('Nominees'),
    results: votesInfo.error ? {} : tally(),
    votesInfo: votesInfo,
    log: readTable('Log').slice(-30).reverse(),
    unpublished: hasUnpublishedChanges()
  };
}

// True when categories, nominees or winners changed since the last Publish (settings go live without publishing).
// The proposal actions are from the retired committee page: old Log rows may still hold them.
function hasUnpublishedChanges() {
  const log = readTable('Log');
  let last = -1;
  log.forEach((l, i) => { if (l.Action === 'publish') last = i; });
  return log.slice(last + 1).some(l => !/^(publish|edit settings|propose|withdraw proposal|reject proposal)/.test(l.Action));
}

function adminSaveCategory(c) {
  const email = requireAdmin();
  return withLock(() => {
    const rows = readTable('Categories');
    const name = String(c.name || '').trim();
    if (!name) throw new Error('Category needs a name');
    const clean = {
      name: name,
      description: String(c.description || '').trim(),
      type: c.type === 'special' ? 'special' : 'vote',
      method: METHODS[c.method] ? c.method : 'tier',
      max_picks: String(parseInt(c.max_picks, 10) || ''),
      opens: '',
      closes: ''
    };
    let row = rows.find(r => r.id === c.id);
    if (row && row.locked === 'TRUE' && (clean.method !== row.method || clean.max_picks !== row.max_picks || clean.type !== row.type)) {
      throw new Error('This category is locked: unlock it to change its type or voting method');
    }
    if (row) Object.assign(row, clean);
    else rows.push(row = Object.assign({id: newId(), order: String(rows.length + 1)}, clean));
    writeTable('Categories', TABS.Categories, rows);
    log(email, c.id ? 'edit category' : 'add category', name);
    return adminState();
  });
}

function adminDeleteCategory(id) {
  const email = requireAdmin();
  return withLock(() => {
    const rows = readTable('Categories');
    const c = rows.find(r => r.id === id);
    if (!c) throw new Error('Category not found');
    if (readVotes().some(v => v.category === id)) throw new Error('This category already has votes; it can\'t be deleted');
    writeTable('Categories', TABS.Categories, rows.filter(r => r.id !== id).map((r, i) => Object.assign(r, {order: String(i + 1)})));
    writeTable('Nominees', TABS.Nominees, readTable('Nominees').filter(n => n.category_id !== id));
    log(email, 'delete category', c.name);
    return adminState();
  });
}

function adminMoveCategory(id, dir) {
  const email = requireAdmin();
  return withLock(() => {
    const rows = readTable('Categories').sort((a, b) => Number(a.order) - Number(b.order));
    const i = rows.findIndex(r => r.id === id), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= rows.length) return adminState();
    [rows[i], rows[j]] = [rows[j], rows[i]];
    writeTable('Categories', TABS.Categories, rows.map((r, k) => Object.assign(r, {order: String(k + 1)})));
    log(email, 'reorder categories', rows[j].name);
    return adminState();
  });
}

// Poster art for an anime title from AniList (then Jikan), or '' if not found. Several titles can be given,
// separated by ' | ', and are tried in order.
function findPoster(titles) {
  for (const t of String(titles || '').split('|').map(x => x.trim()).filter(Boolean)) {
    try {
      const res = UrlFetchApp.fetch('https://graphql.anilist.co', {method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({query: 'query($s:String){Media(search:$s,type:ANIME,format_not_in:[SPECIAL,OVA,TV_SHORT,MUSIC]){coverImage{extraLarge large}}}', variables: {s: t}})});
      const c = ((JSON.parse(res.getContentText()).data || {}).Media || {}).coverImage || {};
      const url = c.extraLarge || c.large;
      if (url && url.indexOf('/default') < 0) return url; // AniList's "NO IMAGE" placeholder doesn't count
    } catch (err) { console.error(err); }
  }
  try {
    const first = String(titles || '').split('|')[0].trim();
    if (first) {
      const j = JSON.parse(UrlFetchApp.fetch('https://api.jikan.moe/v4/anime?limit=1&q=' + encodeURIComponent(first), {muteHttpExceptions: true}).getContentText());
      const im = ((j.data || [])[0] || {}).images || {};
      return (im.jpg || {}).large_image_url || (im.webp || {}).large_image_url || '';
    }
  } catch (err) { console.error(err); }
  return '';
}

// Fills in the picture of every nominee that has an anime title but no picture yet.
function adminFillPosters() {
  const email = requireAdmin();
  return withLock(() => {
    const rows = readTable('Nominees');
    let found = 0, missed = [];
    rows.forEach(r => {
      if (r.image || !r.image_search) return;
      r.image = findPoster(r.image_search);
      if (r.image) found++; else missed.push(r.name);
    });
    if (found) writeTable('Nominees', TABS.Nominees, rows);
    log(email, 'find posters', found + ' found' + (missed.length ? '; not found: ' + missed.join(', ') : ''));
    const st = adminState();
    st.message = found + ' poster' + (found === 1 ? '' : 's') + ' found' + (missed.length ? ' · not found: ' + missed.join(', ') : '');
    return st;
  });
}

function adminSaveNominee(n) {
  const email = requireAdmin();
  return withLock(() => {
    const rows = readTable('Nominees');
    const name = String(n.name || '').trim();
    if (!name) throw new Error('Nominee needs a name');
    const cat = readTable('Categories').find(c => c.id === n.category_id);
    if (!cat) throw new Error('Category not found');
    if (cat.locked === 'TRUE') throw new Error('This category is locked: unlock it to change nominees');
    const clean = {name: name, subtitle: String(n.subtitle || '').trim(), image: String(n.image || '').trim(),
      image_search: String(n.image_search || '').trim(), link: String(n.link || '').trim()};
    // An anime title without a picture: look the poster up now, so the site gets a real image link.
    if (!clean.image && clean.image_search) clean.image = findPoster(clean.image_search);
    let row = rows.find(r => r.id === n.id);
    if (row) Object.assign(row, clean);
    else rows.push(Object.assign({id: newId(), category_id: n.category_id, winner: ''}, clean));
    writeTable('Nominees', TABS.Nominees, rows);
    log(email, n.id ? 'edit nominee' : 'add nominee', name);
    return adminState();
  });
}

function adminDeleteNominee(id) {
  const email = requireAdmin();
  return withLock(() => {
    const rows = readTable('Nominees');
    const n = rows.find(r => r.id === id);
    if (!n) throw new Error('Nominee not found');
    if (readTable('Categories').some(c => c.id === n.category_id && c.locked === 'TRUE')) throw new Error('This category is locked: unlock it to change nominees');
    if (readVotes().some(v => v.nominee === id)) throw new Error('This nominee already has votes; it can\'t be deleted');
    writeTable('Nominees', TABS.Nominees, rows.filter(r => r.id !== id));
    log(email, 'delete nominee', n.name);
    return adminState();
  });
}

// Marks the given nominees as the category's winner(s); an empty list clears the winners.
function adminSetWinners(categoryId, nomineeIds) {
  const email = requireAdmin();
  return withLock(() => {
    const rows = readTable('Nominees');
    rows.forEach(r => { if (r.category_id === categoryId) r.winner = nomineeIds.indexOf(r.id) >= 0 ? 'TRUE' : ''; });
    writeTable('Nominees', TABS.Nominees, rows);
    log(email, 'set winners', categoryId + ': ' + rows.filter(r => r.winner && r.category_id === categoryId).map(r => r.name).join(', '));
    return adminState();
  });
}

function adminSaveSettings(values) {
  const email = requireAdmin();
  return withLock(() => {
    const current = settingsMap();
    Object.keys(values).forEach(k => { if (/^[a-z_]+$/.test(k)) current[k] = String(values[k]); });
    writeTable('Settings', TABS.Settings, Object.keys(current).map(k => ({key: k, value: current[k]})));
    log(email, 'edit settings', Object.keys(values).join(', '));
    return adminState();
  });
}

// The Site tab's rows built from the Categories and Nominees tabs, plus the categories that publishing will lock.
// In a locked category that already has votes, the list of nominees stays as it was published: a nominee added in
// the Sheet waits and a removed one stays on the ballot until an admin unlocks the category, so every voter sees the
// same ballot. Names, subtitles, pictures, links and winners still update. `held` says what was held back.
function buildSite(cats, noms, before) {
  const rows = [], held = [], toLock = [];
  let voted = null;   // categories with votes, read only if needed
  const hasVotes = id => {
    if (!voted) { voted = {}; try { readVotes().forEach(v => voted[v.category] = true); } catch (err) { voted = null; return true; } }
    return !!voted[id];
  };
  cats.filter(c => String(c.name || '').trim() && c.id).forEach(c => {
    const base = {category: c.name, category_description: c.description, category_id: c.id, category_type: c.type,
      method: c.method, max_picks: c.max_picks, opens: '', closes: ''};
    let list = noms.filter(n => n.category_id === c.id && String(n.name || '').trim() && n.id).map(n => ({nominee: n.name, subtitle: n.subtitle,
      image: n.image, image_search: n.image_search, link: n.link, winner: n.winner, nominee_id: n.id}));
    const was = before.filter(r => r.category_id === c.id && r.nominee);
    const sameList = was.map(r => r.nominee_id).sort().join('|') === list.map(n => n.nominee_id).sort().join('|');
    if (c.locked === 'TRUE' && was.length && !sameList && hasVotes(c.id)) {
      const ids = was.map(r => r.nominee_id);
      list.filter(n => ids.indexOf(n.nominee_id) < 0).forEach(n =>
        held.push('Not added to ' + c.name + ' because voting has started: "' + n.nominee + '". An admin can unlock the category in the dashboard to add it.'));
      list = was.map(r => {
        const now = list.find(n => n.nominee_id === r.nominee_id);
        if (!now) held.push('Kept on the ballot in ' + c.name + ' because voting has started: "' + r.nominee + '" (it is no longer in the Nominees tab). An admin can unlock the category in the dashboard to remove it.');
        return now || {nominee: r.nominee, subtitle: r.subtitle, image: r.image, image_search: r.image_search, link: r.link, winner: r.winner, nominee_id: r.nominee_id};
      });
    }
    // Public-vote categories lock once they're published with nominees, so the ballot can't change mid-vote.
    const locked = c.locked === 'TRUE' || (c.type !== 'special' && list.length > 0);
    if (locked && c.locked !== 'TRUE') toLock.push(c.id);
    const lockText = locked ? 'TRUE' : '';
    if (!list.length) rows.push(Object.assign({locked: lockText}, base));
    list.forEach(n => rows.push(Object.assign({}, base, n, {locked: lockText})));
  });
  return {rows: rows, held: held, toLock: toLock};
}

// Writes the Site tab (which the public awards page and ballot read), locks newly voted categories and logs it, then
// emails and starts the video search (afterPublish). `who` is the admin's email, or AUTO for the automatic publish.
function publishSite(who, issues) {
  let before = [], after = [], held = [];
  withLock(() => {
    before = sheet('Site') ? readTable('Site') : [];
    const cats = readTable('Categories').sort((a, b) => Number(a.order) - Number(b.order));
    const built = buildSite(cats, readTable('Nominees'), before);
    if (built.toLock.length) {
      cats.forEach(c => { if (built.toLock.indexOf(c.id) >= 0) c.locked = 'TRUE'; });
      writeTable('Categories', TABS.Categories, cats);
    }
    writeTable('Site', SITE_HEADERS, built.rows);
    after = built.rows; held = built.held;
    const lockedNames = cats.filter(c => built.toLock.indexOf(c.id) >= 0).map(c => c.name);
    log(who, 'publish', built.rows.length + ' rows' + (lockedNames.length ? '; locked ' + lockedNames.join(', ') : ''));
  });
  return afterPublish(who, before, after, held.concat(issues || []));
}

function adminPublish() {
  const email = requireAdmin();
  const message = publishSite(email);
  const st = adminState();
  st.message = message;
  return st;
}

/* ===== After a publish: email the committee what changed, and look up videos for new songs ===== */
// Script properties (Project Settings → Script properties; kept out of this file because the repository is public):
//   PUBLISH_EMAILS — who gets the "site published" email, separated by commas
//   GITHUB_TOKEN   — a fine-grained GitHub token allowed only to run Actions on GITHUB_REPO; starts the video search
//   GITHUB_REPO    — optional, default benburnsred/awards
//   SITE_URL       — optional, default the official awards page
const DEFAULT_SITE_URL = 'https://animexangas.github.io/awards/2026/';
const VIDEO_CATEGORY = /opening|ending/i;   // must match the categories tools/fetch_videos.py looks at

// What changed between two copies of the Site tab, as {lines: [text], songs: true if an Opening/Ending changed}.
function siteChanges(before, after) {
  const lines = [], q = s => '"' + s + '"';
  let songs = false;
  const catsOf = rows => { const m = {}; rows.forEach(r => { const id = r.category_id || r.category; if (id && !m[id]) m[id] = r; }); return m; };
  const nomsOf = rows => { const m = {}; rows.forEach(r => { if (r.nominee) m[r.nominee_id || (r.category_id || r.category) + '|' + r.nominee] = r; }); return m; };
  const oc = catsOf(before), nc = catsOf(after), on = nomsOf(before), nn = nomsOf(after);
  const song = r => { if (VIDEO_CATEGORY.test(r.category)) songs = true; };
  Object.keys(nc).forEach(id => {
    const a = nc[id], b = oc[id];
    if (!b) lines.push('New category: ' + q(a.category) + (a.category_type === 'special' ? ' (special award)' : ''));
    else {
      if (b.category !== a.category) { lines.push('Category renamed: ' + q(b.category) + ' → ' + q(a.category)); song(a); }
      if ((b.category_description || '') !== (a.category_description || '')) lines.push('Description changed: ' + q(a.category));
      if ((b.method || '') !== (a.method || '') || (b.max_picks || '') !== (a.max_picks || '')) lines.push('Voting method changed: ' + q(a.category));
    }
  });
  Object.keys(oc).forEach(id => { if (!nc[id]) lines.push('Category removed: ' + q(oc[id].category)); });
  const fields = [['subtitle', 'subtitle'], ['image', 'picture'], ['link', 'link']];
  Object.keys(nn).forEach(id => {
    const a = nn[id], b = on[id];
    if (!b) { lines.push('Nominee added to ' + a.category + ': ' + q(a.nominee)); song(a); return; }
    if (b.category !== a.category && (b.category_id || '') !== (a.category_id || '')) { lines.push('Nominee moved: ' + q(a.nominee) + ' from ' + b.category + ' to ' + a.category); song(a); }
    if (b.nominee !== a.nominee) { lines.push('Nominee renamed in ' + a.category + ': ' + q(b.nominee) + ' → ' + q(a.nominee)); song(a); }
    const changed = fields.filter(f => (b[f[0]] || '') !== (a[f[0]] || '')).map(f => f[1]);
    if (changed.length) { lines.push('Nominee updated in ' + a.category + ': ' + q(a.nominee) + ' (' + changed.join(', ') + ')'); if (changed.indexOf('link') >= 0) song(a); }
    if ((b.winner === 'TRUE') !== (a.winner === 'TRUE')) lines.push((a.winner === 'TRUE' ? 'Winner set in ' : 'Winner cleared in ') + a.category + ': ' + q(a.nominee));
  });
  Object.keys(on).forEach(id => { if (!nn[id]) lines.push('Nominee removed from ' + on[id].category + ': ' + q(on[id].nominee)); });
  return {lines: lines, songs: songs};
}

// Starts the "Find opening and ending videos" job on GitHub. It waits 6 minutes first, because Google takes a few
// minutes to update the published copy of the Sheet that the job reads. True if GitHub accepted it.
function startVideoJob(props) {
  const token = props.getProperty('GITHUB_TOKEN');
  if (!token) return false;
  const repo = props.getProperty('GITHUB_REPO') || 'benburnsred/awards';
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/actions/workflows/videos.yml/dispatches', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
    payload: JSON.stringify({ref: 'main', inputs: {wait: '360'}})
  });
  const code = res.getResponseCode();
  if (code !== 204 && code !== 200) throw new Error('GitHub answered ' + code + ': ' + String(res.getContentText()).slice(0, 200));
  return true;
}

// Runs after the Site tab is written. Never undoes or blocks the publish: problems only show in the returned message.
function afterPublish(email, before, after, issues) {
  issues = issues || [];
  const props = PropertiesService.getScriptProperties(), notes = ['Published'];
  const change = siteChanges(before, after);
  let videos = false;
  if (change.songs) {
    try { videos = startVideoJob(props); if (videos) notes.push('looking up videos for new songs (about 10 minutes)'); }
    catch (err) { console.error(err); notes.push('the video search could not start: ' + err.message); }
  }
  const to = String(props.getProperty('PUBLISH_EMAILS') || '').split(/[,;\s]+/).filter(x => /@/.test(x));
  if (to.length) {
    try {
      const when = new Date().toLocaleString('en-US', {timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'});
      const site = props.getProperty('SITE_URL') || DEFAULT_SITE_URL;
      const n = change.lines.length;
      const body = [(email === AUTO ? 'The awards site was published automatically after the Sheet changed, on ' : email + ' published the awards site on ')
        + when + ' (Philippine time).', '',
        n ? 'What changed since the last publish:' : 'Nothing changed in the categories or nominees (published again as it was).']
        .concat(change.lines.map(l => '  • ' + l))
        .concat(['', 'The site and the ballot show it within about 5 minutes:', '  Awards page: ' + site, '  Ballot: ' + site.replace(/\d{4}\/?$/, '') + 'vote/'])
        .concat(issues.length ? ['', 'Needs attention:'].concat(issues.map(l => '  • ' + l)) : [])
        .concat(videos ? ['', 'New or changed songs: the opening/ending video search starts in about 6 minutes and adds any videos it finds.'] : [])
        .concat(['', 'Sent automatically by the awards admin dashboard.']).join('\n');
      MailApp.sendEmail({to: to.join(','), subject: 'Awards site published' + (n ? ': ' + n + ' change' + (n === 1 ? '' : 's') : ' (no changes)'),
        body: body, name: 'Anime X Angas Awards'});
      notes.push('emailed ' + to.length + (to.length === 1 ? ' person' : ' people'));
    } catch (err) { console.error(err); notes.push('the email could not be sent: ' + err.message); }
  }
  return notes.join(' · ');
}

/* ===== Automatic publish: the Sheet is checked every 5 minutes and published when it changed ===== */
// Turned on with a time-driven trigger on autoPublish (Triggers → Add trigger → autoPublish → Time-driven →
// Minutes timer → Every 5 minutes). It publishes only once nobody has changed the Sheet for QUIET_MS, so half-typed
// edits don't go out, and sends the same "site published" email as the Publish button (PUBLISH_EMAILS).
const AUTO = 'automatic';
const QUIET_MS = 4 * 60 * 1000;

// A short fingerprint of some text, to tell whether something changed between two checks.
function fingerprint(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33 + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + text.length;
}

// Tidies rows typed straight into the Sheet: fills in missing ids, and links a nominee whose category was typed by
// name instead of id. Writes only the cells it fixes. Returns {fixed, problems} as lines of text; rows with a
// problem are left off the site.
function checkSheet(dryRun) {
  const fixed = [], problems = [];
  const raw = name => {
    const sh = sheet(name), values = sh.getDataRange().getValues();
    return {sh: sh, head: (values[0] || []).map(String), rows: values.slice(1).map((r, i) => ({n: i + 2, v: r.map(x => String(x).trim())}))};
  };
  const get = (t, row, col) => row.v[t.head.indexOf(col)] || '';
  const set = (t, row, col, value) => { if (!dryRun) t.sh.getRange(row.n, t.head.indexOf(col) + 1).setValue(value); row.v[t.head.indexOf(col)] = value; };
  const C = raw('Categories'), cats = {};
  C.rows.filter(r => r.v.some(Boolean)).forEach(r => {
    const name = get(C, r, 'name');
    if (!name) { problems.push('Categories tab, row ' + r.n + ': it has no name, so it is not on the site.'); return; }
    if (!get(C, r, 'id') || cats[get(C, r, 'id')]) { set(C, r, 'id', newId()); fixed.push('gave the category "' + name + '" an id'); }
    cats[get(C, r, 'id')] = name;
  });
  const N = raw('Nominees'), seen = {};
  N.rows.filter(r => r.v.some(Boolean)).forEach(r => {
    const name = get(N, r, 'name'), cat = get(N, r, 'category_id');
    if (!name) { problems.push('Nominees tab, row ' + r.n + ': it has no name, so it is not on the site.'); return; }
    if (!cats[cat]) {
      const id = Object.keys(cats).find(k => cats[k].toLowerCase() === cat.toLowerCase());
      if (id) { set(N, r, 'category_id', id); fixed.push('linked "' + name + '" to the category "' + cats[id] + '"'); }
      else problems.push('Nominees tab, row ' + r.n + ': "' + name + '" has a category that doesn\'t exist ("' + cat + '"), so it is not on the site. Type the category\'s exact name in its category_id cell.');
    }
    if (!get(N, r, 'id') || seen[get(N, r, 'id')]) { set(N, r, 'id', newId()); fixed.push('gave the nominee "' + name + '" an id'); }
    seen[get(N, r, 'id')] = true;
  });
  forget('Categories'); forget('Nominees');
  return {fixed: fixed, problems: problems};
}

// Shows what the next publish would change, without writing anything (run it from the Apps Script editor and read
// the execution log). Rows the checker would tidy are listed but not counted in the changes.
function previewPublish() {
  forget('Categories'); forget('Nominees');
  const check = checkSheet(true);
  const before = sheet('Site') ? readTable('Site') : [];
  const cats = readTable('Categories').sort((a, b) => Number(a.order) - Number(b.order));
  const built = buildSite(cats, readTable('Nominees'), before);
  const out = {changes: siteChanges(before, built.rows).lines, needsAttention: check.problems.concat(built.held), checkerWouldTidy: check.fixed};
  console.log(JSON.stringify(out, null, 2));
  return out;
}

// Emails PUBLISH_EMAILS. False if there's no list or it couldn't send.
function mailCommittee(subject, lines) {
  const to = String(PropertiesService.getScriptProperties().getProperty('PUBLISH_EMAILS') || '').split(/[,;\s]+/).filter(x => /@/.test(x));
  if (!to.length) return false;
  try { MailApp.sendEmail({to: to.join(','), subject: subject, body: lines.join('\n'), name: 'Anime X Angas Awards'}); return true; }
  catch (err) { console.error(err); return false; }
}

// Runs every 5 minutes (time-driven trigger). Publishes when what the site would show differs from the Site tab and
// has stayed the same for QUIET_MS. Problems in the Sheet that keep a row off the site are emailed once, not every
// 5 minutes. Returns what it did, for the execution log.
function autoPublish() {
  const props = PropertiesService.getScriptProperties();
  const check = checkSheet();   // also makes the next reads come from the Sheet itself, not the one-minute copy
  const before = sheet('Site') ? readTable('Site') : [];
  const cats = readTable('Categories').sort((a, b) => Number(a.order) - Number(b.order));
  const built = buildSite(cats, readTable('Nominees'), before);
  const flat = rows => JSON.stringify(rows.map(r => SITE_HEADERS.map(h => String(r[h] === undefined ? '' : r[h]))));
  const issues = check.problems.concat(built.held), issuesSig = fingerprint(issues.join('\n'));
  // Fixes are made as soon as they're found, and listed in the next publish email
  const fixed = String(props.getProperty('AUTO_FIXED') || '').split('\n').filter(Boolean).concat(check.fixed);
  props.setProperty('AUTO_FIXED', fixed.join('\n').slice(0, 8000));
  if (flat(built.rows) === flat(before)) {
    props.setProperty('AUTO_PENDING', '');
    props.setProperty('AUTO_FIXED', '');
    if (issues.length && props.getProperty('AUTO_ISSUES') !== issuesSig) {
      mailCommittee('Awards Sheet: ' + issues.length + ' thing' + (issues.length === 1 ? '' : 's') + ' to fix',
        ['The awards Sheet checker found rows that are not on the site:', ''].concat(issues.map(l => '  • ' + l))
          .concat(['', 'You get this email again only if the list changes.', '', 'Sent automatically by the awards Sheet checker.']));
    }
    props.setProperty('AUTO_ISSUES', issues.length ? issuesSig : '');
    return 'Up to date' + (issues.length ? ' (' + issues.length + ' to fix)' : '');
  }
  const sig = fingerprint(flat(built.rows)), now = Date.now();
  const pending = String(props.getProperty('AUTO_PENDING') || '').split('@');
  if (pending[0] !== sig) { props.setProperty('AUTO_PENDING', sig + '@' + now); return 'Changed: waiting for edits to settle'; }
  if (now - Number(pending[1]) < QUIET_MS) return 'Changed: waiting for edits to settle';
  props.setProperty('AUTO_PENDING', '');
  props.setProperty('AUTO_ISSUES', issues.length ? issuesSig : '');
  props.setProperty('AUTO_FIXED', '');
  return publishSite(AUTO, check.problems.concat(fixed.length ? ['Tidied by the checker: ' + fixed.join('; ') + '.'] : []));
}

/* ===== Site check: every hour, make sure the site, the official copy and the GitHub jobs are fine ===== */
// Turned on with a time-driven trigger on healthCheck (Hour timer → Every hour). Emails PUBLISH_EMAILS when the list
// of problems changes (and once when everything is fine again); nothing while nothing changes.
//   MIRROR_REPO — optional, default animexangas/awards (the official copy)
//   SITE_CSV    — optional, the published Site tab the pages read (default: the one in 2026/index.html)
const DEFAULT_SITE_CSV = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT3drRB6t5qgQb6EKA2cZwP7eNJpywJvxW_z9jskSucv6jBLtzgA3g93ZaRmCcaw_roiKJry41ADMf-/pub?gid=636394&single=true&output=csv';
const MIRROR_GRACE_MS = 3 * 60 * 60 * 1000;   // how long the official copy may lag before it counts as stuck

function siteProblems() {
  const props = PropertiesService.getScriptProperties(), problems = [], token = props.getProperty('GITHUB_TOKEN');
  const fetch = (url, github) => {
    try {
      const r = UrlFetchApp.fetch(url, {muteHttpExceptions: true, followRedirects: true,
        headers: github && token ? {Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json'} : {}});
      return {code: r.getResponseCode(), text: r.getContentText()};
    } catch (err) { return {code: 0, text: String((err && err.message) || err)}; }
  };
  // GitHub answers; null when GitHub itself can't be reached (then that part is skipped, not reported)
  const gh = path => { const r = fetch('https://api.github.com/' + path, true); try { return r.code === 200 ? JSON.parse(r.text) : null; } catch (e) { return null; } };
  const site = props.getProperty('SITE_URL') || DEFAULT_SITE_URL, ballot = site.replace(/\d{4}\/?$/, '') + 'vote/';
  [['The awards page', site], ['The ballot', ballot]].forEach(([what, url]) => {
    const r = fetch(url);
    if (r.code !== 200) problems.push(what + ' is not loading (' + (r.code || r.text) + '): ' + url);
  });
  const csv = fetch(props.getProperty('SITE_CSV') || DEFAULT_SITE_CSV);
  if (csv.code !== 200 || !/^category,/.test(csv.text)) {
    problems.push('The published Sheet that the site reads is not loading. In the Sheet: File → Share → Publish to web, and check that the Site tab is still published.');
  }
  // The official copy keeps up with this repository
  const repo = props.getProperty('GITHUB_REPO') || 'benburnsred/awards', mirror = props.getProperty('MIRROR_REPO') || 'animexangas/awards';
  const up = gh('repos/' + repo + '/commits/main'), copy = gh('repos/' + mirror + '/commits/main');
  if (up && copy && up.sha !== copy.sha) {
    const since = new Date(((up.commit || {}).committer || {}).date || 0).getTime();
    const cmp = gh('repos/' + repo + '/compare/' + copy.sha + '...' + up.sha);
    if (cmp && cmp.status === 'ahead' && Date.now() - since > MIRROR_GRACE_MS) {
      problems.push('The official site (' + mirror + ') stopped updating and is ' + cmp.ahead_by + ' change' + (cmp.ahead_by === 1 ? '' : 's') +
        ' behind. animexangas needs to open https://github.com/' + mirror + ' and click Sync fork → Update branch.');
    }
  }
  // The last finished run of each GitHub job that keeps the site going
  [[repo, 'pages.yml', 'publishing the site'], [repo, 'videos.yml', 'finding opening/ending videos'],
    [mirror, 'pages.yml', 'publishing the official site'], [mirror, 'mirror.yml', 'copying updates to the official site']].forEach(([r, wf, what]) => {
    const runs = gh('repos/' + r + '/actions/workflows/' + wf + '/runs?per_page=5&status=completed');
    const last = runs && (runs.workflow_runs || []).find(x => x.conclusion !== 'skipped' && x.conclusion !== 'cancelled');
    if (last && last.conclusion === 'failure') problems.push('The GitHub job for ' + what + ' failed (' + r + '): ' + last.html_url);
  });
  return problems;
}

function healthCheck() {
  const props = PropertiesService.getScriptProperties(), problems = siteProblems();
  const sig = problems.length ? fingerprint(problems.join('\n')) : '', was = props.getProperty('HEALTH_LAST') || '';
  if (sig === was) return problems;
  const site = props.getProperty('SITE_URL') || DEFAULT_SITE_URL;
  const sent = problems.length
    ? mailCommittee('Awards site check: ' + problems.length + ' problem' + (problems.length === 1 ? '' : 's'),
      ['The hourly check of the awards site found:', ''].concat(problems.map(l => '  • ' + l))
        .concat(['', 'You get this email again only when the list changes.', 'Awards page: ' + site, '', 'Sent automatically by the awards site check.']))
    : mailCommittee('Awards site check: all fine again', ['Everything the hourly check looks at is working again.', 'Awards page: ' + site, '', 'Sent automatically by the awards site check.']);
  if (sent) props.setProperty('HEALTH_LAST', sig);
  return problems;
}

function adminUnlockCategory(id) {
  const email = requireAdmin();
  return withLock(() => {
    const rows = readTable('Categories');
    const c = rows.find(r => r.id === id);
    if (!c) throw new Error('Category not found');
    c.locked = '';
    writeTable('Categories', TABS.Categories, rows);
    log(email, 'unlock category', c.name);
    return adminState();
  });
}

/* ===== Data check: flag suspicious ballots for the daily clean-up ===== */

// Rude words (English and Filipino) that mark a voter name as junk. Matched inside the simplified name.
const JUNK_WORDS = ['fuck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'asshole', 'nigga', 'nigger', 'puta', 'putang', 'tangina',
  'gago', 'tanga', 'bobo', 'ulol', 'pakyu', 'kantot', 'burat', 'titi', 'pepe'];

// A name boiled down for comparison: lower case, letters only, common number-for-letter swaps undone.
function simpleName(name) {
  return cleanVoter(name).toLowerCase()
    .replace(/0/g, 'o').replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/[1!|]/g, 'i').replace(/[5$]/g, 's').replace(/7/g, 't')
    .replace(/[^a-z]/g, '');
}

// Every ballot (all rows from one voter name) with the reasons it looks suspicious. Nothing is removed here.
function dataCheck() {
  const byKey = {};
  readVotes().forEach(v => {
    const key = cleanVoter(v.voter).toLowerCase(); if (!key) return;
    const b = byKey[key] || (byKey[key] = {key: key, voter: cleanVoter(v.voter), code: v.code, at: v.timestamp, picks: [], cats: {}});
    if (v.timestamp && (!b.at || v.timestamp < b.at)) b.at = v.timestamp;
    if (v.code && !b.code) b.code = v.code;
    b.picks.push(v.category + ':' + v.nominee + '=' + v.value); b.cats[v.category] = true;
  });
  const list = Object.keys(byKey).map(k => byKey[k]);
  list.forEach(b => { b.flags = []; b.sig = b.picks.sort().join('|'); b.ncats = Object.keys(b.cats).length; b.time = new Date(b.at).getTime() || 0; });
  const group = fn => { const g = {}; list.forEach(b => { const k = fn(b); if (k) (g[k] = g[k] || []).push(b); });
    return Object.keys(g).map(k => g[k]).filter(x => x.length >= 2); };
  const others = (b, set) => set.filter(x => x !== b).map(x => x.voter).join(', ');
  group(b => simpleName(b.voter)).forEach(set => set.forEach(b => b.flags.push('Look-alike name: ' + others(b, set))));
  group(b => /^DC-/.test(b.code) ? b.code : '').forEach(set => set.forEach(b => b.flags.push('Same Discord account as: ' + others(b, set))));
  group(b => b.ncats >= 3 ? b.sig : '').forEach(set => set.forEach(b => b.flags.push('Identical choices to: ' + others(b, set))));
  const sorted = list.slice().sort((a, b) => a.time - b.time);
  sorted.forEach(b => {
    const near = sorted.filter(x => x !== b && x.time && Math.abs(x.time - b.time) <= 120000);
    if (b.time && near.length >= 2) b.flags.push((near.length + 1) + ' ballots within 2 minutes: ' + near.map(x => x.voter).join(', '));
  });
  list.forEach(b => {
    const s = simpleName(b.voter), raw = b.voter;
    const junk = raw.length < 3 ? 'very short' : !/[a-z]/i.test(raw) ? 'no letters' : /(.)\1{3,}/i.test(raw) ? 'repeated characters'
      : /^[^aeiouy]{5,}$/.test(s) ? 'looks like keyboard mashing' : JUNK_WORDS.some(w => s.indexOf(w) >= 0) ? 'rude word' : '';
    if (junk) b.flags.push('Junk name: ' + junk);
  });
  return {
    checked: new Date().toISOString(),
    ballots: list.length,
    flagged: list.filter(b => b.flags.length).sort((a, b) => b.time - a.time)
      .map(b => ({key: b.key, voter: b.voter, discord: /^DC-/.test(b.code), at: b.at, categories: b.ncats, flags: b.flags}))
  };
}

function adminDataCheck() {
  requireAdmin();
  return Object.assign(adminState(), {dataCheck: dataCheck()});
}

// Removes every vote row of one ballot (matched by voter name, ignoring capitals and spaces), frees a voter code it
// used, and logs who removed it. The name can then vote again.
function adminRemoveBallot(key) {
  const email = requireAdmin();
  key = cleanVoter(key).toLowerCase();
  if (!key) throw new Error('No ballot chosen');
  return withLock(() => {
    const src = votesSource(), col = src.head.indexOf(src.map.voter);
    if (col < 0) throw new Error('The votes sheet has no voter column');
    const values = src.sheet.getDataRange().getValues();
    const rows = [];
    for (let i = values.length - 1; i >= 1; i--) if (cleanVoter(String(values[i][col]).replace(/^'/, '')).toLowerCase() === key) rows.push(i + 1);
    if (!rows.length) throw new Error('That ballot was not found (it may already be removed)');
    rows.forEach(r => src.sheet.deleteRow(r));   // bottom to top, so row numbers stay valid
    CACHE.votes = null;
    const codes = sheet('Codes'), cv = codes.getDataRange().getValues();
    for (let i = cv.length - 1; i >= 1; i--) if (cleanVoter(cv[i][2]).toLowerCase() === key) codes.deleteRow(i + 1);
    forget('Codes');
    log(email, 'remove ballot', key + ' (' + rows.length + ' vote rows)');
    return Object.assign(adminState(), {dataCheck: dataCheck()});
  });
}

/* ===== Optional "Sign in with Discord" =====
 * Setup: create an application at discord.com/developers, add the PUBLIC web app's /exec address as an OAuth2
 * redirect, put its Client ID in Settings, and its Client Secret in
 * Project Settings → Script properties as DISCORD_CLIENT_SECRET. Voters who sign in get a signed pass; their ballot
 * then records a scrambled form of their Discord ID (never the ID itself), so one account can be spotted voting
 * under two names. Signing in is optional; voting without Discord works as before. */

function passSecret() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('PASS_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('PASS_SECRET', s); }
  return s;
}
function b64url(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
function signPass(obj) {
  const body = b64url(Utilities.newBlob(JSON.stringify(obj)).getBytes());
  return body + '.' + b64url(Utilities.computeHmacSha256Signature(body, passSecret()));
}
function readPass(pass) {
  const parts = String(pass || '').split('.');
  if (parts.length !== 2 || b64url(Utilities.computeHmacSha256Signature(parts[0], passSecret())) !== parts[1]) return null;
  try {
    const pad = parts[0] + '==='.slice((parts[0].length + 3) % 4);
    const o = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(pad)).getDataAsString());
    return o && o.x > Date.now() ? o : null;
  } catch (err) {
    return null;
  }
}
function scrambledId(id) {
  return b64url(Utilities.computeHmacSha256Signature('discord:' + id, passSecret())).slice(0, 16).toUpperCase();
}

// Only send voters back to our own ballot pages.
function safeReturn(url) {
  url = String(url || '');
  const ok = /^https:\/\/(benburnsred|animexangas)\.github\.io\/awards\/vote\//.test(url);
  return ok ? url.split('#')[0].split('?')[0] : '';
}

function discordPage(title, text, link, linkText) {
  const t = HtmlService.createTemplate(
    '<div style="font-family:system-ui,sans-serif;background:#030806;color:#e8f5ec;min-height:100vh;margin:0;display:grid;place-items:center;text-align:center;padding:24px">' +
    '<div><h2 style="color:#e9c46a;font-weight:600"><?= title ?></h2><p style="color:#a9bcb2;max-width:420px"><?= text ?></p>' +
    '<? if (link) { ?><p><a href="<?= link ?>" target="_top" style="display:inline-block;padding:12px 22px;border:1px solid #c99a3c;color:#f6e3ad;text-decoration:none">' +
    '<?= linkText ?></a></p><script>try { window.top.location.href = <?!= JSON.stringify(link) ?>; } catch (e) {}</script><? } ?></div></div>');
  t.title = title; t.text = text; t.link = link || ''; t.linkText = linkText || '';
  return t.evaluate().setTitle('Anime X Angas Awards').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Swaps the one-time code from Discord for the voter's username and picture, and returns a signed pass.
// redirect must be one of our ballot pages and match the address the sign-in started from.
function discordExchange(code, redirect) {
  if (!code || !safeReturn(redirect)) return {ok: false, error: 'Sign-in link not recognised. Please try again.'};
  const clientId = String(settingsMap().discord_client_id || '').trim();
  const secret = PropertiesService.getScriptProperties().getProperty('DISCORD_CLIENT_SECRET');
  if (!clientId || !secret) return {ok: false, error: 'Discord sign-in isn’t set up yet. You can still vote without Discord.'};
  const tok = JSON.parse(UrlFetchApp.fetch('https://discord.com/api/oauth2/token', {method: 'post', muteHttpExceptions: true,
    payload: {client_id: clientId, client_secret: secret, grant_type: 'authorization_code', code: code, redirect_uri: redirect}}).getContentText());
  if (!tok.access_token) throw new Error(tok.error_description || tok.error || 'no token');
  const user = JSON.parse(UrlFetchApp.fetch('https://discord.com/api/users/@me',
    {headers: {Authorization: 'Bearer ' + tok.access_token}, muteHttpExceptions: true}).getContentText());
  if (!user.id) throw new Error('no user');
  const name = user.global_name || user.username;   // only the basic profile is asked for: no server or member info
  const avatar = user.avatar ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=256'
    : 'https://cdn.discordapp.com/embed/avatars/' + (Number(String(user.id).slice(-4)) % 6) + '.png';
  return {ok: true, pass: signPass({h: scrambledId(user.id), n: String(name).slice(0, 40), a: avatar, x: Date.now() + 12 * 3600 * 1000})};
}

// Older sign-in route: Discord sends the voter back here with ?code=…&state=… (state carries the ballot address and a one-time nonce).
function discordCallback(p) {
  let st = {};
  try {
    const raw = String(p.state || ''), pad = raw + '==='.slice((raw.length + 3) % 4);
    st = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(pad)).getDataAsString());
  } catch (err) {}
  const back = safeReturn(st.r);
  if (!back) return discordPage('Sign-in link not recognised', 'Please go back to the ballot and try again.');
  const s = settingsMap(), clientId = String(s.discord_client_id || '').trim();
  const secret = PropertiesService.getScriptProperties().getProperty('DISCORD_CLIENT_SECRET');
  if (p.error || !p.code) return discordPage('Discord sign-in cancelled', 'No problem: you can still vote without Discord.', back, 'Back to the ballot');
  if (!clientId || !secret) return discordPage('Discord sign-in isn\'t set up yet', 'You can still vote without Discord.', back, 'Back to the ballot');
  try {
    const tok = JSON.parse(UrlFetchApp.fetch('https://discord.com/api/oauth2/token', {method: 'post', muteHttpExceptions: true,
      payload: {client_id: clientId, client_secret: secret, grant_type: 'authorization_code', code: p.code, redirect_uri: st.u}}).getContentText());
    if (!tok.access_token) throw new Error(tok.error_description || tok.error || 'no token');
    const auth = {headers: {Authorization: 'Bearer ' + tok.access_token}, muteHttpExceptions: true};
    const user = JSON.parse(UrlFetchApp.fetch('https://discord.com/api/users/@me', auth).getContentText());
    if (!user.id) throw new Error('no user');
    const name = user.global_name || user.username;   // only the basic profile is asked for: no server or member info
    let avatar = user.avatar ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=256' : '';
    if (!avatar) avatar = 'https://cdn.discordapp.com/embed/avatars/' + (Number(String(user.id).slice(-4)) % 6) + '.png';
    const pass = signPass({h: scrambledId(user.id), n: String(name).slice(0, 40), a: avatar, x: Date.now() + 12 * 3600 * 1000});
    return discordPage('Signed in as ' + name, 'Taking you back to the ballot…', back + '#dc=' + pass + '&n=' + encodeURIComponent(st.n || ''), 'Continue to the ballot');
  } catch (err) {
    console.error(err);
    return discordPage('Discord sign-in didn\'t work', 'You can still vote without Discord, or try again in a moment.', back, 'Back to the ballot');
  }
}
