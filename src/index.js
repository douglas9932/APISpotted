import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { validateMessage } from './routes/validate.js';
import { publicar } from './routes/publicar.js';
import { listarIas, atualizarIa, definirEmUso, salvarChave, removerChave, obterChave } from './routes/ias.js';
import { listarPendentes, listarRejeitados, listarLiberados, liberarPost, marcarPostado, listarPublicados, reservarCodigo } from './routes/posts.js';
import { obterConfig, salvarConfig, obterTokenConfig } from './routes/config.js';
import { uploadStaging, excluirStaging } from './routes/staging.js';
import { listarLogs, registrarLog } from './routes/logs.js';
import { login, sessao } from './routes/auth.js';
import { criarRateLimit } from './lib/rateLimit.js';
import { logErro, logInfo } from './lib/logger.js';

const app = express();
const PORT = process.env.PORT || 3001;
app.set('trust proxy', 1);

// F8: falha rápido sem master key de IA — seleção e chave vêm SOMENTE da
// tabela tbias (docs/tbias.sql, modo estrito, sem fallback p/ env).
if (!process.env.IA_MASTER_KEY) {
  logErro('[startup] IA_MASTER_KEY ausente. Gere com node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" e cadastre a chave criptografada em tbias.api_key_enc.');
  process.exit(1);
}

// F2: 30 validações/minuto por IP (protege a quota da IA)
const limiteValidate = criarRateLimit({ janelaMs: 60_000, max: 30 });

app.use(helmet());
app.use(cors());
// F1: publicação via servidor (service-role) com corpo maior só nesta rota;
// o limite global restrito (F4) continua valendo para as demais
app.post('/api/publicar', express.json({ limit: '8mb' }), publicar);
// PUT config com corpo maior (base64 da imagem chega a MBs) ANTES do json global;
// registrado depois, o global de 100kb rejeitaria antes (F4)
app.put('/api/configuracoes', express.json({ limit: '8mb' }), salvarConfig);
// Upload temporário p/ publicação via painel web (JPEG montado em base64) —
// mesmo motivo: corpo maior que o limite global
app.post('/api/upload-imagem', express.json({ limit: '8mb' }), uploadStaging);
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ online: true });
});

// Marcador de versão (confirma qual código está no ar)
app.get('/api/versao', (_req, res) => {
  res.json({ versao: '2026-09-25-upload-imagem' });
});

app.post('/api/validate', limiteValidate, validateMessage);

// Login do painel (tblogins) — corpo pequeno, usa o json global
app.post('/api/login', login);
// Validação do token de sessão (48h) — 401 = painel volta p/ tela de login
app.get('/api/sessao', sessao);

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
app.get('/api/posts-liberados', listarLiberados);
app.patch('/api/posts/:id/liberar', liberarPost);
app.patch('/api/posts/:id/postado', marcarPostado);
app.post('/api/posts/:id/reservar-codigo', reservarCodigo);
app.get('/api/posts-publicados', listarPublicados);

// Leitura de logs (tblogs) — idem, somente localhost
app.get('/api/logs', listarLogs);
app.post('/api/logs', registrarLog);

// Configuração global (tbconfiguracoes, 1 linha) — idem, somente localhost
app.get('/api/configuracoes', obterConfig);
app.get('/api/configuracoes/token', obterTokenConfig);

// Limpeza do staging após publicar (corpo pequeno, usa o json global)
app.delete('/api/upload-imagem', excluirStaging);



// Página inicial: http://localhost:PORTA mostra que a API está rodando
app.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spotted API — rodando</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem;">
  <h1>✅ API Spotted rodando</h1>
  <p>Servidor no ar — ${new Date().toLocaleString('pt-BR')}.</p>
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
