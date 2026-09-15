// Rate-limit em memória por IP (F2).
// Suficiente para instância única; com múltiplas réplicas usar store
// externo (ex. Redis/Upstash) ou o rate-limit do provedor.

export function criarRateLimit({ janelaMs, max }) {
  const seen = new Map();
  return function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const arr = (seen.get(ip) || []).filter((t) => now - t < janelaMs);
    arr.push(now);
    seen.set(ip, arr);
    if (arr.length > max) {
      return res.status(429).json({
        mensagemvalida: false,
        motivorecusa: 'Muitas tentativas. Aguarde um minuto e tente novamente.',
        suspeita: false,
        necessita_validacao: false
      });
    }
    next();
  };
}
