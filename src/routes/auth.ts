import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/client.js';
import { createToken, hashPassword, verifyPassword } from '../lib/password.js';
import { getAuthContext } from '../lib/auth.js';

const sanitizeUser = (row: any) => ({
  id: row.id,
  email: row.email,
  name: row.name ?? null,
  role: row.role ?? 'member'
});

export default fp(async function authRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post('/auth/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string };
    const email = body?.email?.trim().toLowerCase();
    const password = body?.password ?? '';
    if (!email || !password) {
      return reply.status(400).send({ error: 'email and password are required' });
    }
    const totalUsers = db.prepare('SELECT COUNT(1) as count FROM users').get() as { count: number };
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    if (!user && totalUsers.count === 0) {
      const now = Date.now();
      const id = uuidv4();
      const passwordHash = hashPassword(password);
      db.prepare(
        `INSERT INTO users (id, email, name, password_hash, role, created_at, last_login_at)
         VALUES (@id, @email, @name, @password_hash, @role, @created_at, @last_login_at)`
      ).run({
        id,
        email,
        name: null,
        password_hash: passwordHash,
        role: 'admin',
        created_at: now,
        last_login_at: now
      });
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }
    if (!user || !verifyPassword(password, user.password_hash)) {
      return reply.status(401).send({ error: 'invalid credentials' });
    }
    const now = Date.now();
    const sessionId = uuidv4();
    const token = createToken();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO sessions (id, user_id, token, created_at, last_used_at, expires_at)
       VALUES (@id, @user_id, @token, @created_at, @last_used_at, @expires_at)`
    ).run({
      id: sessionId,
      user_id: user.id,
      token,
      created_at: now,
      last_used_at: now,
      expires_at: expiresAt
    });
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);
    return { token, user: sanitizeUser(user) };
  });

  app.post('/auth/logout', async (req) => {
    const auth = getAuthContext(req);
    if (auth?.sessionId) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(auth.sessionId);
    }
    return { ok: true };
  });

  app.get('/auth/me', async (req, reply) => {
    const auth = getAuthContext(req);
    if (!auth) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    if (auth.user.id === 'api-key') {
      return { user: auth.user };
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(auth.user.id);
    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    return { user: sanitizeUser(user) };
  });

  app.post('/auth/register', async (req, reply) => {
    const body = req.body as { email?: string; password?: string; name?: string; role?: string };
    const email = body?.email?.trim().toLowerCase();
    const password = body?.password ?? '';
    if (!email || !password) {
      return reply.status(400).send({ error: 'email and password are required' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return reply.status(409).send({ error: 'email already registered' });
    }
    const totalUsers = db.prepare('SELECT COUNT(1) as count FROM users').get() as { count: number };
    const auth = getAuthContext(req);
    const allowSignup = process.env.ALLOW_SIGNUP === 'true';
    const isAdmin = auth?.user?.role === 'admin';
    if (totalUsers.count > 0 && !allowSignup && !isAdmin) {
      return reply.status(403).send({ error: 'registration disabled' });
    }
    const now = Date.now();
    const id = uuidv4();
    const passwordHash = hashPassword(password);
    const role = isAdmin && body?.role ? body.role : totalUsers.count === 0 ? 'admin' : 'member';
    db.prepare(
      `INSERT INTO users (id, email, name, password_hash, role, created_at, last_login_at)
       VALUES (@id, @email, @name, @password_hash, @role, @created_at, @last_login_at)`
    ).run({
      id,
      email,
      name: body?.name ?? null,
      password_hash: passwordHash,
      role,
      created_at: now,
      last_login_at: null
    });
    return { user: { id, email, name: body?.name ?? null, role } };
  });
});
