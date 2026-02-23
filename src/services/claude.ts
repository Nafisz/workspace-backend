import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function buildSystemPrompt(project: any, projectDocs: any[]) {
  const docsContext = projectDocs
    .filter((doc) => doc.content)
    .map((doc) => `## ${doc.name}\n${doc.content}`)
    .join('\n\n---\n\n');

  const basePrompt = project.system_prompt ?? '';
  const knowledge = docsContext ? `## Project Knowledge Base\n${docsContext}` : '';
  const dateString = new Date().toLocaleDateString('id-ID', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  return `${basePrompt}\n\n${knowledge}\n\nHari ini: ${dateString}`.trim();
}

type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown };

export async function* streamMessageWithTools(params: {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: any }>;
  tools?: Anthropic.Tool[];
  model?: string;
  toolExecutor?: (name: string, input: unknown) => Promise<unknown>;
}): AsyncGenerator<StreamEvent> {
  let currentMessages = params.messages;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
    let assistantText = '';
    let currentTool: { id: string; name: string; inputJson: string } | null = null;

    const stream = await client.messages.stream({
      model: params.model ?? 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: params.systemPrompt,
      messages: currentMessages as any,
      tools: params.tools
    });

    for await (const event of stream as any) {
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        currentTool = {
          id: event.content_block.id,
          name: event.content_block.name,
          inputJson: ''
        };
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta?.text) {
          assistantText += delta.text;
          yield { type: 'text', text: delta.text };
        }
        if (currentTool && typeof delta?.partial_json === 'string') {
          currentTool.inputJson += delta.partial_json;
        }
      } else if (event.type === 'content_block_stop' && currentTool) {
        let input: unknown = {};
        try {
          input = currentTool.inputJson ? JSON.parse(currentTool.inputJson) : {};
        } catch {
          input = currentTool.inputJson;
        }
        toolUses.push({ id: currentTool.id, name: currentTool.name, input });
        yield { type: 'tool_use', name: currentTool.name, input };
        currentTool = null;
      }
    }

    if (toolUses.length === 0) break;
    if (!params.toolExecutor) break;

    const toolResults = [];
    for (const toolUse of toolUses) {
      const result = await params.toolExecutor(toolUse.name, toolUse.input);
      const content = typeof result === 'string' ? result : JSON.stringify(result);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content
      });
      yield { type: 'tool_result', name: toolUse.name, output: result };
    }

    const assistantContent: any[] = [];
    if (assistantText) assistantContent.push({ type: 'text', text: assistantText });
    for (const toolUse of toolUses) {
      assistantContent.push({
        type: 'tool_use',
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input
      });
    }

    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: toolResults }
    ];
  }
}
