import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/client.js';
import { startTask, pauseTask, cancelTask, resumeTask, approveAction } from '../services/cowork-runner.js';

function parseJson(value: string | null, fallback: any) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export default fp(async function coworkRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/cowork/tasks', async (req) => {
    const query = req.query as { status?: string; projectId?: string };
    const filters: string[] = [];
    const params: any[] = [];
    if (query?.status) {
      filters.push('status = ?');
      params.push(query.status);
    }
    if (query?.projectId) {
      filters.push('project_id = ?');
      params.push(query.projectId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT * FROM cowork_tasks ${where} ORDER BY created_at DESC`)
      .all(...params) as any[];
    return rows.map((row) => ({
      ...row,
      plan: parseJson(row.plan, {}),
      artifacts: parseJson(row.artifacts, []),
      pending_actions: parseJson(row.pending_actions, [])
    }));
  });

  app.post('/cowork/tasks', async (req, reply) => {
    const body = req.body as {
      project_id?: string;
      title?: string;
      description?: string;
      autoApprove?: boolean;
    };
    if (!body?.title) return reply.status(400).send({ error: 'title is required' });
    const id = uuidv4();
    const now = Date.now();
    const plan = JSON.stringify({ settings: { autoApprove: body.autoApprove ?? false } });
    db.prepare(
      `INSERT INTO cowork_tasks (id, project_id, title, description, status, plan, artifacts, pending_actions, created_at, started_at, completed_at)
       VALUES (@id, @project_id, @title, @description, @status, @plan, @artifacts, @pending_actions, @created_at, @started_at, @completed_at)`
    ).run({
      id,
      project_id: body.project_id ?? null,
      title: body.title,
      description: body.description ?? null,
      status: 'queued',
      plan,
      artifacts: JSON.stringify([]),
      pending_actions: JSON.stringify([]),
      created_at: now,
      started_at: null,
      completed_at: null
    });
    startTask(id);
    const row = db.prepare('SELECT * FROM cowork_tasks WHERE id = ?').get(id) as any;
    return reply.send({
      ...row,
      plan: parseJson(row.plan, {}),
      artifacts: parseJson(row.artifacts, []),
      pending_actions: parseJson(row.pending_actions, [])
    });
  });

  app.get('/cowork/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM cowork_tasks WHERE id = ?').get(id) as any;
    if (!row) return reply.status(404).send({ error: 'task not found' });
    return {
      ...row,
      plan: parseJson(row.plan, {}),
      artifacts: parseJson(row.artifacts, []),
      pending_actions: parseJson(row.pending_actions, [])
    };
  });

  app.post('/cowork/tasks/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string };
    pauseTask(id);
    return reply.send({ ok: true });
  });

  app.post('/cowork/tasks/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    cancelTask(id);
    return reply.send({ ok: true });
  });

  app.post('/cowork/tasks/:id/resume', async (req, reply) => {
    const { id } = req.params as { id: string };
    resumeTask(id);
    return reply.send({ ok: true });
  });

  app.post('/cowork/tasks/:id/approve/:actionId', async (req, reply) => {
    const { id, actionId } = req.params as { id: string; actionId: string };
    approveAction(id, actionId);
    return reply.send({ ok: true });
  });
});
