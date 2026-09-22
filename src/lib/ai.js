import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { obterChaveProvedor } from './crypto.js';

// Moderação pela IA selecionada na tabela public.tbias (docs/tbias.sql):
// a linha com em_uso=true é a IA em uso (só pode haver uma — índice único).
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

// Fonte primária: a ÚNICA linha com em_uso=true (+ ativa e com chave na env).
function configViaTabela() {
  const supa = getSupabaseAdmin();
  return supa
    .from('tbias')
    .select('provedor, env_key, api_key_enc, modelo, max_tokens')
    .eq('em_uso', true)
    .eq('ativo', true)
    .limit(1)
    .then(({ data, error }) => {
      const p = !error && data && data[0];
      const key = p && obterChaveProvedor(p); // banco criptografado > env
      if (!p || !CALLERS[p.provedor] || !key) return null;
      return {
        provedor: p.provedor,
        key,
        modelo: p.modelo,
        maxTokens: p.max_tokens || 150
      };
    });
}

export async function validateWithAI(message) {
  let cfg = null;
  try {
    cfg = await configViaTabela();
  } catch (err) {
    throw new Error(`tbias inacessível: ${err.message}`);
  }
  if (!cfg) {
    throw new Error('Nenhuma IA em uso (tbias sem linha em_uso=true ativa com chave válida)');
  }
  // Log apenas provedor/modelo (sem dados sensíveis da chave)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[ai] provedor=${cfg.provedor} modelo=${cfg.modelo}`);
  }
  // UMA única tentativa, na IA em uso. Falha aqui vira 503 (/validate) ou
  // revisão manual (/publicar) — nunca tenta outro provedor sozinha.
  const text = await CALLERS[cfg.provedor](message, cfg);
  return parseAIResponse(text);
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
