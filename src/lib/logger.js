import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSupabaseAdmin } from './supabaseAdmin.js';

// Log em arquivo diário: <raiz>/logs/api-AAAA-MM-DD.log
// Mantém saída no console e espelha em arquivo (Vercel: só console — FS efêmero).
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'logs');

function arquivoDeHoje() {
  const d = new Date();
  const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(DIR, `api-${dia}.log`);
}

function gravar(nivel, msg, detalhe, ctx) {
  const linha = `[${new Date().toISOString()}] ${nivel} ${msg}${detalhe ? ' :: ' + String(detalhe).slice(0, 500) : ''}\n`;
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(arquivoDeHoje(), linha);
  } catch {
    // log nunca pode derrubar a API
  }
  if (nivel === 'ERRO') {
    console.error(msg);
    persistirNoBanco(nivel, msg, detalhe, ctx);
  } else console.log(msg);
}

// Espelha o ERRO na tabela public.tblogs (docs/tblogs.sql) em best-effort:
// fire-and-forget (processo longa-vida) + silêncio total em falha.
// Sem Supabase configurado, cai só no arquivo.
function persistirNoBanco(nivel, msg, detalhe, ctx) {
  let supa;
  try {
    supa = getSupabaseAdmin();
  } catch {
    return;
  }
  try {
    const p = supa.from('tblogs').insert({
      nivel,
      origem: ctx?.origem ? String(ctx.origem).slice(0, 120) : '',
      mensagem: String(msg).slice(0, 500),
      detalhe: detalhe ? String(detalhe).slice(0, 2000) : null,
      ip: ctx?.ip ? String(ctx.ip).slice(0, 80) : null,
      criado_em: new Date().toISOString()
    });
    // supabase-js é preguiçoso: só dispara ao consumir o thenable.
    // Promise.resolve().catch() consome (dispara) e engole a rejeição.
    Promise.resolve(p).catch(() => {});
  } catch {
    // log nunca pode derrubar a API
  }
}

export function logErro(msg, detalhe, ctx) {
  gravar('ERRO', msg, detalhe, ctx);
}

export function logInfo(msg) {
  gravar('INFO', msg);
}
