import { validateWithAI } from '../lib/ai.js';
import { logErro } from '../lib/logger.js';

export async function validateMessage(req, res) {
  const { mensagem } = req.body;

  if (!mensagem || !mensagem.trim()) {
    return res.status(400).json({ mensagemvalida: false, motivorecusa: 'Mensagem é obrigatória', suspeita: false, motivo_suspeita: null, necessita_validacao: false, motivo_validacao: null });
  }

  try {
    const resultado = await validateWithAI(mensagem.trim());
    // garantir campos necessita_validacao/motivo_validacao sempre presentes;
    // suspeita=true => vai para revisão humana com motivo obrigatório
    const necessita = resultado.suspeita === true;
    return res.json({
      necessita_validacao: false, suspeita: false, motivo_suspeita: null, motivo_validacao: null,
      ...resultado,
      necessita_validacao: necessita,
      motivo_validacao: necessita ? (resultado.motivo_suspeita || 'Sinalizado como suspeito pela IA — revisão humana.') : null
    });
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
      motivo_suspeita: null,
      necessita_validacao: false,
      motivo_validacao: null
    });
  }
}
