import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import fs from 'fs';
import { unlink, writeFile } from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/client.js';
import { buildSystemPrompt, streamMessageWithTools } from '../services/ai.js';
import { mcpManager } from '../services/mcp.js';
import { classifyMessage } from '../services/summarizer.js';

export default fp(async function conversationsRoutes(app: FastifyInstance) {
  const db = getDb();
  const uploadDir = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? './data/uploads');

  app.get('/projects/:id/conversations', async (req, reply) => {
    const { id: projectId } = req.params as { id: string };
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return reply.status(404).send({ error: 'project not found' });
    const convos = db.prepare(
      'SELECT * FROM conversations WHERE project_id = ? ORDER BY COALESCE(last_activity_at, created_at) DESC, created_at DESC'
    ).all(projectId);
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

    const token = (req.headers.authorization as string)?.replace('Bearer ', '') || (req.query as any)?.token;
    let userName: string | undefined;
    if (token) {
      const session = db.prepare(
        `SELECT u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ?`
      ).get(token) as { name: string } | undefined;
      if (session?.name) {
        userName = session.name;
      }
    }

    const docs = db.prepare('SELECT * FROM documents WHERE project_id = ?').all(project.id) as any[];
    const inferFileName = (content: string) => {
      const lowerContent = content.toLowerCase();
      const match = content.match(/([a-zA-Z0-9._-]+\.(py|js|ts|md|txt|json|csv|html|css))/i);
      if (match?.[1]) return match[1];
      if (lowerContent.includes('.py') || lowerContent.includes('python')) return 'script.py';
      if (lowerContent.includes('.js') || lowerContent.includes('javascript')) return 'script.js';
      if (lowerContent.includes('.ts') || lowerContent.includes('typescript')) return 'script.ts';
      if (lowerContent.includes('markdown') || lowerContent.includes('.md')) return 'document.md';
      if (lowerContent.includes('pdf')) return 'document.md';
      if (lowerContent.includes('xlsx') || lowerContent.includes('excel') || lowerContent.includes('spreadsheet')) {
        return 'data.csv';
      }
      if (lowerContent.includes('csv')) return 'data.csv';
      if (lowerContent.includes('json')) return 'data.json';
      if (lowerContent.includes('dokumen') || lowerContent.includes('document')) return 'document.md';
      return 'output.txt';
    };
    const inferMimeType = (name: string) => {
      const lower = name.toLowerCase();
      if (lower.endsWith('.py')) return 'text/x-python; charset=utf-8';
      if (lower.endsWith('.js')) return 'text/javascript; charset=utf-8';
      if (lower.endsWith('.ts')) return 'text/plain; charset=utf-8';
      if (lower.endsWith('.md')) return 'text/markdown; charset=utf-8';
      if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
      if (lower.endsWith('.csv')) return 'text/csv; charset=utf-8';
      if (lower.endsWith('.html')) return 'text/html; charset=utf-8';
      if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
      return 'text/plain; charset=utf-8';
    };
    const normalizeRequestedName = (requestedName: string | undefined, actualName: string | undefined) => {
      const trimmedRequested = (requestedName ?? '').trim();
      const trimmedActual = (actualName ?? '').trim();
      if (!trimmedRequested) return trimmedActual || 'output.txt';
      if (!trimmedActual) return trimmedRequested;
      const requestedExtMatch = trimmedRequested.toLowerCase().match(/(\.[a-z0-9]+)$/);
      const requestedExt = requestedExtMatch?.[1] ?? '';
      const actualHasRequestedExt = requestedExt && trimmedActual.toLowerCase().endsWith(requestedExt);
      if (requestedExt && !actualHasRequestedExt) {
        const base = trimmedActual.replace(/\.[a-z0-9]+$/i, '');
        return `${base}${requestedExt}`;
      }
      return trimmedActual;
    };
    const isMarkdownFile = (name: string, mimeType?: string) =>
      name.toLowerCase().endsWith('.md') || mimeType?.toLowerCase().includes('markdown');
    const isBinaryFile = (name: string, mimeType?: string) => {
      const lower = name.toLowerCase();
      if (lower.endsWith('.docx') || lower.endsWith('.xlsx') || lower.endsWith('.pptx')) return true;
      if (mimeType && !mimeType.startsWith('text/')) return true;
      return false;
    };
    const shouldPreviewMarkdown = (name: string, mimeType?: string) => isMarkdownFile(name, mimeType);
    const decodeBinaryContent = (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return Buffer.from('', 'utf-8');
      const base64Like = /^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.length % 4 === 0;
      if (base64Like) {
        try {
          return Buffer.from(trimmed, 'base64');
        } catch {
          return Buffer.from(trimmed, 'utf-8');
        }
      }
      return Buffer.from(trimmed, 'utf-8');
    };
    const wantsFile =
      Boolean(body.outputFile) ||
      /file|script|kode|program|python|javascript|typescript|markdown|csv|json|pdf|xlsx|excel|spreadsheet|simpan|download|export|hasilkan/i.test(
        body.content
      );
    const outputFileSpec = body.outputFile
      ? {
          name: body.outputFile.name ?? inferFileName(body.content),
          mimeType: body.outputFile.mimeType ?? inferMimeType(body.outputFile.name ?? inferFileName(body.content)),
          content: body.outputFile.content
        }
      : wantsFile
      ? {
          name: inferFileName(body.content),
          mimeType: inferMimeType(inferFileName(body.content))
        }
      : null;
    const fileInstruction = outputFileSpec
      ? '\n\nSaat diminta membuat file, panggil function tool `present_files` untuk mengirim hasil akhir. Isi argumen `response` dengan jawaban singkat dan `files` dengan daftar file berisi `name`, `content`, dan `mimeType` opsional.'
      : '';
    const systemPrompt = buildSystemPrompt(project, docs, userName) + fileInstruction;

    const historyRows = db.prepare(
      `SELECT * FROM messages WHERE conversation_id = ?
       ORDER BY created_at ASC`
    ).all(conversationId) as any[];
    const history = historyRows
      .filter((row) => row.role === 'user' || row.role === 'assistant')
      .map((row) => ({ role: row.role, content: row.content }));

    const now = Date.now();
    const userMessageId = uuidv4();
    const assistantMessageId = uuidv4();
    const messageCategory = classifyMessage(body.content);
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, attachments, metadata, category, created_at)
       VALUES (@id, @conversation_id, @role, @content, @attachments, @metadata, @category, @created_at)`
    ).run({
      id: userMessageId,
      conversation_id: conversationId,
      role: 'user',
      content: body.content,
      attachments: JSON.stringify(body.attachments ?? []),
      metadata: JSON.stringify({}),
      category: messageCategory,
      created_at: now
    });
    db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, attachments, metadata, category, created_at)
       VALUES (@id, @conversation_id, @role, @content, @attachments, @metadata, @category, @created_at)`
    ).run({
      id: assistantMessageId,
      conversation_id: conversationId,
      role: 'assistant',
      content: '',
      attachments: JSON.stringify([]),
      metadata: JSON.stringify({}),
      category: 'normal',
      created_at: Date.now()
    });

    db.prepare('UPDATE conversations SET updated_at = ?, last_activity_at = ? WHERE id = ?').run(Date.now(), now, conversationId);

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

    const globalIntegrations = db.prepare('SELECT * FROM integration_configs WHERE id = ?').get('singleton') as any;
    const slack = globalIntegrations?.slack ? JSON.parse(globalIntegrations.slack) : {};
    const jira = globalIntegrations?.jira ? JSON.parse(globalIntegrations.jira) : {};
    const confluence = globalIntegrations?.confluence ? JSON.parse(globalIntegrations.confluence) : {};
    const services: Array<'slack' | 'atlassian'> = [];
    if (slack?.enabled) services.push('slack');
    if (jira?.enabled || confluence?.enabled) services.push('atlassian');
    const mcpTools = services.length > 0 ? await mcpManager.getTools(services) : undefined;
    const presentFilesTool: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined = outputFileSpec
      ? [{
          type: 'function',
          function: {
            name: 'present_files',
            description: 'Mengirim file final dari AI ke platform.',
            parameters: {
              type: 'object',
              properties: {
                response: { type: 'string' },
                files: {
                  type: 'array',
                  minItems: 1,
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      content: { type: 'string' },
                      mimeType: { type: 'string' }
                    },
                    required: ['name', 'content']
                  }
                }
              },
              required: ['files']
            }
          }
        }]
      : undefined;
    const tools = outputFileSpec ? presentFilesTool : mcpTools;
    const settings = project.settings ? JSON.parse(project.settings) : {};
    const extractFileSections = (text: string) => {
      const fileMarker = /(^|\n)FILE:\s*/i;
      const responseMarker = /(^|\n)RESPONSE:\s*/i;
      const fileIndex = text.search(fileMarker);
      if (fileIndex === -1) {
        return { responseText: text.replace(responseMarker, '').trim(), fileContent: '', hasFile: false };
      }
      const responseText = text
        .slice(0, fileIndex)
        .replace(responseMarker, '')
        .trim();
      const filePart = text.slice(fileIndex).replace(fileMarker, '').trim();
      const fenceMatch = filePart.match(/```(?:[^\n]*)\n([\s\S]*?)```/);
      const fileContent = fenceMatch ? fenceMatch[1].trim() : filePart;
      return { responseText, fileContent, hasFile: true };
    };
    const previewFileId = uuidv4();
    let lastPreviewFileContent = '';
    let presentedResponseText = '';
    let presentedFilePayloads: Array<Record<string, unknown>> = [];
    let usedPresentFiles = false;

    let fullResponse = '';
    try {
      for await (const event of streamMessageWithTools({
        systemPrompt,
        messages: [...history, { role: 'user', content: body.content }],
        tools,
        model: settings.model,
        toolExecutor: tools
          ? async (name, input) => {
              if (outputFileSpec && name === 'present_files') {
                usedPresentFiles = true;
                const payload = (input && typeof input === 'object') ? (input as any) : {};
                const response = typeof payload.response === 'string' ? payload.response.trim() : '';
                if (response) {
                  presentedResponseText = response;
                }
                const rawFiles = Array.isArray(payload.files) ? payload.files : [];
                const nextFiles = rawFiles
                  .filter((file: any) => file && typeof file === 'object')
                  .map((file: any) => ({
                    name: String(file.name ?? '').trim(),
                    content: String(file.content ?? ''),
                    mimeType: typeof file.mimeType === 'string' ? file.mimeType : undefined
                  }))
                  .filter((file: any) => file.name && file.content.length > 0);
                if (nextFiles.length > 0) {
                  presentedFilePayloads = [];
                  for (const file of nextFiles) {
                    const normalizedName = normalizeRequestedName(outputFileSpec.name, file.name);
                    const resolvedMimeType = file.mimeType ?? outputFileSpec.mimeType ?? inferMimeType(normalizedName);
                    const binary = isBinaryFile(normalizedName, resolvedMimeType);
                    const fileId = uuidv4();
                    const filePath = path.join(uploadDir, fileId);
                    const resolvedContent = binary ? decodeBinaryContent(file.content) : file.content;
                    await writeFile(filePath, resolvedContent as any);
                    const size = Buffer.isBuffer(resolvedContent)
                      ? resolvedContent.length
                      : Buffer.byteLength(String(resolvedContent ?? ''), 'utf-8');
                    const payloadFile: Record<string, unknown> = {
                      type: 'file',
                      id: fileId,
                      name: normalizedName || `assistant-${fileId}.txt`,
                      mimeType: resolvedMimeType || 'text/plain; charset=utf-8',
                      size,
                      url: `/api/conversations/${conversationId}/files/${fileId}`,
                    };
                    if (shouldPreviewMarkdown(normalizedName, resolvedMimeType) && typeof file.content === 'string') {
                      payloadFile.content = file.content;
                    }
                    presentedFilePayloads.push(payloadFile);
                  }
                    db.prepare('UPDATE messages SET attachments = ? WHERE id = ?').run(
                      JSON.stringify(presentedFilePayloads),
                      assistantMessageId
                    );
                  const latest = presentedFilePayloads[presentedFilePayloads.length - 1] as any;
                  if (latest?.content && latest.content !== lastPreviewFileContent) {
                    lastPreviewFileContent = String(latest.content);
                    reply.raw.write(
                      `data: ${JSON.stringify({
                        type: 'file_preview',
                        file: {
                          id: latest.id,
                          name: latest.name,
                          mimeType: latest.mimeType
                        },
                        content: latest.content,
                        done: false
                      })}\n\n`
                    );
                  }
                }
                return { response: presentedResponseText, files: presentedFilePayloads };
              }
              if (outputFileSpec) {
                return { error: 'Tool not available' };
              }
              return mcpManager.executeTool(name, input);
            }
          : undefined
      })) {
        if (event.type === 'text') {
          fullResponse += event.text;
          if (!outputFileSpec) {
            reply.raw.write(`data: ${JSON.stringify({ type: 'text', text: event.text })}\n\n`);
          } else {
            if (!usedPresentFiles && outputFileSpec && shouldPreviewMarkdown(outputFileSpec.name ?? '', outputFileSpec.mimeType)) {
              const parsedSections = extractFileSections(fullResponse);
              if (parsedSections.hasFile && parsedSections.fileContent !== lastPreviewFileContent) {
                lastPreviewFileContent = parsedSections.fileContent;
                reply.raw.write(
                  `data: ${JSON.stringify({
                    type: 'file_preview',
                    file: {
                      id: previewFileId,
                      name: outputFileSpec.name ?? `assistant-${previewFileId}.txt`,
                      mimeType: outputFileSpec.mimeType ?? 'text/plain; charset=utf-8'
                    },
                    content: parsedSections.fileContent,
                    done: false
                  })}\n\n`
                );
              }
            }
          }
        } else if (event.type === 'tool_use') {
          reply.raw.write(`data: ${JSON.stringify({ type: 'tool_use', name: event.name })}\n\n`);
        } else if (event.type === 'tool_result') {
          reply.raw.write(`data: ${JSON.stringify({ type: 'tool_result', name: event.name, content: event.output })}\n\n`);
        }
      }
    } catch (error: any) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: error?.message ?? 'stream error' })}\n\n`);
      reply.raw.end();
      return;
    }

    let responseText = fullResponse;
    let fileContent = '';
    try {
      let resolvedName = outputFileSpec?.name ?? `assistant-${previewFileId}.txt`;
      let resolvedMimeType = outputFileSpec?.mimeType ?? inferMimeType(resolvedName);
      const parsedSections = outputFileSpec
        ? extractFileSections(fullResponse)
        : { responseText: fullResponse, fileContent: '', hasFile: false };
      responseText = outputFileSpec
        ? (parsedSections.hasFile ? parsedSections.responseText : '')
        : parsedSections.responseText;
      fileContent = outputFileSpec
        ? (parsedSections.hasFile ? parsedSections.fileContent : fullResponse)
        : parsedSections.fileContent;
      if (outputFileSpec && presentedFilePayloads.length > 0) {
        const lastPayload = presentedFilePayloads[presentedFilePayloads.length - 1] as any;
        resolvedName = String(lastPayload?.name ?? resolvedName);
        resolvedMimeType = String(lastPayload?.mimeType ?? resolvedMimeType);
        responseText = presentedResponseText || responseText || `File ${resolvedName} berhasil dibuat.`;
      } else if (outputFileSpec) {
        const fallbackText = fullResponse.trim();
        if (!fileContent.trim()) {
          fileContent = fallbackText;
        }
        if (!responseText.trim()) {
          responseText = `File ${resolvedName} berhasil dibuat.`;
        }
      }
      if (outputFileSpec && responseText) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'text', text: responseText })}\n\n`);
      }

      const assistantAttachments: Array<Record<string, unknown>> = [];
      const assistantCategory = classifyMessage(responseText);
      db.prepare(
        `UPDATE messages SET content = ?, metadata = ?, category = ? WHERE id = ?`
      ).run(
        responseText,
        JSON.stringify({ model: settings.model ?? 'claude-sonnet-4-6' }),
        assistantCategory,
        assistantMessageId
      );
      if (outputFileSpec && presentedFilePayloads.length > 0) {
        assistantAttachments.push(...presentedFilePayloads);
        db.prepare('UPDATE messages SET attachments = ? WHERE id = ?').run(
          JSON.stringify(assistantAttachments),
          assistantMessageId
        );
      } else if (outputFileSpec) {
        const fileId = uuidv4();
        const fileName = resolvedName;
        const filePath = path.join(uploadDir, fileId);
        const resolvedContent = outputFileSpec.content ?? fileContent ?? fullResponse;
        const mimeType = resolvedMimeType || 'text/plain; charset=utf-8';
        const binary = isBinaryFile(fileName, mimeType);
        const writeContent = binary ? decodeBinaryContent(String(resolvedContent ?? '')) : (resolvedContent ?? '');
        await writeFile(filePath, writeContent as any);
        const size = Buffer.isBuffer(writeContent)
          ? writeContent.length
          : Buffer.byteLength(String(writeContent ?? ''), 'utf-8');
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
        const filePayload: Record<string, unknown> = {
          type: 'file',
          id: fileId,
          name: fileName,
          mimeType,
          size,
          url: `/api/conversations/${conversationId}/files/${fileId}`
        };
        if (shouldPreviewMarkdown(fileName, mimeType)) {
          filePayload.content = String(resolvedContent ?? '');
        }
        assistantAttachments.push(filePayload);
        db.prepare('UPDATE messages SET attachments = ? WHERE id = ?').run(
          JSON.stringify(assistantAttachments),
          assistantMessageId
        );
        reply.raw.write(`data: ${JSON.stringify({ type: 'file', file: filePayload })}\n\n`);
      }
    } catch (error: any) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', message: error?.message ?? 'file generation error' })}\n\n`);
    }

    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversationId);
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  });

  app.put('/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { title?: string };
    const convo = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;
    if (!convo) return reply.status(404).send({ error: 'conversation not found' });
    const title = body?.title ?? convo.title;
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
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
