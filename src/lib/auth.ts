import { FastifyReply, FastifyRequest } from 'fastify';

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const key = req.headers['x-api-key'];
  if (key !== process.env.API_KEY) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}
