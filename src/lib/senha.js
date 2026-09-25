import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

// Senhas de login (tblogins.senha_hash) — scrypt com salt aleatório.
// Formato: scrypt$<saltHex>$<hashHex>. Sem dependências externas.
// (A chave nunca é logada nem trafega de volta: só o hash vai ao banco.)

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scryptAsync(senha, salt) {
  return new Promise((resolve, reject) => {
    scrypt(senha, salt, KEYLEN, { N, R, P }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashSenha(senha) {
  const salt = randomBytes(16).toString('hex');
  const key = await scryptAsync(String(senha), salt);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function verificarSenha(senha, hash) {
  try {
    if (typeof senha !== 'string' || typeof hash !== 'string') return false;
    const partes = hash.split('$');
    if (partes.length !== 3 || partes[0] !== 'scrypt') return false;
    const [, salt, esperado] = partes;
    const key = await scryptAsync(senha, salt);
    const a = Buffer.from(key.toString('hex'), 'hex');
    const b = Buffer.from(esperado, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
