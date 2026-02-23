# NovaX Backend — Implementation Plan (Minimalis)

Dokumen ini adalah blueprint backend untuk **NovaX Cowork + Projects**. Backend ini menggantikan OpenClaw dengan server custom yang ringan, cukup untuk kebutuhan internal team.

> **Scope:** Internal team, bukan production publik. Prioritas: cepat jalan, mudah di-maintain, cukup fitur.

---

## 1. Stack & Arsitektur

| Layer | Technology | Alasan |
|-------|-----------|--------|
| Runtime | **Node.js 22 + TypeScript** | Familiar, ecosystem lengkap |
| Framework | **Fastify** | Lebih cepat dari Express, built-in schema validation |
| WebSocket | **@fastify/websocket** | Integrated, tanpa library terpisah |
| Database | **SQLite via better-sqlite3** | Zero setup, file-based, cukup untuk team kecil |
| AI | **Anthropic SDK** (claude-sonnet-4-6) | Langsung ke Claude API |
| MCP Client | **@modelcontextprotocol/sdk** | Untuk integrasi Atlassian & Slack |
| File Storage | Filesystem lokal (`./data/uploads/`) | Simple, no S3 needed |
| Auth | API Key statis di `.env` | Internal team, tidak perlu OAuth |

### Struktur Folder

```
novax-backend/
├── src/
│   ├── index.ts              # Entry point, Fastify setup
│   ├── db/
│   │   ├── schema.sql        # Schema SQLite
│   │   └── client.ts         # DB singleton
│   ├── routes/
│   │   ├── projects.ts       # CRUD projects
│   │   ├── conversations.ts  # Chat + streaming
│   │   ├── cowork.ts         # Task execution
│   │   ├── documents.ts      # Upload/delete docs
│   │   └── integrations.ts   # Slack/Jira/Confluence config
│   ├── services/
│   │   ├── claude.ts         # Anthropic SDK wrapper
│   │   ├── mcp.ts            # MCP client manager
│   │   └── cowork-runner.ts  # Task execution engine
│   ├── ws/
│   │   └── handler.ts        # WebSocket event handler
│   └── lib/
│       ├── auth.ts           # API key middleware
│       └── file-parser.ts    # Parse uploaded docs ke text
├── data/                     # Gitignored
│   ├── novax.db
│   └── uploads/
├── .env
├── package.json
└── tsconfig.json
```

---

## 2. Database Schema (SQLite)

```sql
-- src/db/schema.sql

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT DEFAULT '📁',
  color       TEXT DEFAULT '#6366f1',
  system_prompt TEXT DEFAULT '',
  settings    TEXT DEFAULT '{}',   -- JSON: model, temperature, maxTokens, autoApprove
  integrations TEXT DEFAULT '{}',  -- JSON: {jira, confluence, slack}
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,       -- 'file' | 'url' | 'text' | 'confluence_page' | 'jira_filter'
  content     TEXT,               -- extracted text content
  url         TEXT,
  file_path   TEXT,               -- path di ./data/uploads/
  size        INTEGER DEFAULT 0,
  metadata    TEXT DEFAULT '{}',
  uploaded_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  is_starred  INTEGER DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,   -- 'user' | 'assistant' | 'system'
  content        TEXT NOT NULL,
  attachments    TEXT DEFAULT '[]',
  metadata       TEXT DEFAULT '{}', -- model, tokens, duration, toolCalls
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cowork_tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id),
  title         TEXT NOT NULL,
  description   TEXT,
  status        TEXT DEFAULT 'queued',  -- queued|planning|executing|paused|confirming|completed|failed
  plan          TEXT DEFAULT '{}',      -- JSON: {thinking, steps, estimatedDuration}
  artifacts     TEXT DEFAULT '[]',
  pending_actions TEXT DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS integration_configs (
  id        TEXT PRIMARY KEY DEFAULT 'singleton',
  slack     TEXT DEFAULT '{}',    -- {token, defaultChannel}
  jira      TEXT DEFAULT '{}',    -- {baseUrl, token, email}
  confluence TEXT DEFAULT '{}'    -- {baseUrl, token, email}
);

-- Seed default integration config row
INSERT OR IGNORE INTO integration_configs (id) VALUES ('singleton');
```

---

## 3. Environment & Config

```bash
# .env
PORT=8080
API_KEY=novax-internal-secret-key-ganti-ini

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# MCP — Atlassian (Jira + Confluence)
ATLASSIAN_MCP_URL=https://mcp.atlassian.com/v1/mcp
ATLASSIAN_TOKEN=your-atlassian-api-token
ATLASSIAN_EMAIL=your@email.com

# MCP — Slack
SLACK_MCP_URL=https://mcp.slack.com/mcp
SLACK_TOKEN=xoxb-your-slack-bot-token

# File storage
UPLOAD_DIR=./data/uploads
MAX_FILE_SIZE_MB=10
```

---

## 4. Authentication

Semua request harus menyertakan header `X-API-Key`. Simple, cukup untuk internal.

```typescript
// src/lib/auth.ts
import { FastifyRequest, FastifyReply } from 'fastify';

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const key = req.headers['x-api-key'];
  if (key !== process.env.API_KEY) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}
```

Frontend cukup hardcode key di env Tauri: `VITE_API_KEY=novax-internal-...`

---

## 5. REST API Routes

### 5A. Projects

```
GET    /api/projects              → list semua projects
POST   /api/projects              → create project
GET    /api/projects/:id          → detail project + docs + convos (tanpa messages)
PUT    /api/projects/:id          → update project
DELETE /api/projects/:id          → delete project
```

**POST /api/projects body:**
```json
{
  "name": "Backend API",
  "description": "...",
  "icon": "🔧",
  "color": "#6366f1",
  "system_prompt": "Kamu adalah senior backend engineer...",
  "settings": { "model": "claude-sonnet-4-6", "temperature": 0.7, "autoApprove": false }
}
```

### 5B. Documents

```
POST   /api/projects/:id/documents         → upload file (multipart) atau add URL/text
DELETE /api/projects/:id/documents/:docId  → hapus dokumen
```

Upload flow: file di-save ke `./data/uploads/{docId}`, lalu di-parse ke plain text dan disimpan di kolom `content`. Format yang didukung: `.txt`, `.md`, `.pdf` (via `pdf-parse`), `.docx` (via `mammoth`).

### 5C. Conversations & Chat

```
GET    /api/projects/:id/conversations             → list conversations
POST   /api/projects/:id/conversations             → create conversation baru
DELETE /api/conversations/:id                      → delete conversation
GET    /api/conversations/:id/messages             → get messages (paginated, default limit 50)
POST   /api/conversations/:id/messages             → send message (streaming SSE)
```

**POST /api/conversations/:id/messages** — ini endpoint utama chat. Menggunakan **Server-Sent Events (SSE)** untuk streaming, bukan WebSocket (lebih simple untuk REST pattern):

```typescript
// Pseudocode: route handler
async function sendMessage(req, reply) {
  const { content, attachments } = req.body;
  const conversation = db.getConversation(req.params.id);
  const project = db.getProject(conversation.project_id);
  
  // Build context: system prompt + project docs + conversation history
  const systemPrompt = buildSystemPrompt(project);
  const history = db.getMessages(conversation.id);
  
  // Save user message
  const userMsg = db.saveMessage({ role: 'user', content, ... });
  
  // Stream dari Claude
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  
  const stream = await claudeService.streamMessage({
    systemPrompt,
    messages: [...history, { role: 'user', content }],
    tools: getMCPTools(project.integrations),  // inject Slack/Jira/Confluence tools
    model: project.settings.model,
  });
  
  let fullResponse = '';
  for await (const chunk of stream) {
    reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    fullResponse += chunk.text ?? '';
  }
  
  // Save assistant message
  db.saveMessage({ role: 'assistant', content: fullResponse, ... });
  reply.raw.end();
}
```

### 5D. Cowork Tasks

```
GET    /api/cowork/tasks              → list tasks (filter: status, projectId)
POST   /api/cowork/tasks              → create & queue task
GET    /api/cowork/tasks/:id          → detail task + steps + artifacts
POST   /api/cowork/tasks/:id/pause    → pause task
POST   /api/cowork/tasks/:id/cancel   → cancel task
POST   /api/cowork/tasks/:id/resume   → resume task
POST   /api/cowork/tasks/:id/approve/:actionId  → approve pending action
```

### 5E. Integrations Config

```
GET    /api/integrations         → get current integration configs (tokens di-mask)
PUT    /api/integrations/slack   → update Slack config
PUT    /api/integrations/jira    → update Jira config  
PUT    /api/integrations/confluence → update Confluence config
GET    /api/integrations/test    → test semua koneksi, return status tiap integration
```

---

## 6. WebSocket — Real-time Updates

WebSocket di `ws://localhost:8080/ws` digunakan **hanya untuk push events** dari server ke client (one-way broadcast). Chat streaming tetap via SSE.

```typescript
// Event types yang di-broadcast via WS
type WSEvent =
  | { type: 'task:status_changed'; taskId: string; status: string }
  | { type: 'task:step_update'; taskId: string; step: TaskStep }
  | { type: 'task:pending_action'; taskId: string; action: PendingAction }
  | { type: 'task:completed'; taskId: string; artifacts: TaskArtifact[] }
  | { type: 'task:failed'; taskId: string; error: string }
  | { type: 'integration:connected'; service: string }
  | { type: 'ping' };
```

Client (frontend existing) connect ke WS, listen events, update UI accordingly. Tidak perlu kirim command via WS — semua command tetap via REST.

---

## 7. Claude Integration (claude.ts)

```typescript
// src/services/claude.ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export function buildSystemPrompt(project: Project, projectDocs: Document[]): string {
  const docsContext = projectDocs
    .filter(d => d.content)
    .map(d => `## ${d.name}\n${d.content}`)
    .join('\n\n---\n\n');

  return `${project.system_prompt}

${docsContext ? `## Project Knowledge Base\n${docsContext}` : ''}

Hari ini: ${new Date().toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
}

export async function* streamMessage(params: {
  systemPrompt: string;
  messages: { role: string; content: string }[];
  tools?: Anthropic.Tool[];
  model?: string;
}) {
  const stream = await client.messages.stream({
    model: params.model ?? 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: params.systemPrompt,
    messages: params.messages as any,
    tools: params.tools,
  });

  for await (const event of stream) {
    yield event;
  }
}
```

---

## 8. MCP Integration (mcp.ts)

Backend menggunakan **MCP sebagai tool provider** untuk Claude. Ketika project punya integrasi Slack/Jira/Confluence aktif, tools dari MCP server di-inject ke setiap Claude API call.

```typescript
// src/services/mcp.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

class MCPManager {
  private clients: Map<string, Client> = new Map();

  async connect(service: 'slack' | 'atlassian') {
    const urls = {
      slack: process.env.SLACK_MCP_URL!,
      atlassian: process.env.ATLASSIAN_MCP_URL!,
    };

    const client = new Client({ name: 'novax-backend', version: '1.0.0' });
    const transport = new SSEClientTransport(new URL(urls[service]), {
      // inject auth token via header
      headers: service === 'slack'
        ? { Authorization: `Bearer ${process.env.SLACK_TOKEN}` }
        : { Authorization: `Bearer ${process.env.ATLASSIAN_TOKEN}` }
    });

    await client.connect(transport);
    this.clients.set(service, client);
    return client;
  }

  async getTools(services: string[]): Promise<Anthropic.Tool[]> {
    const tools: Anthropic.Tool[] = [];
    for (const service of services) {
      const client = this.clients.get(service) ?? await this.connect(service as any);
      const { tools: mcpTools } = await client.listTools();
      // Convert MCP tool format → Anthropic tool format
      tools.push(...mcpTools.map(convertMCPToolToAnthropic));
    }
    return tools;
  }

  async executeTool(name: string, input: unknown): Promise<unknown> {
    // Route tool call ke client yang tepat berdasarkan nama tool
    for (const [, client] of this.clients) {
      try {
        const result = await client.callTool({ name, arguments: input as any });
        return result;
      } catch { continue; }
    }
    throw new Error(`Tool ${name} not found in any MCP client`);
  }
}

export const mcpManager = new MCPManager();
```

**Cara kerjanya di chat:** Claude menerima list tools dari MCP, bisa memanggil `create_jira_issue`, `send_slack_message`, `get_confluence_page`, dll. Backend intercept tool calls dari Claude stream, execute via MCP, return result ke Claude, lalu Claude lanjut generate response.

---

## 9. Cowork Runner (cowork-runner.ts)

Cowork task dijalankan sebagai **async job** di background. Tidak perlu job queue library — cukup pakai Map in-memory untuk track running tasks.

```typescript
// src/services/cowork-runner.ts
import { EventEmitter } from 'events';

export const taskEvents = new EventEmitter(); // broadcast ke WS

const runningTasks = new Map<string, AbortController>();

export async function startTask(taskId: string) {
  const task = db.getTask(taskId);
  const ac = new AbortController();
  runningTasks.set(taskId, ac);
  
  db.updateTask(taskId, { status: 'planning', started_at: Date.now() });
  taskEvents.emit('task:status_changed', { taskId, status: 'planning' });

  try {
    // Phase 1: Planning — Claude membuat plan
    const plan = await generatePlan(task, ac.signal);
    db.updateTask(taskId, { plan, status: 'executing' });
    taskEvents.emit('task:status_changed', { taskId, status: 'executing' });

    // Phase 2: Executing — jalankan tiap step
    for (const step of plan.steps) {
      if (ac.signal.aborted) break;

      // Update step status
      taskEvents.emit('task:step_update', { taskId, step: { ...step, status: 'running' } });

      // Jika step butuh approval
      if (step.requiresApproval && !task.settings?.autoApprove) {
        db.addPendingAction(taskId, step);
        taskEvents.emit('task:pending_action', { taskId, action: step });
        await waitForApproval(taskId, step.id, ac.signal);
      }

      // Execute step via Claude + MCP tools
      const result = await executeStep(step, task, ac.signal);
      taskEvents.emit('task:step_update', { taskId, step: { ...step, status: 'done', result } });
    }

    db.updateTask(taskId, { status: 'completed', completed_at: Date.now() });
    taskEvents.emit('task:completed', { taskId });

  } catch (err: any) {
    if (!ac.signal.aborted) {
      db.updateTask(taskId, { status: 'failed' });
      taskEvents.emit('task:failed', { taskId, error: err.message });
    }
  } finally {
    runningTasks.delete(taskId);
  }
}

export function pauseTask(taskId: string) {
  const ac = runningTasks.get(taskId);
  if (ac) {
    ac.abort();
    db.updateTask(taskId, { status: 'paused' });
    taskEvents.emit('task:status_changed', { taskId, status: 'paused' });
  }
}
```

---

## 10. Frontend — Perubahan yang Diperlukan

Perubahan di frontend **minimal** karena contract API-nya sama dengan yang sudah direncanakan di `implementation_plan.md`. Yang perlu diubah:

| Sebelum (OpenClaw) | Sesudah (Backend Custom) |
|---|---|
| WebSocket ke `ws://localhost:8080` untuk chat | SSE ke `http://localhost:8080/api/conversations/:id/messages` |
| `useOpenClaw` hook | `useChatStream` hook baru (fetch + ReadableStream) |
| WS untuk semua events | WS hanya untuk cowork task events |
| Auth: tidak ada | Auth: `X-API-Key` header di semua request |

**Contoh `useChatStream` di frontend:**
```typescript
async function sendMessage(conversationId: string, content: string) {
  const response = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'X-API-Key': import.meta.env.VITE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    // Parse SSE events dan update UI
    parseSSEChunk(chunk);
  }
}
```

---

## 11. Implementation Phases

### Phase 1: Core Setup (Est. 1 hari)
- [ ] Init project: `npm init`, install dependencies, setup tsconfig
- [ ] Setup Fastify + SQLite + schema migration
- [ ] Auth middleware
- [ ] Dockerfile sederhana (optional, untuk deploy ke server tim)

**Dependencies:**
```bash
npm i fastify @fastify/websocket @fastify/multipart @fastify/cors fastify-plugin
npm i @anthropic-ai/sdk @modelcontextprotocol/sdk
npm i better-sqlite3 uuid
npm i pdf-parse mammoth  # document parsing
npm i -D typescript @types/node @types/better-sqlite3 tsx nodemon
```

### Phase 2: Projects & Documents (Est. 1 hari)
- [ ] CRUD routes untuk projects
- [ ] Upload + parsing dokumen (PDF, DOCX, MD, TXT)
- [ ] List + delete conversations

### Phase 3: Chat + Claude Streaming (Est. 1-2 hari)
- [ ] `claude.ts` service (build system prompt, stream messages)
- [ ] Handle tool use loop (Claude → MCP tool → Claude) dalam stream
- [ ] SSE streaming route `/api/conversations/:id/messages`
- [ ] Save messages ke DB

### Phase 4: MCP Integration (Est. 1 hari)
- [ ] `mcp.ts` — connect ke Atlassian + Slack MCP servers
- [ ] `convertMCPToolToAnthropic()` helper
- [ ] Tool execution routing
- [ ] Integration config routes + test endpoint

### Phase 5: Cowork (Est. 1-2 hari)
- [ ] CRUD routes untuk tasks
- [ ] `cowork-runner.ts` — planning + execution engine
- [ ] WebSocket broadcast untuk task events
- [ ] Approval flow (pause → wait → resume)

### Phase 6: Polish & Connect ke Frontend (Est. 0.5 hari)
- [ ] CORS config untuk Tauri (allow `tauri://localhost`)
- [ ] Error handling konsisten
- [ ] Logging sederhana (pino)
- [ ] Test semua endpoints manual (Postman/curl)

**Total estimasi: ~7-8 hari kerja**

---

## 12. Cara Run

```bash
# Development
cp .env.example .env  # isi API keys
npm run dev           # nodemon + tsx

# Production (internal server)
npm run build         # tsc → dist/
node dist/index.js

# Atau pakai PM2
pm2 start dist/index.js --name novax-backend
```

Frontend Tauri: ubah `VITE_BACKEND_URL=http://localhost:8080` dan `VITE_API_KEY=...` di `.env`.

---

## 13. Catatan Penting

**Apa yang sengaja TIDAK diimplementasi (YAGNI untuk internal):**
- User auth / multi-user sessions — semua pakai satu API key
- Rate limiting — tidak perlu untuk internal
- Database backup otomatis — cukup commit `novax.db` secara berkala atau rsync
- File storage cloud — lokal sudah cukup
- Redis / job queue — AbortController in-memory sudah cukup untuk team kecil
- Unit tests — manual testing dulu, tambah kalau ada bug recurring

