import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logErro } from '../lib/logger.js';
import { enviarPushParaUsuario } from '../lib/push.js';

// Push FCM (tbdispositivos_push, docs/add-notificacoes-push.sql).
// POST /api/notificacoes/dispositivo — registra/atualiza aparelho (upsert).
// POST /api/notificacoes/enviar — envia p/ tokens ativos do usuário.
// DELETE /api/notificacoes/dispositivo — desativa aparelho (soft).
// Aberto (celular não é localhost): valida formato + rate-limit por IP.

const PLATAFORMAS = ['ANDROID', 'IOS'];
const MIN_JANELA = 60_000;
const MAX_DISP_MIN = 10;
const MAX_ENV_MIN = 30;
const vistoDisp = new Map();
const vistoEnv = new Map();

function taxaOk(mapa, ip, max) {
  const agora = Date.now();
  const arr = (mapa.get(ip) || []).filter((t) => agora - t < MIN_JANELA);
  if (arr.length >= max) return false;
  arr.push(agora);
  mapa.set(ip, arr);
  return true;
}

function ctx(req, rota) {
  return { origem: rota, ip: req.ip || req.socket?.remoteAddress || 'unknown' };
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

function texto(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export async function registrarDispositivo(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!taxaOk(vistoDisp, ip, MAX_DISP_MIN)) {
    return res.status(429).json({ ok: false, motivo: 'Muitas tentativas. Aguarde e tente novamente.' });
  }
  const { usuarioId, token, plataforma, modelo, versaoApp } = req.body || {};
  const usuario = texto(usuarioId, 120) || 'moderador';
  if (typeof token !== 'string' || token.trim().length < 10 || token.trim().length > 500) {
    return res.status(400).json({ ok: false, motivo: 'Token inválido.' });
  }
  const plat = texto(plataforma, 20).toUpperCase() || 'ANDROID';
  if (!PLATAFORMAS.includes(plat)) {
    return res.status(400).json({ ok: false, motivo: 'Plataforma inválida.' });
  }
  const supa = supaOu503(res);
  if (!supa) return;
  try {
    const { error } = await supa.from('tbdispositivos_push').upsert(
      {
        id_usuario: usuario,
        token: token.trim(),
        plataforma: plat,
        modelo: texto(modelo, 120) || null,
        versao_app: texto(versaoApp, 40) || null,
        data_ultima_atualizacao: new Date().toISOString(),
        ativo: true
      },
      { onConflict: 'id_usuario,token' }
    );
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    logErro('notificacoes registrar falhou', err.message, ctx(req, '/api/notificacoes/dispositivo'));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível registrar. Tente novamente.' });
  }
}

export async function removerDispositivo(req, res) {
  const { usuarioId, token } = req.body || {};
  const usuario = texto(usuarioId, 120) || 'moderador';
  if (typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ ok: false, motivo: 'Token inválido.' });
  }
  const supa = supaOu503(res);
  if (!supa) return;
  try {
    const { error } = await supa.from('tbdispositivos_push')
      .update({ ativo: false, data_ultima_atualizacao: new Date().toISOString() })
      .eq('id_usuario', usuario)
      .eq('token', token.trim());
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    logErro('notificacoes remover falhou', err.message, ctx(req, '/api/notificacoes/dispositivo'));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível remover. Tente novamente.' });
  }
}

export async function enviarNotificacao(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!taxaOk(vistoEnv, ip, MAX_ENV_MIN)) {
    return res.status(429).json({ ok: false, motivo: 'Muitas tentativas. Aguarde e tente novamente.' });
  }
  const { usuarioId, titulo, mensagem, dados } = req.body || {};
  const usuario = texto(usuarioId, 120);
  const tit = texto(titulo, 200);
  const msg = texto(mensagem, 500);
  if (!usuario) {
    return res.status(400).json({ ok: false, motivo: 'usuarioId é obrigatório.' });
  }
  if (!tit || !msg) {
    return res.status(400).json({ ok: false, motivo: 'titulo e mensagem são obrigatórios.' });
  }
  const supa = supaOu503(res);
  if (!supa) return;
  try {
    const r = await enviarPushParaUsuario(usuario, tit, msg, dados);
    return res.json({ ok: true, enviados: r.enviados, falhas: r.falhas });
  } catch (err) {
    logErro('notificacoes enviar falhou', err.message, ctx(req, '/api/notificacoes/enviar'));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível enviar. Verifique a credencial FCM no servidor.' });
  }
}
