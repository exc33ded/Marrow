// Marrow's local backend: one reader's library and PDFs on this machine. No service, no accounts, no dependencies.
// The schema lives in schema.sql; this module opens it, keeps the indexes in step, and answers the API's data calls.
const fs = require('fs'), path = require('path'), { randomUUID } = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILES = path.join(DATA, 'files');
const DAY = 86400000;
const fail = (code, msg) => Object.assign(new Error(msg), { code });
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
  fs.mkdirSync(FILES, { recursive: true });
  db = new DatabaseSync(path.join(DATA, 'marrow.db'));
  db.exec('pragma journal_mode=wal; pragma foreign_keys=on');
  // A library made before vector search has parts without emb columns, and "create table if not exists" never adds columns.
  const cols = db.prepare("select name from pragma_table_info('parts')").all().map(r => r.name);
  if (cols.length && !cols.includes('emb')) db.exec('alter table parts add column emb blob; alter table parts add column emb_model text');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  db.function('cosine', cosine);
  return db;
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
  const { cards = [], notes = [], parts, kind, title, url, project, done, added, opened, id: _, ...data } = b;
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
}
function getParts(id) {
  open();
  return db.prepare('select n,t,body,html from parts where item_id=? order by n').all(id).map(drop);
}
function partsWithoutEmb(id) {
  open();
  return db.prepare('select id,body from parts where item_id=? and emb is null order by n').all(id);
}
function allItemIds() {
  open();
  return db.prepare('select id from items').all().map(r => r.id);
}
function deleteItem(id) {
  open();
  db.prepare('delete from items where id=?').run(id);
  deleteFile(id);
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
}
function deleteNote(id) {
  open();
  db.prepare('delete from notes where id=? and item_id is null').run(id);
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
  return { items, notes, activity, feeds, projects: json(settingsOf().projects, []) };
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

function fileOf(id) { return path.join(FILES, id + '.pdf'); }
function putFile(id, buf) {
  open();
  if (!safeId(id)) throw fail(400, 'invalid file name');
  fs.mkdirSync(FILES, { recursive: true });
  fs.writeFileSync(fileOf(id), buf);
}
function getFile(id) {
  open();
  if (!safeId(id)) return null;
  const f = fileOf(id);
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
}
function deleteFile(id) {
  if (safeId(id)) fs.rmSync(fileOf(id), { force: true });
}
function fileList() {
  open();
  return fs.existsSync(FILES) ? fs.readdirSync(FILES).filter(f => /^[\w-]{1,64}\.pdf$/.test(f)).map(f => f.slice(0, -4)) : [];
}
function raw(sql, ...args) {
  open();
  return db.prepare(sql).all(...args);
}

module.exports = { open, fail, settingsOf, saveSettings, putItem, getParts, partsWithoutEmb, allItemIds, deleteItem, setEmb, conceptEmbs, saveConceptEmbs,
  saveNote, deleteNote, addActivity, saveFeed, deleteFeed, library, searchParts, matchParts,
  putFile, getFile, deleteFile, fileList, raw, DATA, FILES };
