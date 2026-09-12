import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prompts = JSON.parse(readFileSync(join(__dirname, '../../prompts.json'), 'utf-8'));

function buildPrompt(message) {
  return `${prompts.validacao}${message}${prompts.sufixo}`;
}

async function callClaude(message) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 150,
      messages: [{ role: 'user', content: buildPrompt(message) }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    console.error('Anthropic error:', response.status, err);
    throw new Error(`Anthropic ${response.status}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

async function callGemini(message) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada');

  const genAI = new GoogleGenerativeAI(apiKey);
  // modelo padrão atualizado: gemini-2.5-flash bloqueado para novas chaves, usar gemini-3.6-flash
  const modelName = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const model = genAI.getGenerativeModel({ model: modelName });

  const result = await model.generateContent(buildPrompt(message));
  return result.response.text();
}

function parseAIResponse(text) {
  let resultado;
  try {
    resultado = JSON.parse(text);
    if (typeof resultado.mensagemvalida !== 'boolean') {
      resultado = { mensagemvalida: false, motivorecusa: 'Erro na validação', suspeita: false };
    }
    if (typeof resultado.suspeita !== 'boolean') {
      resultado.suspeita = false;
    }
  } catch {
    resultado = { mensagemvalida: false, motivorecusa: 'Erro ao processar resposta', suspeita: false };
  }
  return resultado;
}

export async function validateWithAI(message) {
  const provider = (process.env.AI_PROVIDER || 'claude').toLowerCase();

  const callAI = provider === 'gemini' ? callGemini : callClaude;
  const text = await callAI(message);
  return parseAIResponse(text);
}
