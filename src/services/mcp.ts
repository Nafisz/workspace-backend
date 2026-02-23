import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

function convertMCPToolToAnthropic(tool: any): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema ?? tool.input_schema ?? { type: 'object', properties: {} }
  } as Anthropic.Tool;
}

class MCPManager {
  private clients: Map<string, Client> = new Map();

  async connect(service: 'slack' | 'atlassian') {
    const urls = {
      slack: process.env.SLACK_MCP_URL,
      atlassian: process.env.ATLASSIAN_MCP_URL
    };
    const url = urls[service];
    if (!url) throw new Error(`Missing MCP URL for ${service}`);
    const client = new Client({ name: 'novax-backend', version: '1.0.0' });
    const headers =
      service === 'slack'
        ? { Authorization: `Bearer ${process.env.SLACK_TOKEN ?? ''}` }
        : { Authorization: `Bearer ${process.env.ATLASSIAN_TOKEN ?? ''}` };
    const transport = new SSEClientTransport(new URL(url), { headers } as any);
    await client.connect(transport);
    this.clients.set(service, client);
    return client;
  }

  async getTools(services: Array<'slack' | 'atlassian'>): Promise<Anthropic.Tool[]> {
    const tools: Anthropic.Tool[] = [];
    for (const service of services) {
      const client = this.clients.get(service) ?? (await this.connect(service));
      const { tools: mcpTools } = await client.listTools();
      tools.push(...mcpTools.map(convertMCPToolToAnthropic));
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
}

export const mcpManager = new MCPManager();
