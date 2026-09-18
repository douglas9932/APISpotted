-- RLS de referencia para Spotted — aplique no Supabase Dashboard > SQL Editor
-- e versione este arquivo. O front NAO usa anon-key desde F1 (so VITE_API_URL),
-- todo INSERT/STORAGE passa por service-role via /api/publicar.

-- 1) Garantir RLS ativa
alter table public.tbposts enable row level security;
alter table public.tbias enable row level security;
alter table public.tblogs enable row level security;
alter table public.tbposts_rejeitados enable row level security;
alter table public.tbconfiguracoes enable row level security;

-- 2) Remover policies permissivas de anon/authenticated (ajuste os nomes reais)
-- Liste antes: select policyname, cmd, roles from pg_policies where tablename in ('tbposts','tbias','tblogs');
-- drop policy if exists "anon_insert_tbposts" on public.tbposts;
-- drop policy if exists "anon_select_tbposts" on public.tbposts;
-- drop policy if exists "anon_insert_tbias" on public.tbias;

-- 3) Sem policy para anon/authenticated, so service_role (que bypassa RLS) escreve
-- via /api/publicar, /api/ias, etc. Leitura publica futura deve passar por endpoint
-- servidor com regra explicita (ex: so postado=true e liberado=true).

-- 4) Storage bucket "posts": Storage > Policies > posts
-- Remova INSERT/SELECT anon. Uploads usam randomUUID + upsert:false via service-role.
-- Leitura publica (getPublicUrl) pode permanecer public read se desejar exibir imagens.

-- 5) Funcao check_rate_limit(user_ip): como o IP agora eh da conexao no servidor,
-- o parametro user_ip do cliente perdeu sentido — avalie:
-- revoke execute on function public.check_rate_limit(text) from anon, authenticated;

-- 6) Verificacao
-- select * from pg_policies where tablename = 'tbposts';
-- select name, public from storage.buckets where name = 'posts';
