import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { exigirLocal } from '../lib/adminAuth.js';
import { logErro } from '../lib/logger.js';

// Moderação de posts (tbposts) — SEM token, SOMENTE localhost (ver adminAuth).
// Pendentes: necessita_validacao=true E liberado_para_postar IS NULL E postado=false.
// Permitir => liberado_para_postar=true | Recusar => false.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ctx(req, origem) {
  return { origem, ip: req.ip || req.socket?.remoteAddress || 'unknown' };
}

export async function listarPendentes(req, res) {
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
    const { data, error } = await supa
      .from('tbposts')
      .select('id, mensagem, imagem_url, ip, cidade, estado, pais, user_agent, criado_em, codigo')
      .eq('necessita_validacao', true)
      .is('liberado_para_postar', null)
      .eq('postado', false)
      .order('criado_em', { ascending: false })
      .limit(100);
    if (error) throw error;
    return res.json({ ok: true, posts: data || [] });
  } catch (err) {
    logErro('posts pendentes falhou', err.message, ctx(req, '/api/posts-pendentes'));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível carregar. Tente novamente.' });
  }
}

export async function liberarPost(req, res) {
  if (!exigirLocal(req, res)) return;
  const { id } = req.params;
  if (typeof id !== 'string' || !UUID.test(id)) {
    return res.status(400).json({ ok: false, motivo: 'ID inválido.' });
  }
  const { liberado } = req.body || {};
  if (typeof liberado !== 'boolean') {
    return res.status(400).json({ ok: false, motivo: 'Informe liberado: true|false.' });
  }
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
    const { data, error } = await supa
      .from('tbposts')
      .update({ liberado_para_postar: liberado })
      .eq('id', id)
      .select('id');
    if (error) throw error;
    if (!data || !data.length) {
      return res.status(404).json({ ok: false, motivo: 'Post não encontrado.' });
    }
    return res.json({ ok: true });
  } catch (err) {
    logErro('posts liberar falhou', err.message, ctx(req, '/api/posts/:id/liberar'));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível salvar. Tente novamente.' });
  }
}
