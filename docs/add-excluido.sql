-- Novo campo para impedir reenvio apos exclusao do Instagram
-- Quando voce clica em "Excluir publicado" no painel, o app limpa instagram_id
-- e marca excluido=true, assim o servico nao pega de novo em /api/posts-liberados
-- (que filtra excluido IS NULL OR = false).

alter table public.tbposts
  add column if not exists excluido boolean not null default false;

-- Opcional: indice para o filtro do servico (liberados)
create index if not exists idx_tbposts_liberados_excluido
  on public.tbposts (liberado_para_postar, postado, excluido)
  where liberado_para_postar = true and postado = false;

-- Verificacao
-- select column_name, data_type, column_default from information_schema.columns where table_name='tbposts' and column_name='excluido';
