import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  normalizeEmail,
  sanitizeAccount,
  verifyStoredPassword,
} from './security.js';

const SESSION_COOKIE = 'pnc_session';
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

function parseCookies(headerValue = '') {
  return Object.fromEntries(
    String(headerValue)
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separatorIndex = entry.indexOf('=');
        const key = separatorIndex >= 0 ? entry.slice(0, separatorIndex) : entry;
        const value = separatorIndex >= 0 ? entry.slice(separatorIndex + 1) : '';
        return [decodeURIComponent(key), decodeURIComponent(value)];
      }),
  );
}

function getSessionToken(request) {
  return parseCookies(request.headers.cookie)[SESSION_COOKIE] ?? '';
}

function sessionCookie(token, { secure, maxAgeSeconds = SESSION_LIFETIME_MS / 1000 } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];

  if (secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

export function createAuthService({ sessionsFile, sessionStore = null, readAccounts, saveAccounts, migrateAccountPassword = null, secureCookies = false, now = () => Date.now() }) {
  let sessions = new Map();
  let loaded = false;
  let writePromise = Promise.resolve();

  async function loadSessions() {
    if (loaded) return;
    loaded = true;

    if (!existsSync(sessionsFile)) return;

    try {
      const parsed = JSON.parse(await readFile(sessionsFile, 'utf8'));
      sessions = new Map(Array.isArray(parsed.sessions) ? parsed.sessions : []);
    } catch {
      sessions = new Map();
    }
  }

  async function persistSessions() {
    const content = JSON.stringify({ sessions: [...sessions.entries()] }, null, 2);
    writePromise = writePromise.then(() => writeFile(sessionsFile, content, 'utf8'));
    await writePromise;
  }

  async function removeExpiredSessions() {
    if (sessionStore) {
      sessionStore.deleteExpired(now());
      return;
    }
    await loadSessions();
    let changed = false;

    for (const [tokenHash, session] of sessions) {
      if (session.expiresAt <= now()) {
        sessions.delete(tokenHash);
        changed = true;
      }
    }

    if (changed) await persistSessions();
  }

  async function login(identifier, password) {
    const normalizedIdentifier = String(identifier ?? '').trim().toLowerCase();
    const accounts = await readAccounts();
    const account = accounts.find(
      (entry) => normalizeEmail(entry.email) === normalizedIdentifier || String(entry.phone ?? '').trim().toLowerCase() === normalizedIdentifier,
    );

    if (!account || !(await verifyStoredPassword(account, password))) {
      return null;
    }

    if (account.status === 'Suspended') {
      return { suspended: true };
    }

    if (!account.passwordHash) {
      account.passwordHash = await hashPassword(password);
      delete account.password;
      if (migrateAccountPassword) {
        await migrateAccountPassword(account.id, account.passwordHash);
      } else {
        await saveAccounts(accounts);
      }
    }

    await removeExpiredSessions();
    const token = createSessionToken();
    const createdAt = now();
    const session = {
      userId: account.id,
      role: account.role,
      createdAt,
      expiresAt: createdAt + SESSION_LIFETIME_MS,
    };
    const tokenHash = hashSessionToken(token);
    if (sessionStore) {
      sessionStore.set(tokenHash, session);
    } else {
      sessions.set(tokenHash, session);
      await persistSessions();
    }

    return { token, session, account: sanitizeAccount(account) };
  }

  async function authenticate(request) {
    const token = getSessionToken(request);
    if (!token) return null;

    const tokenHash = hashSessionToken(token);
    if (!sessionStore) await loadSessions();
    const session = sessionStore ? sessionStore.get(tokenHash) : sessions.get(tokenHash);

    if (!session || session.expiresAt <= now()) {
      if (session) {
        if (sessionStore) {
          sessionStore.delete(tokenHash);
        } else {
          sessions.delete(tokenHash);
          await persistSessions();
        }
      }
      return null;
    }

    const accounts = await readAccounts();
    const account = accounts.find((entry) => entry.id === session.userId);
    if (!account || account.role !== session.role || account.status === 'Suspended') return null;

    return { tokenHash, session, account };
  }

  async function logout(request) {
    const token = getSessionToken(request);
    if (!token) return;

    const tokenHash = hashSessionToken(token);
    if (sessionStore) {
      sessionStore.delete(tokenHash);
    } else {
      await loadSessions();
      if (sessions.delete(tokenHash)) await persistSessions();
    }
  }

  function setSessionCookie(response, token) {
    response.setHeader('Set-Cookie', sessionCookie(token, { secure: secureCookies }));
  }

  function clearSessionCookie(response) {
    response.setHeader('Set-Cookie', sessionCookie('', { secure: secureCookies, maxAgeSeconds: 0 }));
  }

  async function requireAuth(request, response, next) {
    try {
      const authentication = await authenticate(request);
      if (!authentication) {
        response.status(401).json({ message: 'Authentication required.' });
        return;
      }

      request.auth = authentication;
      next();
    } catch {
      response.status(500).json({ message: 'Unable to validate the current session.' });
    }
  }

  function requireRole(role) {
    return (request, response, next) => {
      if (request.auth?.account?.role !== role) {
        response.status(403).json({ message: 'You are not authorized to perform this action.' });
        return;
      }

      next();
    };
  }

  return {
    authenticate,
    clearSessionCookie,
    login,
    logout,
    requireAuth,
    requireRole,
    setSessionCookie,
  };
}