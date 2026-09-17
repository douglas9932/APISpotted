import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { validateMessage } from './routes/validate.js';
import { publicar } from './routes/publicar.js';
import { listarIas, atualizarIa, definirEmUso, salvarChave, removerChave, obterChave } from './routes/ias.js';
import { listarPendentes, listarRejeitados, liberarPost } from './routes/posts.js';
import { obterConfig, salvarConfig, obterTokenConfig } from './routes/config.js';
import { criarRateLimit } from './lib/rateLimit.js';
import { logErro, logInfo } from './lib/logger.js';

const app = express();
const PORT = process.env.PORT || 3001;

// F8: falha rápido sem master key de IA — seleção e chave vêm SOMENTE da
// tabela tbias (docs/tbias.sql, modo estrito, sem fallback p/ env).
if (!process.env.IA_MASTER_KEY) {
  logErro('[startup] IA_MASTER_KEY ausente. Gere com node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" e cadastre a chave criptografada em tbias.api_key_enc.');
  process.exit(1);
}

// F2: 30 validações/minuto por IP (protege a quota da IA)
const limiteValidate = criarRateLimit({ janelaMs: 60_000, max: 30 });

app.use(cors());
// F1: publicação via servidor (service-role) com corpo maior só nesta rota;
// o limite global restrito (F4) continua valendo para as demais
app.post('/api/publicar', express.json({ limit: '8mb' }), publicar);
// PUT config com corpo maior (base64 da imagem chega a MBs) ANTES do json global;
// registrado depois, o global de 100kb rejeitaria antes (F4)
app.put('/api/configuracoes', express.json({ limit: '8mb' }), salvarConfig);
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ online: true });
});

app.post('/api/validate', limiteValidate, validateMessage);

// Admin das IAs (tbias) — sem token, somente localhost (ver lib/adminAuth.js)
// (bodies já parseados pelo express.json() global acima)
app.get('/api/ias', listarIas);
app.get('/api/ias/:provedor/chave', obterChave);
app.put('/api/ias/:provedor', atualizarIa);
app.post('/api/ias/:provedor/em-uso', definirEmUso);
app.post('/api/ias/:provedor/chave', salvarChave);
app.delete('/api/ias/:provedor/chave', removerChave);

// Moderação de posts (tbias: permitir/recusar) — idem, somente localhost
app.get('/api/posts-pendentes', listarPendentes);
app.get('/api/posts-rejeitados', listarRejeitados);
app.patch('/api/posts/:id/liberar', liberarPost);

// Configuração global (tbconfiguracoes, 1 linha) — idem, somente localhost
app.get('/api/configuracoes', obterConfig);
app.get('/api/configuracoes/token', obterTokenConfig);

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
// (espelha em tblogs em best-effort, com IP/rota do request)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logErro('unexpected error', err.message, { origem: req.path || 'middleware', ip: req.ip || req.socket?.remoteAddress || 'unknown' });
  if (res.headersSent) return;
  return res.status(500).json({ ok: false, motivo: 'Erro inesperado. Tente novamente.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  logInfo(`Server running on port ${PORT}`);
});
