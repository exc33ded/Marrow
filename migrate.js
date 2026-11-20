// One-time move of one Supabase account into the local library:
//   node --env-file=.env --env-file=.env.migrate migrate.js [email]
// Needs SUPABASE_URL and a SUPABASE_SERVICE_ROLE_KEY in the environment, used only here.
// Keep APP_SECRET from the old .env: AI keys are copied across still encrypted with it.
const fs = require('fs'), { createDecipheriv } = require('crypto'), local = require('./local');

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, ''), KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_KEY = Buffer.from(process.env.APP_SECRET || '', 'hex');
if (!SB || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (service role, for this script only) in .env.migrate.'); process.exit(1); }

const call = async (p, o = {}) => {
  const r = await fetch(SB + p, { ...o, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, ...o.headers } });
  if (!r.ok) throw new Error(`${p}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r;
};
const table = async (name, uid) => {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const b = await (await call(`/rest/v1/${name}?select=*&user_id=eq.${uid}`, { headers: { Range: `${from}-${from + 999}` } })).json();
    out.push(...b);
    if (b.length < 1000) return out;
  }
};
const accounts = async () => {
  const out = [];
  for (let page = 1; ; page++) {
    const b = await (await call(`/auth/v1/admin/users?page=${page}&per_page=200`)).json();
    out.push(...(b.users || []));
    if (!b.users || b.users.length < 200) return out;
  }
};
const pdfNames = async uid => {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const b = await (await call('/storage/v1/object/list/files', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: uid + '/', limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }) })).json();
    if (!Array.isArray(b)) throw new Error('could not list the files bucket');
    out.push(...b.filter(x => /\.pdf$/i.test(x.name)).map(x => x.name));
    if (b.length < 100) return out;
  }
};
const vec = v => {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v !== 'string') return null;
  if (v.startsWith('[')) { try { return JSON.parse(v).map(Number); } catch {} }
  if (v.startsWith('{') && v.endsWith('}')) return v.slice(1, -1).split(',').filter(Boolean).map(Number);
  console.warn('  could not read an embedding; it will be made again when needed');
  return null;
};
const byPos = (rows, k = 'pos') => [...rows].sort((a, b) => (a[k] ?? 0) - (b[k] ?? 0));
const opens = s => {
  if (!s?.startsWith('enc1:')) return true;
  try {
    const [iv, tag, ct] = s.slice(5).split('.').map(x => Buffer.from(x, 'base64'));
    const d = createDecipheriv('aes-256-gcm', APP_KEY, iv);
    d.setAuthTag(tag); d.update(ct); d.final(); return true;
  } catch { return false; }
};

(async () => {
  const all = await accounts(), wanted = process.argv[2];
  const u = wanted ? all.find(x => x.email.toLowerCase() === wanted.toLowerCase())
    : all.length === 1 ? all[0] : null;
  if (!u) {
    console.error(wanted ? `No Supabase account for ${wanted}.` : `Supabase has ${all.length} accounts; pass the email to migrate.`);
    for (const x of all) console.error('  ' + x.email);
    process.exit(1);
  }
  console.log(`Reading ${u.email} from Supabase…`);
  const [items, parts, cards, notes, activity, feeds, settings] = await Promise.all(
    ['items', 'parts', 'cards', 'notes', 'activity', 'feeds', 'settings'].map(t => table(t, u.id)));
  const names = await pdfNames(u.id);
  const pdfs = [];
  for (const name of names) {
    const object = name.split('/').map(encodeURIComponent).join('/');
    pdfs.push([name.slice(0, -4), Buffer.from(await (await call(`/storage/v1/object/files/${u.id}/${object}`)).arrayBuffer())]);
  }

  fs.rmSync(local.FILES, { recursive: true, force: true });
  for (const sql of ['delete from items', 'delete from notes', 'delete from activity', 'delete from feeds', 'delete from settings']) local.raw(sql);
  for (const [id, buf] of pdfs) local.putFile(id, buf);

  for (const it of items) {
    const mine = t => byPos(t.filter(r => r.item_id === it.id));
    local.putItem(it.id, { ...(it.data || {}), id: it.id, kind: it.kind, title: it.title, url: it.url, project: it.project,
      done: it.done, added: it.added, opened: it.opened,
      cards: mine(cards).map(c => ({ q: c.q, a: c.a, quote: c.quote, src: c.src, ease: c.ease, ivl: c.ivl, due: c.due })),
      notes: mine(notes).map(n => ({ note: n.note, quote: n.quote, page: n.page, a: n.a, b: n.b, eb: n.eb, c: n.c, ul: n.ul })),
      parts: mine(parts, 'n').map(p => ({ t: p.t, body: p.body, html: p.html, emb: vec(p.emb), emb_model: p.emb_model })) });
  }
  for (const n of notes.filter(x => !x.item_id)) local.saveNote(n.id, { title: n.title, project: n.project, note: n.note, updated: n.updated });
  for (const a of activity) local.addActivity(a.kind, a.item_id, a.ts);
  for (const f of feeds) local.saveFeed({ url: f.url, title: f.title, added: f.added });
  if (settings.length) local.saveSettings(settings.map(s => ({ k: s.k, v: s.v })));
  const providers = JSON.parse(settings.find(s => s.k === 'providers')?.v || '[]');
  if (providers.some(p => !opens(p.key))) console.warn('Warning: APP_SECRET does not match the old one. Re-enter your AI keys in Settings.');
  console.log(`Migrated ${items.length} sources, ${notes.filter(x => !x.item_id).length} notebook pages, ${pdfs.length} PDFs, ${activity.length} activity rows.`);
  console.log('Set APP_SECRET in .env to the same value as before, then run: npm start');
})().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
