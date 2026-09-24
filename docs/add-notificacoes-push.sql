-- Aparelhos para push FCM (POST /api/notificacoes/*).
-- Execute no Supabase Dashboard > SQL Editor.
-- Um usuário pode ter VÁRIOS aparelhos (unique por usuário+token).
-- Acesso SOMENTE via service-role (RLS ativa sem policies p/ anon,
-- mesmo padrão de tbias/tbposts/tblogs).

create table if not exists public.tbdispositivos_push (
  id_dispositivo uuid primary key default gen_random_uuid(),
  id_usuario text not null default 'moderador',
  token text not null,
  plataforma text not null default 'ANDROID',
  modelo text,
  versao_app text,
  data_cadastro timestamptz not null default now(),
  data_ultima_atualizacao timestamptz not null default now(),
  ativo boolean not null default true,
  constraint uq_dispositivo_usuario_token unique (id_usuario, token)
);

create index if not exists idx_disp_push_usuario_ativo
  on public.tbdispositivos_push (id_usuario, ativo);

alter table public.tbdispositivos_push enable row level security;

-- Verificação
-- select id_usuario, count(*) as aparelhos from public.tbdispositivos_push where ativo group by 1;
