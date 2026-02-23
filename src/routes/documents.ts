import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs/promises';
import { getDb } from '../db/client.js';
import { extractTextFromFile } from '../lib/file-parser.js';

export default fp(async function documentsRoutes(app: FastifyInstance) {
  const db = getDb();
  const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? './data/uploads');

  app.post('/:id/documents', async (req, reply) => {
    const { id: projectId } = req.params as { id: string };
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return reply.status(404).send({ error: 'project not found' });

    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) return reply.status(400).send({ error: 'file is required' });
      const docId = uuidv4();
      const fileName = file.filename;
      const filePath = path.join(uploadDir, docId);
      const buffer = await file.toBuffer();
      await fs.writeFile(filePath, buffer);
      const content = await extractTextFromFile(filePath, fileName);
      const now = Date.now();
      db.prepare(
        `INSERT INTO documents (id, project_id, name, type, content, url, file_path, size, metadata, uploaded_at)
         VALUES (@id, @project_id, @name, @type, @content, @url, @file_path, @size, @metadata, @uploaded_at)`
      ).run({
        id: docId,
        project_id: projectId,
        name: fileName,
        type: 'file',
        content,
        url: null,
        file_path: filePath,
        size: buffer.length,
        metadata: JSON.stringify({ mimeType: file.mimetype }),
        uploaded_at: now
      });
      const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any;
      return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : {} };
    }

    const body = req.body as {
      type: 'url' | 'text';
      name?: string;
      content?: string;
      url?: string;
      metadata?: Record<string, unknown>;
    };
    if (!body?.type) {
      return reply.status(400).send({ error: 'type is required' });
    }
    if (body.type === 'text' && !body.content) {
      return reply.status(400).send({ error: 'content is required for text' });
    }
    if (body.type === 'url' && !body.url) {
      return reply.status(400).send({ error: 'url is required for url' });
    }
    const docId = uuidv4();
    const now = Date.now();
    db.prepare(
      `INSERT INTO documents (id, project_id, name, type, content, url, file_path, size, metadata, uploaded_at)
       VALUES (@id, @project_id, @name, @type, @content, @url, @file_path, @size, @metadata, @uploaded_at)`
    ).run({
      id: docId,
      project_id: projectId,
      name: body.name ?? (body.type === 'url' ? body.url : 'Text Document'),
      type: body.type,
      content: body.type === 'text' ? body.content : null,
      url: body.type === 'url' ? body.url : null,
      file_path: null,
      size: body.content ? Buffer.byteLength(body.content, 'utf-8') : 0,
      metadata: JSON.stringify(body.metadata ?? {}),
      uploaded_at: now
    });
    const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId) as any;
    return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : {} };
  });

  app.delete('/:id/documents/:docId', async (req, reply) => {
    const { id: projectId, docId } = req.params as { id: string; docId: string };
    const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND project_id = ?').get(docId, projectId) as any;
    if (!doc) return reply.status(404).send({ error: 'document not found' });
    if (doc.file_path) {
      try {
        await fs.unlink(doc.file_path);
      } catch {}
    }
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId);
    return { ok: true };
  });
});
