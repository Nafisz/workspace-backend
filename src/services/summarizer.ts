import { getDb } from '../db/client.js';
import { streamMessageWithTools } from './ai.js';

const INACTIVITY_THRESHOLD = 5 * 60 * 1000;
const SUMMARIZE_CHECK_INTERVAL = 60 * 1000;

const importantKeywords = [
  'bug', 'error', 'fix', 'important', 'urgent', 'critical',
  'perubahan', 'ubah', 'rubah', 'update', 'ubah', 'modifikasi',
  'fitur', 'feature', 'tambah', 'hapus', 'delete', 'remove',
  'deploy', 'production', 'release', 'versi', 'version',
  'api', 'database', 'security', 'keamanan', 'vulnerability',
  'task', 'tugas', 'job', 'kerja', 'pekerjaan',
  'review', 'cek', 'check', 'validasi', 'validation',
  'requirement', 'kebutuhan', 'spec', 'spesifikasi',
  'decision', 'keputusan', 'approve', 'setuju', 'tolak'
];

function classifyMessage(content: string): 'important' | 'normal' {
  const lowerContent = content.toLowerCase();
  for (const keyword of importantKeywords) {
    if (lowerContent.includes(keyword)) {
      return 'important';
    }
  }
  return 'normal';
}

function buildSummarizePrompt(messages: Array<{ role: string; content: string; name?: string }>, summary?: string): string {
  const historySection = summary
    ? `## Ringkasan Percakapan Sebelumnya\n${summary}\n\n## Percakapan Terbaru\n`
    : '## Percakapan\n';

  const formattedMessages = messages
    .map((msg) => {
      const roleLabel = msg.role === 'user' ? (msg.name || 'Pengguna') : 'AI';
      return `${roleLabel}: ${msg.content}`;
    })
    .join('\n\n');

  return `${historySection}${formattedMessages}\n\nBuat ringkasan dalam bahasa Indonesia yang mencakup:
1. Topik utama yang dibicarakan
2. Keputusan atau kesimpulan penting
3. Action items atau tugas yang perlu dilakukan
4. Informasi teknis penting

Ringkasan harus fokus pada informasi substantif, bukan sekadar perulangan.`;
}

async function generateSummary(conversationId: string, existingSummary?: string): Promise<string> {
  const db = getDb();

  const unsummarizedMessages = db.prepare(
    `SELECT m.*, u.name as user_name
     FROM messages m
     LEFT JOIN users u ON m.role = 'user'
     WHERE m.conversation_id = ? AND m.is_summarized = 0
     ORDER BY m.created_at ASC`
  ).all(conversationId) as any[];

  if (unsummarizedMessages.length === 0) {
    return existingSummary || '';
  }

  const messagesForSummary = unsummarizedMessages.map((msg) => ({
    role: msg.role,
    content: msg.content,
    name: msg.role === 'user' ? msg.user_name : undefined
  }));

  const prompt = buildSummarizePrompt(messagesForSummary, existingSummary);

  let fullResponse = '';
  try {
    for await (const event of streamMessageWithTools({
      systemPrompt: 'Kamu adalah AI asisten yang tugasnya membuat ringkasan percakapan. Buat ringkasan yang jelas, ringkas, dan informatif.',
      messages: [{ role: 'user', content: prompt }]
    })) {
      if (event.type === 'text') {
        fullResponse += event.text;
      }
    }
  } catch (error) {
    console.error(`Error generating summary for conversation ${conversationId}:`, error);
    return existingSummary || '';
  }

  const summarizedIds = unsummarizedMessages.map((msg) => msg.id);
  if (summarizedIds.length > 0) {
    const placeholders = summarizedIds.map(() => '?').join(',');
    db.prepare(
      `UPDATE messages SET is_summarized = 1 WHERE id IN (${placeholders})`
    ).run(...summarizedIds);
  }

  return fullResponse.trim();
}

function checkAndSummarize(): void {
  const db = getDb();
  const now = Date.now();

  const inactiveConversations = db.prepare(
    `SELECT c.*, p.name as project_name
     FROM conversations c
     JOIN projects p ON p.id = c.project_id
     WHERE c.last_activity_at IS NOT NULL
       AND c.last_activity_at < ?
       AND (c.summary IS NULL OR c.last_activity_at > (
         SELECT COALESCE(MAX(m.created_at), 0)
         FROM messages m
         WHERE m.conversation_id = c.id AND m.is_summarized = 1
       ))
     ORDER BY c.last_activity_at ASC
     LIMIT 10`
  ).all(now - INACTIVITY_THRESHOLD) as any[];

  for (const convo of inactiveConversations) {
    const hasImportantMessage = db.prepare(
      `SELECT 1 FROM messages
       WHERE conversation_id = ?
         AND category = 'important'
         AND is_summarized = 0
       LIMIT 1`
    ).get(convo.id);

    if (hasImportantMessage) {
      console.log(`[Summarizer] Summarizing conversation ${convo.id} (project: ${convo.project_name})`);
      generateSummary(convo.id, convo.summary || undefined)
        .then((newSummary) => {
          if (newSummary) {
            db.prepare('UPDATE conversations SET summary = ? WHERE id = ?').run(newSummary, convo.id);
            console.log(`[Summarizer] Summary updated for conversation ${convo.id}`);
          }
        })
        .catch((error) => {
          console.error(`[Summarizer] Failed to summarize conversation ${convo.id}:`, error);
        });
    }
  }
}

export function startSummarizerService(): void {
  console.log('[Summarizer] Service started, checking every', SUMMARIZE_CHECK_INTERVAL / 1000, 'seconds');
  setInterval(checkAndSummarize, SUMMARIZE_CHECK_INTERVAL);
  checkAndSummarize();
}

export { classifyMessage };