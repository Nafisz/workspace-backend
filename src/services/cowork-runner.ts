import { EventEmitter } from 'events';
import { getDb } from '../db/client.js';
import { buildSystemPrompt, streamMessageWithTools } from '../services/ai.js';

export const taskEvents = new EventEmitter();

const runningTasks = new Map<string, AbortController>();
const approvalWaiters = new Map<string, (value: boolean) => void>();

function parseJson(value: string | null, fallback: any) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function buildDefaultPlan(task: any) {
  const steps = task.description
    ? task.description
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0)
        .map((line: string, index: number) => ({
          id: `step-${index + 1}`,
          title: line.replace(/^\-\s*/, ''),
          requiresApproval: false,
          status: 'queued'
        }))
    : [
        {
          id: 'step-1',
          title: task.title,
          requiresApproval: false,
          status: 'queued'
        }
      ];

  return {
    thinking: '',
    steps,
    estimatedDuration: 'short',
    settings: { autoApprove: false }
  };
}

function updateTaskFields(taskId: string, fields: Record<string, unknown>) {
  const db = getDb();
  const entries = Object.keys(fields)
    .map((key) => `${key}=@${key}`)
    .join(', ');
  db.prepare(`UPDATE cowork_tasks SET ${entries} WHERE id=@id`).run({ ...fields, id: taskId });
}

export async function startTask(taskId: string) {
  const db = getDb();
  const task = db.prepare('SELECT * FROM cowork_tasks WHERE id = ?').get(taskId) as any;
  if (!task) return;

  const ac = new AbortController();
  runningTasks.set(taskId, ac);

  updateTaskFields(taskId, { status: 'planning', started_at: Date.now() });
  taskEvents.emit('task:status_changed', { taskId, status: 'planning' });

  try {
    const existingPlan = parseJson(task.plan, null);
    const plan = existingPlan ?? buildDefaultPlan(task);
    updateTaskFields(taskId, { plan: JSON.stringify(plan), status: 'executing' });
    taskEvents.emit('task:status_changed', { taskId, status: 'executing' });

    const autoApprove = plan.settings?.autoApprove ?? false;
    for (const step of plan.steps) {
      if (ac.signal.aborted) break;
      taskEvents.emit('task:step_update', { taskId, step: { ...step, status: 'running' } });

      if (step.requiresApproval && !autoApprove) {
        const pending = parseJson(task.pending_actions, []);
        pending.push({ ...step, status: 'pending' });
        updateTaskFields(taskId, { pending_actions: JSON.stringify(pending), status: 'confirming' });
        taskEvents.emit('task:pending_action', { taskId, action: step });
        await waitForApproval(taskId, step.id, ac.signal);
        const refreshed = parseJson(
          (db.prepare('SELECT pending_actions FROM cowork_tasks WHERE id = ?').get(taskId) as any)
            ?.pending_actions,
          []
        );
        updateTaskFields(taskId, { pending_actions: JSON.stringify(refreshed), status: 'executing' });
      }

      const result = { ok: true };
      taskEvents.emit('task:step_update', { taskId, step: { ...step, status: 'done', result } });
    }

    updateTaskFields(taskId, { status: 'completed', completed_at: Date.now() });
    taskEvents.emit('task:completed', { taskId, artifacts: [] });
  } catch (error: any) {
    if (!ac.signal.aborted) {
      updateTaskFields(taskId, { status: 'failed' });
      taskEvents.emit('task:failed', { taskId, error: error?.message ?? 'failed' });
    }
  } finally {
    runningTasks.delete(taskId);
  }
}

export function pauseTask(taskId: string) {
  const ac = runningTasks.get(taskId);
  if (!ac) return;
  ac.abort();
  updateTaskFields(taskId, { status: 'paused' });
  taskEvents.emit('task:status_changed', { taskId, status: 'paused' });
}

export function cancelTask(taskId: string) {
  const ac = runningTasks.get(taskId);
  if (ac) ac.abort();
  updateTaskFields(taskId, { status: 'failed' });
  taskEvents.emit('task:failed', { taskId, error: 'canceled' });
}

export function resumeTask(taskId: string) {
  startTask(taskId);
}

export function approveAction(taskId: string, actionId: string) {
  const db = getDb();
  const row = db.prepare('SELECT pending_actions FROM cowork_tasks WHERE id = ?').get(taskId) as any;
  const pending = parseJson(row?.pending_actions ?? '[]', []);
  const nextPending = pending.filter((item: any) => item.id !== actionId);
  updateTaskFields(taskId, { pending_actions: JSON.stringify(nextPending) });
  const key = `${taskId}:${actionId}`;
  const resolver = approvalWaiters.get(key);
  if (resolver) {
    resolver(true);
    approvalWaiters.delete(key);
  }
}

function waitForApproval(taskId: string, actionId: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const key = `${taskId}:${actionId}`;
    const onAbort = () => {
      approvalWaiters.delete(key);
      reject(new Error('aborted'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    approvalWaiters.set(key, () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}
