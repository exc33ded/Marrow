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

// ---------- transcription: Whisper, run on this computer ----------
// From Settings the reader downloads a Whisper model, and on Windows the whisper.cpp program; elsewhere `brew install whisper-cpp` puts it on PATH.
// The browser decodes the audio to 16 kHz mono WAV before sending it, so ffmpeg is never needed. yt-dlp, if present, fetches a YouTube video's audio.
const { execFile, spawn } = require('child_process'), os = require('os'), { pipeline } = require('stream/promises');
const WH = path.join(DATA, 'whisper'), BIN = path.join(WH, 'bin'), WIN = process.platform === 'win32';
const WMODELS = [ // id on Hugging Face, name, bytes, what it is good for
  ['tiny.en', 'Tiny · English', 77704715, 'Fastest. Fine for a clear lecture; stumbles on accents and jargon.'],
  ['base.en', 'Base · English', 147964211, 'A good start: quick on any computer, decent accuracy.'],
  ['small', 'Small · any language', 487601967, 'Clearly better, and handles other languages.'],
  ['large-v3-turbo-q5_0', 'Large v3 Turbo · any language', 574041195, 'Close to the best Whisper gets, compressed to a third of its size. Slow without a graphics card.'],
  ['medium', 'Medium · any language', 1533763059, 'Very accurate, but slow on a laptop.'],
];
const YTDLP = path.join(WH, WIN ? 'yt-dlp.exe' : 'yt-dlp');
fs.mkdirSync(WH, { recursive: true });
const jobs = {}; // in progress, by key: downloads { got, total, ac } and transcriptions { pct, ch }; finished ones leave { error } or { segs }
const onPath = name => (process.env.PATH || '').split(path.delimiter).map(d => path.join(d, name + (WIN ? '.exe' : ''))).find(f => fs.existsSync(f));
const within = (dir, file) => { try { const f = fs.readdirSync(dir, { recursive: true }).find(f => path.basename(f) === file); return f && path.join(dir, f); } catch {} };
const whisperCli = () => within(BIN, WIN ? 'whisper-cli.exe' : 'whisper-cli') || onPath('whisper-cli');
const ytDlp = () => (fs.existsSync(YTDLP) && YTDLP) || onPath('yt-dlp');
const modelFile = id => path.join(WH, `ggml-${id}.bin`);
const haveModels = () => WMODELS.map(m => m[0]).filter(id => fs.existsSync(modelFile(id)));
const inUse = () => haveModels().includes(saved('whisper')) ? saved('whisper') : haveModels()[0] || '';
// Runs in the background; the Settings page polls /api/whisper for progress. A cancelled download leaves nothing behind.
const start = (key, fn) => {
  if (jobs[key] && !jobs[key].error) throw fail(409, 'that is already downloading');
  jobs[key] = { got: 0, total: 0 };
  fn().catch(e => { if (jobs[key]) jobs[key] = { error: e.message }; });
};
async function download(key, url, dest) {
  const ac = new AbortController(), job = jobs[key] = { got: 0, total: 0, ac }, part = dest + '.part';
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Marrow' } });
    if (!r.ok) throw new Error(`the download site answered ${r.status}`);
    job.total = +r.headers.get('content-length') || 0;
    await pipeline(r.body, async function* (src) { for await (const c of src) { job.got += c.length; yield c; } }, fs.createWriteStream(part));
    fs.renameSync(part, dest);
  } catch (e) { fs.rmSync(part, { force: true }); if (ac.signal.aborted) delete jobs[key]; throw e; }
}
const run = (cmd, args, opt = {}) => new Promise((ok, no) => execFile(cmd, args, { timeout: 15 * 60e3, maxBuffer: 64e6, ...opt }, (e, out, err) => e ? no(new Error(String(err || e.message).trim().split('\n').pop())) : ok(out)));
// whisper.cpp publishes its Windows build on numbered releases (b5454…), not on the tagged ones, so look for the newest that carries it.
async function getProgram() {
  const rels = await (await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30', { headers: { 'User-Agent': 'Marrow' } })).json();
  const a = (Array.isArray(rels) ? rels : []).flatMap(r => r.assets || []).find(a => a.name === 'whisper-bin-x64.zip');
  if (!a) throw new Error('could not find the whisper.cpp download on GitHub');
  const zip = path.join(WH, 'whisper-bin-x64.zip');
  await download('program', a.browser_download_url, zip);
  jobs.program = { got: a.size, total: a.size, unpacking: true };
  fs.rmSync(BIN, { recursive: true, force: true }); fs.mkdirSync(BIN);
  // Windows' own tar (in Windows 10 and later): a Git or MSYS tar earlier on PATH reads "D:\…" as a remote host.
  try { await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', BIN]); } finally { fs.rmSync(zip, { force: true }); }
  if (!whisperCli()) throw new Error('the download did not contain whisper-cli');
  delete jobs.program;
}
async function getYtDlp() {
  await download('ytdlp', 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + (WIN ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux'), YTDLP);
  if (!WIN) fs.chmodSync(YTDLP, 0o755);
  delete jobs.ytdlp;
}
const pub = j => j && { got: j.got, total: j.total, unpacking: j.unpacking, error: j.error };
const whisperState = () => ({
  models: WMODELS.map(([id, name, size, note]) => ({ id, name, size, note, have: fs.existsSync(modelFile(id)), job: pub(jobs['model:' + id]) })),
  use: inUse(), platform: process.platform,
  program: { have: !!whisperCli(), mine: !!within(BIN, WIN ? 'whisper-cli.exe' : 'whisper-cli'), job: pub(jobs.program) },
  ytdlp: { have: !!ytDlp(), mine: fs.existsSync(YTDLP), job: pub(jobs.ytdlp) },
});
// whisper-cli -oj writes { transcription: [{ offsets: { from: ms }, text }] }.
const segsOf = j => (j.transcription || []).map(s => ({ t: s.offsets.from / 1000, body: s.text.trim() })).filter(s => s.body);
async function transcribe(id, req) {
  const cli = whisperCli(), model = inUse(), key = 'tx:' + id;
  if (!cli || !model) throw fail(400, 'set up Whisper in Settings first: the program and one model');
  if (jobs[key]) throw fail(409, 'this video is already being transcribed');
  const base = path.join(WH, 'tx-' + id), wav = base + '.wav', job = jobs[key] = { pct: 0 }; let n = 0;
  try {
    await pipeline(req, async function* (src) { for await (const c of src) { if ((n += c.length) > 9e8) throw fail(413, 'the audio is too long'); yield c; } }, fs.createWriteStream(wav));
  } catch (e) {
    if (jobs[key] === job) delete jobs[key];
    fs.rmSync(wav, { force: true }); throw e;
  }
  if (jobs[key] !== job) return fs.rmSync(wav, { force: true }); // stopped while uploading
  const args = ['-m', modelFile(model), '-f', wav, '-oj', '-of', base, '-pp', '-l', model.endsWith('.en') ? 'en' : 'auto', '-t', String(Math.max(1, os.availableParallelism() - 1))];
  const ch = job.ch = spawn(cli, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let tail = '';
  ch.stderr.on('data', d => { tail = (tail + d).slice(-2000); const m = [...tail.matchAll(/progress\s*=\s*(\d+)%/g)].pop(); if (m) job.pct = +m[1]; });
  const end = () => { fs.rmSync(wav, { force: true }); fs.rmSync(base + '.json', { force: true }); };
  ch.on('error', e => { jobs[key] = { error: e.message }; end(); });
  ch.on('close', code => {
    if (jobs[key] !== job) return end(); // cancelled
    try { jobs[key] = { segs: segsOf(JSON.parse(fs.readFileSync(base + '.json', 'utf8'))) }; }
    catch { jobs[key] = { error: `Whisper stopped${code ? ` (code ${code})` : ''}: ${tail.trim().split('\n').pop() || 'no transcript was written'}` }; }
    end();
  });
}
// yt-dlp needs no ffmpeg for a single audio-only download. The audio goes to the browser, which decodes it.
async function youtubeAudio(vid, res) {
  const exe = ytDlp(); if (!exe) throw fail(400, 'download the YouTube helper in Settings first');
  const out = path.join(WH, 'yt-' + vid), pre = path.basename(out) + '.';
  for (const f of fs.readdirSync(WH)) if (f.startsWith(pre)) fs.rmSync(path.join(WH, f), { force: true }); // a leftover from an earlier try
  await run(exe, ['-f', 'bestaudio[ext=m4a]/bestaudio', '--no-playlist', '--quiet', '--no-progress', '-o', out + '.%(ext)s', 'https://www.youtube.com/watch?v=' + vid]).catch(e => { throw fail(502, e.message); });
  const file = fs.readdirSync(WH).map(f => path.join(WH, f)).find(f => f.startsWith(pre));
  if (!file) throw fail(502, 'YouTube sent no audio');
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
  await pipeline(fs.createReadStream(file), res).catch(() => res.destroy()).finally(() => fs.rmSync(file, { force: true }));
}
// YouTube's captions as json3: one event per line, no rolling repeats. The plain VTT/SRT parser below is the fallback.
const json3Segs = j => (j.events || []).filter(e => e.segs).map(e => ({ t: (e.tStartMs || 0) / 1000, body: e.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim() })).filter(s => s.body);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };
const unent = s => s.replace(/&(?:#x([\da-f]+)|#(\d+)|(\w+));/gi, (m, hex, dec, name) => hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(+dec) : ENT[name.toLowerCase()] ?? m);
// VTT or SRT -> timed lines. YouTube's auto-captions repeat each line in overlapping cues (and split it with <c> tags), so a cue that only extends the one before it replaces it.
const capsSegs = text => {
  const out = [];
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n'), i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const m = lines[i].match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d+)?/);
    if (!m) continue;
    const body = unent(lines.slice(i + 1).join(' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const t = (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3], last = out.at(-1);
    if (last && body.startsWith(last.body)) { if (body.length > last.body.length) last.body = body; continue; }
    if (last && last.body.startsWith(body)) continue;
    out.push({ t, body });
  }
  return out;
};
// Caption URLs are signed and may redirect; every hop stays on YouTube's own hosts.
async function fetchCaptions(url) {
  for (let i = 0; i < 4; i++) {
    let u; try { u = new URL(url); } catch { throw fail(502, 'YouTube sent an unexpected captions address'); }
    if (!/(^|\.)(youtube\.com|googlevideo\.com)$/.test(u.hostname)) throw fail(502, 'YouTube sent an unexpected captions address');
    const r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'Marrow' }, signal: AbortSignal.timeout(30000) });
    const loc = r.headers.get('location');
    if (r.status < 300 || r.status > 399 || !loc) return r;
    try { url = new URL(loc, u).href; } catch { throw fail(502, 'YouTube sent an unexpected captions address'); }
  }
  throw fail(502, 'the captions address redirected too many times');
}
const pickTrack = (m, prefs) => prefs.map(k => m?.[k]).find(t => t?.length);
// YouTube's own captions, when the video has them: human-written tracks first, then auto-generated, in the video's own language before English. No Whisper needed.
async function youtubeCaptions(vid) {
  const exe = ytDlp(); if (!exe) throw fail(400, 'download the YouTube helper in Settings first');
  const out = await run(exe, ['--skip-download', '--no-playlist', '--print', '%(.{language,subtitles,automatic_captions})j', 'https://www.youtube.com/watch?v=' + vid], { timeout: 120e3 }).catch(e => { throw fail(502, e.message); });
  let info; try { info = JSON.parse(out.trim()); } catch { throw fail(502, 'YouTube sent no video information'); }
  if (!info) throw fail(502, 'YouTube sent no video information');
  const lang = info.language || 'en', manual = info.subtitles || {}, auto = info.automatic_captions || {};
  const track = pickTrack(manual, [lang, 'en', ...Object.keys(manual)]) || pickTrack(auto, [lang, lang + '-orig', 'en-orig', 'en', ...Object.keys(auto)]);
  const j3 = track?.find(x => x.ext === 'json3'), f = j3 || track?.find(x => x.ext === 'vtt') || track?.find(x => x.ext === 'srt');
  if (!f?.url) throw fail(404, 'this video has no captions on YouTube');
  const r = await fetchCaptions(f.url).catch(e => { throw e.code ? e : fail(502, 'could not fetch the captions: ' + e.message); });
  if (!r.ok) throw fail(502, `YouTube answered ${r.status} for the captions`);
  const txt = await r.text(); let segs;
  try { segs = j3 ? json3Segs(JSON.parse(txt)) : capsSegs(txt); } catch { segs = []; }
  if (!segs.length) throw fail(404, 'this video has no captions on YouTube');
  return { segs, lang };
}

// ---------- routes ----------
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), M = req.method, p = url.pathname, q = k => url.searchParams.get(k) || '';
    // Only this machine's own pages may talk to the API: no other website (Origin), no DNS-rebinding name (Host).
    const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (host !== 'localhost' && !net.isIP(host)) throw fail(403, 'unknown host');
    if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) throw fail(403, 'cross-site request refused');
    // Browsers leave Origin off plain GETs (an <img> or <script>), so also refuse pages from another site.
    if (p.startsWith('/api/') && /^(cross-site|same-site)$/.test(req.headers['sec-fetch-site'] || '')) throw fail(403, 'cross-site request refused');

    if (M === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    if (M === 'GET' && p === '/api/library') return send(res, 200, { ...library(), projects: JSON.parse(saved('projects') || '[]') });
    if (M === 'PUT' && p === '/api/projects') { // project names, so a project with nothing in it yet is kept too
      const b = await json(req, 1e5); if (!Array.isArray(b.list)) throw fail(400, 'list must be an array');
      db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('projects', JSON.stringify(b.list.map(x => String(x).trim()).filter(Boolean))); return send(res, 200, {});
    }
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
    if (p === '/api/whisper' && M === 'GET') return send(res, 200, whisperState());
    if (p === '/api/whisper' && (M === 'POST' || M === 'DELETE')) { // what = model:<id> | program | ytdlp
      const what = q('what'), id = what.startsWith('model:') && what.slice(6);
      if (id ? !WMODELS.some(m => m[0] === id) : !['program', 'ytdlp'].includes(what)) throw fail(400, 'unknown download');
      if (M === 'POST') {
        if (what === 'program' && !WIN) throw fail(400, 'on this system install it yourself: brew install whisper-cpp');
        start(what, id ? () => download(what, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${id}.bin`, modelFile(id)).then(() => delete jobs[what])
          : what === 'program' ? getProgram : getYtDlp);
      } else { // delete what is there, or stop it downloading
        jobs[what]?.ac?.abort(); delete jobs[what];
        fs.rmSync(id ? modelFile(id) : what === 'program' ? BIN : YTDLP, { recursive: true, force: true });
      }
      return send(res, 200, whisperState());
    }
    if (p === '/api/whisper/use' && M === 'PUT') {
      if (!haveModels().includes(q('id'))) throw fail(400, 'download that model first');
      db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('whisper', q('id')); return send(res, 200, whisperState());
    }
    if (p === '/api/transcribe') {
      const id = q('id'), key = 'tx:' + id, j = jobs[key];
      if (!/^[\w-]{1,64}$/.test(id)) throw fail(400, 'which source?');
      if (M === 'POST') { await transcribe(id, req); return send(res, 200, {}); }
      if (M === 'DELETE') { j?.ch?.kill(); delete jobs[key]; return send(res, 200, {}); }
      if (M === 'GET') { if (!j) throw fail(404, 'nothing is being transcribed'); if (j.segs || j.error) delete jobs[key]; return send(res, 200, { pct: j.pct, segs: j.segs, error: j.error }); }
    }
    if (p === '/api/ytaudio' && M === 'GET') {
      if (!/^[\w-]{11}$/.test(q('vid'))) throw fail(400, 'not a YouTube video id');
      return await youtubeAudio(q('vid'), res);
    }
    if (p === '/api/ytsubs' && M === 'GET') {
      if (!/^[\w-]{11}$/.test(q('vid'))) throw fail(400, 'not a YouTube video id');
      return send(res, 200, await youtubeCaptions(q('vid')));
    }
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
