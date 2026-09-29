import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { obterChaveProvedor } from './crypto.js';

// Moderação pelas IAs da tabela public.tbias (docs/tbias.sql):
// 1º a linha com em_uso=true; em falha de infra/comunicação (sem créditos,
// token vencido, timeout, rede, 429/5xx...), cai para a próxima ATIVA com
// chave válida, em ordem de prioridade (da MAIOR para a MENOR).
// Chave e seleção vêm SOMENTE do banco (modo estrito, sem fallback p/ env).
// Sem linha válida, falha explícito (503 / revisão manual).

const __dirname = dirname(fileURLToPath(import.meta.url));
const prompts = JSON.parse(readFileSync(join(__dirname, '../../prompts.json'), 'utf-8'));

// Timeout da IA: configurável via AI_TIMEOUT_MS (padrão 45s, mín 5s, máx 120s).
// Aumente se a IA estiver lenta (ex: AI_TIMEOUT_MS=60000 no .env).
// Vale para Gemini (corrida) e Claude/OpenAI (AbortSignal).
const TIMEOUT_MS = (() => {
  const v = Number.parseInt(process.env.AI_TIMEOUT_MS || '45000', 10);
  if (!Number.isFinite(v)) return 45000;
  return Math.min(120000, Math.max(5000, v));
})();

function buildPrompt(message) {
  return `${prompts.validacao}${message}${prompts.sufixo}`;
}

// Gemini via SDK não aceita AbortSignal: timeout por corrida.
function comTimeout(promise, rotulo) {
  let timer;
  const limite = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${rotulo} timeout após ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
  });
  return Promise.race([promise, limite]).finally(() => clearTimeout(timer));
}

async function callClaude(message, { key, modelo, maxTokens }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: modelo,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: buildPrompt(message) }]
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Anthropic error:', response.status, err);
    // Inclui o corpo (truncado) na exceção: cai só no log do servidor/tblogs,
    // nunca na resposta ao usuário (F7). Essencial p/ diagnosticar 400/401.
    throw new Error(`Anthropic ${response.status}: ${String(err).slice(0, 300)}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

async function callGemini(message, { key, modelo }) {
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: modelo });

  const result = await comTimeout(model.generateContent(buildPrompt(message)), 'Gemini');
  return result.response.text();
}

async function callOpenAI(message, { key, modelo, maxTokens }) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: modelo,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: buildPrompt(message) }]
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('OpenAI error:', response.status, err);
    // Corpo truncado só no log do servidor/tblogs, nunca ao usuário (F7).
    throw new Error(`OpenAI ${response.status}: ${String(err).slice(0, 300)}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function callGroq(message, { key, modelo, maxTokens }) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: modelo,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: buildPrompt(message) }]
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Groq error:', response.status, err);
    // Corpo truncado só no log do servidor/tblogs, nunca ao usuário (F7).
    throw new Error(`Groq ${response.status}: ${String(err).slice(0, 300)}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

const CALLERS = { claude: callClaude, gemini: callGemini, groq: callGroq, openai: callOpenAI };

// Fonte primária: a ÚNICA linha com em_uso=true (+ ativa e com chave).
// Fallback: demais linhas ativas COM chave válida, em ordem de prioridade
// (da MAIOR para a MENOR). Só entra quem tem caller implementado.
async function listarCandidatas() {
  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from('tbias')
    .select('provedor, env_key, api_key_enc, modelo, max_tokens, prioridade, ativo, em_uso')
    .eq('ativo', true)
    .order('prioridade', { ascending: false });
  if (error) throw error;
  const lista = [];
  for (const p of data || []) {
    if (!p || !CALLERS[p.provedor]) continue;
    const key = obterChaveProvedor(p); // banco criptografado; sem chave válida = pula
    if (!key) continue;
    lista.push({
      provedor: p.provedor,
      key,
      modelo: p.modelo,
      maxTokens: p.max_tokens || 150,
      prioridade: p.prioridade ?? 0,
      em_uso: p.em_uso === true
    });
  }
  // EM USO primeiro; depois as demais pela prioridade (já veio DESC do banco).
  lista.sort((a, b) => Number(b.em_uso) - Number(a.em_uso) || (b.prioridade - a.prioridade));
  return lista;
}

// Erro de infra/comunicação que justifica trocar de IA: sem créditos,
// token vencido/inválido, rate-limit/quota, timeout, rede, 5xx, sobrecarga.
// Qualquer exceção do provedor cai no fallback; a classificação abaixo serve
// para log/diagnóstico (o detalhe nunca volta ao usuário — F7).
function causaTroca(msg) {
  const t = String(msg || '');
  if (/credit|billing|balance|insufficient/i.test(t)) return 'sem créditos';
  if (/expir|vencido|expired/i.test(t)) return 'token vencido/expirado';
  if (/\b401\b|unauthorized|authentication|invalid.*api.*key|incorrect api key/i.test(t)) return 'falha de autenticação';
  if (/\b429\b|rate.?limit|quota|resource.?exhausted/i.test(t)) return 'limite/quota excedido';
  if (/\b402\b|payment/i.test(t)) return 'pagamento pendente';
  if (/timeout após|timed out|timeouterror|abort/i.test(t)) return 'timeout';
  if (/high demand|overloaded|overload|try again later|capacity|temporar/i.test(t)) return 'sobrecarga temporária';
  if (/\b5\d\d\b|fetch failed|network|econn|enotfound|etimedout|eai_again|socket hang/i.test(t)) return 'falha de comunicação';
  return 'falha no provedor';
}

export async function validateWithAI(message) {
  let candidatas;
  try {
    candidatas = await listarCandidatas();
  } catch (err) {
    throw new Error(`tbias inacessível: ${err.message}`);
  }
  if (!candidatas.length) {
    throw new Error('Nenhuma IA disponível (tbias sem linha ativa com chave válida)');
  }
  // Log apenas provedor/modelo (sem dados sensíveis da chave)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[ai] ordem=${candidatas.map((c) => `${c.provedor}${c.em_uso ? '(em_uso)' : ''}:pri${c.prioridade}`).join(' > ')}`);
  }
  // Tenta a IA EM USO primeiro; em falha de infra/comunicação (sem créditos,
  // token vencido, timeout, rede, 429/5xx...), cai para a próxima ativa COM
  // token, em ordem de prioridade (maior -> menor). O resultado da moderação
  // (mensagemvalida true/false) NUNCA dispara troca — só exceção do provedor.
  let ultimoErro = null;
  for (const cfg of candidatas) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[ai] provedor=${cfg.provedor} modelo=${cfg.modelo}`);
    }
    try {
      const text = await CALLERS[cfg.provedor](message, cfg);
      return parseAIResponse(text);
    } catch (err) {
      ultimoErro = err;
      console.error(`[ai] ${cfg.provedor} falhou (${causaTroca(err?.message)}): ${String(err?.message || err).slice(0, 200)}`);
    }
  }
  throw ultimoErro instanceof Error ? ultimoErro : new Error(String(ultimoErro || 'Todas as IAs falharam'));
}

function parseAIResponse(text) {
  let resultado;
  try {
    resultado = JSON.parse(text);
    if (typeof resultado.mensagemvalida !== 'boolean') {
      resultado = { mensagemvalida: false, motivorecusa: 'Erro na validação', suspeita: false, motivo_suspeita: null };
    }
    if (typeof resultado.suspeita !== 'boolean') {
      resultado.suspeita = false;
    }
    // motivo_suspeita: obrigatório quando suspeita=true (novo campo motivo_validacao em tbposts)
    if (typeof resultado.motivo_suspeita === 'string') {
      resultado.motivo_suspeita = resultado.motivo_suspeita.trim().slice(0, 500) || null;
    } else {
      resultado.motivo_suspeita = null;
    }
    if (resultado.suspeita !== true) {
      resultado.motivo_suspeita = null;
    }
  } catch {
    resultado = { mensagemvalida: false, motivorecusa: 'Erro ao processar resposta', suspeita: false, motivo_suspeita: null };
  }
  return resultado;
}
