import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { exigirLocal } from '../lib/adminAuth.js';
import { criptografarChave, descriptografarChave } from '../lib/crypto.js';
import { logErro } from '../lib/logger.js';

// Administração das IAs (tbias) — SEM token, SOMENTE localhost (ver adminAuth).
// A chave em claro chega no body, é criptografada em memória e só o
// ciphertext vai ao banco. Nenhum endpoint retorna chave (só tem_chave).

const PROVEDORES = ['gemini', 'openai', 'claude'];

function provedorOk(v) {
  return typeof v === 'string' && PROVEDORES.includes(v.toLowerCase());
}

function ctx(req) {
  return { origem: '/api/ias', ip: req.ip || req.socket?.remoteAddress || 'unknown' };
}

function supaOu503(res) {
  try {
    return getSupabaseAdmin();
  } catch (e) {
    if (e.code === 'E_NO_SUPABASE') {
      res.status(503).json({ ok: false, motivo: 'Serviço indisponível. Tente novamente em instantes.' });
      return null;
    }
    throw e;
  }
}

export async function listarIas(req, res) {
  if (!exigirLocal(req, res)) return;
  const supa = supaOu503(res);
  if (!supa) return;
  try {
    const { data, error } = await supa
      .from('tbias')
      .select('provedor, env_key, modelo, prioridade, max_tokens, ativo, em_uso, api_key_enc')
      .order('prioridade', { ascending: true });
    if (error) throw error;
    // nunca expõe ciphertext nem chave: só presença
    const ias = (data || []).map((p) => ({
      provedor: p.provedor,
      env_key: p.env_key,
      modelo: p.modelo,
      prioridade: p.prioridade,
      max_tokens: p.max_tokens,
      ativo: p.ativo,
      em_uso: p.em_uso,
      tem_chave: !!p.api_key_enc
    }));
    return res.json({ ok: true, ias });
  } catch (err) {
    logErro('ias listar falhou', err.message, ctx(req));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível carregar. Tente novamente.' });
  }
}

export async function atualizarIa(req, res) {
  if (!exigirLocal(req, res)) return;
  const { provedor } = req.params;
  if (!provedorOk(provedor)) {
    return res.status(400).json({ ok: false, motivo: 'Provedor inválido.' });
  }
  const { modelo, prioridade, max_tokens, ativo } = req.body || {};
  const patch = {};
  if (modelo !== undefined) {
    if (typeof modelo !== 'string' || !modelo.trim() || modelo.length > 120) {
      return res.status(400).json({ ok: false, motivo: 'Modelo inválido.' });
    }
    patch.modelo = modelo.trim();
  }
  if (prioridade !== undefined) {
    if (!Number.isInteger(prioridade) || prioridade < 0 || prioridade > 100000) {
      return res.status(400).json({ ok: false, motivo: 'Prioridade inválida.' });
    }
    patch.prioridade = prioridade;
  }
  if (max_tokens !== undefined) {
    if (!Number.isInteger(max_tokens) || max_tokens < 1 || max_tokens > 4000) {
      return res.status(400).json({ ok: false, motivo: 'max_tokens inválido.' });
    }
    patch.max_tokens = max_tokens;
  }
  if (ativo !== undefined) {
    if (typeof ativo !== 'boolean') {
      return res.status(400).json({ ok: false, motivo: 'ativo inválido.' });
    }
    patch.ativo = ativo;
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({ ok: false, motivo: 'Nada para atualizar.' });
  }
  const supa = supaOu503(res);
  if (!supa) return;
  try {
    const { error } = await supa.from('tbias').update(patch).eq('provedor', provedor.toLowerCase());
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    logErro('ias atualizar falhou', err.message, ctx(req));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível salvar. Tente novamente.' });
  }
}

export async function definirEmUso(req, res) {
  if (!exigirLocal(req, res)) return;
  const { provedor } = req.params;
  if (!provedorOk(provedor)) {
    return res.status(400).json({ ok: false, motivo: 'Provedor inválido.' });
  }
  const supa = supaOu503(res);
  if (!supa) return;
  try {
    const alvo = provedor.toLowerCase();
    const r1 = await supa.from('tbias').update({ em_uso: false }).eq('em_uso', true);
    if (r1.error) throw r1.error;
    const r2 = await supa.from('tbias').update({ em_uso: true }).eq('provedor', alvo);
    if (r2.error) throw r2.error;
    return res.json({ ok: true });
  } catch (err) {
    logErro('ias em_uso falhou', err.message, ctx(req));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível definir. Tente novamente.' });
  }
}

export async function salvarChave(req, res) {
  if (!exigirLocal(req, res)) return;
  const { provedor } = req.params;
  if (!provedorOk(provedor)) {
    return res.status(400).json({ ok: false, motivo: 'Provedor inválido.' });
  }
  const { key } = req.body || {};
  if (typeof key !== 'string' || !key.trim() || key.length > 500) {
    return res.status(400).json({ ok: false, motivo: 'Chave inválida.' });
  }
  if (!process.env.IA_MASTER_KEY) {
    return res.status(503).json({ ok: false, motivo: 'IA_MASTER_KEY não configurada no servidor.' });
  }
  const supa = supaOu503(res);
  if (!supa) return;
  try {
    // Criptografa em memória; a chave em claro nunca é logada nem persistida.
    const cipher = criptografarChave(key.trim());
    const alvo = provedor.toLowerCase();
    const rUp = await supa.from('tbias').update({ api_key_enc: cipher }).eq('provedor', alvo);
    if (rUp.error) throw rUp.error;
    // Conferência ponta a ponta: relê, descriptografa e compara.
    const rSel = await supa.from('tbias').select('api_key_enc').eq('provedor', alvo).limit(1);
    if (rSel.error) throw rSel.error;
    const volta = rSel.data && rSel.data[0] && rSel.data[0].api_key_enc;
    const conferido = !!volta && descriptografarChave(volta) === key.trim();
    return res.json({ ok: true, conferido });
  } catch (err) {
    logErro('ias salvar chave falhou', err.message, ctx(req));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível salvar a chave. Tente novamente.' });
  }
}

export async function removerChave(req, res) {
  if (!exigirLocal(req, res)) return;
  const { provedor } = req.params;
  if (!provedorOk(provedor)) {
    return res.status(400).json({ ok: false, motivo: 'Provedor inválido.' });
  }
  const supa = supaOu503(res);
  if (!supa) return;
  try {
    const { error } = await supa.from('tbias').update({ api_key_enc: null }).eq('provedor', provedor.toLowerCase());
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    logErro('ias remover chave falhou', err.message, ctx(req));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível remover. Tente novamente.' });
  }
}
