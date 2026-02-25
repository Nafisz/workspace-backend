import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import fs from 'fs';
import { unlink, writeFile } from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/client.js';
import { buildSystemPrompt, streamMessageWithTools } from '../services/ai.js';
import { mcpManager } from '../services/mcp.js';

export default fp(async function conversationsRoutes(app: FastifyInstance) {
  const db = getDb();
  const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? './data/uploads');

  app.get('/projects/:id/conversations', async (req, reply) => {
    const { id: projectId } = req.params as { id: string };
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return reply.status(404).send({ error: 'project not found' });
    const convos = db.prepare('SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC').all(projectId);
    return convos;
  });

  app.post('/projects/:id/conversations', async (req, reply) => {
    const { id: projectId } = req.params as { id: string };
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return reply.status(404).send({ error: 'project not found' });
    const body = req.body as { title?: string };
    const now = Date.now();
    const id = uuidv4();
    db.prepare(
      `INSERT INTO conversations (id, project_id, title, is_starred, created_at, updated_at)
       VALUES (@id, @project_id, @title, @is_starred, @created_at, @updated_at)`
    ).run({
      id,
      project_id: projectId,
      title: body?.title ?? 'New Conversation',
      is_starred: 0,
      created_at: now,
      updated_at: now
    });
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;
    return row;
  });

  app.get('/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const convo = db.prepare('SELECT id FROM conversations WHERE id = ?').get(id);
    if (!convo) return reply.status(404).send({ error: 'conversation not found' });
    const query = req.query as { limit?: string; offset?: string };
    const limit = Math.min(Number(query?.limit ?? 50), 200);
    const offset = Number(query?.offset ?? 0);
    const rows = db.prepare(
      `SELECT * FROM messages WHERE conversation_id = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(id, limit, offset) as any[];
    return rows.map((row) => ({
      ...row,
      attachments: row.attachments ? JSON.parse(row.attachments) : [],
      metadata: row.metadata ? JSON.parse(row.metadata) : {}
    }));
  });

  app.post('/conversations/:id/messages', async (req, reply) => {
    const { id: conversationId } = req.params as { id: string };
    const body = req.body as {
      content?: string;
      attachments?: unknown[];
      outputFile?: { name?: string; mimeType?: string; content?: string };
    };
    if (!body?.content) return reply.status(400).send({ error: 'content is required' });

    const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as any;
    if (!convo) return reply.status(404).send({ error: 'conversation not found' });
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(convo.project_id) as any;
    if (!project) return reply.status(404).send({ error: 'project not found' });

    const docs = db.prepare('SELECT * FROM documents WHERE project_id = ?').all(project.id) as any[];
    const systemPrompt = buildSystemPrompt(project, docs);

    const historyRows = db.prepare(
      `SELECT * FROM messages WHERE conversation_id = ?
       ORDER BY created_at ASC`
    ).all(conversationId) as any[];
    const history = historyRows
      .filter((row) => row.role === 'user' || row.role === 'assistant')
      .map((row) => ({ role: row.role, content: row.content }));

    const now = Date.now();
    const userMessageId = uuidv4();
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, attachments, metadata, created_at)
       VALUES (@id, @conversation_id, @role, @content, @attachments, @metadata, @created_at)`
    ).run({
      id: userMessageId,
      conversation_id: conversationId,
      role: 'user',
      content: body.content,
      attachments: JSON.stringify(body.attachments ?? []),
      metadata: JSON.stringify({}),
      created_at: now
    });

    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversationId);

    const origin = req.headers.origin;
    if (origin) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin);
      reply.raw.setHeader('Vary', 'Origin');
      reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders?.();

    const integrations = project.integrations ? JSON.parse(project.integrations) : {};
    const services: Array<'slack' | 'atlassian'> = [];
    if (integrations?.slack) services.push('slack');
    if (integrations?.jira || integrations?.confluence) services.push('atlassian');
    const tools = services.length > 0 ? await mcpManager.getTools(services) : undefined;
    const settings = project.settings ? JSON.parse(project.settings) : {};

    let fullResponse = '';
    try {
      for await (const event of streamMessageWithTools({
        systemPrompt,
        messages: [...history, { role: 'user', content: body.content }],
        tools,
        model: settings.model,
        toolExecutor: async (name, input) => mcpManager.executeTool(name, input)
      })) {
        if (event.type === 'text') {
          fullResponse += event.text;
          reply.raw.write(`data: ${JSON.stringify({ type: 'text', text: event.text })}\n\n`);
        } else if (event.type === 'tool_use') {
          reply.raw.write(`data: ${JSON.stringify({ type: 'tool_use', name: event.name })}\n\n`);
        }
      }
    } catch (error: any) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: error?.message ?? 'stream error' })}\n\n`);
      reply.raw.end();
      return;
    }

    const assistantMessageId = uuidv4();
    const assistantAttachments: Array<Record<string, unknown>> = [];
    if (body.outputFile) {
      const fileId = uuidv4();
      const fileName = body.outputFile.name ?? `assistant-${fileId}.txt`;
      const filePath = path.join(uploadDir, fileId);
      const fileContent = body.outputFile.content ?? fullResponse;
      const mimeType = body.outputFile.mimeType ?? 'text/plain; charset=utf-8';
      await writeFile(filePath, fileContent ?? '');
      const size = Buffer.byteLength(fileContent ?? '', 'utf-8');
      db.prepare(
        `INSERT INTO chat_files (id, conversation_id, message_id, name, mime_type, size, file_path, created_at)
         VALUES (@id, @conversation_id, @message_id, @name, @mime_type, @size, @file_path, @created_at)`
      ).run({
        id: fileId,
        conversation_id: conversationId,
        message_id: assistantMessageId,
        name: fileName,
        mime_type: mimeType,
        size,
        file_path: filePath,
        created_at: Date.now()
      });
      const filePayload = {
        type: 'file',
        id: fileId,
        name: fileName,
        mimeType,
        size,
        url: `/api/conversations/${conversationId}/files/${fileId}`
      };
      assistantAttachments.push(filePayload);
      reply.raw.write(`data: ${JSON.stringify({ type: 'file', file: filePayload })}\n\n`);
    }
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, attachments, metadata, created_at)
       VALUES (@id, @conversation_id, @role, @content, @attachments, @metadata, @created_at)`
    ).run({
      id: assistantMessageId,
      conversation_id: conversationId,
      role: 'assistant',
      content: fullResponse,
      attachments: JSON.stringify(assistantAttachments),
      metadata: JSON.stringify({ model: settings.model ?? 'claude-sonnet-4-6' }),
      created_at: Date.now()
    });

    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversationId);
    reply.raw.end();
  });

  app.put('/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { title?: string };
    const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;
    if (!convo) return reply.status(404).send({ error: 'conversation not found' });
    const now = Date.now();
    const title = body?.title ?? convo.title;
    db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
    const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;
    return row;
  });

  app.delete('/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const convo = db.prepare('SELECT id FROM conversations WHERE id = ?').get(id);
    if (!convo) return reply.status(404).send({ error: 'conversation not found' });
    const files = db.prepare('SELECT * FROM chat_files WHERE conversation_id = ?').all(id) as any[];
    for (const file of files) {
      if (file?.file_path) {
        try {
          await unlink(file.file_path);
        } catch {}
      }
    }
    db.prepare('DELETE FROM chat_files WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return { ok: true };
  });

  app.get('/conversations/:id/files/:fileId', async (req, reply) => {
    const { id: conversationId, fileId } = req.params as { id: string; fileId: string };
    const file = db.prepare(
      'SELECT * FROM chat_files WHERE id = ? AND conversation_id = ?'
    ).get(fileId, conversationId) as any;
    if (!file) return reply.status(404).send({ error: 'file not found' });
    if (!file.file_path) return reply.status(404).send({ error: 'file not found' });
    try {
      await fs.promises.access(file.file_path);
    } catch {
      return reply.status(404).send({ error: 'file not found' });
    }
    const safeName = String(file.name ?? 'download').replace(/"/g, '');
    reply.header('Content-Type', file.mime_type ?? 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
    return reply.send(fs.createReadStream(file.file_path));
  });
});
