// Server self-check: node --env-file=.env --env-file=.env.test test.js
// Starts the server on a spare port against your real Supabase project and logs in as two throwaway test users
// (TEST_EMAIL_A, TEST_EMAIL_B, TEST_PASSWORD: create them in Supabase > Authentication > Users > Add user, auto-confirm on).
// It only touches those two accounts' rows, and removes what it adds.
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { TEST_EMAIL_A, TEST_EMAIL_B, TEST_PASSWORD } = process.env;
if (!TEST_EMAIL_A || !TEST_EMAIL_B || !TEST_PASSWORD) { console.error('Set TEST_EMAIL_A, TEST_EMAIL_B and TEST_PASSWORD (see the top of test.js).'); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-test-')), PORT = 5981, base = `http://localhost:${PORT}/api/`;
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir, HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
const raw = async (p, method = 'GET', body, headers = {}) => {
  const r = await fetch(base + p, { method, body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body, headers });
  return { status: r.status, cookies: r.headers.getSetCookie(), body: r.headers.get('content-type').includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
const login = async (email, password = TEST_PASSWORD) => {
  const r = await raw('login', 'POST', { email, password }, { 'Content-Type': 'application/json' });
  return { r, cookie: r.cookies.map(c => c.split(';')[0]).join('; ') };
};
const as = cookie => (p, method, body, headers) => raw(p, method, body, { ...headers, Cookie: cookie });
srv.stdout.once('data', async () => {
  let failed = 0, A, B;
  try {
    // ---- the door: nothing works without a login, and wrong passwords don't get in
    for (const p of ['library', 'search?q=x', 'fetch?url=https://example.com/', 'discover?q=x', 'settings', 'whisper', 'items/abc/parts', 'files/abc'])
      assert.equal((await raw(p)).status, 401, p + ' needs a login');
    assert.equal((await raw('ai', 'POST', { messages: [] }, { 'Content-Type': 'application/json' })).status, 401, 'the AI proxy needs a login');
    assert.equal((await raw('items/abc', 'PUT', { kind: 'web' })).status, 401);
    assert.equal((await login(TEST_EMAIL_A, 'wrong-password')).r.status, 401, 'wrong password');
    assert.equal((await raw('login', 'POST', { email: 'nobody@example.org', password: 'x' }, { 'Content-Type': 'application/json' })).status, 401, 'unknown email');
    const la = await login(TEST_EMAIL_A), lb = await login(TEST_EMAIL_B);
    assert.equal(la.r.status, 200, 'user A can log in'); assert.equal(lb.r.status, 200, 'user B can log in');
    assert.ok(la.r.cookies.every(c => /HttpOnly/.test(c) && /SameSite=Lax/.test(c)), 'session cookies are HttpOnly');
    assert.ok(!JSON.stringify(la.r.body).includes('token'), 'no token in the login response');
    A = as(la.cookie); B = as(lb.cookie);
    assert.equal((await A('me')).body.email, TEST_EMAIL_A);
    for (const c of [A, B]) { for (const id of ['abc', 'n1']) { await c('items/' + id, 'DELETE'); await c('notes/' + id, 'DELETE'); } } // leftovers of an earlier run

    // ---- A's library works as it did on SQLite
    const item = { kind: 'web', title: 'Sparse coding', url: 'https://example.org/a', added: 5, tags: ['x'], brief: { tldr: 'short' }, done: true,
      cards: [{ q: 'Q1', a: 'A1', quote: 'qq', src: 2, due: 9 }, { q: 'Q2', a: 'A2' }], notes: [{ quote: 'hi', page: 1, a: 0, b: 4, c: 2, note: 'mine' }] };
    assert.equal((await A('items/abc', 'PUT', { ...item, parts: [{ body: 'Attention is all you need.' }, { body: 'Dictionary learning finds features', t: 12.5, html: '<p>x</p>' }] })).status, 200);
    await A('items/abc', 'PUT', { ...item, title: 'Renamed', kind: 'pdf' }); // a save without parts keeps the text, and kind cannot change
    let lib = (await A('library')).body, it = lib.items[0];
    assert.equal(it.title, 'Renamed'); assert.equal(it.kind, 'web'); assert.equal(it.done, 1); assert.deepEqual(it.tags, ['x']); assert.equal(it.brief.tldr, 'short');
    assert.deepEqual(it.cards, [{ q: 'Q1', a: 'A1', quote: 'qq', src: 2, due: 9 }, { q: 'Q2', a: 'A2' }], 'cards round-trip, missing fields stay missing');
    assert.deepEqual(it.notes, [{ note: 'mine', quote: 'hi', page: 1, a: 0, b: 4, c: 2 }]);
    const parts = (await A('items/abc/parts')).body;
    assert.equal(parts.length, 2); assert.equal(parts[1].t, 12.5); assert.equal(parts[1].n, 2);
    assert.equal((await A('search?q=dictionary+features')).body[0].n, 2, 'full-text search finds the part');
    assert.ok(/\x01.*\x02/.test((await A('search?q=dictionary')).body[0].s), 'matched words are marked');
    assert.equal((await A('search?phrase=1&q=is+all+attention')).body.length, 0, 'phrase search respects word order');
    assert.equal((await A('search?q=' + encodeURIComponent('"OR ( *'))).status, 200, 'search survives query syntax');

    await A('notes/n1', 'PUT', { title: 'Idea', note: 'text', project: 'thesis' });
    await A('activity', 'POST', { kind: 'review', item_id: 'abc' });
    await A('projects', 'PUT', { list: ['thesis', ' '] });
    lib = (await A('library')).body;
    assert.equal(lib.notes[0].title, 'Idea'); assert.equal(lib.activity.length >= 1, true); assert.equal(lib.activity.at(-1).kind, 'review'); assert.deepEqual(lib.projects, ['thesis']);
    await A('feeds', 'PUT', { url: 'https://example.org/feed.xml', title: 'Example' });
    assert.equal((await A('feeds', 'PUT', { url: 'javascript:1' })).status, 400);
    assert.deepEqual((await A('library')).body.feeds, [{ url: 'https://example.org/feed.xml', title: 'Example' }]);

    const pdf = Buffer.from('%PDF-1.4 fake');
    assert.equal((await A('files/abc', 'PUT', pdf)).status, 200);
    assert.ok((await A('files/abc')).body.equals(pdf));
    assert.equal((await A('files/abc', 'PUT', Buffer.from('<html>'))).status, 415, 'only PDFs are stored');
    assert.equal((await A('files/..%2Fserver', 'GET')).status, 404, 'no path traversal');

    // ---- B is a different person: none of A's data is visible or changeable
    assert.equal((await B('library')).body.items.length, 0, "B's library is empty");
    assert.equal((await B('library')).body.notes.length, 0); assert.equal((await B('library')).body.feeds.length, 0);
    assert.deepEqual((await B('items/abc/parts')).body, [], "B cannot read A's text");
    assert.equal((await B('search?q=dictionary')).body.length, 0, "B cannot search A's text");
    assert.equal((await B('files/abc')).status, 404, "B cannot download A's PDF");
    assert.ok((await B('items/abc', 'PUT', { ...item, title: 'Hijacked' })).status >= 400, "B cannot overwrite A's item");
    assert.ok((await B('notes/n1', 'PUT', { title: 'Hijacked' })).status >= 400, "B cannot overwrite A's note");
    await B('items/abc', 'DELETE'); await B('notes/n1', 'DELETE'); await B('feeds?url=' + encodeURIComponent('https://example.org/feed.xml'), 'DELETE');
    lib = (await A('library')).body;
    assert.equal(lib.items[0].title, 'Renamed', "B's delete and save changed nothing"); assert.equal(lib.notes[0].title, 'Idea'); assert.equal(lib.feeds.length, 1);
    assert.ok((await A('files/abc')).body.equals(pdf), "A's PDF is still there");

    // ---- fetching links
    const PORTHOST = `http://127.0.0.1:${PORT}/`;
    assert.equal((await A('fetch?url=' + encodeURIComponent(PORTHOST))).status, 400, 'local addresses are refused');
    assert.equal((await A('fetch?url=' + encodeURIComponent(`http://[::ffff:127.0.0.1]:${PORT}/`))).status, 400, 'nor their IPv6 spellings');
    assert.equal((await A('fetch?url=' + encodeURIComponent('file:///etc/passwd'))).status, 400);
    assert.equal((await A('fetch?url=' + encodeURIComponent('https://example.com/'))).body.html?.includes('Example Domain'), true, 'public pages are fetched (needs internet)');
    assert.equal((await A('library', 'GET', null, { Origin: 'https://evil.example' })).status, 403, 'other sites cannot call the API');

    // ---- AI settings: each reader brings their own key, stored encrypted, never sent back
    const prov = (url, key, extra = {}) => ({ id: 'a', name: 'Test', url, key, ...extra });
    assert.equal((await A('settings', 'PUT', { providers: [prov('ftp://x')], chain: [{ p: 'a', m: 'm' }] })).status, 400, 'the API address must be http(s)');
    assert.equal((await A('settings', 'PUT', { providers: [prov('http://127.0.0.1:9/v1', 'test-key-1234')], chain: [] })).status, 400, 'at least one model');
    assert.equal((await A('settings', 'PUT', { providers: [prov('http://127.0.0.1:9/v1', 'test-key-1234')], chain: [{ p: 'a', m: 'x' }, { p: 'a', m: 'y' }, { p: 'gone', m: 'z' }], paid: true })).status, 200);
    let cfg = (await A('settings')).body, p0 = cfg.providers[0];
    assert.deepEqual([p0.url, p0.hasKey, p0.hint, cfg.paid, cfg.chain.map(e => e.m)], ['http://127.0.0.1:9/v1', true, '1234', true, ['x', 'y']], 'models of unknown providers are dropped');
    assert.ok(!JSON.stringify(cfg).includes('test-key'), 'the key is never sent back');
    const other = (await B('settings')).body;
    assert.deepEqual([other.providers[0].hasKey, other.providers[0].url, other.paid], [false, 'https://openrouter.ai/api/v1', false], "B does not get A's key or settings");
    assert.equal((await B('settings/test', 'POST')).status, 502, 'with no key of their own, B cannot use AI');
    await A('settings', 'PUT', { providers: [prov('http://127.0.0.1:9/v1', '')], chain: [{ p: 'a', m: 'y' }, { p: 'a', m: 'x' }] });
    cfg = (await A('settings')).body;
    assert.deepEqual([cfg.providers[0].hasKey, cfg.chain.map(e => e.m)], [true, ['y', 'x']], 'an empty key keeps the saved one; order is kept');
    await A('settings', 'PUT', { providers: [prov('http://127.0.0.1:9/v1', '', { clearKey: true })], chain: cfg.chain });
    assert.equal((await A('settings')).body.providers[0].hasKey, false, 'a saved key can be deleted');

    const wh = (await A('whisper')).body;
    assert.equal(wh.models.length, 5);
    assert.equal((await A('whisper?what=model:../../x', 'POST')).status, 400, 'only listed models can be downloaded');
    assert.equal((await A('whisper/use?id=base.en', 'PUT')).status, 400, 'a model must be downloaded before it is used');
    assert.equal((await A('ytaudio?vid=../etc')).status, 400, 'only YouTube video ids');
    assert.equal((await A('ytsubs?vid=../etc')).status, 400, 'only YouTube video ids');

    // ---- clean up, then log out
    await A('items/abc', 'DELETE'); await A('notes/n1', 'DELETE'); await A('feeds?url=' + encodeURIComponent('https://example.org/feed.xml'), 'DELETE'); await A('projects', 'PUT', { list: [] });
    lib = (await A('library')).body;
    assert.equal(lib.items.length, 0); assert.equal(lib.notes.length, 0, 'notebook pages are deleted');
    assert.equal((await A('search?q=dictionary')).body.length, 0, 'deleted text leaves the index');
    assert.equal((await A('files/abc')).status, 404, 'deleted PDFs are gone');
    const out = await A('logout', 'POST'); assert.ok(out.cookies.every(c => /Max-Age=0/.test(c)), 'logout clears the cookies');
    console.log('server self-check passed');
  } catch (e) { failed = 1; console.error('FAILED:', e.stack.split('\n').slice(0, 3).join('\n')); }
  srv.kill(); srv.once('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(failed); });
});
