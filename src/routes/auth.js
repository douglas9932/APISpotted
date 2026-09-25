import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { verificarSenha } from '../lib/senha.js';
import { criarToken, verificarToken } from '../lib/sessao.js';
import { logErro } from '../lib/logger.js';

// Login do painel (tblogins) — POST /api/login { login, senha }.
// Resposta genérica (não revela se o login existe). Trava simples de
// força bruta: 10 tentativas/minuto por IP.

// Trava própria (a global criarRateLimit responde no formato de /api/validate)
const tentativas = new Map();
function RATE_EXCEDIDO(ip) {
  const now = Date.now();
  const arr = (tentativas.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  tentativas.set(ip, arr);
  return arr.length > 10;
}

export async function login(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (RATE_EXCEDIDO(ip)) {
    return res.status(429).json({ ok: false, motivo: 'Muitas tentativas. Aguarde um minuto e tente novamente.' });
  }
  const { login, senha } = req.body || {};
  if (typeof login !== 'string' || !login.trim() || typeof senha !== 'string' || !senha || login.length > 80 || senha.length > 200) {
    // genérico de propósito (não revela o que está errado)
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ ok: false, motivo: 'Login ou senha inválidos.' });
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
      .from('tblogins')
      .select('login, senha_hash, ativo')
      .eq('login', login.trim())
      .limit(1);
    if (error) throw error;
    const row = data && data[0];
    const confere = row && row.ativo && (await verificarSenha(senha, row.senha_hash));
    if (!confere) {
      await new Promise((r) => setTimeout(r, 400));
      return res.status(401).json({ ok: false, motivo: 'Login ou senha inválidos.' });
    }
    const sess = criarToken(row.login);
    return res.json({ ok: true, login: row.login, token: sess.token, expira_em: sess.expira_em });
  } catch (err) {
    logErro('login falhou', err.message, { origem: '/api/login', ip });
    return res.status(502).json({ ok: false, motivo: 'Não foi possível entrar. Tente novamente.' });
  }
}

// Validação da sessão (o painel chama ao abrir; 401 = volta p/ tela de login).
// GET /api/sessao — Authorization: Bearer <token>
export async function sessao(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const h = req.headers.authorization || '';
  const loginNome = verificarToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!loginNome) {
    return res.status(401).json({ ok: false, motivo: 'Sessão inválida ou expirada.' });
  }
  // Best-effort: login desativado/apagado no banco invalida o token.
  // Falha transitória no banco NÃO derruba a sessão (aceita pelo HMAC válido).
  try {
    const supa = getSupabaseAdmin();
    const { data } = await supa.from('tblogins').select('ativo').eq('login', loginNome).limit(1);
    if (data && (!data[0] || data[0].ativo === false)) {
      return res.status(401).json({ ok: false, motivo: 'Sessão inválida ou expirada.' });
    }
  } catch (err) {
    logErro('sessao lookup falhou', err.message, { origem: '/api/sessao', ip });
  }
  return res.json({ ok: true, login: loginNome });
}
