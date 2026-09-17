import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { exigirLocal } from '../lib/adminAuth.js';
import { logErro } from '../lib/logger.js';

// Leitura da tabela tblogs — SOMENTE localhost (ver adminAuth).
// GET /api/logs?limite=100&nivel=ERRO&origem=/api/publicar&busca=texto
// - limite: 1..500 (padrão 100)
// - nivel: ERRO | INFO (opcional)
// - origem: contém (opcional)
// - busca: ilike em mensagem OU detalhe (opcional)

export async function listarLogs(req, res) {
  if (!exigirLocal(req, res)) return;
  let supa;
  try {
    supa = getSupabaseAdmin();
  } catch (e) {
    if (e.code === 'E_NO_SUPABASE') {
      return res.status(503).json({ ok: false, motivo: 'Serviço indisponível. Tente novamente em instantes.' });
    }
    throw e;
  }
  try {
    const q = req.query || {};
    let limite = parseInt(q.limite, 10);
    if (!Number.isInteger(limite) || limite < 1) limite = 100;
    if (limite > 500) limite = 500;

    let query = supa
      .from('tblogs')
      .select('id, criado_em, nivel, origem, mensagem, detalhe, ip')
      .order('criado_em', { ascending: false })
      .limit(limite);

    if (q.nivel === 'ERRO' || q.nivel === 'INFO') {
      query = query.eq('nivel', q.nivel);
    }
    if (typeof q.origem === 'string' && q.origem.trim()) {
      query = query.ilike('origem', `%${q.origem.trim().slice(0, 120)}%`);
    }
    if (typeof q.busca === 'string' && q.busca.trim()) {
      const termo = q.busca.trim().slice(0, 200).replace(/[%*,()]/g, '');
      query = query.or(`mensagem.ilike.%${termo}%,detalhe.ilike.%${termo}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return res.json({ ok: true, logs: data || [] });
  } catch (err) {
    logErro('logs listar falhou', err.message, {
      origem: '/api/logs',
      ip: req.ip || req.socket?.remoteAddress || 'unknown'
    });
    return res.status(502).json({ ok: false, motivo: 'Não foi possível carregar. Tente novamente.' });
  }
}

// Recebe erros do app desktop (InstagramConfig) — SOMENTE localhost.
// POST /api/logs { nivel?, origem?, mensagem, detalhe? }
// (ip é sempre o da conexão; validação espelha os limites do logger em arquivo)
export async function registrarLog(req, res) {
  if (!exigirLocal(req, res)) return;
  const { nivel, origem, mensagem, detalhe } = req.body || {};
  if (typeof mensagem !== 'string' || !mensagem.trim() || mensagem.length > 500) {
    return res.status(400).json({ ok: false, motivo: 'Mensagem inválida.' });
  }
  const nv = nivel === 'INFO' ? 'INFO' : 'ERRO';
  let supa;
  try {
    supa = getSupabaseAdmin();
  } catch (e) {
    if (e.code === 'E_NO_SUPABASE') {
      return res.status(503).json({ ok: false, motivo: 'Serviço indisponível. Tente novamente em instantes.' });
    }
    throw e;
  }
  try {
    const { error } = await supa.from('tblogs').insert({
      nivel: nv,
      origem: typeof origem === 'string' ? origem.slice(0, 120) : '',
      mensagem: mensagem.trim(),
      detalhe: typeof detalhe === 'string' ? detalhe.slice(0, 2000) : null,
      ip: req.ip || req.socket?.remoteAddress || 'unknown',
      criado_em: new Date().toISOString()
    });
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    logErro('logs registrar falhou', err.message, {
      origem: '/api/logs',
      ip: req.ip || req.socket?.remoteAddress || 'unknown'
    });
    return res.status(502).json({ ok: false, motivo: 'Não foi possível gravar. Tente novamente.' });
  }
}
