import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

// Client privilegiado (service-role) — SOMENTE servidor, nunca no front (F1).
// Criação preguiçosa para não derrubar o boot quando as chaves ainda não existem;
// a rota /api/publicar responde 503 nesse caso.

let cached = null;

export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    const err = new Error('Supabase não configurado no servidor');
    err.code = 'E_NO_SUPABASE';
    throw err;
  }
  if (!cached) {
    // Node 20 não tem WebSocket nativo: injeta implementação (exige dep "ws").
    // Some junto com o upgrade para Node 22+ (ver F1-correcao.md).
    cached = createClient(url, key, {
      auth: { persistSession: false },
      realtime: { transport: WebSocket }
    });
  }
  return cached;
}
