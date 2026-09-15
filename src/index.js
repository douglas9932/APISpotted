import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { validateMessage } from './routes/validate.js';
import { publicar } from './routes/publicar.js';
import { criarRateLimit } from './lib/rateLimit.js';
import { logErro, logInfo } from './lib/logger.js';

const app = express();
const PORT = process.env.PORT || 3001;

// F8: falha rápido sem a chave do provedor — evita "AI validation error" por request
const AI_PROVIDER = (process.env.AI_PROVIDER || 'claude').toLowerCase();
const TEM_CHAVE_IA = AI_PROVIDER === 'gemini' ? !!process.env.GEMINI_API_KEY : !!process.env.ANTHROPIC_API_KEY;
if (!TEM_CHAVE_IA) {
  logErro(`[startup] provider "${AI_PROVIDER}" sem chave. ` +
    (AI_PROVIDER === 'gemini'
      ? 'Defina GEMINI_API_KEY no .env.'
      : 'Defina ANTHROPIC_API_KEY no .env (ou use AI_PROVIDER=gemini com GEMINI_API_KEY).'));
  process.exit(1);
}

// F2: 30 validações/minuto por IP (protege a quota da IA)
const limiteValidate = criarRateLimit({ janelaMs: 60_000, max: 30 });

app.use(cors());
// F1: publicação via servidor (service-role) com corpo maior só nesta rota;
// o limite global restrito (F4) continua valendo para as demais
app.post('/api/publicar', express.json({ limit: '8mb' }), publicar);
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ online: true });
});

app.post('/api/validate', limiteValidate, validateMessage);

// Página inicial: http://localhost:PORTA mostra que a API está rodando
app.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spotted API — rodando</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem;">
  <h1>✅ API Spotted rodando</h1>
  <p>Servidor no ar em <strong>porta ${PORT}</strong> — ${new Date().toLocaleString('pt-BR')}.</p>
  <h2>Endpoints</h2>
  <ul>
    <li><code>GET /api/health</code> — status</li>
    <li><code>POST /api/validate</code> — moderação de mensagem { mensagem }</li>
    <li><code>POST /api/publicar</code> — publicação (valida + grava)</li>
  </ul>
</body>
</html>`);
});

// Rede de segurança: erro inesperado vira 500 genérico, nunca derruba o processo
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logErro('unexpected error', err.message);
  if (res.headersSent) return;
  return res.status(500).json({ ok: false, motivo: 'Erro inesperado. Tente novamente.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  logInfo(`Server running on port ${PORT}`);
});
