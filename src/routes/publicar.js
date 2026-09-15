import { randomUUID } from 'node:crypto';
import { validateWithAI } from '../lib/ai.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logErro } from '../lib/logger.js';

// Correção F1: publicação sai do browser e passa pelo servidor com service-role.
// O front NÃO fala mais com tbposts/storage diretamente.
// Erro de IA aqui NÃO publica (fail-closed); detalhe interno só no log (F7).

const MAX_MENSAGEM = 1000;
const MAX_IMAGEM_BYTES = 5 * 1024 * 1024;
const TIPOS_PERMITIDOS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif'
};

// rate-limit próprio da rota: 3/minuto + 10/hora por IP (F2 no servidor)
const MIN_WINDOW = 60_000;
const HOUR_WINDOW = 3600_000;
const seen = new Map();
function RATE_EXCEDIDO(ip) {
  const now = Date.now();
  const arr = (seen.get(ip) || []).filter((t) => now - t < HOUR_WINDOW);
  const noMinuto = arr.filter((t) => now - t < MIN_WINDOW).length;
  if (noMinuto >= 3 || arr.length >= 10) return true;
  arr.push(now);
  seen.set(ip, arr);
  return false;
}

function ASSINATURA_OK(buf, tipo) {
  if (tipo === 'image/png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (tipo === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (tipo === 'image/gif') return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
  return false;
}

function FALHA(status, motivo) {
  return { status, body: { ok: false, motivo } };
}

export async function publicar(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  if (RATE_EXCEDIDO(ip)) {
    return res.status(429).json({ ok: false, motivo: 'Limite de publicações atingido. Aguarde e tente novamente.' });
  }

  const { mensagem, imagem, cidade, estado, pais, user_agent } = req.body || {};

  if (typeof mensagem !== 'string' || !mensagem.trim()) {
    return res.status(400).json(FALHA(400, 'Mensagem é obrigatória').body);
  }
  if (mensagem.trim().length > MAX_MENSAGEM) {
    return res.status(400).json({ ok: false, motivo: 'Mensagem excede o limite de 1000 caracteres' });
  }

  // 1) moderação por IA — ERRO não bloqueia: grava p/ revisão humana.
  // Rejeição (mensagemvalida:false) continua bloqueando.
  let ai = null;
  let iaIndisponivel = false;
  try {
    ai = await validateWithAI(mensagem.trim());
  } catch (err) {
    // motivo detalhado só no log do servidor (nunca na resposta — F7)
    logErro('AI validation error on /api/publicar', err.message);
    iaIndisponivel = true;
  }
  if (ai && !ai.mensagemvalida) {
    return res.status(200).json({ ok: false, motivo: ai.motivorecusa || 'Sua mensagem não atende às diretrizes da comunidade.' });
  }
  const necessitaValidacao = iaIndisponivel || ai?.suspeita === true;

  // 2) imagem opcional — validada no servidor (tipo, tamanho, assinatura)
  let imagemUrl = null;
  if (imagem !== undefined && imagem !== null) {
    const tipo = imagem?.contentType;
    const ext = TIPOS_PERMITIDOS[tipo];
    if (!ext || typeof imagem?.data !== 'string') {
      return res.status(400).json({ ok: false, motivo: 'Formato de imagem não suportado. Use PNG, JPG ou GIF.' });
    }
    let buf;
    try {
      buf = Buffer.from(imagem.data, 'base64');
    } catch {
      return res.status(400).json({ ok: false, motivo: 'Imagem inválida.' });
    }
    if (buf.length === 0 || buf.length > MAX_IMAGEM_BYTES) {
      return res.status(400).json({ ok: false, motivo: 'A imagem excede o limite de 5 MB.' });
    }
    if (!ASSINATURA_OK(buf, tipo)) {
      return res.status(400).json({ ok: false, motivo: 'O arquivo não é uma imagem válida.' });
    }

    let supa;
    try {
      supa = getSupabaseAdmin();
    } catch (e) {
      if (e.code === 'E_NO_SUPABASE') {
        return res.status(503).json({ ok: false, motivo: 'Serviço de publicação indisponível. Tente novamente em instantes.' });
      }
      logErro('unexpected error on /api/publicar', e.message);
      return res.status(500).json({ ok: false, motivo: 'Erro inesperado. Tente novamente.' });
    }
    const nome = `${randomUUID()}.${ext}`;
    let upErr = null;
    try {
      ({ error: upErr } = await supa.storage.from('posts').upload(nome, buf, { contentType: tipo, upsert: false }));
    } catch {
      logErro('storage upload failed on /api/publicar');
      return res.status(502).json({ ok: false, motivo: 'Não foi possível enviar a imagem. Tente novamente.' });
    }
    if (upErr) {
      logErro('storage upload failed on /api/publicar');
      return res.status(502).json({ ok: false, motivo: 'Não foi possível enviar a imagem. Tente novamente.' });
    }
    imagemUrl = supa.storage.from('posts').getPublicUrl(nome).data.publicUrl;
  }

  // 3) insert com service-role; IP é o da conexão (nunca o informado pelo cliente — F2)
  let supa;
  try {
    supa = getSupabaseAdmin();
  } catch (e) {
    if (e.code === 'E_NO_SUPABASE') {
      return res.status(503).json({ ok: false, motivo: 'Serviço de publicação indisponível. Tente novamente em instantes.' });
    }
    logErro('unexpected error on /api/publicar', e.message);
    return res.status(500).json({ ok: false, motivo: 'Erro inesperado. Tente novamente.' });
  }
  let insErr = null;
  try {
    const rIns = await supa.from('tbposts').insert({
      mensagem: mensagem.trim(),
      imagem_url: imagemUrl,
      ip,
      cidade: typeof cidade === 'string' ? cidade.slice(0, 120) : null,
      estado: typeof estado === 'string' ? estado.slice(0, 120) : null,
      pais: typeof pais === 'string' ? pais.slice(0, 120) : null,
      user_agent: typeof user_agent === 'string' ? user_agent.slice(0, 300) : null,
      criado_em: new Date().toISOString(),
      necessita_validacao: necessitaValidacao
    });
    insErr = rIns.error;
  } catch {
    logErro('tbposts insert failed on /api/publicar');
    return res.status(502).json({ ok: false, motivo: 'Não foi possível salvar sua publicação. Tente novamente.' });
  }
  if (insErr) {
    logErro('tbposts insert failed on /api/publicar');
    return res.status(502).json({ ok: false, motivo: 'Não foi possível salvar sua publicação. Tente novamente.' });
  }

  return res.status(201).json({
    ok: true,
    necessita_validacao: necessitaValidacao,
    ...(iaIndisponivel ? { aviso: 'Não foi possível validar pela IA; sua mensagem será validada pelo responsável.' } : {})
  });
}
