import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { mkdir, access } from 'fs/promises';
import path from 'path';
import { authMiddleware } from './lib/auth.js';
import { initDb } from './db/client.js';
import projectsRoutes from './routes/projects.js';
import documentsRoutes from './routes/documents.js';
import conversationsRoutes from './routes/conversations.js';
import integrationsRoutes from './routes/integrations.js';
import coworkRoutes from './routes/cowork.js';
import registerWs from './ws/handler.js';

const server = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

const uploadDir = process.env.UPLOAD_DIR ?? './data/uploads';
const resolvedUploadDir = path.resolve(process.cwd(), uploadDir);

await initDb();

try {
  await access(resolvedUploadDir);
} catch {
  await mkdir(resolvedUploadDir, { recursive: true });
}

const allowedOrigins: (string | RegExp)[] = [
  /^tauri:\/\/localhost$/,
  /^http:\/\/localhost:\d+$/,
  /^https:\/\/localhost:\d+$/,
  'file://'
];

if (process.env.CORS_ALLOW_ORIGIN) {
  allowedOrigins.push(process.env.CORS_ALLOW_ORIGIN);
}

await server.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    
    // Check if origin matches any rule
    const isAllowed = allowedOrigins.some((rule) => {
      if (typeof rule === 'string') {
        return rule === origin || rule === '*';
      }
      return rule.test(origin);
    });

    if (isAllowed) return cb(null, true);
    
    cb(null, false);
  }
});
await server.register(multipart, {
  limits: {
    fileSize: (Number(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024
  }
});
await server.register(websocket);

await registerWs(server);

server.setErrorHandler((error, req, reply) => {
  req.log.error(error);
  const err = error as any;
  const status = err?.statusCode ?? 500;
  const message = status >= 500 ? 'Internal Server Error' : err?.message ?? 'Error';
  reply.status(status).send({ error: message });
});

server.setNotFoundHandler((req, reply) => {
  reply.status(404).send({ error: 'Not Found' });
});

await server.register(async (app) => {
  app.get('/', async () => ({
    name: 'novax-backend',
    status: 'ok',
    routes: ['/api/projects', '/api/projects/:id', '/api/cowork/tasks', '/api/integrations']
  }));
  app.addHook('preHandler', authMiddleware);
  await app.register(projectsRoutes, { prefix: '/projects' });
  await app.register(documentsRoutes, { prefix: '/projects' });
  await app.register(conversationsRoutes, { prefix: '/' });
  await app.register(integrationsRoutes, { prefix: '/' });
  await app.register(coworkRoutes, { prefix: '/' });
}, { prefix: '/api' });

server.get('/health', async () => ({ status: 'ok' }));

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '0.0.0.0';

await server.listen({ port, host });
