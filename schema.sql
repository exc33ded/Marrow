-- Marrow on Supabase. Paste into Dashboard > SQL Editor > Run. Safe to re-run.
-- Every table has user_id (defaults to the logged-in user) and a row-level-security policy: you only ever see your own rows.

create table if not exists items(
  id text primary key, user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text not null check(kind in('pdf','web','video')), title text not null, url text,
  project text not null default '', done int not null default 0, added bigint not null, opened bigint,
  data jsonb not null default '{}');
create table if not exists parts(
  id bigint generated always as identity primary key, user_id uuid not null default auth.uid() references auth.users on delete cascade,
  item_id text not null references items(id) on delete cascade, n int not null, t real, body text not null, html text,
  fts tsvector generated always as (to_tsvector('english', body)) stored);
create table if not exists cards(
  id bigint generated always as identity primary key, user_id uuid not null default auth.uid() references auth.users on delete cascade,
  item_id text not null references items(id) on delete cascade, pos int not null,
  q text, a text, quote text, src int, ease real, ivl int, due bigint);
create table if not exists notes(  -- item_id set: highlight on a source. null: a notebook page
  id text primary key, user_id uuid not null default auth.uid() references auth.users on delete cascade,
  item_id text references items(id) on delete cascade, pos int, title text, project text,
  note text, quote text, page int, a int, b int, eb int, c int, ul int, updated bigint);
create table if not exists activity(
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  ts bigint not null, kind text not null, item_id text);
create table if not exists feeds(
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  url text not null, title text not null, added bigint not null, primary key(user_id, url));
create table if not exists settings(  -- AI providers (keys encrypted by the server), model lists, project names
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  k text not null, v text not null, primary key(user_id, k));

create index if not exists items_user on items(user_id, added desc);
create index if not exists parts_item on parts(item_id, n);
create index if not exists parts_fts on parts using gin(fts);
create index if not exists cards_item on cards(item_id, pos);
create index if not exists notes_item on notes(item_id, pos);
create index if not exists activity_user on activity(user_id, ts);

do $$ declare t text; begin
  foreach t in array array['items','parts','cards','notes','activity','feeds','settings'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists own on %I', t);
    execute format('create policy own on %I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- Full-text search. security invoker (default): RLS still applies, so it only searches your own parts.
-- \x01 and \x02 mark matched words, same as the old SQLite version.
create or replace function search_parts(q text, phrase boolean default false)
returns table(item_id text, n int, s text) language sql stable as $$
  with tq as (select case when phrase then phraseto_tsquery('english', q) else plainto_tsquery('english', q) end as t)
  select p.item_id, p.n, ts_headline('english', p.body, tq.t, 'StartSel=' || chr(1) || ',StopSel=' || chr(2) || ',MaxWords=18,MinWords=8')
  from parts p, tq where p.fts @@ tq.t
    -- phrase: the words must really be adjacent and in order (stop words like "is" are not indexed, so the index alone is too loose)
    and (not phrase or p.body ~* ('\m' || array_to_string(regexp_split_to_array(regexp_replace(q, '^\W+|\W+$', '', 'g'), '\W+'), '\W+') || '\M'))
  order by ts_rank(p.fts, tq.t) desc limit 40
$$;

-- PDFs: private bucket, one folder per user (<user id>/<item id>.pdf).
insert into storage.buckets(id, name, public) values('files', 'files', false) on conflict do nothing;
drop policy if exists own_files on storage.objects;
create policy own_files on storage.objects for all to authenticated
  using (bucket_id = 'files' and (select auth.uid())::text = (storage.foldername(name))[1])
  with check (bucket_id = 'files' and (select auth.uid())::text = (storage.foldername(name))[1]);

-- put_item: save one source with its cards, notes and (optionally) text in a single transaction, so a failure halfway can't lose data.
-- security invoker: RLS applies, and saving over another user's id is refused.
create or replace function put_item(p_id text, p jsonb) returns void language plpgsql as $$
begin
  insert into items(id, kind, title, url, project, done, added, opened, data)
  values(p_id, p->>'kind', p->>'title', p->>'url', coalesce(p->>'project', ''), coalesce((p->>'done')::int, 0),
         (p->>'added')::numeric::bigint, (p->>'opened')::numeric::bigint, coalesce(p->'data', '{}'))
  on conflict(id) do update set title = excluded.title, url = excluded.url, project = excluded.project,
         done = excluded.done, opened = excluded.opened, data = excluded.data;  -- kind never changes
  delete from cards where item_id = p_id;
  insert into cards(item_id, pos, q, a, quote, src, ease, ivl, due)
    select p_id, o - 1, c->>'q', c->>'a', c->>'quote', (c->>'src')::numeric::int, (c->>'ease')::real, (c->>'ivl')::numeric::int, (c->>'due')::numeric::bigint
    from jsonb_array_elements(coalesce(p->'cards', '[]')) with ordinality t(c, o);
  delete from notes where item_id = p_id;
  insert into notes(id, item_id, pos, note, quote, page, a, b, eb, c, ul)
    select gen_random_uuid()::text, p_id, o - 1, x->>'note', x->>'quote', (x->>'page')::numeric::int, (x->>'a')::numeric::int, (x->>'b')::numeric::int,
           (x->>'eb')::numeric::int, (x->>'c')::numeric::int, (x->>'ul')::numeric::int
    from jsonb_array_elements(coalesce(p->'notes', '[]')) with ordinality t(x, o);
  if jsonb_typeof(p->'parts') = 'array' then
    delete from parts where item_id = p_id;
    insert into parts(item_id, n, t, body, html)
      select p_id, o, (x->>'t')::real, coalesce(x->>'body', ''), x->>'html'
      from jsonb_array_elements(p->'parts') with ordinality t(x, o);
  end if;
end $$;

-- library: everything the app shows at start, in one round trip. Empty fields are left out, as before.
create or replace function library() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(
        (i.data || jsonb_strip_nulls(jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'url', i.url, 'project', i.project, 'done', i.done, 'added', i.added, 'opened', i.opened))
          || jsonb_build_object(
            'cards', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('q', c.q, 'a', c.a, 'quote', c.quote, 'src', c.src, 'ease', c.ease, 'ivl', c.ivl, 'due', c.due)) order by c.pos) from cards c where c.item_id = i.id), '[]'),
            'notes', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('note', n.note, 'quote', n.quote, 'page', n.page, 'a', n.a, 'b', n.b, 'eb', n.eb, 'c', n.c, 'ul', n.ul)) order by n.pos) from notes n where n.item_id = i.id), '[]')))
        order by i.added desc) from items i), '[]'),
    'notes', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', n.id, 'title', n.title, 'project', n.project, 'note', n.note, 'updated', n.updated)) order by n.updated desc) from notes n where n.item_id is null), '[]'),
    'activity', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('ts', a.ts, 'kind', a.kind, 'item_id', a.item_id)) order by a.ts) from activity a where a.ts > (extract(epoch from now()) * 1000)::bigint - 400 * 86400000::bigint), '[]'),
    'feeds', coalesce((select jsonb_agg(jsonb_build_object('url', f.url, 'title', f.title) order by f.added) from feeds f), '[]'),
    'projects', coalesce((select v::jsonb from settings where k = 'projects'), '[]'));
$$;

-- PDFs: private bucket, one folder per user (<user id>/<item id>.pdf).
insert into storage.buckets(id, name, public) values('files', 'files', false) on conflict do nothing;
drop policy if exists own_files on storage.objects;
create policy own_files on storage.objects for all to authenticated
  using (bucket_id = 'files' and (select auth.uid())::text = (storage.foldername(name))[1])
  with check (bucket_id = 'files' and (select auth.uid())::text = (storage.foldername(name))[1]);

-- put_item: save one source with its cards, notes and (optionally) text in a single transaction, so a failure halfway can't lose data.
-- security invoker: RLS applies, and saving over another user's id is refused.
create or replace function put_item(p_id text, p jsonb) returns void language plpgsql as $$
begin
  insert into items(id, kind, title, url, project, done, added, opened, data)
  values(p_id, p->>'kind', p->>'title', p->>'url', coalesce(p->>'project', ''), coalesce((p->>'done')::int, 0),
         (p->>'added')::numeric::bigint, (p->>'opened')::numeric::bigint, coalesce(p->'data', '{}'))
  on conflict(id) do update set title = excluded.title, url = excluded.url, project = excluded.project,
         done = excluded.done, opened = excluded.opened, data = excluded.data;  -- kind never changes
  delete from cards where item_id = p_id;
  insert into cards(item_id, pos, q, a, quote, src, ease, ivl, due)
    select p_id, o - 1, c->>'q', c->>'a', c->>'quote', (c->>'src')::numeric::int, (c->>'ease')::real, (c->>'ivl')::numeric::int, (c->>'due')::numeric::bigint
    from jsonb_array_elements(coalesce(p->'cards', '[]')) with ordinality t(c, o);
  delete from notes where item_id = p_id;
  insert into notes(id, item_id, pos, note, quote, page, a, b, eb, c, ul)
    select gen_random_uuid()::text, p_id, o - 1, x->>'note', x->>'quote', (x->>'page')::numeric::int, (x->>'a')::numeric::int, (x->>'b')::numeric::int,
           (x->>'eb')::numeric::int, (x->>'c')::numeric::int, (x->>'ul')::numeric::int
    from jsonb_array_elements(coalesce(p->'notes', '[]')) with ordinality t(x, o);
  if jsonb_typeof(p->'parts') = 'array' then
    delete from parts where item_id = p_id;
    insert into parts(item_id, n, t, body, html)
      select p_id, o, (x->>'t')::real, coalesce(x->>'body', ''), x->>'html'
      from jsonb_array_elements(p->'parts') with ordinality t(x, o);
  end if;
end $$;

-- library: everything the app shows at start, in one round trip. Empty fields are left out, as before.
create or replace function library() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(
        (i.data || jsonb_strip_nulls(jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'url', i.url, 'project', i.project, 'done', i.done, 'added', i.added, 'opened', i.opened))
          || jsonb_build_object(
            'cards', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('q', c.q, 'a', c.a, 'quote', c.quote, 'src', c.src, 'ease', c.ease, 'ivl', c.ivl, 'due', c.due)) order by c.pos) from cards c where c.item_id = i.id), '[]'),
            'notes', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('note', n.note, 'quote', n.quote, 'page', n.page, 'a', n.a, 'b', n.b, 'eb', n.eb, 'c', n.c, 'ul', n.ul)) order by n.pos) from notes n where n.item_id = i.id), '[]')))
        order by i.added desc) from items i), '[]'),
    'notes', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', n.id, 'title', n.title, 'project', n.project, 'note', n.note, 'updated', n.updated)) order by n.updated desc) from notes n where n.item_id is null), '[]'),
    'activity', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('ts', a.ts, 'kind', a.kind, 'item_id', a.item_id)) order by a.ts) from activity a where a.ts > (extract(epoch from now()) * 1000)::bigint - 400 * 86400000::bigint), '[]'),
    'feeds', coalesce((select jsonb_agg(jsonb_build_object('url', f.url, 'title', f.title) order by f.added) from feeds f), '[]'),
    'projects', coalesce((select v::jsonb from settings where k = 'projects'), '[]'));
$$;
