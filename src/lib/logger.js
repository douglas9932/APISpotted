import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Log em arquivo diário: <raiz>/logs/api-AAAA-MM-DD.log
// Mantém saída no console e espelha em arquivo (Vercel: só console — FS efêmero).
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'logs');

function arquivoDeHoje() {
  const d = new Date();
  const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(DIR, `api-${dia}.log`);
}

function gravar(nivel, msg, detalhe) {
  const linha = `[${new Date().toISOString()}] ${nivel} ${msg}${detalhe ? ' :: ' + String(detalhe).slice(0, 500) : ''}\n`;
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(arquivoDeHoje(), linha);
  } catch {
    // log nunca pode derrubar a API
  }
  if (nivel === 'ERRO') console.error(msg);
  else console.log(msg);
}

export function logErro(msg, detalhe) {
  gravar('ERRO', msg, detalhe);
}

export function logInfo(msg) {
  gravar('INFO', msg);
}
