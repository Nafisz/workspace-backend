import { FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/client.js';

type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
};

const openPaths = new Set([
  '/api',
  '/api/',
  '/api/_meta',
  '/api/auth/login',
  '/api/auth/register',
  '/auth/login',
  '/auth/register',
  '/health'
]);

const isOpenPath = (path: string) => {
  if (openPaths.has(path)) return true;
  if (path.startsWith('/api') && openPaths.has(path.replace('/api', ''))) return true;
  return false;
};

const normalizeToken = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

const getTokenFromRequest = (req: FastifyRequest) => {
  const headerKey = normalizeToken(req.headers['x-api-key']);
  const authHeader = normalizeToken(req.headers.authorization);
  const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined;
  const queryToken = (req.query as { token?: string; api_key?: string; apiKey?: string } | undefined) ?? {};
  const queryValue = queryToken.token || queryToken.api_key || queryToken.apiKey;
  return bearer || headerKey || queryValue;
};

const getUserFromSession = (token: string) => {
  const db = getDb();
  const now = Date.now();
  const row = db.prepare(
    `SELECT s.id as session_id, s.expires_at as expires_at, u.id as id, u.email as email, u.name as name, u.role as role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  ).get(token) as { session_id: string; expires_at: number | null; id: string; email: string; name: string | null; role: string } | undefined;
  if (!row) return null;
  if (row.expires_at && row.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    return null;
  }
  db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(now, row.session_id);
  return { user: { id: row.id, email: row.email, name: row.name, role: row.role }, sessionId: row.session_id };
};

export function getAuthContext(req: FastifyRequest) {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  if (process.env.API_KEY && token === process.env.API_KEY) {
    return { user: { id: 'api-key', email: 'api-key', name: 'API Key', role: 'admin' } as AuthUser, sessionId: null };
  }
  return getUserFromSession(token);
}

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const path = req.url.split('?')[0];
  if (req.method === 'OPTIONS' || isOpenPath(path)) {
    return;
  }
  const auth = getAuthContext(req);
  if (!auth) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  (req as { user?: AuthUser; sessionId?: string | null }).user = auth.user;
  (req as { user?: AuthUser; sessionId?: string | null }).sessionId = auth.sessionId;
}
