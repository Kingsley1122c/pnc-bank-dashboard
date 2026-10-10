import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_LENGTH = 64;
const PASSWORD_SCHEME = 'scrypt';

async function derivePasswordHash(password) {
  const normalizedPassword = String(password ?? '');
  const salt = randomBytes(16).toString('hex');
  const derivedKey = await scrypt(normalizedPassword, salt, PASSWORD_KEY_LENGTH);
  return `${PASSWORD_SCHEME}$${salt}$${Buffer.from(derivedKey).toString('hex')}`;
}

export async function hashPassword(password) {
  if (String(password ?? '').length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }
  return derivePasswordHash(password);
}

export async function hashLegacyPassword(password) {
  if (String(password ?? '').length === 0) {
    throw new Error('Legacy password cannot be empty.');
  }
  return derivePasswordHash(password);
}

export async function verifyPassword(password, passwordHash) {
  const [scheme, salt, expectedHex] = String(passwordHash ?? '').split('$');

  if (scheme !== PASSWORD_SCHEME || !salt || !expectedHex) {
    return false;
  }

  const expected = Buffer.from(expectedHex, 'hex');

  if (expected.length !== PASSWORD_KEY_LENGTH) {
    return false;
  }

  const actual = Buffer.from(await scrypt(String(password ?? ''), salt, expected.length));
  return timingSafeEqual(actual, expected);
}

export async function verifyStoredPassword(account, password) {
  if (account?.passwordHash) {
    return verifyPassword(password, account.passwordHash);
  }

  const storedPassword = String(account?.password ?? '');
  const suppliedPassword = String(password ?? '');
  const storedDigest = createHash('sha256').update(storedPassword).digest();
  const suppliedDigest = createHash('sha256').update(suppliedPassword).digest();
  return storedPassword.length > 0 && timingSafeEqual(storedDigest, suppliedDigest);
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex');
}

export function sanitizeAccount(account) {
  const { password: _password, passwordHash: _passwordHash, ...safeAccount } = account ?? {};
  return safeAccount;
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isValidEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function isValidEmailHeader(value, maxLength = 160) {
  const text = String(value ?? '').trim();
  return text.length > 0 && text.length <= maxLength && !/[\r\n]/.test(text);
}

export function isValidPublicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch {
    return false;
  }
}