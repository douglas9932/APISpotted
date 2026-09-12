import { validateWithAI } from '../lib/ai.js';

export async function validateMessage(req, res) {
  const { mensagem } = req.body;

  if (!mensagem || !mensagem.trim()) {
    return res.status(400).json({ mensagemvalida: false, motivorecusa: 'Mensagem é obrigatória' });
  }

  try {
    const resultado = await validateWithAI(mensagem.trim());
    return res.json(resultado);
  } catch (err) {
    console.error('AI validation error:', err.message);
    return res.json({ mensagemvalida: false, motivorecusa: 'Serviço de validação indisponível' });
  }
}
