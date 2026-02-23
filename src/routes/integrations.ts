import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { getDb } from '../db/client.js';
import { mcpManager } from '../services/mcp.js';

function maskToken(token?: string) {
  if (!token) return '';
  if (token.length <= 8) return `${token[0]}***${token[token.length - 1]}`;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

export default fp(async function integrationsRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get('/integrations', async () => {
    const row = db.prepare('SELECT * FROM integration_configs WHERE id = ?').get('singleton') as any;
    const slack = row?.slack ? JSON.parse(row.slack) : {};
    const jira = row?.jira ? JSON.parse(row.jira) : {};
    const confluence = row?.confluence ? JSON.parse(row.confluence) : {};
    return {
      slack: { ...slack, token: maskToken(slack.token) },
      jira: { ...jira, token: maskToken(jira.token) },
      confluence: { ...confluence, token: maskToken(confluence.token) }
    };
  });

  app.put('/integrations/slack', async (req, reply) => {
    const body = req.body as { token?: string; defaultChannel?: string; enabled?: boolean };
    const payload = { token: body.token, defaultChannel: body.defaultChannel, enabled: body.enabled ?? true };
    db.prepare('UPDATE integration_configs SET slack = ? WHERE id = ?').run(JSON.stringify(payload), 'singleton');
    if (body.token) {
      process.env.SLACK_TOKEN = body.token;
      mcpManager.disconnect('slack'); // Force reconnect with new token
    }
    return reply.send({ ok: true });
  });

  app.put('/integrations/jira', async (req, reply) => {
    const body = req.body as { baseUrl?: string; token?: string; email?: string; enabled?: boolean };
    const payload = { baseUrl: body.baseUrl, token: body.token, email: body.email, enabled: body.enabled ?? true };
    db.prepare('UPDATE integration_configs SET jira = ? WHERE id = ?').run(JSON.stringify(payload), 'singleton');
    if (body.token) {
      process.env.ATLASSIAN_TOKEN = body.token;
      mcpManager.disconnect('atlassian'); // Force reconnect with new token
    }
    if (body.email) process.env.ATLASSIAN_EMAIL = body.email;
    return reply.send({ ok: true });
  });

  app.put('/integrations/confluence', async (req, reply) => {
    const body = req.body as { baseUrl?: string; token?: string; email?: string; enabled?: boolean };
    const payload = { baseUrl: body.baseUrl, token: body.token, email: body.email, enabled: body.enabled ?? true };
    db.prepare('UPDATE integration_configs SET confluence = ? WHERE id = ?').run(JSON.stringify(payload), 'singleton');
    if (body.token) {
      process.env.ATLASSIAN_TOKEN = body.token;
      mcpManager.disconnect('atlassian'); // Force reconnect with new token
    }
    if (body.email) process.env.ATLASSIAN_EMAIL = body.email;
    return reply.send({ ok: true });
  });

  app.get('/integrations/test', async () => {
    const row = db.prepare('SELECT * FROM integration_configs WHERE id = ?').get('singleton') as any;
    const slack = row?.slack ? JSON.parse(row.slack) : {};
    const jira = row?.jira ? JSON.parse(row.jira) : {};
    const confluence = row?.confluence ? JSON.parse(row.confluence) : {};
    const results: Record<string, unknown> = {};

    if (slack?.token && process.env.SLACK_MCP_URL) {
      try {
        const client = await mcpManager.connect('slack');
        const { tools } = await client.listTools();
        results.slack = { ok: true, toolsCount: tools.length };
      } catch (error: any) {
        results.slack = { ok: false, error: error?.message ?? 'error' };
      }
    } else {
      results.slack = { ok: false, error: 'missing config' };
    }

    if ((jira?.token || confluence?.token) && process.env.ATLASSIAN_MCP_URL) {
      try {
        const client = await mcpManager.connect('atlassian');
        const { tools } = await client.listTools();
        results.atlassian = { ok: true, toolsCount: tools.length };
      } catch (error: any) {
        results.atlassian = { ok: false, error: error?.message ?? 'error' };
      }
    } else {
      results.atlassian = { ok: false, error: 'missing config' };
    }

    return results;
  });
});
