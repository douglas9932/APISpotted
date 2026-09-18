import { isIP } from 'node:net';

// Guarda dos endpoints admin (/api/ias*) SEM token:
// 1) só aceita conexão localhost (127.x / ::1) — deploys públicos (Render,
//    Vercel) recusam, então a ferramenta é usada contra a API local;
// 2) bloqueia Origin/Referer de site externo — sem isso, com CORS *, uma
//    página maliciosa chamaria http://localhost:3001 pelo browser da vítima.
function ipLocal(ip) {
  if (!ip) return false;
  const v = ip.toLowerCase().replace(/^::ffff:/, '');
  if (v === '::1' || v === 'localhost') return true;
  if (isIP(v) === 4) return v === '127.0.0.1' || v.startsWith('127.');
  return false;
}

function origemExterna(req) {
  const origem = req.headers.origin || req.headers.referer || '';
  if (!origem) return false; // WPF e curl não mandam Origin
  try {
    const host = new URL(origem).hostname.toLowerCase();
    return !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]');
  } catch {
    return true;
  }
}

export function exigirLocal(req, res) {
  const tokenEsperado = (process.env.ADMIN_TOKEN || process.env.API_ADMIN_TOKEN || '').trim();
  if (tokenEsperado) {
    const headerToken = (req.headers['x-admin-token'] || '').trim() ||
      ((req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim());
    if (headerToken && headerToken === tokenEsperado) {
      return true;
    }
    if (!headerToken) {
      res.status(401).json({ ok: false, motivo: 'Token de administração ausente. Configure x-admin-token.' });
    } else {
      res.status(401).json({ ok: false, motivo: 'Token de administração inválido.' });
    }
    return false;
  }

  const ip = req.ip || req.socket?.remoteAddress || '';
  if (!ipLocal(ip) || origemExterna(req)) {
    res.status(403).json({ ok: false, motivo: 'Administração disponível somente no localhost. Configure ADMIN_TOKEN no servidor para acesso remoto.' });
    return false;
  }
  return true;
}
