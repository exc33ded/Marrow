-- Marrow's local store, created automatically by local.js. This file is the schema of record.
-- One reader, one library: no accounts and no per-user columns.

create table if not exists items(
  id text primary key,
  kind text not null check(kind in ('pdf','web','video')),
  title text not null,
  url text,
  project text not null default '',
  done integer not null default 0,
  added integer not null,
  opened integer,
  data text not null default '{}'
);
create table if not exists parts(
  id integer primary key autoincrement,
  item_id text not null references items(id) on delete cascade,
  n integer not null,
  t real,
  body text not null,
  html text,
  emb blob,
  emb_model text
);
create virtual table if not exists parts_fts using fts5(body, content='parts', content_rowid='id', tokenize='porter unicode61');
create trigger if not exists parts_ai after insert on parts begin
  insert into parts_fts(rowid, body) values (new.id, new.body);
end;
create trigger if not exists parts_ad after delete on parts begin
  insert into parts_fts(parts_fts, rowid, body) values('delete', old.id, old.body);
end;
create trigger if not exists parts_au after update on parts begin
  insert into parts_fts(parts_fts, rowid, body) values('delete', old.id, old.body);
  insert into parts_fts(rowid, body) values (new.id, new.body);
end;
create table if not exists cards(
  id integer primary key autoincrement,
  item_id text not null references items(id) on delete cascade,
  pos integer not null,
  q text, a text, quote text,
  src integer, ease real, ivl integer, due integer
);
create table if not exists notes(
  id text primary key,
  item_id text references items(id) on delete cascade,
  pos integer, title text, project text,
  note text, quote text, page integer,
  a integer, b integer, eb integer, c integer, ul integer, updated integer
);
create table if not exists activity(
  ts integer not null, kind text not null, item_id text
);
create table if not exists feeds(
  url text primary key, title text not null, added integer not null
);
-- Where each file in the library folder lives, relative to it: key = pdf:<item id> | src:<item id> | pg:<page id>.
create table if not exists paths(
  key text primary key, rel text not null
);
-- Vectors for the concept map's "similar meaning" links, one per concept text ("name: definition") and model.
create table if not exists concept_emb(
  text text not null, model text not null, emb blob not null,
  primary key(text, model)
);
create table if not exists settings(
  k text primary key, v text not null
);
create index if not exists items_added on items(added desc);
create index if not exists parts_item on parts(item_id, n);
create index if not exists parts_model on parts(emb_model);
create index if not exists cards_item on cards(item_id, pos);
create index if not exists notes_item on notes(item_id, pos);
create index if not exists activity_ts on activity(ts);
