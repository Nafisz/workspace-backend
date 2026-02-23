import { FastifyInstance } from 'fastify';
import { taskEvents } from '../services/cowork-runner.js';

export default async function registerWs(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (connection, req) => {
    const key = req.headers['x-api-key'] || (req.query as any).token;
    if (key !== process.env.API_KEY) {
      connection.socket.close();
      return;
    }

    const sendEvent = (event: any) => {
      try {
        connection.socket.send(JSON.stringify(event));
      } catch {}
    };

    const statusHandler = (payload: any) => sendEvent({ type: 'task:status_changed', ...payload });
    const stepHandler = (payload: any) => sendEvent({ type: 'task:step_update', ...payload });
    const pendingHandler = (payload: any) => sendEvent({ type: 'task:pending_action', ...payload });
    const completedHandler = (payload: any) => sendEvent({ type: 'task:completed', ...payload });
    const failedHandler = (payload: any) => sendEvent({ type: 'task:failed', ...payload });

    taskEvents.on('task:status_changed', statusHandler);
    taskEvents.on('task:step_update', stepHandler);
    taskEvents.on('task:pending_action', pendingHandler);
    taskEvents.on('task:completed', completedHandler);
    taskEvents.on('task:failed', failedHandler);

    connection.socket.on('close', () => {
      taskEvents.off('task:status_changed', statusHandler);
      taskEvents.off('task:step_update', stepHandler);
      taskEvents.off('task:pending_action', pendingHandler);
      taskEvents.off('task:completed', completedHandler);
      taskEvents.off('task:failed', failedHandler);
    });
  });
}
