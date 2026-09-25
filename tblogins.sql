-- Tabela de login do painel (tblogins)
-- Rode no SQL Editor do Supabase (uma vez).
create table if not exists tblogins (
  id uuid primary key default gen_random_uuid(),
  login text unique not null,
  senha_hash text not null,
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);

-- Login inicial (senha em scrypt, nunca em claro)
insert into tblogins (login, senha_hash)
values ('Admin', 'scrypt$713d10543c3295e3c897075816006961$6816d8413a06126b045ca63cc7510e67fec6745b98dc715f5acd9e663fd7148ea7964c7a2f5e03a4f1524c6ab001c77a06bfc2568fa55027612e7ccf7d60fe98')
on conflict (login) do update set senha_hash = excluded.senha_hash, ativo = true;
