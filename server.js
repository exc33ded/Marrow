// Marrow server: serves the app and proxies AI calls, page fetches and paper search. Accounts, the library and PDFs live in Supabase
// (Auth, Postgres with row-level security, Storage); the server only ever talks to Supabase as the logged-in user.
// Run: node --env-file=.env server.js
const http = require('http'), fs = require('fs'), path = require('path'), net = require('net'), dns = require('dns').promises;
const { randomBytes, createCipheriv, createDecipheriv } = require('crypto');

const PORT = process.env.PORT || 5173;
const HOST = process.env.HOST || '127.0.0.1'; // local only; set HOST=0.0.0.0 to reach it from other devices or a host's proxy
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data'); // only Whisper's downloads live here now
// Free models only, tried in order until one answers. Override with MODELS=a,b,c in .env.
const MODELS = (process.env.MODELS ||
  'baidu/ernie-5.5-flash-preview:free,nvidia/nemotron-3-ultra-550b-a55b:free,google/gemma-4-26b-a4b-it:free,google/gemma-4-31b-it:free,openrouter/free'
).split(',');
// Used when a message carries an image (figure/equation snips).
const VISION = (process.env.VISION_MODELS ||
  'nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free,openrouter/free'
).split(',');

// ---------- Supabase ----------
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), PK = process.env.SUPABASE_PUBLISHABLE_KEY, APP_KEY = Buffer.from(process.env.APP_SECRET || '', 'hex');
if (!SB || !PK || APP_KEY.length !== 32) {
  console.error('Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and APP_SECRET (64 hex characters) in .env.\nNew secret: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
const sb = (p, { token, method = 'GET', body, headers } = {}) => fetch(SB + p, {
  method, signal: AbortSignal.timeout(120000), body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  headers: { apikey: PK, ...(token && { Authorization: 'Bearer ' + token }), ...(body !== undefined && !Buffer.isBuffer(body) && { 'Content-Type': 'application/json' }), ...headers } });
// Postgres through PostgREST, as the user: row-level security does the isolation, so no query here filters by user.
async function db(ctx, p, o) {
  const r = await sb('/rest/v1/' + p, { token: ctx.token, ...o }), t = await r.text();
  if (!r.ok) { let m; try { m = JSON.parse(t).message; } catch {} throw fail(r.status >= 500 ? 502 : [401, 403].includes(r.status) ? r.status : 400, m || 'the database refused that'); }
  return t ? JSON.parse(t) : null;
}
const rpc = (ctx, fn, args = {}) => db(ctx, 'rpc/' + fn, { method: 'POST', body: args });
const upsert = (ctx, table, rows, on) => db(ctx, `${table}?on_conflict=${on}`, { method: 'POST', body: rows, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
const settingsOf = async ctx => Object.fromEntries((await db(ctx, 'settings?select=k,v')).map(r => [r.k, r.v]));

// Sessions: Supabase's access and refresh tokens live in HttpOnly cookies, so page scripts never see them.
// A verified token is remembered for 5 minutes so each request doesn't call Supabase Auth; an expired one is refreshed from the refresh cookie.
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(c => c.includes('=')).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
function setSession(req, res, t) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
  const c = (k, v, age) => `${k}=${encodeURIComponent(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
  res.setHeader('Set-Cookie', t ? [c('mw_at', t.access_token, 2592000), c('mw_rt', t.refresh_token, 2592000)] : [c('mw_at', '', 0), c('mw_rt', '', 0)]);
}
const verified = new Map(), refreshing = new Map();
async function whoIs(token) {
  const hit = verified.get(token); if (hit && hit.until > Date.now()) return hit;
  const r = await sb('/auth/v1/user', { token }); if (!r.ok) return null;
  const u = await r.json(), v = { token, uid: u.id, email: u.email, until: Date.now() + 5 * 60e3 };
  verified.set(token, v); if (verified.size > 500) verified.delete(verified.keys().next().value);
  return v;
}
async function session(req, res) {
  const { mw_at, mw_rt } = cookies(req);
  let v = mw_at && await whoIs(mw_at);
  if (!v && mw_rt) { // concurrent requests share one refresh: the refresh token is single-use
    if (!refreshing.has(mw_rt)) refreshing.set(mw_rt, sb('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: mw_rt } }).then(r => r.ok ? r.json() : null).catch(() => null).finally(() => setTimeout(() => refreshing.delete(mw_rt), 15000)));
    const t = await refreshing.get(mw_rt);
    if (t) { setSession(req, res, t); v = await whoIs(t.access_token); }
  }
  if (!v) throw fail(401, 'log in');
  return v;
}

// Each reader's AI keys are stored encrypted with APP_SECRET, so reading the database (or a backup) does not reveal them. They are decrypted only here, to call the provider.
const seal = s => {
  if (!s) return '';
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', APP_KEY, iv), ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return 'enc1:' + [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
};
const unseal = s => {
  if (!s?.startsWith('enc1:')) return s || '';
  try { const [iv, tag, ct] = s.slice(5).split('.').map(x => Buffer.from(x, 'base64')), d = createDecipheriv('aes-256-gcm', APP_KEY, iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]).toString('utf8'); }
  catch { return ''; } // wrong APP_SECRET: the reader has to enter the key again
};

// AI settings of one reader (S = their settings rows). The server supplies no key of its own: each reader brings their own.
// Providers each have their own address and key; "chain" and "vision" are ordered lists of { p: provider id, m: model } tried top to bottom.
const isOR = url => /(^|\.)openrouter\.ai$/.test(new URL(url).hostname);
const conf = S => {
  const jsonOf = k => { try { return JSON.parse(S[k]); } catch {} };
  const providers = (jsonOf('providers') || [{ id: 'main', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', key: '' }]).map(p => ({ ...p, url: p.url.replace(/\/+$/, ''), key: unseal(p.key) }));
  const first = providers[0].id, chainOf = (k, def) => jsonOf(k) || def.map(m => ({ p: first, m }));
  return { providers, chain: chainOf('chain', MODELS), vision: chainOf('vchain', VISION), paid: S.paid === '1' };
};

// ponytail: an item is saved whole, so its cards and notes are rewritten each time (inside the put_item function). Diff them if items grow to thousands of cards.
const putItem = (ctx, id, { cards = [], notes = [], parts, kind, title, url, project, done, added, opened, id: _, ...data }) =>
  rpc(ctx, 'put_item', { p_id: id, p: { kind, title: String(title || 'Untitled'), url, project: String(project || ''), done: done ? 1 : 0, added: +added || Date.now(), opened, data, cards, notes,
    parts: Array.isArray(parts) ? parts.map(p => ({ t: p.t, html: p.html, body: String(p.body ?? '') })) : null } });
const drop = r => { for (const k in r) if (r[k] === null) delete r[k]; return { ...r }; }; // NULL columns become absent fields
// Full-text search over the reader's library. \x01 and \x02 mark the matched words (the client escapes, then styles them).
const search = (ctx, q, phrase) => (q.match(/[\p{L}\p{N}]+/gu) || []).length ? rpc(ctx, 'search_parts', { q, phrase: !!phrase }) : [];


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
const cooling = new Map(); // keyed by reader, provider and model
const headers = p => ({ 'Content-Type': 'application/json', 'X-Title': 'Marrow', ...(p.key && { Authorization: `Bearer ${p.key}`, ...(/anthropic\.com$/.test(new URL(p.url).hostname) && { 'x-api-key': p.key, 'anthropic-version': '2023-06-01' }) }) });
async function ai(uid, c, messages) {
  const errs = [], badKey = new Set(), ck = (p, m) => uid + '|' + p + '|' + m;
  const all = messages.some(m => Array.isArray(m.content)) ? c.vision : c.chain;
  const open = all.filter(e => !(cooling.get(ck(e.p, e.m)) > Date.now()));
  for (const { p: pid, m: model } of open.length ? open : all) {
    const p = c.providers.find(x => x.id === pid);
    if (!p || badKey.has(pid)) continue;
    if (isOR(p.url) && !c.paid && !model.endsWith(':free') && model !== 'openrouter/free') continue; // never spend money unless told to
    if (!p.key && isOR(p.url)) { badKey.add(pid); errs.push(`${p.name}: no API key yet. Add one in Settings`); continue; }
    let err;
    try {
      const r = await fetch(p.url + '/chat/completions', { method: 'POST', headers: headers(p), body: JSON.stringify({ model, messages, temperature: 0.3 }), signal: AbortSignal.timeout(90000) });
      const j = await r.json().catch(() => ({})); // an error page is not JSON
      const text = j.choices?.[0]?.message?.content;
      if (text) return { text, model, provider: p.name };
      // A rejected key fails every model of that provider the same way, so skip the rest of its models.
      if (r.status === 401 || r.status === 403) { badKey.add(pid); errs.push(`${p.name}: the service rejected the API key`); continue; }
      err = r.status === 404 ? 'the service does not know this model' : r.status === 429 ? 'rate limited' : j.error?.message || `answered ${r.status} with no text`;
    } catch (e) { err = e.name === 'TimeoutError' ? 'no answer within 90 s' : e.message === 'fetch failed' ? `could not reach ${p.url}` : e.message; }
    errs.push(`${p.name} / ${model}: ${err}`);
    cooling.set(ck(pid, model), Date.now() + 10 * 60e3);
    console.warn('model failed ->', errs.at(-1));
  }
  throw fail(502, errs.length ? errs.join('; ') : 'no model is allowed to answer. Add one in Settings (on OpenRouter only free models are used unless you allow paid ones)');
}

// The models a provider offers, so the reader picks from them instead of typing ids from memory. GET {url}/models is the OpenAI-format list.
async function offered(c, id) {
  const p = c.providers.find(x => x.id === id); if (!p) throw fail(404, 'unknown provider');
  const r = await fetch(p.url + '/models', { headers: headers(p), signal: AbortSignal.timeout(20000) }).catch(() => { throw fail(502, `could not reach ${p.url}`); });
  if (r.status === 401 || r.status === 403) throw fail(401, `${p.name} rejected the API key`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(j.data)) throw fail(502, `${p.name} did not return a model list (${r.status}). Type the model name instead`);
  return j.data.map(m => m.id).filter(Boolean).sort().map(id => ({ id, free: id.endsWith(':free') }));
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
const inUse = S => haveModels().includes(S.whisper) ? S.whisper : haveModels()[0] || '';
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
const whisperState = S => ({
  models: WMODELS.map(([id, name, size, note]) => ({ id, name, size, note, have: fs.existsSync(modelFile(id)), job: pub(jobs['model:' + id]) })),
  use: inUse(S), platform: process.platform,
  program: { have: !!whisperCli(), mine: !!within(BIN, WIN ? 'whisper-cli.exe' : 'whisper-cli'), job: pub(jobs.program) },
  ytdlp: { have: !!ytDlp(), mine: fs.existsSync(YTDLP), job: pub(jobs.ytdlp) },
});
// whisper-cli -oj writes { transcription: [{ offsets: { from: ms }, text }] }.
const segsOf = j => (j.transcription || []).map(s => ({ t: s.offsets.from / 1000, body: s.text.trim() })).filter(s => s.body);
async function transcribe(id, req, S, key) {
  const cli = whisperCli(), model = inUse(S);
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
// Names this server may be reached by, besides localhost and plain IP addresses: ALLOWED_HOSTS=marrow.example.com,...
const HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
const store = (uid, id) => `/storage/v1/object/files/${uid}/${id}.pdf`;
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), M = req.method, p = url.pathname, q = k => url.searchParams.get(k) || '';
    // Only this server's own pages may talk to the API: no other website (Origin), no DNS-rebinding name (Host).
    const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (host !== 'localhost' && !net.isIP(host) && !HOSTS.includes(host)) throw fail(403, 'unknown host');
    if (req.headers.origin) { let o; try { o = new URL(req.headers.origin).host; } catch {} if (o !== req.headers.host) throw fail(403, 'cross-site request refused'); }
    // Browsers leave Origin off plain GETs (an <img> or <script>), so also refuse pages from another site.
    if (p.startsWith('/api/') && /^(cross-site|same-site)$/.test(req.headers['sec-fetch-site'] || '')) throw fail(403, 'cross-site request refused');

    if (M === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    // Accounts are made by the admin in the Supabase dashboard; there is no sign-up route. Every other /api route needs a logged-in reader.
    if (p === '/api/login' && M === 'POST') {
      const { email, password } = await json(req, 1e4);
      const r = await sb('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: String(email || '').trim(), password: String(password || '') } });
      if (r.status === 429) throw fail(429, 'too many attempts: wait a minute and try again');
      if (r.status >= 500) throw fail(502, 'the login service is not answering');
      const t = await r.json().catch(() => ({}));
      if (!r.ok || !t.access_token) throw fail(401, 'wrong email or password');
      setSession(req, res, t); return send(res, 200, { email: t.user?.email });
    }
    if (p === '/api/logout' && M === 'POST') {
      const { mw_at } = cookies(req); if (mw_at) { verified.delete(mw_at); sb('/auth/v1/logout', { method: 'POST', token: mw_at }).catch(() => {}); }
      setSession(req, res, null); return send(res, 200, {});
    }
    const ctx = await session(req, res), S = () => settingsOf(ctx);
    if (p === '/api/me') return send(res, 200, { email: ctx.email });

    if (M === 'GET' && p === '/api/library') return send(res, 200, await rpc(ctx, 'library'));
    if (M === 'PUT' && p === '/api/projects') { // project names, so a project with nothing in it yet is kept too
      const b = await json(req, 1e5); if (!Array.isArray(b.list)) throw fail(400, 'list must be an array');
      await upsert(ctx, 'settings', [{ k: 'projects', v: JSON.stringify(b.list.map(x => String(x).trim()).filter(Boolean)) }], 'user_id,k'); return send(res, 200, {});
    }
    if (M === 'GET' && p === '/api/search') return send(res, 200, await search(ctx, q('q'), q('phrase')));
    if (M === 'GET' && p === '/api/discover') return send(res, 200, await discover(q('q')));
    if (M === 'POST' && p === '/api/ai') {
      const { messages } = await json(req, 6e6); // source text plus one cropped image
      if (!Array.isArray(messages)) throw fail(400, 'messages required');
      return send(res, 200, await ai(ctx.uid, conf(await S()), messages));
    }
    if (p === '/api/settings' && M === 'GET') { // keys never leave the server: only whether there is one, and its last four characters
      const c = conf(await S());
      return send(res, 200, { paid: c.paid, chain: c.chain, vision: c.vision, providers: c.providers.map(({ id, name, url, key }) => ({ id, name, url, hasKey: !!key, fromEnv: false, hint: key.slice(-4) })) });
    }
    if (p === '/api/settings' && M === 'PUT') {
      const b = await json(req, 1e5); let have = []; try { have = JSON.parse((await S()).providers) || []; } catch {}
      if (!Array.isArray(b.providers) || !b.providers.length) throw fail(400, 'add at least one provider');
      const ids = new Set(), providers = b.providers.map(x => {
        const id = String(x.id || ''), url = String(x.url || '').trim(), name = String(x.name || '').trim() || url;
        try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch { throw fail(400, `${name}: the API address must start with http:// or https://`); }
        if (!id || ids.has(id)) throw fail(400, 'duplicate provider'); ids.add(id);
        const prev = have.find(h => h.id === id); // its key is already encrypted
        return { id, name, url, key: typeof x.key === 'string' && x.key.trim() ? seal(x.key.trim()) : x.clearKey ? '' : prev?.key || '' };
      });
      const clean = a => (Array.isArray(a) ? a : []).filter(e => ids.has(e.p) && String(e.m || '').trim()).map(e => ({ p: e.p, m: String(e.m).trim() }));
      const chain = clean(b.chain); if (!chain.length) throw fail(400, 'pick at least one model');
      const vision = clean(b.vision);
      await upsert(ctx, 'settings', [{ k: 'providers', v: JSON.stringify(providers) }, { k: 'chain', v: JSON.stringify(chain) }, { k: 'vchain', v: JSON.stringify(vision.length ? vision : chain) }, { k: 'paid', v: b.paid ? '1' : '0' }], 'user_id,k');
      for (const k of cooling.keys()) if (k.startsWith(ctx.uid + '|')) cooling.delete(k);
      return send(res, 200, {});
    }
    if (p === '/api/settings/models' && M === 'GET') return send(res, 200, await offered(conf(await S()), q('provider')));
    if (p === '/api/settings/test' && M === 'POST') { const r = await ai(ctx.uid, conf(await S()), [{ role: 'user', content: 'Reply with the single word: ready' }]); return send(res, 200, { model: r.model, provider: r.provider }); }
    // ponytail: Whisper and yt-dlp run on this server's computer and are shared by every reader. Fine on your own machine; a small free host can't run them.
    if (p === '/api/whisper' && M === 'GET') return send(res, 200, whisperState(await S()));
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
      return send(res, 200, whisperState(await S()));
    }
    if (p === '/api/whisper/use' && M === 'PUT') {
      if (!haveModels().includes(q('id'))) throw fail(400, 'download that model first');
      await upsert(ctx, 'settings', [{ k: 'whisper', v: q('id') }], 'user_id,k'); return send(res, 200, whisperState(await S()));
    }
    if (p === '/api/transcribe') {
      const id = q('id'), key = 'tx:' + ctx.uid + ':' + id, j = jobs[key];
      if (!/^[\w-]{1,64}$/.test(id)) throw fail(400, 'which source?');
      if (M === 'POST') { await transcribe(id, req, await S(), key); return send(res, 200, {}); }
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
      await db(ctx, 'activity', { method: 'POST', body: { ts: Date.now(), kind: String(kind), item_id: item_id ?? null }, headers: { Prefer: 'return=minimal' } });
      return send(res, 200, {});
    }
    if (M === 'PUT' && p === '/api/feeds') {
      const f = await json(req, 1e4);
      if (!/^https?:\/\//.test(f.url)) throw fail(400, 'feed address required');
      await upsert(ctx, 'feeds', [{ url: f.url, title: String(f.title || f.url), added: Date.now() }], 'user_id,url');
      return send(res, 200, {});
    }
    if (M === 'DELETE' && p === '/api/feeds') { await db(ctx, 'feeds?url=eq.' + encodeURIComponent(q('url')), { method: 'DELETE' }); return send(res, 200, {}); }
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
      const [, what, id, parts] = m;
      if (what === 'items' && parts && M === 'GET') return send(res, 200, (await db(ctx, `parts?item_id=eq.${id}&select=n,t,body,html&order=n`)).map(drop));
      if (what === 'items' && M === 'PUT') { await putItem(ctx, id, await json(req)); return send(res, 200, {}); }
      if (what === 'items' && M === 'DELETE') { await db(ctx, 'items?id=eq.' + id, { method: 'DELETE' }); await sb(store(ctx.uid, id), { method: 'DELETE', token: ctx.token }).catch(() => {}); return send(res, 200, {}); }
      if (what === 'notes' && M === 'PUT') { const n = await json(req, 5e6); await upsert(ctx, 'notes', [{ id, title: n.title, project: n.project, note: n.note, updated: Date.now() }], 'id'); return send(res, 200, {}); }
      if (what === 'notes' && M === 'DELETE') { await db(ctx, `notes?id=eq.${id}&item_id=is.null`, { method: 'DELETE' }); return send(res, 200, {}); }
      if (what === 'files' && M === 'PUT') {
        const buf = await slurp(req, 150e6);
        if (!buf.subarray(0, 1024).includes('%PDF-')) throw fail(415, 'not a PDF');
        const r = await sb(store(ctx.uid, id), { method: 'POST', token: ctx.token, body: buf, headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'true' } });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw fail(r.status === 413 ? 413 : r.status >= 500 ? 502 : 400, e.message || `the file store refused the PDF (${r.status})`); }
        return send(res, 200, {});
      }
      if (what === 'files' && M === 'GET') {
        // the unique ?t= keeps Supabase's CDN from serving a PDF that was just deleted or replaced
        const r = await sb(store(ctx.uid, id).replace('/object/', '/object/authenticated/') + '?t=' + Date.now(), { token: ctx.token });
        return r.ok ? send(res, 200, Buffer.from(await r.arrayBuffer()), 'application/pdf') : send(res, 404, { error: 'the PDF file is missing' });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, Number.isInteger(e.code) && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); }
}).listen(PORT, HOST, () => console.log(`Marrow -> http://localhost:${PORT}`));
