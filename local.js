// Marrow's local backend: one reader's library and PDFs on this machine. No service, no accounts, no dependencies.
// The schema lives in schema.sql; this module opens it, keeps the indexes in step, and answers the API's data calls.
const fs = require('fs'), path = require('path'), os = require('os'), { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DAY = 86400000;
const fail = (code, msg) => Object.assign(new Error(msg), { code });
// The library folder: DATA_DIR fixes it (tests, servers); otherwise the reader picks it on first launch and it is remembered in CONF,
// outside the library so it can be found before the library is. LEGACY is where libraries lived before the reader could choose.
const CONF = process.env.MARROW_CONFIG || path.join(os.homedir(), '.marrow.json');
const LEGACY = process.env.MARROW_LEGACY || path.join(__dirname, 'data'); // tests point it elsewhere so they never read a real library
let DATA = process.env.DATA_DIR || (() => { try { return JSON.parse(fs.readFileSync(CONF, 'utf8')).dir || null; } catch { return null; } })();
let db;

const numbers = v => v && new Float64Array(v.buffer, v.byteOffset, Math.floor(v.byteLength / 8));
const blob = v => Buffer.from(Float64Array.from(v.map(Number)).buffer);
const cosine = (a, b) => {
  const x = numbers(a), y = numbers(b);
  if (!x || !y || x.length !== y.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < x.length; i++) { dot += x[i] * y[i]; na += x[i] * x[i]; nb += y[i] * y[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};
const drop = r => { const o = { ...r }; for (const k in o) if (o[k] === null || o[k] === undefined) delete o[k]; return o; };
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const safeId = id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);
const words = q => (String(q || '').match(/[\p{L}\p{N}]+/gu) || []).slice(0, 40);
const matchQuery = (q, phrase) => phrase ? '"' + words(q).join(' ') + '"' : words(q).map(w => '"' + w + '"').join(' AND ');

function open() {
  if (db) return db;
  if (!DATA) throw fail(409, 'choose a folder for your library first');
  fs.mkdirSync(DATA, { recursive: true });
  db = new DatabaseSync(path.join(DATA, 'marrow.db'));
  db.exec('pragma journal_mode=wal; pragma foreign_keys=on');
  // A library made before vector search has parts without emb columns, and "create table if not exists" never adds columns.
  const cols = db.prepare("select name from pragma_table_info('parts')").all().map(r => r.name);
  if (cols.length && !cols.includes('emb')) db.exec('alter table parts add column emb blob; alter table parts add column emb_model text');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  db.function('cosine', cosine);
  // Libraries from before the folder layout kept PDFs as files/<id>.pdf: each moves next to its project, once.
  const old = path.join(DATA, 'files');
  if (fs.existsSync(old)) {
    for (const f of fs.readdirSync(old)) {
      const id = f.slice(0, -4), it = f.endsWith('.pdf') && db.prepare('select project,title from items where id=?').get(id);
      if (it) quietly(() => place('pdf:' + id, relOf('pdf:' + id, id, it.project, it.title, 'papers', '.pdf'), null, path.join(old, f)));
    }
    prune(old);
  }
  if (!fs.existsSync(path.join(DATA, 'README.md'))) fs.writeFileSync(path.join(DATA, 'README.md'), README);
  return db;
}

// ---------- the library folder: the database plus readable copies, one folder per project ----------
const README = `# Marrow library

This folder is your Marrow library. Marrow manages everything in it.

- \`marrow.db\` is the library itself: sources, highlights, cards, notebook pages and settings. Back up this whole folder to back up everything.
- \`<Project>/papers/\` holds the PDFs you added. Marrow opens them from here, so don't move or rename them, or the source will not open.
- \`<Project>/sources/\` has one Markdown file per source: its brief, reading map, your notes, concepts and flashcards.
- \`<Project>/pages/\` has your notebook pages as Markdown.
- \`Unfiled/\` holds sources and pages that are not in a project.

The Markdown files are copies for reading, searching and backing up; they open in Obsidian, VS Code or any editor. Marrow rewrites them whenever you change something in the app, so edits made here are overwritten. Make changes in Marrow.

To move the library somewhere else, use Settings > Library folder.
`;
const abs = rel => path.join(DATA, ...rel.split('/'));
const where = key => db.prepare('select rel from paths where key=?').get(key)?.rel;
// Names every system accepts. Unicode letters stay; reserved characters and device names (CON, NUL…) do not; 80 characters keeps paths short.
const safe = s => { let n = String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, ''); return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n) ? '_' + n : n || 'Untitled'; };
// Where a file belongs. A name another file already has (in any case: Windows and macOS ignore it) gets the first 6 characters of the id.
// ponytail: a project literally called "Unfiled" shares the unfiled folder.
function relOf(key, id, project, title, sub, ext) {
  const dir = `${project ? safe(project) : 'Unfiled'}/${sub}/`, mine = where(key);
  const taken = r => r.toLowerCase() !== mine?.toLowerCase() && (db.prepare('select 1 from paths where key<>? and lower(rel)=lower(?)').get(key, r) || fs.existsSync(abs(r)));
  const rel = dir + safe(title) + ext;
  return taken(rel) ? `${dir}${safe(title)} (${String(id).slice(0, 6)})${ext}` : rel;
}
// Puts a file at rel: moves it from where it was (or from `from`), then writes body if given. The row changes only once the file is there.
function place(key, rel, body, from = where(key) && abs(where(key))) {
  const to = abs(rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (from && path.resolve(from) !== path.resolve(to) && fs.existsSync(from)) { fs.renameSync(from, to); prune(path.dirname(from)); }
  if (body != null) fs.writeFileSync(to, body);
  if (fs.existsSync(to)) db.prepare('insert into paths(key,rel) values(?,?) on conflict(key) do update set rel=excluded.rel').run(key, rel);
}
function unplace(key) {
  const rel = where(key); if (!rel) return;
  fs.rmSync(abs(rel), { force: true }); prune(path.dirname(abs(rel)));
  db.prepare('delete from paths where key=?').run(key);
}
// Folders left empty by a move or delete go too, up to the library folder.
const prune = dir => { try { while (path.resolve(dir) !== path.resolve(DATA) && !fs.readdirSync(dir).length) { fs.rmdirSync(dir); dir = path.dirname(dir); } } catch {} };
// The readable copies never block a save: the database already holds the truth, and the next save tries again (a PDF open in a viewer can't be renamed on Windows).
const quietly = f => { try { f(); } catch (e) { console.warn('library folder:', e.message); } };
function mirrorItem(id, md) {
  const it = db.prepare('select project,title from items where id=?').get(id); if (!it) return;
  if (where('pdf:' + id)) quietly(() => place('pdf:' + id, relOf('pdf:' + id, id, it.project, it.title, 'papers', '.pdf')));
  if (md != null || where('src:' + id)) quietly(() => place('src:' + id, relOf('src:' + id, id, it.project, it.title, 'sources', '.md'), md));
}

function store() {
  const suggest = fs.existsSync(path.join(LEGACY, 'marrow.db')) ? LEGACY : path.join(os.homedir(), 'Documents', 'Marrow');
  return { dir: DATA, fixed: !!process.env.DATA_DIR, suggest, legacy: !DATA && fs.existsSync(path.join(LEGACY, 'marrow.db')) ? LEGACY : null };
}
// First launch: use dir; a library already there opens as it is, and one in the old ./data is copied in. Later: the library moves to dir.
// The old folder is left untouched for the reader to delete.
function choose(input) {
  if (process.env.DATA_DIR) throw fail(400, 'the library folder is set by DATA_DIR');
  if (!path.isAbsolute(String(input || '').trim())) throw fail(400, 'give the full path of a folder, e.g. ' + store().suggest);
  const dir = path.resolve(String(input).trim()), from = DATA || store().legacy, has = fs.existsSync(path.join(dir, 'marrow.db'));
  if (from && path.resolve(from) !== dir) {
    if (DATA && has) throw fail(400, 'that folder already holds a Marrow library; pick an empty folder');
    if (!has) copyLibrary(from, dir);
  }
  if (db) { db.close(); db = null; }
  DATA = dir; open();
  fs.writeFileSync(CONF, JSON.stringify({ dir }, null, 2));
  return store();
}
function copyLibrary(from, to) {
  const inside = (a, b) => !path.relative(a, b).startsWith('..') && !path.isAbsolute(path.relative(a, b));
  if (inside(from, to) || inside(to, from)) throw fail(400, 'the new folder cannot be inside the old one, or the other way round');
  if (fs.existsSync(to) && fs.readdirSync(to).length) throw fail(400, 'pick an empty folder (or one that does not exist yet)');
  const ck = new DatabaseSync(path.join(from, 'marrow.db')); ck.exec('pragma wal_checkpoint(truncate)'); ck.close(); // everything in the main file before copying
  if (db) { db.close(); db = null; }
  const skip = s => path.relative(from, s).split(path.sep)[0] === 'whisper'; // Whisper's downloads are tools, not the library: they stay with the app
  try {
    fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true, filter: s => !skip(s) });
    const a = new DatabaseSync(path.join(from, 'marrow.db'), { readOnly: true }), b = new DatabaseSync(path.join(to, 'marrow.db'), { readOnly: true });
    try {
      if (b.prepare('pragma integrity_check').get().integrity_check !== 'ok') throw new Error('the copied database is damaged');
      for (const { name } of a.prepare("select name from sqlite_master where type='table' and name not like '%fts%'").all())
        if (a.prepare(`select count(*) n from "${name}"`).get().n !== b.prepare(`select count(*) n from "${name}"`).get().n) throw new Error(`the copy of ${name} is incomplete`);
    } finally { a.close(); b.close(); }
    const count = d => fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && !skip(path.join(e.parentPath, e.name))).length;
    if (count(from) !== count(to)) throw new Error('not every file was copied');
  } catch (e) {
    fs.rmSync(to, { recursive: true, force: true });
    throw fail(500, 'could not move the library: ' + e.message + '. Nothing changed.');
  }
}

function settingsOf() {
  open();
  return Object.fromEntries(db.prepare('select k,v from settings').all().map(r => [r.k, r.v]));
}
function saveSettings(rows) {
  open();
  const q = db.prepare('insert into settings(k,v) values(?,?) on conflict(k) do update set v=excluded.v');
  db.exec('begin');
  try { for (const r of rows) q.run(r.k, String(r.v)); db.exec('commit'); }
  catch (e) { db.exec('rollback'); throw e; }
}
function putItem(id, b) {
  open();
  if (!safeId(id)) throw fail(400, 'invalid source id');
  const { cards = [], notes = [], parts, kind, title, url, project, done, added, opened, id: _, md, ...data } = b; // md: the source as Markdown, for its file only
  const q = {
    item: db.prepare(`insert into items(id,kind,title,url,project,done,added,opened,data) values(?,?,?,?,?,?,?,?,?)
      on conflict(id) do update set title=excluded.title,url=excluded.url,project=excluded.project,done=excluded.done,opened=excluded.opened,data=excluded.data`),
    card: db.prepare('insert into cards(item_id,pos,q,a,quote,src,ease,ivl,due) values(?,?,?,?,?,?,?,?,?)'),
    note: db.prepare('insert into notes(id,item_id,pos,note,quote,page,a,b,eb,c,ul) values(?,?,?,?,?,?,?,?,?,?,?)'),
    part: db.prepare('insert into parts(item_id,n,t,body,html,emb,emb_model) values(?,?,?,?,?,?,?)'),
  };
  db.exec('begin');
  try {
    q.item.run(id, String(kind || 'web'), String(title || 'Untitled'), url ?? null, String(project || ''), done ? 1 : 0, +added || Date.now(), opened ?? null, JSON.stringify(data));
    db.prepare('delete from cards where item_id=?').run(id);
    if (Array.isArray(cards)) cards.forEach((c, i) => q.card.run(id, i, c.q ?? null, c.a ?? null, c.quote ?? null, c.src ?? null, c.ease ?? null, c.ivl ?? null, c.due ?? null));
    db.prepare('delete from notes where item_id=?').run(id);
    if (Array.isArray(notes)) notes.forEach((n, i) => q.note.run(randomUUID(), id, i, n.note ?? null, n.quote ?? null, n.page ?? null, n.a ?? null, n.b ?? null, n.eb ?? null, n.c ?? null, n.ul ?? null));
    if (Array.isArray(parts)) {
      db.prepare('delete from parts where item_id=?').run(id);
      parts.forEach((p, i) => q.part.run(id, i + 1, p.t ?? null, String(p.body ?? ''), p.html ?? null,
        Array.isArray(p.emb) ? blob(p.emb) : p.emb ?? null, p.emb_model ?? null));
    }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  mirrorItem(id, md); // after the commit: a file problem never loses a save
}
function getParts(id) {
  open();
  return db.prepare('select n,t,body,html from parts where item_id=? order by n').all(id).map(drop);
}
function partsWithoutEmb(id, model) { // no vector yet, or one made by a different model
  open();
  return db.prepare('select id,body from parts where item_id=? and (emb is null or emb_model is not ?) order by n').all(id, model);
}
function allItemIds() {
  open();
  return db.prepare('select id from items').all().map(r => r.id);
}
function deleteItem(id) {
  open();
  db.prepare('delete from items where id=?').run(id);
  deleteFile(id); quietly(() => unplace('src:' + id));
}
function setEmb(pairs, model) {
  open();
  const q = db.prepare('update parts set emb=?,emb_model=? where id=?');
  db.exec('begin');
  try { for (const p of pairs) q.run(blob(p.v), model, p.id); db.exec('commit'); }
  catch (e) { db.exec('rollback'); throw e; }
}
function conceptEmbs(texts, model) { // cached vectors, null where a text has none yet
  open();
  const q = db.prepare('select emb from concept_emb where text=? and model=?');
  return texts.map(t => { const r = q.get(t, model); return r ? Array.from(numbers(r.emb)) : null; });
}
function saveConceptEmbs(pairs, model) {
  open();
  const q = db.prepare('insert or replace into concept_emb(text,model,emb) values(?,?,?)');
  db.exec('begin');
  try { for (const p of pairs) q.run(p.t, model, blob(p.v)); db.exec('commit'); }
  catch (e) { db.exec('rollback'); throw e; }
}
function saveNote(id, n) {
  open();
  if (!safeId(id)) throw fail(400, 'invalid note id');
  db.prepare(`insert into notes(id,item_id,title,project,note,updated) values(?,null,?,?,?,?)
    on conflict(id) do update set title=excluded.title,project=excluded.project,note=excluded.note,updated=excluded.updated`)
    .run(id, n.title ?? null, n.project ?? null, n.note ?? null, n.updated || Date.now());
  if (n.md != null || where('pg:' + id)) quietly(() => place('pg:' + id, relOf('pg:' + id, id, n.project, n.title || 'Untitled page', 'pages', '.md'), n.md));
}
function deleteNote(id) {
  open();
  db.prepare('delete from notes where id=? and item_id is null').run(id);
  quietly(() => unplace('pg:' + id));
}
function addActivity(kind, itemId, ts) {
  open();
  db.prepare('insert into activity(ts,kind,item_id) values(?,?,?)').run(ts || Date.now(), String(kind), itemId ?? null);
}
function saveFeed(f) {
  open();
  db.prepare(`insert into feeds(url,title,added) values(?,?,?)
    on conflict(url) do update set title=excluded.title,added=excluded.added`)
    .run(f.url, String(f.title || f.url), f.added || Date.now());
}
function deleteFeed(url) {
  open();
  db.prepare('delete from feeds where url=?').run(url);
}
function library() {
  open();
  const items = db.prepare('select * from items order by added desc').all().map(i => ({
    ...json(i.data, {}), ...drop({ id: i.id, kind: i.kind, title: i.title, url: i.url, project: i.project, done: i.done, added: i.added, opened: i.opened }),
    cards: db.prepare('select q,a,quote,src,ease,ivl,due from cards where item_id=? order by pos').all(i.id).map(drop),
    notes: db.prepare('select note,quote,page,a,b,eb,c,ul from notes where item_id=? order by pos').all(i.id).map(drop),
  }));
  const notes = db.prepare('select id,title,project,note,updated from notes where item_id is null order by updated desc').all().map(drop);
  const activity = db.prepare('select ts,kind,item_id from activity where ts>? order by ts').all(Date.now() - 400 * DAY).map(drop);
  const feeds = db.prepare('select url,title from feeds order by added').all();
  // Sources and pages with no file in the library folder yet (made before it, or moved in by migrate.js): the browser saves them once to write them.
  const unmirrored = db.prepare(`select id from items where 'src:'||id not in (select key from paths)
    union all select id from notes where item_id is null and 'pg:'||id not in (select key from paths)`).all().map(r => r.id);
  return { items, notes, activity, feeds, projects: json(settingsOf().projects, []), unmirrored };
}
function searchParts(q, phrase) {
  open();
  const mq = matchQuery(q, phrase);
  if (!mq) return [];
  return db.prepare(`select p.item_id, p.n, snippet(parts_fts,0,char(1),char(2),'…',18) s
    from parts_fts join parts p on p.id=parts_fts.rowid
    where parts_fts match ? order by bm25(parts_fts) limit 40`).all(mq).map(drop);
}
function matchParts({ qe, q, m, k = 12, only_item = null }) {
  open();
  const vec = blob(qe), mq = matchQuery(q, false), args = [];
  const vSql = `select id, row_number() over (order by cosine(emb, ?) desc) r from parts
    where emb_model=? and emb is not null${only_item ? ' and item_id=?' : ''}
    order by cosine(emb, ?) desc limit 40`;
  args.push(vec, m);
  if (only_item) args.push(only_item);
  args.push(vec);
  const fSql = mq ? `select p.id, row_number() over (order by bm25(parts_fts)) r
    from parts_fts join parts p on p.id=parts_fts.rowid
    where parts_fts match ?${only_item ? ' and p.item_id=?' : ''}
    order by bm25(parts_fts) limit 40` : 'select 0 id, 0 r where 0';
  if (mq) { args.push(mq); if (only_item) args.push(only_item); }
  args.push(k);
  return db.prepare(`with v as (${vSql}), f as (${fSql}),
    s as (select id, sum(1.0/(60+r)) sc from (select * from v union all select * from f) group by id)
    select p.item_id,p.n,p.t,p.body from s join parts p on p.id=s.id order by sc desc limit ?`).all(...args).map(drop);
}

// PDFs live in <Project>/papers/<Title>.pdf. A PDF that arrives before its source is saved waits in Unfiled and moves on the first save.
// Unlike the Markdown copies the PDF is the only copy, so a failed write here does fail the upload.
function putFile(id, buf) {
  open();
  if (!safeId(id)) throw fail(400, 'invalid file name');
  const it = db.prepare('select project,title from items where id=?').get(id) || { project: '', title: id };
  place('pdf:' + id, relOf('pdf:' + id, id, it.project, it.title, 'papers', '.pdf'), buf);
}
function getFile(id) {
  open();
  if (!safeId(id)) return null;
  const rel = where('pdf:' + id); if (!rel) return null;
  if (!fs.existsSync(abs(rel))) throw fail(404, `the PDF is missing from your library folder: put it back at ${rel}, or add the source again`);
  return fs.readFileSync(abs(rel));
}
function deleteFile(id) {
  open();
  if (safeId(id)) quietly(() => unplace('pdf:' + id));
}
function raw(sql, ...args) {
  open();
  return db.prepare(sql).all(...args);
}

module.exports = { open, fail, settingsOf, saveSettings, putItem, getParts, partsWithoutEmb, allItemIds, deleteItem, setEmb, conceptEmbs, saveConceptEmbs,
  saveNote, deleteNote, addActivity, saveFeed, deleteFeed, library, searchParts, matchParts,
  putFile, getFile, deleteFile, raw, store, choose, get DATA() { return DATA; } };
