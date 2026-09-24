import admin from 'firebase-admin';
import { getSupabaseAdmin } from './supabaseAdmin.js';
import { logErro } from './logger.js';

// Push FCM (best-effort: falha aqui NUNCA quebra a rota chamadora).
// Credencial administrativa SOMENTE no servidor:
// FIREBASE_SERVICE_ACCOUNT_JSON (JSON da conta de serviço em 1 linha).
// Nunca commite, nunca exponha no app/APK.

const MAX_TRECHO = 120;
const MAX_TOKENS = 1000;

let pushApp = null;

function appPush() {
  if (pushApp) return pushApp;
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON ausente');
  let cred;
  try {
    cred = JSON.parse(raw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON inválido (não é JSON)');
  }
  pushApp = admin.initializeApp({ credential: admin.credential.cert(cred) });
  return pushApp;
}

export function trechoPush(mensagem) {
  const limpa = String(mensagem || '').replace(/\s+/g, ' ').trim();
  if (limpa.length <= MAX_TRECHO) return limpa;
  return `${limpa.slice(0, MAX_TRECHO).trimEnd()}…`;
}

function mapaStrings(dados) {
  const out = {};
  if (dados && typeof dados === 'object' && !Array.isArray(dados)) {
    for (const [k, v] of Object.entries(dados)) {
      if (typeof k === 'string' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        out[k.slice(0, 64)] = String(v).slice(0, 500);
      }
    }
  }
  out.tela = 'pendentes';
  return out;
}

// Envia para os tokens ATIVOS do usuário. Remove do banco os tokens
// que o FCM marcou como inválidos. Retorna { enviados, falhas }.
export async function enviarPushParaUsuario(usuarioId, titulo, mensagem, dados) {
  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from('tbdispositivos_push')
    .select('token')
    .eq('id_usuario', usuarioId)
    .eq('ativo', true)
    .limit(MAX_TOKENS);
  if (error) throw error;
  const tokens = [...new Set((data || []).map((r) => r.token).filter(Boolean))];
  if (!tokens.length) return { enviados: 0, falhas: 0 };

  let resp;
  try {
    resp = await appPush().messaging().sendEachForMulticast({
      tokens,
      notification: { title: titulo, body: mensagem },
      data: mapaStrings(dados),
      android: {
        priority: 'high',
        notification: { clickAction: 'ABRIR_PENDENTES' }
      },
      apns: { payload: { aps: { sound: 'default' } } }
    });
  } catch (err) {
    logErro('push fcm falhou', err.message, { origem: 'push' });
    throw err;
  }

  const ruins = [];
  resp.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (!r.success && (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token')) {
      ruins.push(tokens[i]);
    }
  });
  if (ruins.length) {
    try {
      await supa.from('tbdispositivos_push').update({ ativo: false }).in('token', ruins);
    } catch (e) {
      logErro('push desativar tokens falhou', e.message, { origem: 'push' });
    }
  }
  return { enviados: resp.successCount, falhas: resp.failureCount };
}
