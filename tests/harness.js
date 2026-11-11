/* Test harness for apps-script/Code.gs.
 *
 * Code.gs runs inside Google Apps Script, which provides SpreadsheetApp, Utilities and friends. This file builds
 * small stand-ins for those (a pretend Google Sheet kept in memory) so the same code can run in Node or a browser.
 * Nothing here touches the real Sheet, Discord or the internet.
 *
 * Used by run.js (Node) and index.html (browser).
 */
(function (root) {
  'use strict';

  /* ---- SHA-256 and HMAC over byte arrays (plain JS, so it works the same everywhere and without waiting) ---- */
  const K = [];
  (function () {
    const isPrime = n => { for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; };
    for (let n = 2; K.length < 64; n++) if (isPrime(n)) K.push((Math.cbrt(n) % 1) * 4294967296 >>> 0);
  })();
  function sha256(bytes) {
    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const msg = bytes.slice(), bits = bytes.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    for (let i = 7; i >= 0; i--) msg.push(i >= 4 ? 0 : (bits >>> (i * 8)) & 255);
    const w = new Array(64), rot = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < msg.length; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = (msg[o + i * 4] << 24 | msg[o + i * 4 + 1] << 16 | msg[o + i * 4 + 2] << 8 | msg[o + i * 4 + 3]) >>> 0;
      for (let i = 16; i < 64; i++) {
        const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      [a, b, c, d, e, f, g, hh].forEach((v, i) => h[i] = (h[i] + v) >>> 0);
    }
    const out = [];
    h.forEach(v => out.push(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255));
    return out;
  }
  const utf8 = s => Array.from(new TextEncoder().encode(String(s)));
  const unsigned = bytes => Array.from(bytes, b => b & 255);
  function hmacSha256(value, key) {
    let k = typeof key === 'string' ? utf8(key) : unsigned(key);
    if (k.length > 64) k = sha256(k);
    while (k.length < 64) k.push(0);
    const m = typeof value === 'string' ? utf8(value) : unsigned(value);
    return sha256(k.map(b => b ^ 0x5c).concat(sha256(k.map(b => b ^ 0x36).concat(m))));
  }

  /* ---- A pretend spreadsheet ---- */
  // Like Google Sheets, a leading apostrophe marks text and isn't part of the stored value.
  const stored = v => typeof v === 'string' && v.charAt(0) === "'" ? v.slice(1) : v;

  class FakeSheet {
    constructor(name) { this.name = name; this.rows = []; }
    getName() { return this.name; }
    setFrozenRows() {}
    appendRow(r) { this.rows.push(r.map(stored)); }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
    deleteRow(n) { this.rows.splice(n - 1, 1); }
    getDataRange() { return this.getRange(1, 1, Math.max(1, this.rows.length), Math.max(1, this.getLastColumn())); }
    getRange(r, c, nr, nc) {
      const sh = this; nr = nr || 1; nc = nc || 1;
      const range = {
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = sh.rows[r - 1 + i] || [];
            out.push(Array.from({length: nc}, (_, k) => row[c - 1 + k] === undefined ? '' : row[c - 1 + k]));
          }
          return out;
        },
        setValues(values) {
          values.forEach((vals, i) => {
            while (sh.rows.length < r + i) sh.rows.push([]);
            const row = sh.rows[r - 1 + i];
            vals.forEach((v, k) => { while (row.length < c - 1 + k) row.push(''); row[c - 1 + k] = stored(v); });
          });
          return range;
        },
        setValue(v) { return range.setValues([[v]]); },
        setNumberFormat() { return range; },
        clearContent() {
          for (let i = 0; i < nr; i++) {
            const row = sh.rows[r - 1 + i];
            if (row) for (let k = 0; k < nc; k++) if (c - 1 + k < row.length) row[c - 1 + k] = '';
          }
          while (sh.rows.length && sh.rows[sh.rows.length - 1].every(v => v === '')) sh.rows.pop();
          return range;
        }
      };
      return range;
    }
  }

  class FakeSpreadsheet {
    constructor(name) { this.name = name; this.sheets = {}; }
    getSheetByName(n) { return this.sheets[n] || null; }
    insertSheet(n) { return this.sheets[n] = new FakeSheet(n); }
    getUrl() { return 'https://sheets.example/' + this.name; }
    getName() { return this.name; }
  }

  /* ---- The pretend Apps Script services ---- */
  function makeEnv() {
    const env = {
      ss: new FakeSpreadsheet('AxA Awards test'),
      otherSheets: {},                 // spreadsheets opened by id (votes_sheet_id)
      user: 'admin@example.com',       // who is "signed in" to the admin web app
      props: {},                       // Script properties (secrets)
      cache: {},                       // CacheService
      lockFree: true,                  // false = another request holds the lock
      fetches: [],                     // every UrlFetchApp call made
      fetch: () => { throw new Error('No internet in tests: ' + 'set env.fetch'); },
      errors: [],                      // console.error calls
      uuid: 0
    };
    const email = () => ({getEmail: () => env.user});
    env.globals = {
      SpreadsheetApp: {
        getActive: () => env.ss,
        openById: id => { if (!env.otherSheets[id]) throw new Error('No such spreadsheet'); return env.otherSheets[id]; }
      },
      Session: {getActiveUser: email, getEffectiveUser: email},
      LockService: {getScriptLock: () => ({tryLock: () => env.lockFree, releaseLock() {}})},
      CacheService: {getScriptCache: () => ({get: k => (k in env.cache ? env.cache[k] : null), put: (k, v) => { env.cache[k] = String(v); }})},
      PropertiesService: {getScriptProperties: () => ({
        getProperty: k => (k in env.props ? env.props[k] : null), setProperty: (k, v) => { env.props[k] = String(v); }})},
      ContentService: {
        MimeType: {JSON: 'application/json'},
        createTextOutput: text => { const o = {text: text, setMimeType: () => o, getContent: () => text}; return o; }
      },
      HtmlService: {
        createHtmlOutputFromFile: file => { const o = {file: file, setTitle: t => { o.title = t; return o; }, addMetaTag: () => o}; return o; },
        createTemplate: html => { const t = {html: html, evaluate: () => { const o = {template: t, setTitle: () => o, addMetaTag: () => o}; return o; }}; return t; }
      },
      Utilities: {
        getUuid: () => { const n = (++env.uuid).toString(16).padStart(8, '0'); return n + '-0000-4000-8000-' + n.padStart(12, '0'); },
        computeHmacSha256Signature: (value, key) => hmacSha256(value, key),
        base64EncodeWebSafe: bytes => btoa(String.fromCharCode.apply(null, unsigned(bytes))).replace(/\+/g, '-').replace(/\//g, '_'),
        base64DecodeWebSafe: s => Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0)),
        newBlob: data => ({
          getBytes: () => typeof data === 'string' ? utf8(data) : unsigned(data),
          getDataAsString: () => typeof data === 'string' ? data : new TextDecoder().decode(new Uint8Array(unsigned(data)))
        })
      },
      UrlFetchApp: {fetch: (url, opts) => {
        env.fetches.push({url: url, opts: opts || {}});
        const res = env.fetch(url, opts || {});
        const text = typeof res === 'string' ? res : JSON.stringify(res);
        return {getContentText: () => text, getResponseCode: () => 200};
      }},
      console: {log() {}, warn() {}, error: e => { env.errors.push(e); }}
    };
    return env;
  }

  // Names of every top-level function and const in Code.gs.
  function topLevelNames(source) {
    const names = [], re = /^(?:function|const)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = re.exec(source))) names.push(m[1]);
    return names;
  }

  // Runs Code.gs against a fresh pretend environment. Returns {api, env}: api holds every top-level function and const.
  function load(source) {
    const env = makeEnv(), names = Object.keys(env.globals);
    const build = new Function(names.join(','), source + '\n;return {' + topLevelNames(source).join(',') + '};');
    return {api: build.apply(null, names.map(n => env.globals[n])), env: env};
  }

  const Harness = {load: load, topLevelNames: topLevelNames, hmacSha256: hmacSha256, sha256: sha256, FakeSpreadsheet: FakeSpreadsheet};
  if (typeof module !== 'undefined' && module.exports) module.exports = Harness;
  else root.AxaHarness = Harness;
})(typeof globalThis !== 'undefined' ? globalThis : this);
