-- Novo campo: motivo obrigatório sempre que necessita_validacao=true
-- Rode no Supabase Dashboard > SQL Editor. Idempotente (pode rodar 2x).

-- 1) Coluna (texto livre, até 500 chars na API; sem limite rígido no banco)
alter table public.tbposts
  add column if not exists motivo_validacao text;

-- 2) Backfill das linhas antigas que estão pendentes sem motivo
-- Heurística: com imagem => motivo imagem; sem imagem => falha IA / suspeita genérica
update public.tbposts
  set motivo_validacao = case
    when imagem_url is not null and imagem_url <> ''
      then 'Contém imagem — revisão humana obrigatória (IA não analisa imagem).'
    else 'Encaminhado para revisão humana (registro anterior sem motivo detalhado).'
  end
  where necessita_validacao = true
    and (motivo_validacao is null or btrim(motivo_validacao) = '');

-- 3) CHECK: necessita_validacao=true EXIGE motivo preenchido
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_tbposts_motivo_validacao'
  ) then
    alter table public.tbposts
      add constraint chk_tbposts_motivo_validacao
      check (necessita_validacao = false or (motivo_validacao is not null and btrim(motivo_validacao) <> ''));
  end if;
end $$;

-- 4) Índice para a tela de pendentes (opcional, só leitura)
create index if not exists idx_tbposts_pendentes_validacao
  on public.tbposts (necessita_validacao, liberado_para_postar, postado)
  where necessita_validacao = true;

-- Verificação
-- select column_name, data_type from information_schema.columns where table_name='tbposts' and column_name='motivo_validacao';
-- select conname, pg_get_constraintdef(oid) from pg_constraint where conname='chk_tbposts_motivo_validacao';
-- select id, necessita_validacao, left(motivo_validacao, 60) from public.tbposts where necessita_validacao=true limit 10;
