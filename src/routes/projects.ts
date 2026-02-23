import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/client.js';

function parseProject(row: any) {
  return {
    ...row,
    settings: row.settings ? JSON.parse(row.settings) : {},
    integrations: row.integrations ? JSON.parse(row.integrations) : {}
  };
}

export default fp(async function projectsRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/', async () => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
    return rows.map(parseProject);
  });

  app.post('/', async (req, reply) => {
    const body = req.body as {
      name: string;
      description?: string;
      icon?: string;
      color?: string;
      system_prompt?: string;
      settings?: Record<string, unknown>;
      integrations?: Record<string, unknown>;
    };
    if (!body?.name) {
      return reply.status(400).send({ error: 'name is required' });
    }
    const now = Date.now();
    const id = uuidv4();
    const settings = JSON.stringify(body.settings ?? {});
    const integrations = JSON.stringify(body.integrations ?? {});
    db.prepare(
      `INSERT INTO projects (id, name, description, icon, color, system_prompt, settings, integrations, created_at, updated_at)
       VALUES (@id, @name, @description, @icon, @color, @system_prompt, @settings, @integrations, @created_at, @updated_at)`
    ).run({
      id,
      name: body.name,
      description: body.description ?? null,
      icon: body.icon ?? '📁',
      color: body.color ?? '#6366f1',
      system_prompt: body.system_prompt ?? '',
      settings,
      integrations,
      created_at: now,
      updated_at: now
    });
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    return parseProject(row);
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    if (!project) return reply.status(404).send({ error: 'not found' });
    const docs = db.prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY uploaded_at DESC').all(id);
    const convos = db.prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC').all(id);
    return {
      ...parseProject(project),
      documents: docs.map((d: any) => ({ ...d, metadata: d.metadata ? JSON.parse(d.metadata) : {} })),
      conversations: convos
    };
  });

  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      name?: string;
      description?: string;
      icon?: string;
      color?: string;
      system_prompt?: string;
      settings?: Record<string, unknown>;
      integrations?: Record<string, unknown>;
    };
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    if (!existing) return reply.status(404).send({ error: 'not found' });
    const now = Date.now();
    const updated = {
      name: body.name ?? existing.name,
      description: body.description ?? existing.description,
      icon: body.icon ?? existing.icon,
      color: body.color ?? existing.color,
      system_prompt: body.system_prompt ?? existing.system_prompt,
      settings: JSON.stringify(body.settings ?? JSON.parse(existing.settings ?? '{}')),
      integrations: JSON.stringify(body.integrations ?? JSON.parse(existing.integrations ?? '{}')),
      updated_at: now,
      id
    };
    db.prepare(
      `UPDATE projects
       SET name=@name, description=@description, icon=@icon, color=@color,
           system_prompt=@system_prompt, settings=@settings, integrations=@integrations, updated_at=@updated_at
       WHERE id=@id`
    ).run(updated);
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    return parseProject(row);
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!existing) return reply.status(404).send({ error: 'not found' });
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return { ok: true };
  });
});
