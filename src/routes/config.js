import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { exigirLocal } from '../lib/adminAuth.js';
import { criptografarChave, descriptografarChave } from '../lib/crypto.js';
import { TIPOS_PERMITIDOS, ASSINATURA_OK, MAX_IMAGEM_BYTES } from './publicar.js';
import { logErro } from '../lib/logger.js';

// Configuração global (tbconfiguracoes, SEMPRE 1 linha id=1) — SOMENTE localhost.
// Token do Instagram chega em claro, é criptografado em memória; a imagem
// padrão chega em base64 validado (tipo/tamanho/assinatura, como publicar).
// GET nunca retorna segredo (só tem_token) — a imagem volta em data URL,
// pois a tela precisa exibi-la.

function ctx(req) {
  return { origem: '/api/configuracoes', ip: req.ip || req.socket?.remoteAddress || 'unknown' };
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

async function lerLinha(supa) {
  const { data, error } = await supa
    .from('tbconfiguracoes')
    .select('id, instagram_token_enc, imagem_padrao_base64, imagem_padrao_content_type, atualizado_em')
    .eq('id', 1)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

export async function obterConfig(req, res) {
  if (!exigirLocal(req, res)) return;
  const supa = supaOu503(res);
  if (!supa) return;
  try {
    const linha = await lerLinha(supa);
    return res.json({
      ok: true,
      configuracoes: {
        tem_token: !!(linha && linha.instagram_token_enc),
        tem_imagem: !!(linha && linha.imagem_padrao_base64),
        imagem_content_type: (linha && linha.imagem_padrao_content_type) || null,
        imagem_data_url: linha && linha.imagem_padrao_base64
          ? `data:${linha.imagem_padrao_content_type || 'image/png'};base64,${linha.imagem_padrao_base64}`
          : null,
        atualizado_em: (linha && linha.atualizado_em) || null
      }
    });
  } catch (err) {
    logErro('config obter falhou', err.message, ctx(req));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível carregar. Tente novamente.' });
  }
}

export async function obterTokenConfig(req, res) {
  if (!exigirLocal(req, res)) return;
  if (!process.env.IA_MASTER_KEY) {
    return res.status(503).json({ ok: false, motivo: 'IA_MASTER_KEY não configurada no servidor.' });
  }
  const supa = supaOu503(res);
  if (!supa) return;
  try {
    const linha = await lerLinha(supa);
    const enc = linha && linha.instagram_token_enc;
    if (!enc) {
      return res.status(404).json({ ok: false, motivo: 'Nenhum token cadastrado.' });
    }
    return res.json({ ok: true, token: descriptografarChave(enc) });
  } catch (err) {
    logErro('config obter token falhou', err.message, ctx(req));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível obter o token. Verifique a IA_MASTER_KEY.' });
  }
}

export async function salvarConfig(req, res) {
  if (!exigirLocal(req, res)) return;
  const { token, imagem_data, imagem_content_type } = req.body || {};
  const patch = {};
  let confereToken = null;
  let concorrente = null;
  let cipher = null;
  let imagemBytes = null;

  // token: null limpa | string não-vazia criptografa | undefined mantém
  if (token !== undefined) {
    if (token !== null) {
      if (typeof token !== 'string' || !token.trim() || token.length > 500) {
        return res.status(400).json({ ok: false, motivo: 'Token inválido.' });
      }
      if (!process.env.IA_MASTER_KEY) {
        return res.status(503).json({ ok: false, motivo: 'IA_MASTER_KEY não configurada no servidor.' });
      }
      cipher = criptografarChave(token.trim());
      patch.instagram_token_enc = cipher;
    } else {
      patch.instagram_token_enc = null;
    }
  }

  // imagem: null limpa | {data+contentType} valida e grava | undefined mantém
  if (imagem_data !== undefined || imagem_content_type !== undefined) {
    if (imagem_data === null || imagem_content_type === null) {
      if (imagem_data !== null || imagem_content_type !== null) {
        return res.status(400).json({ ok: false, motivo: 'Envie imagem_data e imagem_content_type juntos (ou ambos null).' });
      }
      patch.imagem_padrao_base64 = null;
      patch.imagem_padrao_content_type = null;
    } else {
      const ext = TIPOS_PERMITIDOS[imagem_content_type];
      if (!ext || typeof imagem_data !== 'string') {
        return res.status(400).json({ ok: false, motivo: 'Formato de imagem não suportado. Use PNG, JPG ou GIF.' });
      }
      let buf;
      try {
        buf = Buffer.from(imagem_data, 'base64');
      } catch {
        return res.status(400).json({ ok: false, motivo: 'Imagem inválida.' });
      }
      if (buf.length === 0 || buf.length > MAX_IMAGEM_BYTES) {
        return res.status(400).json({ ok: false, motivo: 'A imagem excede o limite de 5 MB.' });
      }
      if (!ASSINATURA_OK(buf, imagem_content_type)) {
        return res.status(400).json({ ok: false, motivo: 'O arquivo não é uma imagem válida.' });
      }
      patch.imagem_padrao_base64 = imagem_data;
      patch.imagem_padrao_content_type = imagem_content_type;
      imagemBytes = buf.length;
    }
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({ ok: false, motivo: 'Nada para atualizar.' });
  }
  patch.atualizado_em = new Date().toISOString();

  const supa = supaOu503(res);
  if (!supa) return;
  try {
    // update; se a linha seed ainda não existir, insere id=1
    const rUp = await supa.from('tbconfiguracoes').update(patch).eq('id', 1).select('id');
    if (rUp.error) throw rUp.error;
    if (!rUp.data || !rUp.data.length) {
      const rIns = await supa.from('tbconfiguracoes').insert({ id: 1, ...patch }).select('id');
      if (rIns.error) throw rIns.error;
    }
    // conferência do token (round-trip), quando alterado para valor.
    // Compara também o ciphertext: se mudou entre gravar e reler, houve
    // escrita concorrente (outra sessão/aba salvando ao mesmo tempo).
    if (patch.instagram_token_enc) {
      const linha = await lerLinha(supa);
      const volta = linha && linha.instagram_token_enc;
      if (!volta) {
        concorrente = 'apagado';
        confereToken = false;
      } else if (volta !== cipher) {
        concorrente = 'sobrescrito';
        confereToken = false;
      } else {
        confereToken = descriptografarChave(volta) === token.trim();
      }
    } else if ('instagram_token_enc' in patch) {
      confereToken = false;
    }
    return res.json({ ok: true, token_conferido: confereToken, concorrente, imagem_bytes: imagemBytes });
  } catch (err) {
    logErro('config salvar falhou', err.message, ctx(req));
    return res.status(502).json({ ok: false, motivo: 'Não foi possível salvar. Tente novamente.' });
  }
}
