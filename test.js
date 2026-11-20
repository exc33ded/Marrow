// Server self-check: node test.js
// Starts the server on a spare port with a throwaway DATA_DIR, so it never touches your library.
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-test-')), PORT = 5981, base = `http://localhost:${PORT}/api/`;
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, APP_SECRET: process.env.APP_SECRET || '0'.repeat(64), PORT, DATA_DIR: dir, HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
const raw = async (p, method = 'GET', body, headers = {}) => {
  const r = await fetch(base + p, { method, body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body, headers });
  return { status: r.status, body: r.headers.get('content-type').includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
srv.stdout.once('data', async () => {
  let failed = 0;
  try {
    // ---- a source round-trips, with its cards, notes and text
    const item = { kind: 'web', title: 'Sparse coding', url: 'https://example.org/a', added: 5, tags: ['x'], brief: { tldr: 'short' }, done: true,
      cards: [{ q: 'Q1', a: 'A1', quote: 'qq', src: 2, due: 9 }, { q: 'Q2', a: 'A2' }], notes: [{ quote: 'hi', page: 1, a: 0, b: 4, c: 2, note: 'mine' }] };
    assert.equal((await raw('items/abc', 'PUT', { ...item, parts: [{ body: 'Attention is all you need.' }, { body: 'Dictionary learning finds features', t: 12.5, html: '<p>x</p>' }] })).status, 200);
    await raw('items/abc', 'PUT', { ...item, title: 'Renamed', kind: 'pdf' }); // a save without parts keeps the text, and kind cannot change
    let lib = (await raw('library')).body, it = lib.items[0];
    assert.equal(it.title, 'Renamed'); assert.equal(it.kind, 'web'); assert.equal(it.done, 1); assert.deepEqual(it.tags, ['x']); assert.equal(it.brief.tldr, 'short');
    assert.deepEqual(it.cards, [{ q: 'Q1', a: 'A1', quote: 'qq', src: 2, due: 9 }, { q: 'Q2', a: 'A2' }], 'cards round-trip, missing fields stay missing');
    assert.deepEqual(it.notes, [{ note: 'mine', quote: 'hi', page: 1, a: 0, b: 4, c: 2 }]);
    const parts = (await raw('items/abc/parts')).body;
    assert.equal(parts.length, 2); assert.equal(parts[1].t, 12.5); assert.equal(parts[1].n, 2);
    assert.equal((await raw('search?q=dictionary+features')).body[0].n, 2, 'full-text search finds the part');
    assert.ok(/\x01.*\x02/.test((await raw('search?q=dictionary')).body[0].s), 'matched words are marked');
    assert.equal((await raw('search?phrase=1&q=is+all+attention')).body.length, 0, 'phrase search respects word order');
    assert.equal((await raw('search?q=' + encodeURIComponent('"OR ( *'))).status, 200, 'search survives query syntax');

    await raw('notes/n1', 'PUT', { title: 'Idea', note: 'text', project: 'thesis' });
    await raw('activity', 'POST', { kind: 'review', item_id: 'abc' });
    await raw('projects', 'PUT', { list: ['thesis', ' '] });
    lib = (await raw('library')).body;
    assert.equal(lib.notes[0].title, 'Idea'); assert.equal(lib.activity.length >= 1, true); assert.equal(lib.activity.at(-1).kind, 'review'); assert.deepEqual(lib.projects, ['thesis']);
    await raw('feeds', 'PUT', { url: 'https://example.org/feed.xml', title: 'Example' });
    assert.equal((await raw('feeds', 'PUT', { url: 'javascript:1' })).status, 400);
    assert.deepEqual((await raw('library')).body.feeds, [{ url: 'https://example.org/feed.xml', title: 'Example' }]);

    const pdf = Buffer.from('%PDF-1.4 fake');
    assert.equal((await raw('files/abc', 'PUT', pdf)).status, 200);
    assert.ok((await raw('files/abc')).body.equals(pdf));
    assert.equal((await raw('files/abc', 'PUT', Buffer.from('<html>'))).status, 415, 'only PDFs are stored');
    assert.equal((await raw('files/..%2Fserver', 'GET')).status, 404, 'no path traversal');

    // ---- fetching links
    const PORTHOST = `http://127.0.0.1:${PORT}/`;
    assert.equal((await raw('fetch?url=' + encodeURIComponent(PORTHOST))).status, 400, 'local addresses are refused');
    assert.equal((await raw('fetch?url=' + encodeURIComponent(`http://[::ffff:127.0.0.1]:${PORT}/`))).status, 400, 'nor their IPv6 spellings');
    assert.equal((await raw('fetch?url=' + encodeURIComponent('file:///etc/passwd'))).status, 400);
    assert.equal((await raw('fetch?url=' + encodeURIComponent('https://example.com/'))).body.html?.includes('Example Domain'), true, 'public pages are fetched (needs internet)');
    assert.equal((await raw('library', 'GET', null, { Origin: 'https://evil.example' })).status, 403, 'other sites cannot call the API');

    // ---- AI settings: keys are stored encrypted, never sent back
    const prov = (url, key, extra = {}) => ({ id: 'a', name: 'Test', url, key, ...extra });
    assert.equal((await raw('settings', 'PUT', { providers: [prov('ftp://x')], chain: [{ p: 'a', m: 'm' }] })).status, 400, 'the API address must be http(s)');
    assert.equal((await raw('settings', 'PUT', { providers: [prov('http://127.0.0.1:9/v1', 'test-key-1234')], chain: [] })).status, 400, 'at least one model');
    assert.equal((await raw('settings', 'PUT', { providers: [prov('http://127.0.0.1:9/v1', 'test-key-1234')], chain: [{ p: 'a', m: 'x' }, { p: 'a', m: 'y' }, { p: 'gone', m: 'z' }], paid: true })).status, 200);
    let cfg = (await raw('settings')).body, p0 = cfg.providers[0];
    assert.deepEqual([p0.url, p0.hasKey, p0.hint, cfg.paid, cfg.chain.map(e => e.m)], ['http://127.0.0.1:9/v1', true, '1234', true, ['x', 'y']], 'models of unknown providers are dropped');
    assert.ok(!JSON.stringify(cfg).includes('test-key'), 'the key is never sent back');
    { const r = await raw('settings/test', 'POST', {}); assert.equal(r.status, 502, 'with no reachable provider, AI cannot answer'); }
    await raw('settings', 'PUT', { providers: [prov('http://127.0.0.1:9/v1', '')], chain: [{ p: 'a', m: 'y' }, { p: 'a', m: 'x' }] });
    cfg = (await raw('settings')).body;
    assert.deepEqual([cfg.providers[0].hasKey, cfg.chain.map(e => e.m)], [true, ['y', 'x']], 'an empty key keeps the saved one; order is kept');
    await raw('settings', 'PUT', { providers: [prov('http://127.0.0.1:9/v1', '', { clearKey: true })], chain: cfg.chain });
    assert.equal((await raw('settings')).body.providers[0].hasKey, false, 'a saved key can be deleted');

    const wh = (await raw('whisper')).body;
    assert.equal(wh.models.length, 5);
    assert.equal((await raw('whisper?what=model:../../x', 'POST')).status, 400, 'only listed models can be downloaded');
    assert.equal((await raw('whisper/use?id=base.en', 'PUT')).status, 400, 'a model must be downloaded before it is used');
    assert.equal((await raw('ytaudio?vid=../etc')).status, 400, 'only YouTube video ids');
    assert.equal((await raw('ytsubs?vid=../etc')).status, 400, 'only YouTube video ids');

    // ---- meaning-based search: a fake embedding service (word counts hashed into 1024 numbers) stands in for a real model
    let embCalls = 0;
    const emb = require('http').createServer((rq, rs) => { let b = ''; rq.on('data', d => b += d).on('end', () => {
      rs.setHeader('content-type', 'application/json'); embCalls++;
      rs.end(JSON.stringify({ data: JSON.parse(b).input.map((t, index) => { const v = new Array(1024).fill(0); for (const w of t.toLowerCase().match(/[a-z]+/g) || []) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1024, 7)]++; return { index, embedding: v }; }) }));
    }); });
    await new Promise(r => emb.listen(5982, '127.0.0.1', r));
    const withEmb = { providers: [prov('http://127.0.0.1:5982/v1', '')], chain: [{ p: 'a', m: 'x' }], embed: { p: 'a', m: 'fake' } };
    assert.equal((await raw('retrieve', 'POST', { q: 'dictionary' })).status, 400, 'no embedding model chosen yet');
    await raw('settings', 'PUT', withEmb);
    assert.equal((await raw('settings')).body.embed.m, 'fake', 'the embedding model is saved');
    { const r = await raw('embed', 'POST', { item: 'abc' }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
    const near = (await raw('retrieve', 'POST', { q: 'dictionary learning', item: 'abc' })).body;
    assert.equal(near[0].n, 2, 'the passage about dictionary learning comes first');
    // ---- concept map: nearest concepts by meaning, with cut-offs; vectors are cached so a redraw costs no provider call
    const texts = ['Ice sheet: glacial ice melting into the sea', 'Sea level: the sea rises as glacial ice melts', 'Query planner: picks how a database query runs', 'Index: speeds up a database query'];
    const cn = (await raw('concept-near', 'POST', { texts })).body, calls = embCalls;
    assert.deepEqual(cn.near.map(r => r[0][0]), [1, 0, 3, 2], 'each concept is nearest the one about the same thing');
    assert.ok(cn.cross >= cn.same, 'the cross-source bar is the higher one');
    assert.deepEqual((await raw('concept-near', 'POST', { texts })).body, cn); assert.equal(embCalls, calls, 'cached vectors are reused');
    assert.equal((await raw('concept-near', 'POST', { texts: ['a'] })).status, 400);
    await raw('settings', 'PUT', { ...withEmb, embed: null });
    assert.deepEqual((await raw('concept-near', 'POST', { texts })).body, {}, 'no model: an empty answer, not an error');
    emb.close();

    // ---- clean up
    await raw('items/abc', 'DELETE'); await raw('notes/n1', 'DELETE'); await raw('feeds?url=' + encodeURIComponent('https://example.org/feed.xml'), 'DELETE'); await raw('projects', 'PUT', { list: [] });
    lib = (await raw('library')).body;
    assert.equal(lib.items.length, 0); assert.equal(lib.notes.length, 0, 'notebook pages are deleted');
    assert.equal((await raw('search?q=dictionary')).body.length, 0, 'deleted text leaves the index');
    assert.equal((await raw('files/abc')).status, 404, 'deleted PDFs are gone');
    console.log('server self-check passed');
  } catch (e) { failed = 1; console.error('FAILED:', e.stack.split('\n').slice(0, 3).join('\n')); }
  srv.kill(); srv.once('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(failed); });
});
