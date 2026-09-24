# Push FCM — moderadores (Android, via APK/ADB, sem Play Store)

Arquitetura:

```
App MAUI → PushNotificationService → POST /api/notificacoes/dispositivo → tbdispositivos_push
/api/publicar (suspeito) ─┐
POST /api/notificacoes/enviar ─┴→ src/lib/push.js → FCM → FirebasePushService → nativa → toque → Pendentes (+id)
```

Sem polling como solução principal: o FCM acorda o app (aberto, fundo,
fechado, tela bloqueada). O monitor local de 45s continua como fallback
(funcionalidade existente, não removida).

## 1) Firebase Console (sua conta Google, 1 vez)

1. https://console.firebase.google.com > Criar projeto (ex. `spotted`).
2. Android: Adicionar app > pacote **`com.spotted.appconfig`** >
   baixar **`google-services.json`** > copiar para
   `Instagram/AppConfig/Platforms/Android/google-services.json` >
   no Visual Studio: botão direito > Propriedades > Ação de Compilação =
   `GoogleServicesJson`.
3. Contas de serviço: Configurações do projeto > Contas de serviço >
   **Gerar nova chave privada** (JSON). Compactar em 1 linha (PowerShell):
   `$j = Get-Content chave.json -Raw; ($j | ConvertFrom-Json | ConvertTo-Json -Compress) | Set-Content fcm-oneline.txt`

## 2) Banco (1 vez)

Supabase > SQL Editor > rodar `docs/add-notificacoes-push.sql`
(tabela `tbdispositivos_push`, um usuário com VÁRIOS aparelhos).

## 3) Render — secrets e deploy

- Environment > Add: **`FIREBASE_SERVICE_ACCOUNT_JSON`** = conteúdo do
  `fcm-oneline.txt` (marcar como secret). É a ÚNICA env do push.
- A API lê via `process.env` em `src/lib/push.js` (lazy, só ao enviar).
  Credencial NUNCA vai no APK (só o remetente genérico + package).
- Deploy com `npm install` (entra `firebase-admin` do `package.json`).
- Teste API→Firebase (troque a URL):
  `curl -X POST https://sua-api/api/notificacoes/enviar -H "Content-Type: application/json" -d "{\"usuarioId\":\"moderador\",\"titulo\":\"Ping\",\"mensagem\":\"Teste\",\"dados\":{\"tipo\":\"TESTE\"}}"`
  Resposta: `{"ok":true,"enviados":N,"falhas":M}`.
- Falha? Render > Logs (`push fcm falhou`, `FIREBASE_... ausente`) +
  aba Logs do app (origem `push`, espelho em `tblogs`).

## 4) Testes (com o APK instalado via ADB)

Pré-requisito de todos: abrir o app 1 vez (pede permissão e registra o
token; confira com `select count(*) from tbdispositivos_push where ativo;`).

- **Teste 1 (aberto):** app na Conexão > "Enviar push de teste" >
  chega "Push de teste" em segundos.
- **Teste 2 (fundo):** minimize > "Enviar push de teste" (ou curl) >
  banner na central.
- **Teste 3 (fechado):** remova dos recentes > envie > chega
  (exceto após "Forçar parada" — trava do sistema, vale até p/ WhatsApp).
- **Teste 4 (bloqueada):** bloqueie a tela > envie > acende com o banner.
- **Teste 5 (toque):** toque no push de post suspeito > abre Pendentes
  JÁ com o post selecionado (`tipo: POST_SUSPEITO` + `id`).
- **Teste 6 (token):** limpar dados do app > abrir > novo `token` na
  tabela para o mesmo `moderador` (re-registro automático via
  `OnNewToken` + na abertura).

## 5) Regras mantidas

- Interruptor da Conexão liga/desliga tudo (desligar desativa o token).
- Tokens mortos (`not-registered`) são desativados sozinhos no envio.
- Rate-limit: 10 disp/min e 30 envios/min por IP.
- Aparelho precisa de Play Services (sideload OK, sem Play Store).
