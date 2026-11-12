/* Unit tests for apps-script/Code.gs (plus a few checks that the pages and the script still agree).
 *
 * AxaTests(Harness, files) runs every test and returns [{group, name, ok, error}].
 * files = {code: Code.gs text, admin: Admin.html text, vote: vote/index.html text}.
 * Each test gets its own pretend Google Sheet, so tests can't affect each other or anything real.
 */
(function (root) {
  'use strict';

  function AxaTests(Harness, files) {
    const results = [];
    let group = '';
    const test = (name, fn) => {
      try { fn(); results.push({group: group, name: name, ok: true}); }
      catch (err) { results.push({group: group, name: name, ok: false, error: String((err && err.message) || err)}); }
    };
    const show = v => JSON.stringify(v);
    const ok = (cond, msg) => { if (!cond) throw new Error(msg || 'Expected a true value'); };
    const eq = (actual, expected, msg) => {
      if (show(actual) !== show(expected)) throw new Error((msg ? msg + ': ' : '') + 'expected ' + show(expected) + ' but got ' + show(actual));
    };
    const throws = (fn, re, msg) => {
      let err = null;
      try { fn(); } catch (e) { err = e; }
      if (!err) throw new Error((msg ? msg + ': ' : '') + 'expected an error, but nothing was refused');
      if (re && !re.test(String(err.message))) throw new Error((msg ? msg + ': ' : '') + 'expected an error like ' + re + ' but got "' + err.message + '"');
    };

    const VOTE_PAGE = 'https://benburnsred.github.io/awards/vote/';

    // A fresh script with a small official ballot: one category per voting method, plus a special award.
    function world() {
      const w = Harness.load(files.code), api = w.api, env = w.env;
      api.setup();
      w.sheet = name => env.ss.getSheetByName(name);
      // Apps Script starts every request with fresh globals; this does the same between calls.
      w.newRequest = () => { api.CACHE.tables = {}; api.CACHE.sheets = {}; api.CACHE.votes = null; };
      w.addCategory = (id, name, type, method, maxPicks, nominees) => {
        w.sheet('Categories').appendRow([id, name, '', type, method, maxPicks || '', '', '', String(w.sheet('Categories').getLastRow()), '']);
        nominees.forEach(n => w.sheet('Nominees').appendRow([n, id, 'Nominee ' + n, '', '', '', '', '']));
      };
      w.addCategory('c_tier', 'Tier', 'vote', 'tier', '', ['t1', 't2', 't3', 't4', 't5', 't6']);
      w.addCategory('c_single', 'Single', 'vote', 'single', '', ['s1', 's2', 's3']);
      w.addCategory('c_multi', 'Multi', 'vote', 'multi', '2', ['m1', 'm2', 'm3', 'm4']);
      w.addCategory('c_rank', 'Rank', 'vote', 'rank', '3', ['r1', 'r2', 'r3', 'r4']);
      w.addCategory('c_special', 'Special', 'special', 'single', '', ['x1']);
      w.set = (key, value) => {
        const sh = w.sheet('Settings'), row = sh.rows.find(r => r[0] === key);
        if (row) row[1] = value; else sh.appendRow([key, value]);
      };
      w.post = body => { w.newRequest(); return JSON.parse(api.doPost({postData: {contents: typeof body === 'string' ? body : JSON.stringify(body)}}).text); };
      w.get = params => { w.newRequest(); return api.doGet({parameter: params}); };
      w.as = user => ({call: (fn, ...args) => { env.user = user; w.newRequest(); return api[fn](...args); }});
      w.admin = (fn, ...args) => w.as('admin@example.com').call(fn, ...args);
      w.ballot = (voter, items, extra) => w.post(Object.assign({action: 'ballot', voter: voter,
        ballots: Object.keys(items).map(c => ({category: c, placements: items[c]}))}, extra || {}));
      w.votesSheet = () => w.sheet('Votes') || (() => { const s = env.ss.insertSheet('Votes'); s.appendRow(api.TABS.Votes); return s; })();
      w.votes = () => (w.sheet('Votes') ? w.sheet('Votes').rows.slice(1) : []).map(r =>
        ({voter: r[1], code: r[2], category: r[3], nominee: r[4], value: r[5], points: r[6]}));
      return w;
    }
    const tier = (nominee, t) => ({nominee: nominee, tier: t});
    const pick = nominee => ({nominee: nominee});
    const cat = (w, id) => w.api.readTable('Categories').find(c => c.id === id);
    const score = (w, id, placements) => {
      w.newRequest();
      const ids = w.api.readTable('Nominees').filter(n => n.category_id === id).map(n => n.id);
      return w.api.scoreBallot(cat(w, id), ids, placements);
    };

    /* ============================================================ */
    group = 'Scoring a ballot';

    test('Tier list: S=5, A=4, B=3, C=2, D=1 points', () => {
      const w = world();
      const out = score(w, 'c_tier', [['t1', 'S'], ['t2', 'A'], ['t3', 'B'], ['t4', 'C'], ['t5', 'D']].map(p => ({nominee: p[0], value: p[1]})));
      eq(out.map(o => o.points), [5, 4, 3, 2, 1]);
    });
    test('Tier list: only 1 nominee in S, 2 in A, 3 in B', () => {
      const w = world(), v = (n, t) => ({nominee: n, value: t});
      throws(() => score(w, 'c_tier', [v('t1', 'S'), v('t2', 'S')]), /S tier allows only 1/);
      throws(() => score(w, 'c_tier', [v('t1', 'A'), v('t2', 'A'), v('t3', 'A')]), /A tier allows only 2/);
      throws(() => score(w, 'c_tier', [v('t1', 'B'), v('t2', 'B'), v('t3', 'B'), v('t4', 'B')]), /B tier allows only 3/);
    });
    test('Tier list: C and D have no limit', () => {
      const w = world();
      eq(score(w, 'c_tier', ['t1', 't2', 't3', 't4', 't5', 't6'].map(n => ({nominee: n, value: 'D'}))).length, 6);
    });
    test('Tier list: an unknown tier letter is refused', () => {
      const w = world();
      throws(() => score(w, 'c_tier', [{nominee: 't1', value: 'Z'}]), /Invalid ballot/);
      throws(() => score(w, 'c_tier', [{nominee: 't1', value: ''}]), /Invalid ballot/);
    });
    test('Pick one: exactly one nominee, worth 1 point', () => {
      const w = world();
      eq(score(w, 'c_single', [{nominee: 's2', value: ''}]), [{nominee: 's2', value: 'pick', points: 1}]);
      throws(() => score(w, 'c_single', [{nominee: 's1', value: ''}, {nominee: 's2', value: ''}]), /exactly one/);
    });
    test('Pick up to N: more than N is refused', () => {
      const w = world(), p = n => ({nominee: n, value: ''});
      eq(score(w, 'c_multi', [p('m1'), p('m2')]).map(o => o.points), [1, 1]);
      throws(() => score(w, 'c_multi', [p('m1'), p('m2'), p('m3')]), /Pick at most 2/);
    });
    test('Rank top N: first place scores most', () => {
      const w = world(), p = n => ({nominee: n, value: ''});
      eq(score(w, 'c_rank', [p('r3'), p('r1'), p('r2')]), [{nominee: 'r3', value: '1', points: 3}, {nominee: 'r1', value: '2', points: 2}, {nominee: 'r2', value: '3', points: 1}]);
    });
    test('A nominee from another category is refused', () => {
      const w = world();
      throws(() => score(w, 'c_single', [{nominee: 't1', value: ''}]), /Invalid ballot/);
    });
    test('The same nominee twice is refused', () => {
      const w = world();
      throws(() => score(w, 'c_tier', [{nominee: 't1', value: 'C'}, {nominee: 't1', value: 'D'}]), /Invalid ballot/);
    });
    test('Pick limit defaults to 3 and never exceeds the number of nominees', () => {
      const w = world();
      eq(w.api.maxPicks({max_picks: ''}, 10), 3);
      eq(w.api.maxPicks({max_picks: '5'}, 10), 5);
      eq(w.api.maxPicks({max_picks: '5'}, 2), 2);
      eq(w.api.maxPicks({max_picks: '-1'}, 10), 3);
    });

    /* ============================================================ */
    group = 'Submitting a ballot';

    test('A valid ballot is saved, one row per pick', () => {
      const w = world();
      eq(w.ballot('Ben', {c_tier: [tier('t1', 'S'), tier('t2', 'A')], c_single: [pick('s1')]}), {ok: true});
      eq(w.votes().map(v => [v.voter, v.category, v.nominee, v.value, v.points]),
        [['Ben', 'c_tier', 't1', 'S', 5], ['Ben', 'c_tier', 't2', 'A', 4], ['Ben', 'c_single', 's1', 'pick', 1]]);
    });
    test('Points sent by the browser are ignored: the script works them out', () => {
      const w = world();
      w.ballot('Ben', {c_tier: [{nominee: 't1', tier: 'D', points: 999}]});
      eq(w.votes()[0].points, 1);
    });
    test('One ballot per name: a second ballot is refused and changes nothing', () => {
      const w = world();
      w.ballot('Ben', {c_single: [pick('s1')]});
      const res = w.ballot('Ben', {c_single: [pick('s2')]});
      eq([res.ok, res.taken], [false, true]);
      eq(w.votes().length, 1);
    });
    test('Names are compared ignoring capitals and extra spaces', () => {
      const w = world();
      w.ballot('Ben Burns', {c_single: [pick('s1')]});
      eq(w.ballot('  ben   BURNS ', {c_single: [pick('s2')]}).taken, true);
    });
    test('A voter can only add to their own ballot once: other categories later are refused too', () => {
      const w = world();
      w.ballot('Ben', {c_single: [pick('s1')]});
      eq(w.ballot('Ben', {c_multi: [pick('m1')]}).ok, false);
    });
    test('The name check tells the ballot page whether a name is taken', () => {
      const w = world();
      eq(w.post({action: 'checkName', voter: 'Ben'}), {ok: true, taken: false});
      w.ballot('Ben', {c_single: [pick('s1')]});
      eq(w.post({action: 'checkName', voter: 'BEN'}), {ok: true, taken: true});
      eq(w.post({action: 'checkName', voter: '   '}).ok, false);
    });
    test('A ballot needs a name', () => {
      const w = world();
      eq(w.ballot('   ', {c_single: [pick('s1')]}), {ok: false, error: 'Please enter your name'});
      eq(w.votes().length, 0);
    });
    test('Names are tidied and cut to 40 characters', () => {
      const w = world();
      eq(w.api.cleanVoter('  Ben \n  Burns  '), 'Ben Burns');
      eq(w.api.cleanVoter('x'.repeat(200)).length, 40);
      eq(w.api.cleanVoter(null), '');
    });
    test('An empty ballot is refused; skipped categories are fine', () => {
      const w = world();
      eq(w.ballot('Ben', {}).error, 'Empty ballot');
      eq(w.ballot('Ben', {c_tier: [], c_single: []}).error, 'Empty ballot');
      eq(w.ballot('Ben', {c_tier: [], c_single: [pick('s1')]}).ok, true);
    });
    test('Breaking a category rule refuses the whole ballot and names the category', () => {
      const w = world();
      const res = w.ballot('Ben', {c_single: [pick('s1')], c_tier: [tier('t1', 'S'), tier('t2', 'S')]});
      eq(res, {ok: false, error: 'Tier: S tier allows only 1'});
      eq(w.votes().length, 0);
    });
    test('An unknown category, or the same category twice, is refused', () => {
      const w = world();
      eq(w.ballot('Ben', {nope: [pick('s1')]}).error, 'Invalid ballot');
      eq(w.post({action: 'ballot', voter: 'Ben', ballots: [{category: 'c_single', placements: [pick('s1')]}, {category: 'c_single', placements: [pick('s2')]}]}).error, 'Invalid ballot');
      eq(w.votes().length, 0);
    });
    test('Special awards cannot be voted on', () => {
      const w = world();
      eq(w.ballot('Ben', {c_special: [pick('x1')]}).ok, false);
      eq(w.votes().length, 0);
    });
    test('Requests that are not a ballot are refused', () => {
      const w = world();
      eq(w.post('this is not json').error, 'Invalid request');
      eq(w.post({action: 'adminPublish'}).error, 'Invalid request');
      eq(w.post({action: 'adminRemoveBallot', key: 'ben'}).error, 'Invalid request');
      eq(w.post({}).error, 'Invalid request');
      ok(/out of date/.test(w.post({action: 'vote'}).error), 'the old one-category ballot is told to reload');
    });
    test('A busy script gives a clear message and saves nothing', () => {
      const w = world();
      w.env.lockFree = false;
      eq(w.ballot('Ben', {c_single: [pick('s1')]}), {ok: false, error: 'Busy — please try again'});
      eq(w.votes().length, 0);
    });

    /* ============================================================ */
    group = 'Voting window';

    test('Voting open = No closes the ballot', () => {
      const w = world();
      w.set('vote_open', 'FALSE');
      eq(w.ballot('Ben', {c_single: [pick('s1')]}), {ok: false, error: 'Voting is closed'});
    });
    test('Before the start time the ballot is closed', () => {
      const w = world();
      w.set('voting_opens', new Date(Date.now() + 3600000).toISOString());
      eq(w.ballot('Ben', {c_single: [pick('s1')]}).error, 'Voting is closed');
      eq(w.votes().length, 0);
    });
    test('After the end time the ballot is closed', () => {
      const w = world();
      w.set('voting_closes', new Date(Date.now() - 3600000).toISOString());
      eq(w.ballot('Ben', {c_single: [pick('s1')]}).error, 'Voting is closed');
    });
    test('Inside the window the ballot is open', () => {
      const w = world();
      w.set('voting_opens', new Date(Date.now() - 3600000).toISOString());
      w.set('voting_closes', new Date(Date.now() + 3600000).toISOString());
      eq(w.ballot('Ben', {c_single: [pick('s1')]}).ok, true);
    });
    test('The official window (Dec 12 to Dec 20, Philippine time) opens and closes at the right moment', () => {
      const w = world();
      w.set('voting_opens', '2026-12-11T16:00:00.000Z');
      w.set('voting_closes', '2026-12-20T15:59:59.000Z');
      const open = iso => { w.newRequest(); return w.api.isOpen({type: 'vote'}, new Date(iso)); };
      eq([open('2026-12-11T15:59:59Z'), open('2026-12-11T16:00:00Z'), open('2026-12-20T15:59:59Z'), open('2026-12-20T16:00:00Z')], [false, true, true, false]);
    });

    /* ============================================================ */
    group = 'Voter codes';

    test('With no codes listed, no code is needed', () => {
      const w = world();
      eq(w.ballot('Ben', {c_single: [pick('s1')]}).ok, true);
    });
    test('With codes listed, a missing or unknown code is refused', () => {
      const w = world();
      w.sheet('Codes').appendRow(['ABC123', '', '', '']);
      eq(w.ballot('Ben', {c_single: [pick('s1')]}).error, 'Unknown voter code');
      eq(w.ballot('Ben', {c_single: [pick('s1')]}, {code: 'WRONG'}).error, 'Unknown voter code');
      eq(w.votes().length, 0);
    });
    test('A code works once', () => {
      const w = world();
      w.sheet('Codes').appendRow(['ABC123', '', '', '']);
      eq(w.ballot('Ben', {c_single: [pick('s1')]}, {code: 'abc123'}).ok, true);
      eq(w.ballot('Someone Else', {c_single: [pick('s1')]}, {code: 'ABC123'}).error, 'This code has already voted');
      eq(w.votes().length, 1);
    });

    /* ============================================================ */
    group = 'Discord sign-in';

    const pass = (w, extra) => w.api.signPass(Object.assign({h: 'SCRAMBLED1234567', n: 'Ben', a: '', x: Date.now() + 3600000}, extra || {}));

    test('A signed pass reads back; a changed one does not', () => {
      const w = world(), p = pass(w);
      eq(w.api.readPass(p).h, 'SCRAMBLED1234567');
      const flip = s => (s.charAt(5) === 'A' ? 'B' : 'A');
      eq(w.api.readPass(p.slice(0, 5) + flip(p) + p.slice(6)), null, 'a changed pass');
      eq(w.api.readPass(p.split('.')[0] + '.AAAA'), null, 'a wrong signature');
      eq(w.api.readPass(''), null);
      eq(w.api.readPass('a.b.c'), null);
    });
    test('A pass signed with another key is refused', () => {
      const w = world(), other = world();
      other.env.props.PASS_SECRET = 'a different secret';
      eq(w.api.readPass(pass(other)), null);
    });
    test('An expired pass is refused', () => {
      const w = world();
      eq(w.api.readPass(pass(w, {x: Date.now() - 1000})), null);
    });
    test('A ballot with a Discord pass is recorded with a scrambled account code', () => {
      const w = world();
      eq(w.ballot('Ben', {c_single: [pick('s1')]}, {dc: pass(w)}).ok, true);
      eq(w.votes()[0].code, 'DC-SCRAMBLED1234567');
    });
    test('A ballot with a bad Discord pass is refused, not saved without it', () => {
      const w = world();
      const res = w.ballot('Ben', {c_single: [pick('s1')]}, {dc: 'made.up'});
      ok(!res.ok && /Discord sign-in has expired/.test(res.error), show(res));
      eq(w.votes().length, 0);
    });
    test('A voter cannot fake a Discord code by typing one', () => {
      const w = world();
      eq(w.ballot('Ben', {c_single: [pick('s1')]}, {code: 'DC-FAKE'}).ok, true);
      eq(w.votes()[0].code, '', 'a typed DC- code is dropped');
      const strict = world();
      strict.sheet('Codes').appendRow(['ABC123', '', '', '']);
      eq(strict.ballot('Ben', {c_single: [pick('s1')]}, {code: 'DC-FAKE'}).error, 'Unknown voter code', 'and it does not skip the voter-code check');
      eq(strict.ballot('Ben', {c_single: [pick('s1')]}, {dc: pass(strict)}).ok, true, 'a real Discord sign-in does');
    });
    test('The account code is scrambled: stable, and never the real Discord ID', () => {
      const w = world(), id = '123456789012345678';
      const a = w.api.scrambledId(id);
      eq(a, w.api.scrambledId(id));
      ok(a !== w.api.scrambledId('123456789012345679'), 'different accounts get different codes');
      ok(a.indexOf(id) < 0 && a.length === 16, a);
    });
    test('Sign-in only returns to the real ballot pages', () => {
      const w = world(), safe = w.api.safeReturn;
      eq(safe('https://benburnsred.github.io/awards/vote/'), 'https://benburnsred.github.io/awards/vote/');
      eq(safe('https://animexangas.github.io/awards/vote/#x'), 'https://animexangas.github.io/awards/vote/');
      ['https://evil.example/awards/vote/', 'https://benburnsred.github.io.evil.example/awards/vote/', 'http://benburnsred.github.io/awards/vote/',
        'https://someoneelse.github.io/awards/vote/', 'https://benburnsred.github.io/other/', 'javascript:alert(1)', '', null]
        .forEach(u => eq(safe(u), '', 'should refuse ' + u));
    });
    const discordWorld = () => {
      const w = world();
      w.set('discord_client_id', '111');
      w.env.props.DISCORD_CLIENT_SECRET = 'top-secret-value';
      w.env.fetch = url => /oauth2\/token/.test(url) ? {access_token: 'tok'} : {id: '123456789012345678', username: 'ben', global_name: 'Ben B', avatar: 'abc'};
      return w;
    };
    test('Finishing sign-in gives a pass with the name and picture, and nothing else', () => {
      const w = discordWorld();
      const res = w.post({action: 'discord', code: 'one-time-code', redirect: VOTE_PAGE});
      eq(res.ok, true);
      const p = w.api.readPass(res.pass);
      eq(Object.keys(p).sort(), ['a', 'h', 'n', 'x']);
      eq(p.n, 'Ben B');
      ok(/^https:\/\/cdn\.discordapp\.com\/avatars\//.test(p.a), p.a);
      ok(show(res).indexOf('top-secret-value') < 0 && show(res).indexOf('tok') < 0, 'no secret or token goes back to the browser');
    });
    test('The secret key is only ever sent to discord.com', () => {
      const w = discordWorld();
      w.post({action: 'discord', code: 'one-time-code', redirect: VOTE_PAGE});
      ok(w.env.fetches.length === 2, 'two calls to Discord');
      w.env.fetches.forEach(f => ok(/^https:\/\/discord\.com\//.test(f.url), 'unexpected address ' + f.url));
    });
    test('Sign-in from an unknown page is refused before Discord is contacted', () => {
      const w = discordWorld();
      eq(w.post({action: 'discord', code: 'one-time-code', redirect: 'https://evil.example/awards/vote/'}).ok, false);
      eq(w.post({action: 'discord', code: '', redirect: VOTE_PAGE}).ok, false);
      eq(w.env.fetches.length, 0);
    });
    test('If Discord refuses the code, the voter gets a plain message with no details', () => {
      const w = discordWorld();
      w.env.fetch = () => ({error: 'invalid_grant', error_description: 'internal detail'});
      const res = w.post({action: 'discord', code: 'bad', redirect: VOTE_PAGE});
      ok(!res.ok && res.error.indexOf('internal detail') < 0 && /still vote without Discord/.test(res.error), show(res));
    });
    test('Without setup, sign-in says so and contacts nobody', () => {
      const w = world();
      const res = w.post({action: 'discord', code: 'x', redirect: VOTE_PAGE});
      ok(!res.ok && /set up/.test(res.error), show(res));
      eq(w.env.fetches.length, 0);
    });

    /* ============================================================ */
    group = 'Flood limit';

    test('More than 120 ballots in a minute get "Busy" and are not saved', () => {
      const w = world();
      // 241 quick ballots: even if the clock ticks over a minute halfway, one minute still gets more than 120.
      const out = [];
      for (let i = 0; i < 241; i++) out.push(w.ballot('Voter ' + i, {c_single: [pick('s1')]}));
      const busy = out.filter(r => !r.ok && /Busy/.test(r.error)).length;
      ok(busy >= 1, 'expected some ballots to be turned away');
      eq(w.votes().length, 241 - busy);
      ok(w.votes().length <= 240, 'never more than 120 a minute');
    });
    test('A rush of 50 voters in one minute is not turned away', () => {
      const w = world();
      const out = [];
      for (let i = 0; i < 50; i++) out.push(w.ballot('Voter ' + i, {c_single: [pick('s1')]}));
      eq(out.filter(r => r.ok).length, 50);
      eq(w.votes().length, 50);
    });
    test('The limit counts each kind of request separately', () => {
      const w = world();
      eq(w.api.overLimit('a', 2), false);
      eq(w.api.overLimit('a', 2), false);
      eq(w.api.overLimit('b', 2), false);
      eq(w.api.overLimit('a', 2), true);
    });

    /* ============================================================ */
    group = 'Results';

    test('Totals add up points, voters and first-place picks', () => {
      const w = world();
      w.ballot('Ann', {c_tier: [tier('t1', 'S'), tier('t2', 'A')], c_rank: [pick('r1'), pick('r2')]});
      w.ballot('Bob', {c_tier: [tier('t2', 'S'), tier('t1', 'B')], c_rank: [pick('r1')]});
      w.newRequest();
      const t = w.api.tally();
      eq(t.c_tier.t1, {points: 8, voters: 2, top: 1});
      eq(t.c_tier.t2, {points: 9, voters: 2, top: 1});
      eq(t.c_rank.r1, {points: 6, voters: 2, top: 2});
      eq(w.api.tally('c_rank').r2, {points: 2, voters: 1, top: 0});
    });
    test('Results stay private: the public link refuses to give totals', () => {
      const w = world();
      eq(w.api.SHOW_RESULTS, false);
      const res = JSON.parse(w.get({action: 'results'}).text);
      eq(res.ok, false);
      ok(!('results' in res));
    });
    test('Votes kept in another sheet with its own column names are read and written correctly', () => {
      const w = world(), other = new Harness.FakeSpreadsheet('Old votes');
      const tab = other.insertSheet('Responses');
      tab.appendRow(['When', 'Name', 'Award', 'Pick', 'Tier']);
      tab.appendRow([new Date(), 'Old Voter', 'Tier', 'Nominee t3', 'A']);
      w.env.otherSheets.SHEET42 = other;
      w.set('votes_sheet_id', 'SHEET42');
      w.set('votes_tab', 'Responses');
      const map = w.sheet('VotesMapping');
      map.rows = [map.rows[0], ['timestamp', 'When'], ['voter', 'Name'], ['category', 'Award'], ['nominee', 'Pick'], ['value', 'Tier'], ['points', 'Score'], ['code', 'Code']];
      eq(w.ballot('Ben', {c_tier: [tier('t1', 'S')]}).ok, true);
      eq(tab.rows[2].slice(1), ['Ben', 'Tier', 'Nominee t1', 'S'], 'written with readable names');
      w.newRequest();
      eq(w.api.tally('c_tier'), {t3: {points: 4, voters: 1, top: 0}, t1: {points: 5, voters: 1, top: 1}}, 'no points column: tier letters score their points');
      eq(w.post({action: 'checkName', voter: 'old voter'}).taken, true);
    });

    /* ============================================================ */
    group = 'Admins only';

    const adminNames = Harness.topLevelNames(files.code).filter(n => /^admin/.test(n));

    test('There are admin functions to protect', () => ok(adminNames.length >= 10, show(adminNames)));
    test('Someone not on the admin list is refused by every admin function, and nothing changes', () => {
      const w = world(), before = show(w.env.ss.sheets);
      adminNames.forEach(fn => throws(() => w.as('stranger@example.com').call(fn, 'c_tier', []), /Not on the admin list/, fn));
      eq(show(w.env.ss.sheets), before);
    });
    test('Someone who is not signed in is refused by every admin function', () => {
      const w = world();
      adminNames.forEach(fn => throws(() => w.as('').call(fn, 'c_tier', []), /Not on the admin list/, fn));
    });
    test('A listed person without the admin role is refused by every admin function', () => {
      const w = world(), before = (w.sheet('Committee').appendRow(['member@example.com', 'Member', 'member']), show(w.env.ss.sheets));
      adminNames.forEach(fn => throws(() => w.as('member@example.com').call(fn, 'c_tier', []), /Admins only/, fn));
      eq(show(w.env.ss.sheets), before);
    });
    test('An admin gets the dashboard; emails match whatever the capitals', () => {
      const w = world();
      const st = w.as('ADMIN@example.com').call('adminState');
      eq(st.email, 'admin@example.com');
      eq(st.categories.length, 5);
    });
    test('If nobody has the admin role, only the first person listed is the admin', () => {
      const w = world(), sh = w.sheet('Committee');
      sh.rows = [sh.rows[0], ['first@example.com', 'First', ''], ['second@example.com', 'Second', '']];
      eq(w.as('first@example.com').call('adminState').email, 'first@example.com');
      throws(() => w.as('second@example.com').call('adminState'), /Admins only/);
    });
    test('The public ballot cannot open the admin page as someone else', () => {
      const w = world();
      eq(w.get({page: 'admin'}).file, 'Admin');
      eq(w.get({page: 'committee'}).file, 'Admin', 'old committee links land on the admin page');
      throws(() => w.as('stranger@example.com').call('adminState'), /Not on the admin list/);
    });

    /* ============================================================ */
    group = 'Admin dashboard';

    test('Publish copies the ballot to the Site tab and locks voted categories', () => {
      const w = world();
      const st = w.admin('adminPublish');
      const site = w.sheet('Site').rows;
      eq(site[0], w.api.SITE_HEADERS);
      eq(site.length - 1, 6 + 3 + 4 + 4 + 1);
      const locked = {};
      st.categories.forEach(c => locked[c.id] = c.locked);
      eq(locked, {c_tier: 'TRUE', c_single: 'TRUE', c_multi: 'TRUE', c_rank: 'TRUE', c_special: ''});
      eq(st.unpublished, false);
    });
    test('A locked category cannot have its nominees or voting method changed until unlocked', () => {
      const w = world();
      w.admin('adminPublish');
      throws(() => w.admin('adminSaveNominee', {category_id: 'c_single', name: 'Late entry'}), /locked/);
      throws(() => w.admin('adminDeleteNominee', 's1'), /locked/);
      throws(() => w.admin('adminSaveCategory', {id: 'c_single', name: 'Single', type: 'vote', method: 'tier'}), /locked/);
      w.admin('adminUnlockCategory', 'c_single');
      const st = w.admin('adminSaveNominee', {category_id: 'c_single', name: 'Late entry'});
      eq(st.nominees.filter(n => n.category_id === 'c_single').length, 4);
      eq(st.unpublished, true, 'a change after publishing shows as unpublished');
    });
    test('Categories and nominees that already have votes cannot be deleted', () => {
      const w = world();
      w.ballot('Ben', {c_single: [pick('s1')]});
      throws(() => w.admin('adminDeleteCategory', 'c_single'), /already has votes/);
      throws(() => w.admin('adminDeleteNominee', 's1'), /already has votes/);
      eq(w.admin('adminDeleteNominee', 's2').nominees.filter(n => n.category_id === 'c_single').length, 2);
      eq(w.sheet('Nominees').rows.length - 1, 6 + 2 + 4 + 4 + 1, 'no leftover rows in the Sheet');
    });
    test('Adding a category and a nominee', () => {
      const w = world();
      let st = w.admin('adminSaveCategory', {name: '  Best Game ', type: 'vote', method: 'nonsense', max_picks: 'x'});
      const c = st.categories[st.categories.length - 1];
      eq([c.name, c.type, c.method, c.max_picks, c.order], ['Best Game', 'vote', 'tier', '', '6']);
      throws(() => w.admin('adminSaveCategory', {name: '   '}), /needs a name/);
      throws(() => w.admin('adminSaveNominee', {category_id: 'nope', name: 'X'}), /Category not found/);
      throws(() => w.admin('adminSaveNominee', {category_id: c.id, name: ''}), /needs a name/);
      st = w.admin('adminSaveNominee', {category_id: c.id, name: 'Aion 2'});
      eq(st.nominees.filter(n => n.category_id === c.id).map(n => n.name), ['Aion 2']);
    });
    test('A nominee with an anime title and no picture gets its poster looked up', () => {
      const w = world();
      w.env.fetch = () => ({data: {Media: {coverImage: {extraLarge: 'https://img.example/poster.jpg'}}}});
      const st = w.admin('adminSaveNominee', {category_id: 'c_single', name: 'Song', image_search: 'Some Anime'});
      eq(st.nominees.find(n => n.name === 'Song').image, 'https://img.example/poster.jpg');
    });
    test('Winners can be set and cleared', () => {
      const w = world();
      eq(w.admin('adminSetWinners', 'c_single', ['s2']).nominees.filter(n => n.winner === 'TRUE').map(n => n.id), ['s2']);
      eq(w.admin('adminSetWinners', 'c_single', []).nominees.filter(n => n.winner === 'TRUE').length, 0);
    });
    test('Settings: only plain setting names are saved', () => {
      const w = world();
      const st = w.admin('adminSaveSettings', {vote_open: 'FALSE', 'Bad Key!': 'x'});
      eq(st.settings.vote_open, 'FALSE');
      ok(!('Bad Key!' in st.settings));
      eq(st.settings.title, 'Anime X Angas Awards 2026', 'other settings are kept');
    });
    test('Text typed by anyone is never stored as a spreadsheet formula', () => {
      const w = world();
      ['=IMPORTXML("x")', '+1', '-1', '@x'].forEach(s => eq(w.api.cell(s), "'" + s));
      eq(w.api.cell('Ben'), 'Ben');
    });
    test('Every change is written to the activity log with who did it', () => {
      const w = world();
      w.admin('adminSaveSettings', {venue: 'Discord'});
      w.admin('adminPublish');
      eq(w.sheet('Log').rows.slice(1).map(r => [r[1], r[2]]), [['admin@example.com', 'edit settings'], ['admin@example.com', 'publish']]);
    });

    /* ============================================================ */
    group = 'Data check';

    // Writes ballots straight into the Votes tab with chosen times (minutes after a fixed start).
    const ballotsAt = (w, list) => {
      const sh = w.votesSheet(), start = Date.UTC(2026, 11, 12, 4, 0, 0);
      list.forEach(b => b.picks.forEach(p => sh.appendRow([new Date(start + b.min * 60000), b.voter, b.code || '', p[0], p[1], p[2] || 'pick', 1])));
    };
    const flagsFor = (w, name) => {
      w.newRequest();
      const f = w.api.dataCheck().flagged.find(x => x.voter === name);
      return f ? f.flags.join(' | ') : '';
    };
    const some = [['c_single', 's1']];

    test('An ordinary ballot is not flagged', () => {
      const w = world();
      ballotsAt(w, [{voter: 'Maria Santos', min: 0, picks: some}, {voter: 'Paolo Reyes', min: 300, picks: [['c_single', 's2']]}]);
      w.newRequest();
      eq(w.api.dataCheck().flagged, []);
      eq(w.api.dataCheck().ballots, 2);
    });
    test('Look-alike names are flagged (Ben, B3n, b.e.n)', () => {
      const w = world();
      ballotsAt(w, [{voter: 'Benny', min: 0, picks: some}, {voter: 'B3nny', min: 300, picks: some}, {voter: 'b.e.n.n.y', min: 600, picks: some}]);
      ok(/Look-alike name: .*B3nny/.test(flagsFor(w, 'Benny')), flagsFor(w, 'Benny'));
      ok(/Look-alike name/.test(flagsFor(w, 'b.e.n.n.y')));
    });
    test('Two names from the same Discord account are flagged', () => {
      const w = world();
      ballotsAt(w, [{voter: 'Maria Santos', code: 'DC-AAA', min: 0, picks: some}, {voter: 'Paolo Reyes', code: 'DC-AAA', min: 300, picks: some},
        {voter: 'Carla Dizon', code: 'DC-BBB', min: 600, picks: some}]);
      ok(/Same Discord account as: Paolo Reyes/.test(flagsFor(w, 'Maria Santos')));
      eq(flagsFor(w, 'Carla Dizon'), '');
    });
    test('Three or more ballots within two minutes are flagged as a burst', () => {
      const w = world();
      ballotsAt(w, [{voter: 'Maria Santos', min: 0, picks: some}, {voter: 'Paolo Reyes', min: 1, picks: some}, {voter: 'Carla Dizon', min: 1.5, picks: some},
        {voter: 'Jose Cruz', min: 300, picks: some}]);
      ok(/3 ballots within 2 minutes/.test(flagsFor(w, 'Paolo Reyes')), flagsFor(w, 'Paolo Reyes'));
      eq(flagsFor(w, 'Jose Cruz'), '');
    });
    test('Identical ballots across three or more categories are flagged', () => {
      const w = world(), same = [['c_single', 's1'], ['c_multi', 'm1'], ['c_rank', 'r1', '1']];
      ballotsAt(w, [{voter: 'Maria Santos', min: 0, picks: same}, {voter: 'Paolo Reyes', min: 300, picks: same},
        {voter: 'Carla Dizon', min: 600, picks: [['c_single', 's1'], ['c_multi', 'm1'], ['c_rank', 'r2', '1']]}]);
      ok(/Identical choices to: Paolo Reyes/.test(flagsFor(w, 'Maria Santos')));
      eq(flagsFor(w, 'Carla Dizon'), '');
    });
    test('Junk names are flagged', () => {
      const w = world();
      const names = {'xx': 'very short', '12345': 'no letters', 'aaaaaaa': 'repeated characters', 'qwrtpsdf': 'keyboard mashing', 'Mr Gago': 'rude word'};
      ballotsAt(w, Object.keys(names).map((n, i) => ({voter: n, min: i * 300, picks: [['c_single', 's' + (i % 3 + 1)]]})));
      Object.keys(names).forEach(n => ok(flagsFor(w, n).indexOf('Junk name: ' + (n === 'qwrtpsdf' ? 'looks like keyboard mashing' : names[n])) >= 0, n + ' → ' + flagsFor(w, n)));
    });
    test('Removing a ballot deletes all its votes, frees the name and is logged', () => {
      const w = world();
      w.ballot('Ben', {c_single: [pick('s1')], c_tier: [tier('t1', 'S'), tier('t2', 'A')]});
      w.ballot('Maria', {c_single: [pick('s2')]});
      w.admin('adminRemoveBallot', '  BEN ');
      eq(w.votes().map(v => v.voter), ['Maria']);
      eq(w.post({action: 'checkName', voter: 'Ben'}).taken, false);
      const last = w.sheet('Log').rows[w.sheet('Log').rows.length - 1];
      eq([last[1], last[2]], ['admin@example.com', 'remove ballot']);
      throws(() => w.admin('adminRemoveBallot', 'Ben'), /not found/);
      throws(() => w.admin('adminRemoveBallot', ''), /No ballot chosen/);
    });

    /* ============================================================ */
    group = 'Pages and script agree';

    test('The committee proposals feature is gone from the script', () => {
      const names = Harness.topLevelNames(files.code), w = world();
      eq(names.filter(n => /propos|^committee|decide/i.test(n)), []);
      eq(Object.keys(w.api.TABS).filter(t => /Proposal|Comments/.test(t)), []);
      ok(!('proposals' in w.admin('adminState')), 'the dashboard no longer carries proposals');
    });
    test('The admin page only calls functions that exist in the script', () => {
      const called = [], re = /call\('(\w+)'/g, names = Harness.topLevelNames(files.code);
      let m;
      while ((m = re.exec(files.admin))) if (called.indexOf(m[1]) < 0) called.push(m[1]);
      ok(called.length >= 8, show(called));
      eq(called.filter(n => names.indexOf(n) < 0), []);
      ok(!/propos/i.test(files.admin), 'no proposals left on the admin page');
    });
    test('Every script on the ballot page is valid JavaScript (a typo there stops the whole ballot loading)', () => {
      const blocks = [...files.vote.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
      ok(blocks.length >= 2, 'found ' + blocks.length + ' scripts');
      blocks.forEach((b, i) => { try { new Function(b); } catch (e) { throw new Error('script ' + (i + 1) + ': ' + e.message); } });
    });
    test('The ballot page and the script use the same tier points and limits', () => {
      const page = {}, re = /\{id:'([A-Z])',\s*points:(\d+),\s*cap:(\d+)/g;
      let m;
      while ((m = re.exec(files.vote))) page[m[1]] = {points: Number(m[2]), cap: Number(m[3])};
      eq(page, world().api.TIERS);
    });
    test('The ballot page asks Discord for the username and picture only', () => {
      ok(/scope:\s*'identify'/.test(files.vote), 'scope should be identify');
      ok(!/guilds|email'/.test((files.vote.match(/scope:[^\n]*/) || [''])[0]));
    });
    test('No secret is written in the pages or the script', () => {
      [files.code, files.admin, files.vote].forEach(text => {
        ok(!/client_secret\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i.test(text), 'a Discord client secret is in the code');
        ok(!/PASS_SECRET['"]?\s*[:=]\s*['"][^'"]{8,}['"]/.test(text), 'the signing key is in the code');
      });
    });

    return results;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = AxaTests;
  else root.AxaTests = AxaTests;
})(typeof globalThis !== 'undefined' ? globalThis : this);
