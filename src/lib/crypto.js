import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// Chaves de IA criptografadas no banco (tbias.api_key_enc, formato v1:iv:ct).
// AES-256-GCM (autenticado: adulteração do ciphertext = erro, não lixo).
// Master key SOMENTE na env IA_MASTER_KEY (64 hex de randomBytes(32)).
// CLI: IA_MASTER_KEY=... node src/lib/crypto.js "SUA-CHAVE-DA-IA"

function masterKey() {
  const raw = (process.env.IA_MASTER_KEY || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (/^[A-Za-z0-9+/=]{44}$/.test(raw)) {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  }
  throw new Error('IA_MASTER_KEY ausente ou inválida (64 hex gerados com crypto.randomBytes(32))');
}

export function criptografarChave(textoClaro) {
  if (typeof textoClaro !== 'string' || !textoClaro) throw new Error('texto vazio');
  const key = masterKey();
  const iv = randomBytes(12); // único por criptografia, pode ser público
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(textoClaro, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${Buffer.concat([ct, tag]).toString('base64')}`;
}

export function descriptografarChave(blob) {
  const key = masterKey();
  const m = /^v1:([^:]+):([^:]+)$/.exec(blob || '');
  if (!m) throw new Error('formato de chave criptografada inválido (esperado v1:iv:ct)');
  const iv = Buffer.from(m[1], 'base64');
  const data = Buffer.from(m[2], 'base64');
  if (iv.length !== 12 || data.length <= 16) throw new Error('chave criptografada corrompida');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
}

// Modo estrito: a chave vem SOMENTE de tbias.api_key_enc (banco).
// Sem ciphertext válido (ou sem IA_MASTER_KEY) retorna null — o chamador
// falha explícito em vez de cair na env.
export function obterChaveProvedor(linha) {
  if (!linha || !linha.api_key_enc) return null;
  try {
    return descriptografarChave(linha.api_key_enc) || null;
  } catch {
    return null; // ciphertext inválido ou sem IA_MASTER_KEY
  }
}

if (process.argv[1] && process.argv[1].endsWith('crypto.js')) {
  const clara = process.argv[2];
  if (!clara) {
    console.error('Uso: IA_MASTER_KEY=<64hex> node src/lib/crypto.js "SUA-CHAVE-DA-IA"');
    process.exit(1);
  }
  console.log(criptografarChave(clara));
}
