import { createHmac, timingSafeEqual } from 'node:crypto';

// Token de sessão do painel — válido por 48h, assinado com HMAC-SHA256.
// Formato: base64url(payload).base64url(assinatura), payload = { login, exp }.
// Stateless (sem tabela de sessões) e sem dependências externas.
// Segredo: SESSION_SECRET (ou IA_MASTER_KEY como fallback — nunca sai do servidor).

const SESSAO_MS = 48 * 3600 * 1000;

function segredo() {
  return process.env.SESSION_SECRET || process.env.IA_MASTER_KEY || '';
}

export function criarToken(login) {
  const exp = Date.now() + SESSAO_MS;
  const payload = Buffer.from(JSON.stringify({ login, exp }), 'utf8').toString('base64url');
  const sig = createHmac('sha256', segredo()).update(payload).digest('base64url');
  return { token: `${payload}.${sig}`, expira_em: new Date(exp).toISOString() };
}

// Retorna o login se o token for íntegro e vigente; null caso contrário.
export function verificarToken(token) {
  try {
    if (typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const esperado = createHmac('sha256', segredo()).update(payload).digest();
    const recebido = Buffer.from(sig, 'base64url');
    if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) return null;
    const doc = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!doc || typeof doc.login !== 'string' || typeof doc.exp !== 'number') return null;
    if (Date.now() > doc.exp) return null;
    return doc.login;
  } catch {
    return null;
  }
}
