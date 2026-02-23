import OpenAI from 'openai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDb } from '../db/client.js';

function convertMCPToolToOpenAI(tool: any): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema ?? tool.input_schema ?? { type: 'object', properties: {} }
    }
  };
}

class MCPManager {
  private clients: Map<string, Client> = new Map();

  private getConfig() {
    try {
      const db = getDb();
      const row = db.prepare('SELECT * FROM integration_configs WHERE id = ?').get('singleton') as any;
      return {
        slack: row?.slack ? JSON.parse(row.slack) : {},
        jira: row?.jira ? JSON.parse(row.jira) : {},
        confluence: row?.confluence ? JSON.parse(row.confluence) : {}
      };
    } catch (error) {
      console.warn('Failed to load integration config from DB:', error);
      return { slack: {}, jira: {}, confluence: {} };
    }
  }

  async connect(service: 'slack' | 'atlassian') {
    const urls = {
      slack: process.env.SLACK_MCP_URL,
      atlassian: process.env.ATLASSIAN_MCP_URL
    };
    const url = urls[service];
    if (!url) throw new Error(`Missing MCP URL for ${service}`);

    // Load config from DB, fallback to env vars
    const dbConfig = this.getConfig();
    let token = '';
    
    if (service === 'slack') {
      token = dbConfig.slack.token || process.env.SLACK_TOKEN || '';
    } else if (service === 'atlassian') {
      // Prefer Jira token, then Confluence token, then env var
      token = dbConfig.jira.token || dbConfig.confluence.token || process.env.ATLASSIAN_TOKEN || '';
    }

    const client = new Client({ name: 'novax-backend', version: '1.0.0' });
    const headers = { Authorization: `Bearer ${token}` };
    
    const transport = new SSEClientTransport(new URL(url), { headers } as any);
    await client.connect(transport);
    this.clients.set(service, client);
    return client;
  }

  async getTools(services: Array<'slack' | 'atlassian'>): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]> {
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
    for (const service of services) {
      // Always reconnect to pick up latest config if not connected, 
      // or we could implement logic to force reconnect if config changed.
      // For now, let's assume we reuse connections but if it fails we might need to retry.
      // Simple approach: get existing or connect.
      // TODO: If token changes in DB, we won't know until restart or simple reconnect logic.
      // For this MVP, we will rely on the cached client. 
      // If the user updates the token, they might expect immediate effect.
      // Let's clear the client from the map if we want to force refresh, 
      // but for now let's just use what we have.
      const client = this.clients.get(service) ?? (await this.connect(service));
      const { tools: mcpTools } = await client.listTools();
      tools.push(...mcpTools.map(convertMCPToolToOpenAI));
    }
    return tools;
  }

  async executeTool(name: string, input: unknown): Promise<unknown> {
    for (const [, client] of this.clients) {
      try {
        const result = await client.callTool({ name, arguments: input as any });
        return result;
      } catch {
        continue;
      }
    }
    throw new Error(`Tool ${name} not found in any MCP client`);
  }
  
  // Method to force reconnect (useful when config updates)
  disconnect(service: 'slack' | 'atlassian') {
    if (this.clients.has(service)) {
        // ideally close connection if supported
        this.clients.delete(service);
    }
  }
}

export const mcpManager = new MCPManager();
