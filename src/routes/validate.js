import { validateWithAI } from '../lib/ai.js';
import { logErro } from '../lib/logger.js';

export async function validateMessage(req, res) {
  const { mensagem } = req.body;

  if (!mensagem || !mensagem.trim()) {
    return res.status(400).json({ mensagemvalida: false, motivorecusa: 'Mensagem é obrigatória', suspeita: false, necessita_validacao: false });
  }

  try {
    const resultado = await validateWithAI(mensagem.trim());
    // garantir campo necessita_validacao sempre presente
    return res.json({ necessita_validacao: false, suspeita: false, ...resultado, necessita_validacao: resultado.necessita_validacao ?? false });
  } catch (err) {
    // F3 fail-closed: IA indisponível (créditos, rede, 429/503) NÃO libera
    // a mensagem. Detalhe interno só no log, nunca na resposta (F7).
    // motivo detalhado só no log do servidor (nunca na resposta — F7)
    // Espelha também em tblogs (best-effort) com o IP da conexão.
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    logErro('AI validation error', err.message, { origem: '/api/validate', ip });
    return res.status(503).json({
      mensagemvalida: false,
      motivorecusa: 'Serviço de validação indisponível. Tente novamente em instantes.',
      suspeita: false,
      necessita_validacao: false
    });
  }
}
