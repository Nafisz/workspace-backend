import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { hashPassword } from '../lib/password.js';
import { v4 as uuidv4 } from 'uuid';

let dbInstance: Database.Database | null = null;

export async function initDb() {
  if (dbInstance) return dbInstance;
  const dataDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = path.join(dataDir, 'novax.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const schemaPath = path.resolve(process.cwd(), 'src', 'db', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schemaSql);
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail) as { id?: string } | undefined;
    if (!existing?.id) {
      const now = Date.now();
      const id = uuidv4();
      const passwordHash = hashPassword(adminPassword);
      db.prepare(
        `INSERT INTO users (id, email, name, password_hash, role, created_at, last_login_at)
         VALUES (@id, @email, @name, @password_hash, @role, @created_at, @last_login_at)`
      ).run({
        id,
        email: adminEmail,
        name: 'Administrator',
        password_hash: passwordHash,
        role: 'admin',
        created_at: now,
        last_login_at: now
      });
    }
  }
  dbInstance = db;
  return db;
}

export function getDb() {
  if (!dbInstance) {
    throw new Error('Database not initialized');
  }
  return dbInstance;
}
