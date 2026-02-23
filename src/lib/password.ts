import crypto from 'crypto';

const iterations = 100000;
const keyLen = 32;
const digest = 'sha256';

export function hashPassword(password: string, salt?: string) {
  const usedSalt = salt ?? crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, usedSalt, iterations, keyLen, digest).toString('hex');
  return `pbkdf2$${iterations}$${usedSalt}$${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const [, iterationsStr, salt, hash] = parts;
  const parsedIterations = Number(iterationsStr);
  if (!parsedIterations || !salt || !hash) return false;
  const derived = crypto.pbkdf2Sync(password, salt, parsedIterations, keyLen, digest).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
}

export function createToken() {
  return crypto.randomBytes(32).toString('hex');
}
