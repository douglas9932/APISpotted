import { randomUUID } from 'node:crypto';
import { validateWithAI } from '../lib/ai.js';
import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { logErro } from '../lib/logger.js';

// Correção F1: publicação sai do browser e passa pelo servidor com service-role.
// O front NÃO fala mais com tbposts/storage diretamente.
// Erro de IA aqui NÃO publica (fail-closed); detalhe interno só no log (F7).

const MAX_MENSAGEM = 600;
const MAX_IMAGEM_BYTES = 5 * 1024 * 1024;
export { MAX_IMAGEM_BYTES };
export const TIPOS_PERMITIDOS = {
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

export function ASSINATURA_OK(buf, tipo) {
  if (tipo === 'image/png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (tipo === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (tipo === 'image/gif') return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
  return false;
}

function FALHA(status, motivo) {
  return { status, body: { ok: false, motivo } };
}

// Resumo técnico do erro para o moderador (até 220 chars, uma linha).
// Seguro: motivo_validacao é lido só pela moderação (não volta ao usuário — F7).
// Higieniza possíveis segredos e o log completo continua no tblogs.
function RESUMO_ERRO_IA(iaErro) {
  let t = String(iaErro?.message || iaErro || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  t = t.replace(/sk-[A-Za-z0-9-_]{10,}/g, '[chave-oculta]').replace(/Bearer\s+\S+/gi, 'Bearer [oculto]');
  return t.slice(0, 220) || null;
}

// Classifica o erro da IA em causa curta e amigável para o moderador.
// O detalhe bruto completo fica SÓ no log/tblogs (F7).
function CAUSA_IA(iaErro) {
  const t = String(iaErro?.message || iaErro || '');
  const ms = /(\d+)\s*ms/i.exec(t);
  const dur = ms ? ` (${Math.round(Number(ms[1]) / 1000)}s)` : '';
  if (/timeout após|timed out|timeouterror|abort/i.test(t)) return `Tempo esgotado na IA${dur}`;
  if (/credit|billing|balance|insufficient/i.test(t)) return 'Créditos da IA esgotados';
  if (/\b401\b|unauthorized|authentication/i.test(t)) return 'Falha de autenticação na IA';
  if (/\b429\b|rate.?limit|quota|resource.?exhausted/i.test(t)) return 'Limite da IA excedido';
  if (/high demand|overloaded|overload|try again later|capacity|temporar/i.test(t)) return 'IA sobrecarregada (demanda alta, temporário)';
  if (/\b402\b|payment/i.test(t)) return 'Pagamento da IA pendente';
  if (/\b400\b|invalid|not.?found/i.test(t)) return 'Configuração da IA inválida (modelo/parâmetros)';
  if (/\b5\d\d\b|fetch failed|network|econn|enotfound|etimedout|eai_again|socket hang/i.test(t)) return 'Erro temporário/falha de comunicação com a IA';
  if (/tbias inacessível|nenhuma ia em uso/i.test(t)) return 'IA não configurada';
  return 'Falha na IA';
}

// motivo_validacao (tbposts.motivo_validacao): OBRIGATÓRIO sempre que
// necessita_validacao=true (CHECK chk_tbposts_motivo_validacao).
// Origens: imagem | IA indisponível (causa classificada) | suspeita da IA (com motivo_suspeita).
function MOTIVO_VALIDACAO({ temImagem, iaIndisponivel, ai, iaErro }) {
  const motivos = [];
  if (temImagem) motivos.push('Contém imagem — revisão humana obrigatória (IA não analisa imagem).');
  if (iaIndisponivel) {
    const resumo = RESUMO_ERRO_IA(iaErro);
    motivos.push(`${CAUSA_IA(iaErro)} — revisão humana.${resumo ? ` Detalhe: ${resumo}` : ''}`);
  }
  if (ai?.suspeita === true) {
    const m = typeof ai?.motivo_suspeita === 'string' ? ai.motivo_suspeita.trim().slice(0, 500) : '';
    motivos.push(m || 'Sinalizado como suspeito pela IA — revisão humana.');
  }
  if (!motivos.length) return null;
  return motivos.join(' | ').slice(0, 500);
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
    return res.status(400).json({ ok: false, motivo: 'Mensagem excede o limite de 600 caracteres' });
  }

  // Com imagem, pula a IA: ela não enxerga imagem, então vai direto p/ revisão humana.
  const temImagem = imagem !== undefined && imagem !== null;

  // 1) moderação por IA (só texto puro) — ERRO não bloqueia: grava p/ revisão humana.
  // Rejeição (mensagemvalida:false) continua bloqueando.
  let ai = null;
  let iaIndisponivel = false;
  let iaErro = null;
  if (!temImagem) {
    try {
      ai = await validateWithAI(mensagem.trim());
    } catch (err) {
      // motivo detalhado só no log do servidor (nunca na resposta — F7)
      logErro('AI validation error on /api/publicar', err.message, { origem: '/api/publicar', ip });
      iaIndisponivel = true;
      iaErro = err;
    }
  }
  if (ai && !ai.mensagemvalida) {
    const motivoRecusa = ai.motivorecusa || 'Sua mensagem não atende às diretrizes da comunidade.';
    // Auditoria best-effort: registra a recusa da IA em tbposts_rejeitados
    // (mensagem + motivo_recusa). Falha aqui nunca muda a resposta —
    // a mensagem segue recusada; só loga.
    try {
      const supaAud = getSupabaseAdmin();
      const { error: audErr } = await supaAud.from('tbposts_rejeitados').insert({
        mensagem: mensagem.trim(),
        imagem_url: null,
        motivo_recusa: String(motivoRecusa).slice(0, 500),
        criado_em: new Date().toISOString()
      });
      if (audErr) logErro('tbposts_rejeitados insert falhou (recusa IA)', audErr.message, { origem: '/api/publicar', ip });
    } catch (e) {
      logErro('tbposts_rejeitados insert falhou (recusa IA)', e.message, { origem: '/api/publicar', ip });
    }
    return res.status(200).json({ ok: false, motivo: motivoRecusa });
  }
  const necessitaValidacao = temImagem || iaIndisponivel || ai?.suspeita === true;
  // Fail-safe: nunca gravar necessita=true sem motivo (violação do CHECK derrubaria o insert)
  let motivoValidacao = MOTIVO_VALIDACAO({ temImagem, iaIndisponivel, ai, iaErro });
  if (necessitaValidacao && !motivoValidacao) motivoValidacao = 'Encaminhado para revisão humana.';
  if (!necessitaValidacao) motivoValidacao = null;

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
      logErro('unexpected error on /api/publicar', e.message, { origem: '/api/publicar', ip });
      return res.status(500).json({ ok: false, motivo: 'Erro inesperado. Tente novamente.' });
    }
    const nome = `${randomUUID()}.${ext}`;
    let upErr = null;
    try {
      ({ error: upErr } = await supa.storage.from('posts').upload(nome, buf, { contentType: tipo, upsert: false }));
    } catch {
      logErro('storage upload failed on /api/publicar', null, { origem: '/api/publicar', ip });
      return res.status(502).json({ ok: false, motivo: 'Não foi possível enviar a imagem. Tente novamente.' });
    }
    if (upErr) {
      logErro('storage upload failed on /api/publicar', null, { origem: '/api/publicar', ip });
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
      necessita_validacao: necessitaValidacao,
      motivo_validacao: motivoValidacao,
      // regra (docs/tbposts_liberado.sql): validacao=false => true; true => NULL
      liberado_para_postar: necessitaValidacao ? null : true
    });
    insErr = rIns.error;
  } catch {
    logErro('tbposts insert failed on /api/publicar', null, { origem: '/api/publicar', ip });
    return res.status(502).json({ ok: false, motivo: 'Não foi possível salvar sua publicação. Tente novamente.' });
  }
  if (insErr) {
    logErro('tbposts insert failed on /api/publicar', null, { origem: '/api/publicar', ip });
    return res.status(502).json({ ok: false, motivo: 'Não foi possível salvar sua publicação. Tente novamente.' });
  }

  const aviso = temImagem
    ? 'Sua mensagem contém imagem e será validada pelo responsável.'
    : (iaIndisponivel ? 'Não foi possível validar pela IA; sua mensagem será validada pelo responsável.' : null);
  // F7: motivo_validacao NÃO volta ao usuário (detalhe interno é só log/moderador).
  return res.status(201).json({
    ok: true,
    necessita_validacao: necessitaValidacao,
    ...(aviso ? { aviso } : {})
  });
}
