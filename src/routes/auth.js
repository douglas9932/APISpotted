import { getSupabaseAdmin } from '../lib/supabaseAdmin.js';
import { hashSenha, verificarSenha } from '../lib/senha.js';
import { criarToken, verificarToken } from '../lib/sessao.js';
import { logErro } from '../lib/logger.js';

// Regra de Admin: login "admin" (case-insensitive) é o administrador.
// (tblogins não tem coluna de perfil; comparação centralizada aqui.)
export function isAdminLogin(nome) {
  return typeof nome === 'string' && nome.trim().toLowerCase() === 'admin';
}

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
    return res.json({ ok: true, login: row.login, token: sess.token, expira_em: sess.expira_em, admin: isAdminLogin(row.login) });
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
  return res.json({ ok: true, login: loginNome, admin: isAdminLogin(loginNome) });
}

// Cadastro de novo login (tblogins) — SOMENTE Admin.
// POST /api/logins { login, senha } — Authorization: Bearer <token de admin>
export async function cadastrarLogin(req, res) {
  const h = req.headers.authorization || '';
  const solicitante = verificarToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!solicitante) {
    return res.status(401).json({ ok: false, motivo: 'Sessão inválida ou expirada.' });
  }
  if (!isAdminLogin(solicitante)) {
    return res.status(403).json({ ok: false, motivo: 'Somente o Admin pode cadastrar novos logins.' });
  }
  const { login, senha } = req.body || {};
  if (typeof login !== 'string' || !login.trim() || login.trim().length > 80) {
    return res.status(400).json({ ok: false, motivo: 'Informe um login válido (até 80 caracteres).' });
  }
  if (typeof senha !== 'string' || senha.length < 4 || senha.length > 200) {
    return res.status(400).json({ ok: false, motivo: 'A senha deve ter de 4 a 200 caracteres.' });
  }
  const nome = login.trim();
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
    const { data: existente, error: errBusca } = await supa
      .from('tblogins')
      .select('login')
      .eq('login', nome)
      .limit(1);
    if (errBusca) throw errBusca;
    if (existente && existente[0]) {
      return res.status(409).json({ ok: false, motivo: `Login '${nome}' já cadastrado.` });
    }
    const senha_hash = await hashSenha(senha);
    const { error: errInsert } = await supa.from('tblogins').insert({ login: nome, senha_hash, ativo: true });
    if (errInsert) throw errInsert;
    return res.status(201).json({ ok: true, login: nome });
  } catch (err) {
    logErro('cadastrar login falhou', err.message, { origem: '/api/logins', ip: req.ip || 'unknown' });
    return res.status(502).json({ ok: false, motivo: 'Não foi possível cadastrar. Tente novamente.' });
  }
}
