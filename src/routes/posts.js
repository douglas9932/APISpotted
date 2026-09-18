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
      .select('id, mensagem, imagem_url, ip, cidade, estado, pais, user_agent, criado_em, codigo, excluido')
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

export async function listarRejeitados(req, res) {
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
    const [rPosts, rRejeitados] = await Promise.all([
      supa
        .from('tbposts')
        .select('id, mensagem, imagem_url, ip, cidade, estado, pais, user_agent, criado_em, codigo, excluido')
        .eq('liberado_para_postar', false)
        .order('criado_em', { ascending: false })
        .limit(100),
      supa
        .from('tbposts_rejeitados')
        .select('id, mensagem, imagem_url, criado_em, motivo_recusa')
        .order('criado_em', { ascending: false })
        .limit(100)
    ]);
    if (rPosts.error) throw rPosts.error;
    if (rRejeitados.error) throw rRejeitados.error;

    const posts = (rPosts.data || []).map((p) => ({
      ...p,
      id: String(p.id),
      origem: 'tbposts',
      motivo_recusa: null
    }));
    const rejeitados = (rRejeitados.data || []).map((p) => ({
      ...p,
      id: String(p.id),
      origem: 'tbposts_rejeitados',
      ip: null,
      cidade: null,
      estado: null,
      pais: null,
      user_agent: null,
      codigo: null
    }));

    const todos = [...posts, ...rejeitados].sort((a, b) => {
      const da = a.criado_em ? new Date(a.criado_em).getTime() : 0;
      const db = b.criado_em ? new Date(b.criado_em).getTime() : 0;
      return db - da;
    }).slice(0, 100);

    return res.json({ ok: true, posts: todos });
  } catch (err) {
    logErro('posts rejeitados falhou', err.message, ctx(req, '/api/posts-rejeitados'));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível carregar. Tente novamente.' });
  }
}

export async function listarLiberados(req, res) {
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
    let resp = await supa
      .from('tbposts')
      .select('id, mensagem, imagem_url, ip, cidade, estado, pais, user_agent, criado_em, codigo, excluido')
      .eq('liberado_para_postar', true)
      .eq('postado', false)
      .order('criado_em', { ascending: false })
      .limit(100);
    if (resp.error && resp.error.code === '42703' && String(resp.error.message).includes('excluido')) {
      resp = await supa
        .from('tbposts')
        .select('id, mensagem, imagem_url, ip, cidade, estado, pais, user_agent, criado_em, codigo')
        .eq('liberado_para_postar', true)
        .eq('postado', false)
        .order('criado_em', { ascending: false })
        .limit(100);
    }
    if (resp.error) throw resp.error;
    return res.json({ ok: true, posts: resp.data || [] });
  } catch (err) {
    logErro('posts liberados falhou', err.message, ctx(req, '/api/posts-liberados'));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível carregar. Tente novamente.' });
  }
}

export async function listarPublicados(req, res) {
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
    let query = supa
      .from('tbposts')
      .select('id, mensagem, imagem_url, ip, cidade, estado, pais, user_agent, criado_em, codigo, instagram_id, excluido')
      .eq('postado', true)
      .order('codigo', { ascending: false })
      .limit(100);
    if (typeof q.busca === 'string' && q.busca.trim()) {
      const termo = q.busca.trim().slice(0, 120).replace(/[%*,()]/g, '');
      query = query.or(`mensagem.ilike.%${termo}%,codigo.ilike.%${termo}%`);
    }
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ ok: true, posts: data || [] });
  } catch (err) {
    logErro('posts publicados falhou', err.message, ctx(req, '/api/posts-publicados'));
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

// Atribui o próximo código (último + 1, 6 casas) se o post ainda não tiver.
// Idempotente e seguro em corrida (update condicional + retry em 23505).
// Retorna o código ou null se a linha não existir.
async function atribuirCodigo(supa, id) {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const atual = await supa.from('tbposts').select('codigo').eq('id', id).limit(1);
    if (atual.error) throw atual.error;
    if (!atual.data || !atual.data.length) return null;
    if (atual.data[0].codigo) return atual.data[0].codigo;
    const ultimo = await supa.from('tbposts')
      .select('codigo')
      .not('codigo', 'is', null)
      .order('codigo', { ascending: false })
      .limit(1);
    if (ultimo.error) throw ultimo.error;
    const max = ultimo.data && ultimo.data[0] && /^\d+$/.test(ultimo.data[0].codigo || '')
      ? parseInt(ultimo.data[0].codigo, 10)
      : 0;
    const proximo = String(max + 1).padStart(6, '0');
    const rUp = await supa.from('tbposts')
      .update({ codigo: proximo })
      .eq('id', id)
      .is('codigo', null)
      .select('id');
    if (rUp.error) {
      if (rUp.error.code === '23505' && tentativa < 2) continue; // corrida: recalcula
      throw rUp.error;
    }
    if (rUp.data && rUp.data.length) return proximo;
    // outro escritor resolveu no meio: relê o código final
    const rel = await supa.from('tbposts').select('codigo').eq('id', id).limit(1);
    if (rel.error) throw rel.error;
    return (rel.data && rel.data[0] && rel.data[0].codigo) || null;
  }
  return null;
}

export async function reservarCodigo(req, res) {
  if (!exigirLocal(req, res)) return;
  const { id } = req.params;
  if (typeof id !== 'string' || !UUID.test(id)) {
    return res.status(400).json({ ok: false, motivo: 'ID inválido.' });
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
    const codigo = await atribuirCodigo(supa, id);
    if (!codigo) {
      return res.status(404).json({ ok: false, motivo: 'Post não encontrado.' });
    }
    return res.json({ ok: true, codigo });
  } catch (err) {
    logErro('posts reservar falhou', err.message, ctx(req, '/api/posts/:id/reservar-codigo'));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível reservar. Tente novamente.' });
  }
}

export async function marcarPostado(req, res) {
  if (!exigirLocal(req, res)) return;
  const { id } = req.params;
  if (typeof id !== 'string' || !UUID.test(id)) {
    return res.status(400).json({ ok: false, motivo: 'ID inválido.' });
  }
  const { postado, instagram_id } = req.body || {};
  if (typeof postado !== 'boolean') {
    return res.status(400).json({ ok: false, motivo: 'Informe postado: true|false.' });
  }
  // instagram_id opcional (ID da mídia na Graph API); só texto curto
  if (instagram_id !== undefined && instagram_id !== null &&
      (typeof instagram_id !== 'string' || !instagram_id.trim() || instagram_id.length > 120)) {
    return res.status(400).json({ ok: false, motivo: 'instagram_id inválido.' });
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
    // Ao publicar (postado=true): garante o código (reserva antecipada ou aqui)
    // e grava postado (+ instagram_id opcional).
    let codigo = null;
    if (postado) {
      codigo = await atribuirCodigo(supa, id);
      const patchPub = { postado: true };
      if (typeof instagram_id === 'string' && instagram_id.trim()) {
        patchPub.instagram_id = instagram_id.trim();
      }
      const { data, error } = await supa.from('tbposts').update(patchPub).eq('id', id).select('id');
      if (error) throw error;
      if (!data || !data.length) {
        return res.status(404).json({ ok: false, motivo: 'Post não encontrado.' });
      }
      return res.json({ ok: true, codigo });
    }
    // Ao despublicar/excluir (postado=false): limpa instagram_id e impede reenvio
    const patchOff = { postado: false, instagram_id: null, liberado_para_postar: false };
    let excluidoOk = false;
    try {
      const test = await supa.from('tbposts').update({ ...patchOff, excluido: true }).eq('id', id).select('id');
      if (!test.error) {
        excluidoOk = true;
        if (!test.data || !test.data.length) {
          return res.status(404).json({ ok: false, motivo: 'Post não encontrado.' });
        }
        return res.json({ ok: true });
      }
      if (test.error && test.error.code !== '42703' && !String(test.error.message).includes('excluido')) throw test.error;
    } catch (e) {
      if (e.code !== '42703' && !String(e.message || '').includes('excluido')) throw e;
    }
    if (excluidoOk) return res.json({ ok: true });
    const { data, error } = await supa
      .from('tbposts')
      .update(patchOff)
      .eq('id', id)
      .select('id');
    if (error) throw error;
    if (!data || !data.length) {
      return res.status(404).json({ ok: false, motivo: 'Post não encontrado.' });
    }
    return res.json({ ok: true });
  } catch (err) {
    logErro('posts postado falhou', err.message, ctx(req, '/api/posts/:id/postado'));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível salvar. Tente novamente.' });
  }
}
