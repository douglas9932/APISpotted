import { validateWithAI } from '../lib/ai.js';

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
    console.error('AI validation error:', err.message);
    // IA indisponível (créditos, rede, 429/503) -> liberar gravação mas marcar para revisão manual
    return res.status(503).json({
      mensagemvalida: true,
      motivorecusa: null,
      suspeita: false,
      necessita_validacao: true,
      erro_ia: true,
      detalhe: err.message
    });
  }
}
