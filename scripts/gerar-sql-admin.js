import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashSenha } from '../src/lib/senha.js';

// Gera tblogins.sql (tabela + login) com a senha já criptografada (scrypt).
// Uso: node scripts/gerar-sql-admin.js <login> <senha>
// O SQL vai para tblogins.sql — rode no SQL Editor do Supabase.
// (A senha em claro aparece SÓ neste comando local; no banco vai só o hash.)

const [login, senha] = process.argv.slice(2);
if (!login || !senha) {
  console.error('Uso: node scripts/gerar-sql-admin.js <login> <senha>');
  process.exit(1);
}

const hash = await hashSenha(senha);
const dir = dirname(fileURLToPath(import.meta.url));
const sql = `-- Tabela de login do painel (tblogins)
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
values ('${login.replace(/'/g, "''")}', '${hash}')
on conflict (login) do update set senha_hash = excluded.senha_hash, ativo = true;
`;
writeFileSync(join(dir, '..', 'tblogins.sql'), sql, 'utf8');
console.log('tblogins.sql gerado (login: ' + login + ').');
