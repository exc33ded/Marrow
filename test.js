// Server self-check: node test.js   (starts the server on a spare port with a throwaway database)
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-test-')), PORT = 5981, base = `http://localhost:${PORT}/api/`;
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir, HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
const call = async (p, method = 'GET', body, headers = {}) => {
  const r = await fetch(base + p, { method, body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body, headers });
  return { status: r.status, body: r.headers.get('content-type').includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
srv.stdout.once('data', async () => {
  let failed = 0;
  try {
    const item = { kind: 'web', title: 'Sparse coding', url: 'https://example.org/a', added: 5, tags: ['x'], brief: { tldr: 'short' }, done: true,
      cards: [{ q: 'Q1', a: 'A1', quote: 'qq', src: 2, due: 9 }, { q: 'Q2', a: 'A2' }], notes: [{ quote: 'hi', page: 1, a: 0, b: 4, c: 2, note: 'mine' }] };
    assert.equal((await call('items/abc', 'PUT', { ...item, parts: [{ body: 'Attention is all you need.' }, { body: 'Dictionary learning finds features', t: 12.5, html: '<p>x</p>' }] })).status, 200);
    await call('items/abc', 'PUT', { ...item, title: 'Renamed', kind: 'pdf' }); // a save without parts keeps the text, and kind cannot change
    let lib = (await call('library')).body, it = lib.items[0];
    assert.equal(it.title, 'Renamed'); assert.equal(it.kind, 'web'); assert.equal(it.done, 1); assert.deepEqual(it.tags, ['x']); assert.equal(it.brief.tldr, 'short');
    assert.deepEqual(it.cards, [{ q: 'Q1', a: 'A1', quote: 'qq', src: 2, due: 9 }, { q: 'Q2', a: 'A2' }], 'cards round-trip, missing fields stay missing');
    assert.deepEqual(it.notes, [{ note: 'mine', quote: 'hi', page: 1, a: 0, b: 4, c: 2 }]);
    const parts = (await call('items/abc/parts')).body;
    assert.equal(parts.length, 2); assert.equal(parts[1].t, 12.5); assert.equal(parts[1].n, 2);
    assert.equal((await call('search?q=dictionary+features')).body[0].n, 2, 'full-text search finds the part');
    assert.equal((await call('search?phrase=1&q=is+all+attention')).body.length, 0, 'phrase search respects word order');
    assert.equal((await call('search?q=' + encodeURIComponent('"OR ( *'))).status, 200, 'search survives query syntax');

    await call('notes/n1', 'PUT', { title: 'Idea', note: 'text', project: 'thesis' });
    await call('activity', 'POST', { kind: 'review', item_id: 'abc' });
    lib = (await call('library')).body;
    assert.equal(lib.notes[0].title, 'Idea'); assert.equal(lib.activity.length, 1);
    await call('feeds', 'PUT', { url: 'https://example.org/feed.xml', title: 'Example' });
    assert.equal((await call('feeds', 'PUT', { url: 'javascript:1' })).status, 400);
    assert.deepEqual((await call('library')).body.feeds, [{ url: 'https://example.org/feed.xml', title: 'Example' }]);
    await call('feeds?url=' + encodeURIComponent('https://example.org/feed.xml'), 'DELETE');
    assert.equal((await call('library')).body.feeds.length, 0, 'feeds follow and unfollow');

    const pdf = Buffer.from('%PDF-1.4 fake');
    assert.equal((await call('files/abc', 'PUT', pdf)).status, 200);
    assert.ok((await call('files/abc')).body.equals(pdf));
    assert.equal((await call('files/abc', 'PUT', Buffer.from('<html>'))).status, 415, 'only PDFs are stored');
    assert.equal((await call('files/..%2Fserver', 'GET')).status, 404, 'no path traversal');

    assert.equal((await call('fetch?url=' + encodeURIComponent(`http://127.0.0.1:${PORT}/`))).status, 400, 'local addresses are refused');
    assert.equal((await call('fetch?url=' + encodeURIComponent(`http://[::ffff:127.0.0.1]:${PORT}/`))).status, 400, 'nor their IPv6 spellings');
    assert.equal((await call('fetch?url=' + encodeURIComponent('file:///etc/passwd'))).status, 400);
    assert.equal((await call('fetch?url=' + encodeURIComponent('https://example.com/'))).body.html?.includes('Example Domain'), true, 'public pages are fetched (needs internet)');
    assert.equal((await call('library', 'GET', null, { Origin: 'https://evil.example' })).status, 403, 'other sites cannot call the API');

    await call('items/abc', 'DELETE');
    lib = (await call('library')).body;
    assert.equal(lib.items.length, 0); assert.equal(lib.notes.length, 1, 'notebook pages survive');
    assert.equal((await call('search?q=dictionary')).body.length, 0, 'deleted text leaves the index');
    assert.equal((await call('files/abc')).status, 404);
    console.log('server self-check passed');
  } catch (e) { failed = 1; console.error('FAILED:', e.message); }
  srv.kill(); srv.once('exit', () => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(failed); });
});
