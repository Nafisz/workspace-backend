import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.FIREWORKS_API_KEY || process.env.OPENAI_API_KEY || 'dummy',
  baseURL: 'https://api.fireworks.ai/inference/v1'
});

const defaultModel =
  process.env.FIREWORKS_MODEL ||
  process.env.OPENAI_MODEL ||
  'accounts/fireworks/models/minimax-m2p5';

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

  const platformInstruction = [
    'Konteks platform:',
    '- Jika diminta membuat/menyimpan file, file harus disimpan ke platform (bukan ke komputer lokal).',
    '- Respons chat dan file harus dipisah: file tidak ditaruh di bubble chat.',
    '- Jika diminta format file, gunakan format teks yang sesuai (.md, .txt, .csv, .json, .html, .css, .py, .js, .ts).',
    '- Jika pengguna menyebut Excel/XLSX, gunakan CSV. Jika menyebut PDF, gunakan Markdown atau TXT.'
  ].join('\n');

  return `${basePrompt}\n\n${knowledge}\n\n${platformInstruction}\n\nHari ini: ${dateString}`.trim();
}

type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown };

export async function* streamMessageWithTools(params: {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: any }>;
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  model?: string;
  toolExecutor?: (name: string, input: unknown) => Promise<unknown>;
}): AsyncGenerator<StreamEvent> {
  // Convert messages to OpenAI format
  let currentMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: params.systemPrompt },
    ...params.messages.map((msg) => {
      if (typeof msg.content === 'string') {
        return { role: msg.role, content: msg.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
      }
      // Handle array content (from previous tool runs)
      if (Array.isArray(msg.content)) {
        // OpenAI expects a single string or array of content parts
        // But for tool results, it's different.
        // Simplified conversion for now:
        const parts = msg.content.map((c: any) => {
            if (c.type === 'text') return c.text;
            return '';
        }).join('\n');
        return { role: msg.role, content: parts } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
      }
      return { role: msg.role, content: String(msg.content) } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    })
  ];

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let assistantText = '';

    const createStream = async (model: string) =>
      client.chat.completions.create({
        model,
        messages: currentMessages,
        tools: params.tools,
        stream: true,
        max_tokens: 4096
      });

    const candidateModels = [
      params.model,
      defaultModel,
      'accounts/fireworks/models/minimax-m2p5',
      'fireworks/minimax-m2p5',
      'accounts/fireworks/models/llama-v3p1-70b-instruct'
    ].filter((model): model is string => Boolean(model));

    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> | null = null;
    let lastError: any = null;
    for (const model of candidateModels) {
      try {
        stream = await createStream(model);
        lastError = null;
        break;
      } catch (error: any) {
        const status = error?.status ?? error?.response?.status;
        const message = String(error?.message ?? '');
        const notFound = status === 404 || message.toLowerCase().includes('model not found');
        if (!notFound) {
          throw error;
        }
        lastError = error;
      }
    }
    if (!stream) {
      throw lastError ?? new Error('model not found');
    }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        assistantText += delta.content;
        yield { type: 'text', text: delta.content };
      }
      if (delta?.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          if (toolCall.id) {
            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function?.name || '',
              arguments: ''
            });
          }
          if (toolCall.function?.arguments) {
            // Find the last tool call (usually the one being streamed)
            // Note: OpenAI can stream multiple tool calls, but usually sequentially or with index
            const index = toolCall.index;
            if (toolCalls[index]) {
                toolCalls[index].arguments += toolCall.function.arguments;
            }
          }
        }
      }
    }

    if (toolCalls.length === 0) break;
    if (!params.toolExecutor) break;

    // Execute tools
    for (const toolCall of toolCalls) {
      let input: unknown = {};
      try {
        input = JSON.parse(toolCall.arguments);
      } catch {
        input = {};
      }
      
      yield { type: 'tool_use', name: toolCall.name, input };

      const result = await params.toolExecutor(toolCall.name, input);
      const content = typeof result === 'string' ? result : JSON.stringify(result);
      
      yield { type: 'tool_result', name: toolCall.name, output: result };
      
      // Append to history
      currentMessages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
            id: toolCall.id,
            type: 'function',
            function: {
                name: toolCall.name,
                arguments: toolCall.arguments
            }
        }]
      });
      
      currentMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content
      });
    }
  }
}
