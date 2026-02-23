import { FastifyReply, FastifyRequest } from 'fastify';

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  if (!process.env.API_KEY) {
    return;
  }
  const headerKey = req.headers['x-api-key'];
  const authHeader = req.headers.authorization;
  const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : undefined;
  const queryToken = (req.query as { token?: string; api_key?: string; apiKey?: string } | undefined) ?? {};
  const key = headerKey || bearer || queryToken.token || queryToken.api_key || queryToken.apiKey;
  if (key !== process.env.API_KEY) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}
