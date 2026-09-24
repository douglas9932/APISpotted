import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { exigirLocal } from '../lib/adminAuth.js';
import { TIPOS_PERMITIDOS, ASSINATURA_OK, MAX_IMAGEM_BYTES } from './publicar.js';
import { logErro } from '../lib/logger.js';

// Hospedagem temporária para publicação no Instagram.
// O painel web (browser/celular) não consegue usar os hosts gratuitos
// (img402/picrd/imgpile) por bloqueio de CORS, então o servidor hospeda a
// imagem montada no bucket `posts` sob staging/ e devolve a URL pública para
// a Graph API. Após publicar, o painel apaga o arquivo (DELETE).
// Validação idêntica à de /api/publicar (tipo/tamanho/assinatura).

function ctx(req) {
  return { origem: '/api/upload-imagem', ip: req.ip || req.socket?.remoteAddress || 'unknown' };
}

function validar(imagemData, imagemContentType) {
  const ext = TIPOS_PERMITIDOS[imagemContentType];
  if (!ext || typeof imagemData !== 'string') {
    return { erro: 'Formato de imagem não suportado. Use PNG, JPG ou GIF.' };
  }
  let buf;
  try {
    buf = Buffer.from(imagemData, 'base64');
  } catch {
    return { erro: 'Imagem inválida.' };
  }
  if (buf.length === 0 || buf.length > MAX_IMAGEM_BYTES) {
    return { erro: 'A imagem excede o limite de 5 MB.' };
  }
  if (!ASSINATURA_OK(buf, imagemContentType)) {
    return { erro: 'O arquivo não é uma imagem válida.' };
  }
  return { buf, ext };
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

export async function uploadStaging(req, res) {
  if (!exigirLocal(req, res)) return;
  const { imagem_data, imagem_content_type } = req.body || {};
  const v = validar(imagem_data, imagem_content_type);
  if (v.erro) {
    return res.status(400).json({ ok: false, motivo: v.erro });
  }
  const supa = supaOu503(res);
  if (!supa) return;
  try {
    const nome = `staging/${randomUUID()}.${v.ext}`;
    const { error: upErr } = await supa.storage
      .from('posts')
      .upload(nome, v.buf, { contentType: imagem_content_type, upsert: false });
    if (upErr) throw upErr;
    const url = supa.storage.from('posts').getPublicUrl(nome).data.publicUrl;
    return res.status(201).json({ ok: true, url, path: nome });
  } catch (err) {
    logErro('staging upload falhou', err.message, ctx(req));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível hospedar a imagem. Tente novamente.' });
  }
}

export async function excluirStaging(req, res) {
  if (!exigirLocal(req, res)) return;
  const { path } = req.body || {};
  // Trava de segurança: só apaga dentro de staging/ (nunca post do usuário).
  if (typeof path !== 'string' || !path.startsWith('staging/') || path.length > 200 || path.includes('..')) {
    return res.status(400).json({ ok: false, motivo: 'Path inválido.' });
  }
  const supa = supaOu503(res);
  if (!supa) return;
  try {
    const { error } = await supa.storage.from('posts').remove([path]);
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    logErro('staging excluir falhou', err.message, ctx(req));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível remover.' });
  }
}
