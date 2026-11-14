// Marrow server: serves the app, keeps the library in SQLite (data/marrow.db, PDFs in data/files),
// proxies AI calls (the OpenRouter key never reaches the browser), and fetches web pages, PDFs and paper search results.
// Run: node --env-file=.env server.js
const http = require('http'), fs = require('fs'), path = require('path'), net = require('net'), dns = require('dns').promises;
const { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const KEY = process.env.OPENROUTER_API_KEY;
const PORT = process.env.PORT || 5173;
const HOST = process.env.HOST || '127.0.0.1'; // local only; set HOST=0.0.0.0 to reach it from other devices on your network
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data'), FILES = path.join(DATA, 'files');
// Free models only, tried in order until one answers. Override with MODELS=a,b,c in .env.
const MODELS = (process.env.MODELS ||
  'baidu/ernie-5.5-flash-preview:free,nvidia/nemotron-3-ultra-550b-a55b:free,google/gemma-4-26b-a4b-it:free,google/gemma-4-31b-it:free,openrouter/free'
).split(',');
// Used when a message carries an image (figure/equation snips).
const VISION = (process.env.VISION_MODELS ||
  'nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free,openrouter/free'
).split(',');

// ---------- database ----------
fs.mkdirSync(FILES, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'marrow.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS items(              -- one row per source: a paper, a web article or a video
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('pdf','web','video')), title TEXT NOT NULL, url TEXT,
  project TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL, opened INTEGER,
  data TEXT NOT NULL DEFAULT '{}');            -- JSON: tags, AI briefing, sections, concepts, chat
CREATE TABLE IF NOT EXISTS parts(              -- the source's text: PDF pages, article paragraphs, transcript chunks
  id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  n INTEGER NOT NULL, t REAL, body TEXT NOT NULL, html TEXT);
CREATE INDEX IF NOT EXISTS parts_item ON parts(item_id, n);
CREATE TABLE IF NOT EXISTS cards(
  id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, pos INTEGER NOT NULL,
  q TEXT, a TEXT, quote TEXT, src INTEGER, ease REAL, ivl INTEGER, due INTEGER);
CREATE INDEX IF NOT EXISTS cards_item ON cards(item_id, pos);
CREATE TABLE IF NOT EXISTS notes(              -- item_id set: highlight/note on a source. NULL: a notebook page
  id TEXT PRIMARY KEY, item_id TEXT REFERENCES items(id) ON DELETE CASCADE, pos INTEGER, title TEXT, project TEXT,
  note TEXT, quote TEXT, page INTEGER, a INTEGER, b INTEGER, eb INTEGER, c INTEGER, ul INTEGER, updated INTEGER);
CREATE INDEX IF NOT EXISTS notes_item ON notes(item_id, pos);
CREATE TABLE IF NOT EXISTS activity(ts INTEGER NOT NULL, kind TEXT NOT NULL, item_id TEXT);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);       -- AI service: url, key, models, vision, paid
CREATE TABLE IF NOT EXISTS feeds(url TEXT PRIMARY KEY, title TEXT NOT NULL, added INTEGER NOT NULL);  -- blogs and journals being followed
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(body, content='parts', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS parts_ai AFTER INSERT ON parts BEGIN INSERT INTO fts(rowid, body) VALUES(new.id, new.body); END;
CREATE TRIGGER IF NOT EXISTS parts_ad AFTER DELETE ON parts BEGIN INSERT INTO fts(fts, rowid, body) VALUES('delete', old.id, old.body); END;`);

// AI settings: what was saved in the app wins over .env, which wins over the defaults. The key is only ever read here, on the server.
const saved = k => db.prepare('SELECT v FROM settings WHERE k=?').get(k)?.v;
const list = v => String(v).split(/[,\n]/).map(x => x.trim()).filter(Boolean);
const conf = () => ({
  url: (saved('url') || process.env.AI_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''), key: saved('key') || KEY || '',
  models: list(saved('models') || MODELS), vision: list(saved('vision') || VISION), paid: saved('paid') === '1',
});
// node:sqlite binds neither undefined, booleans nor objects.
const bind = v => v === undefined ? null : typeof v === 'boolean' ? +v : v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
const inserter = (table, cols) => {
  const st = db.prepare(`INSERT OR REPLACE INTO ${table}(${cols}) VALUES(${cols.map(() => '?')})`);
  return o => st.run(...cols.map(k => bind(o[k])));
};
const CARD = ['q', 'a', 'quote', 'src', 'ease', 'ivl', 'due'], NOTE = ['note', 'quote', 'page', 'a', 'b', 'eb', 'c', 'ul'];
const addCard = inserter('cards', ['item_id', 'pos', ...CARD]), addNote = inserter('notes', ['id', 'item_id', 'pos', ...NOTE]);
const addPart = inserter('parts', ['item_id', 'n', 't', 'body', 'html']), addPage = inserter('notes', ['id', 'title', 'project', 'note', 'updated']);
const upsert = db.prepare(`INSERT INTO items(id,kind,title,url,project,done,added,opened,data) VALUES(?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET title=excluded.title, url=excluded.url, project=excluded.project, done=excluded.done, opened=excluded.opened, data=excluded.data`);
const tx = fn => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };

// ponytail: an item is saved whole, so its cards and notes are rewritten each time. Diff them if items grow to thousands of cards.
function putItem(id, { cards = [], notes = [], parts, kind, title, url, project, done, added, opened, id: _, ...data }) {
  tx(() => {
    upsert.run(id, bind(kind), String(title || 'Untitled'), bind(url), String(project || ''), done ? 1 : 0, +added || Date.now(), bind(opened), JSON.stringify(data));
    db.prepare('DELETE FROM cards WHERE item_id=?').run(id);
    cards.forEach((c, pos) => addCard({ ...c, item_id: id, pos }));
    db.prepare('DELETE FROM notes WHERE item_id=?').run(id);
    notes.forEach((n, pos) => addNote({ ...n, id: randomUUID(), item_id: id, pos }));
    if (Array.isArray(parts)) {
      db.prepare('DELETE FROM parts WHERE item_id=?').run(id);
      parts.forEach((p, i) => addPart({ t: p.t, html: p.html, body: String(p.body ?? ''), item_id: id, n: i + 1 }));
    }
  });
}
const drop = r => { for (const k in r) if (r[k] === null) delete r[k]; return { ...r }; }; // NULL columns become absent fields
function library() {
  const by = rows => rows.reduce((m, { item_id, ...r }) => ((m[item_id] ||= []).push(drop(r)), m), {});
  const cards = by(db.prepare(`SELECT item_id,${CARD} FROM cards ORDER BY item_id,pos`).all());
  const notes = by(db.prepare(`SELECT item_id,${NOTE} FROM notes WHERE item_id IS NOT NULL ORDER BY item_id,pos`).all());
  return {
    items: db.prepare('SELECT * FROM items ORDER BY added DESC').all().map(({ data, ...r }) => ({ ...JSON.parse(data), ...drop(r), cards: cards[r.id] || [], notes: notes[r.id] || [] })),
    notes: db.prepare('SELECT id,title,project,note,updated FROM notes WHERE item_id IS NULL ORDER BY updated DESC').all().map(drop),
    activity: db.prepare('SELECT ts FROM activity WHERE ts > ?').all(Date.now() - 120 * 864e5).map(r => r.ts),
    feeds: db.prepare('SELECT url,title FROM feeds ORDER BY added').all().map(drop),
  };
}
// Full-text search over everything in the library. \x01 and \x02 mark the matched words (the client escapes, then styles them).
function search(q, phrase) {
  const words = q.match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return [];
  const match = phrase ? `"${words.join(' ')}"` : words.map(w => `"${w}"`).join(' ');
  return db.prepare(`SELECT p.item_id, p.n, snippet(fts, 0, char(1), char(2), '…', 18) AS s FROM fts JOIN parts p ON p.id = fts.rowid
    WHERE fts MATCH ? ORDER BY rank LIMIT 40`).all(match).map(drop);
}

// ---------- http helpers ----------
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const fail = (code, msg) => Object.assign(new Error(msg), { code });
async function slurp(stream, max) {
  const chunks = []; let n = 0;
  for await (const c of stream || []) { n += c.length; if (n > max) throw fail(413, 'too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}
const json = async (req, max = 40e6) => { try { return JSON.parse(await slurp(req, max)); } catch (e) { throw e.code ? e : fail(400, 'invalid JSON'); } };

// Fetching a link the user pasted. Only public http(s) hosts, re-checked on every redirect, so the app can't be used to reach the local network.
// ponytail: the host is resolved once for the check and again by fetch. Pin the resolved address if this ever runs on a shared server.
const internal = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]]) internal.addSubnet(a, n);
for (const [a, n] of [['::', 127], ['fc00::', 7], ['fe80::', 10]]) internal.addSubnet(a, n, 'ipv6'); // IPv4-mapped IPv6 is matched by the IPv4 rules above
async function fetchPublic(link) {
  let url = new URL(link);
  for (let hop = 0; hop < 6; hop++) {
    if (!/^https?:$/.test(url.protocol)) throw fail(400, 'only http and https links are supported');
    const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => { throw fail(400, 'could not find that site'); });
    if (addrs.some(a => internal.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'))) throw fail(400, 'that address is not on the public internet');
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Marrow/2 (personal research reader)', Accept: 'text/html,application/pdf;q=0.9,application/rss+xml;q=0.9,application/atom+xml;q=0.9,*/*;q=0.8' } });
    const next = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!next) return { r, url };
    url = new URL(next, url);
  }
  throw fail(502, 'too many redirects');
}

// A model that just failed is skipped for 10 minutes, so one flaky provider doesn't slow every request.
const cooling = new Map();
async function ai(messages) {
  const c = conf(), openrouter = /(^|\.)openrouter\.ai$/.test(new URL(c.url).hostname);
  if (!c.key && openrouter) throw fail(400, 'no API key yet. Add one in Settings');
  let lastErr = 'no model is allowed to answer. On OpenRouter only free models are used unless you allow paid ones in Settings';
  const all = messages.some(m => Array.isArray(m.content)) ? c.vision : c.models;
  const ready = all.filter(m => !(cooling.get(m) > Date.now()));
  for (const model of ready.length ? ready : all) {
    if (openrouter && !c.paid && !model.endsWith(':free') && model !== 'openrouter/free') continue; // never spend money unless told to
    try {
      const r = await fetch(c.url + '/chat/completions', {
        method: 'POST',
        headers: { ...(c.key && { Authorization: `Bearer ${c.key}` }), 'Content-Type': 'application/json', 'X-Title': 'Marrow' },
        body: JSON.stringify({ model, messages, temperature: 0.3 }),
        signal: AbortSignal.timeout(90000),
      });
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content;
      if (text) return { text, model };
      lastErr = `${model}: ${j.error?.message || r.status}`;
    } catch (e) { lastErr = `${model}: ${e.message}`; }
    cooling.set(model, Date.now() + 10 * 60e3);
    console.warn('model failed ->', lastErr);
  }
  throw fail(502, lastErr);
}

async function discover(q) {
  const r = await fetch('https://api.openalex.org/works?per-page=20&select=title,publication_year,authorships,cited_by_count,open_access,best_oa_location,primary_location,doi,abstract_inverted_index&search=' + encodeURIComponent(q), { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw fail(502, `paper search returned ${r.status}`);
  return ((await r.json()).results || []).filter(w => w.title).map(w => ({
    title: w.title, year: w.publication_year || '', cites: w.cited_by_count || 0, doi: w.doi || '',
    authors: (w.authorships || []).slice(0, 8).map(a => a.author?.display_name).filter(Boolean),
    venue: w.primary_location?.source?.display_name || '',
    pdf: w.best_oa_location?.pdf_url || w.open_access?.oa_url || '',
    url: w.primary_location?.landing_page_url || w.doi || '',
    // OpenAlex stores abstracts as word -> positions; put the words back in order.
    abstract: Object.entries(w.abstract_inverted_index || {}).flatMap(([word, at]) => at.map(i => [i, word])).sort((a, b) => a[0] - b[0]).map(x => x[1]).join(' ').slice(0, 1200),
  }));
}

// ---------- routes ----------
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), M = req.method, p = url.pathname, q = k => url.searchParams.get(k) || '';
    // Only this machine's own pages may talk to the API: no other website (Origin), no DNS-rebinding name (Host).
    const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (host !== 'localhost' && !net.isIP(host)) throw fail(403, 'unknown host');
    if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) throw fail(403, 'cross-site request refused');

    if (M === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    if (M === 'GET' && p === '/api/library') return send(res, 200, library());
    if (M === 'GET' && p === '/api/search') return send(res, 200, search(q('q'), q('phrase')));
    if (M === 'GET' && p === '/api/discover') return send(res, 200, await discover(q('q')));
    if (M === 'POST' && p === '/api/ai') {
      const { messages } = await json(req, 6e6); // source text plus one cropped image
      if (!Array.isArray(messages)) throw fail(400, 'messages required');
      return send(res, 200, await ai(messages));
    }
    if (p === '/api/settings' && M === 'GET') { // the key itself never leaves the server: only whether there is one, and its last four characters
      const c = conf();
      return send(res, 200, { url: c.url, models: c.models.join('\n'), vision: c.vision.join('\n'), paid: c.paid, hasKey: !!c.key, keyFrom: saved('key') ? 'saved' : KEY ? 'env' : '', hint: c.key ? c.key.slice(-4) : '' });
    }
    if (p === '/api/settings' && M === 'PUT') {
      const b = await json(req, 1e5), put = (k, v) => db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k, String(v));
      try { if (!/^https?:$/.test(new URL(b.url).protocol)) throw 0; } catch { throw fail(400, 'the API address must start with http:// or https://'); }
      if (!list(b.models || '').length) throw fail(400, 'name at least one model');
      put('url', b.url.trim()); put('models', list(b.models).join(',')); put('vision', list(b.vision || b.models).join(',')); put('paid', b.paid ? 1 : 0);
      if (typeof b.key === 'string' && b.key.trim()) put('key', b.key.trim());
      cooling.clear(); return send(res, 200, {});
    }
    if (p === '/api/settings/key' && M === 'DELETE') { db.prepare("DELETE FROM settings WHERE k='key'").run(); return send(res, 200, {}); }
    if (p === '/api/settings/test' && M === 'POST') { const r = await ai([{ role: 'user', content: 'Reply with the single word: ready' }]); return send(res, 200, { model: r.model }); }
    if (M === 'POST' && p === '/api/activity') {
      const { kind, item_id } = await json(req, 1e4);
      db.prepare('INSERT INTO activity VALUES(?,?,?)').run(Date.now(), String(kind), bind(item_id));
      return send(res, 200, {});
    }
    if (M === 'PUT' && p === '/api/feeds') {
      const f = await json(req, 1e4);
      if (!/^https?:\/\//.test(f.url)) throw fail(400, 'feed address required');
      db.prepare('INSERT OR REPLACE INTO feeds VALUES(?,?,?)').run(f.url, String(f.title || f.url), Date.now());
      return send(res, 200, {});
    }
    if (M === 'DELETE' && p === '/api/feeds') { db.prepare('DELETE FROM feeds WHERE url=?').run(q('url')); return send(res, 200, {}); }
    if (M === 'GET' && p === '/api/fetch') {
      const { r, url: final } = await fetchPublic(q('url'));
      if (!r.ok) throw fail(502, `the site answered ${r.status}`);
      const buf = await slurp(r.body, 80e6), type = r.headers.get('content-type') || '';
      if (buf.subarray(0, 1024).includes('%PDF-')) return send(res, 200, buf, 'application/pdf');
      if (!/html|xml|json|text/.test(type)) throw fail(415, 'that link is neither a web page nor a PDF');
      // Sent as JSON, never as a page, so fetched HTML cannot run on this origin.
      let html; try { html = new TextDecoder(type.match(/charset=["']?([\w-]+)/i)?.[1] || 'utf-8').decode(buf); } catch { html = buf.toString(); }
      return send(res, 200, { url: final.href, html });
    }
    const m = p.match(/^\/api\/(items|files|notes)\/([\w-]{1,64})(\/parts)?$/);
    if (m) {
      const [, what, id, parts] = m, file = path.join(FILES, id + '.pdf');
      if (what === 'items' && parts && M === 'GET') return send(res, 200, db.prepare('SELECT n,t,body,html FROM parts WHERE item_id=? ORDER BY n').all(id).map(drop));
      if (what === 'items' && M === 'PUT') { putItem(id, await json(req)); return send(res, 200, {}); }
      if (what === 'items' && M === 'DELETE') { db.prepare('DELETE FROM items WHERE id=?').run(id); fs.rmSync(file, { force: true }); return send(res, 200, {}); }
      if (what === 'notes' && M === 'PUT') { const n = await json(req, 5e6); addPage({ title: n.title, project: n.project, note: n.note, updated: Date.now(), id }); return send(res, 200, {}); }
      if (what === 'notes' && M === 'DELETE') { db.prepare('DELETE FROM notes WHERE id=? AND item_id IS NULL').run(id); return send(res, 200, {}); }
      if (what === 'files' && M === 'PUT') {
        const buf = await slurp(req, 150e6);
        if (!buf.subarray(0, 1024).includes('%PDF-')) throw fail(415, 'not a PDF');
        fs.writeFileSync(file, buf); return send(res, 200, {});
      }
      if (what === 'files' && M === 'GET') return fs.existsSync(file) ? send(res, 200, fs.readFileSync(file), 'application/pdf') : send(res, 404, { error: 'the PDF file is missing' });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, Number.isInteger(e.code) && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); }
}).listen(PORT, HOST, () => console.log(`Marrow -> http://localhost:${PORT}` + (conf().key ? '' : '  (no API key yet: add one in Settings)')));
