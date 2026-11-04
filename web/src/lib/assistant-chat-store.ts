import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanMessages, conversationTitle, MAX_CHAT_BYTES, type ChatMessage } from './assistant-history.ts';
import { tryAcquireDirLockSync } from './core/dir-lock.ts';

export class ChatError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** One stored conversation. */
export interface StoredChat {
  version: 1;
  id: string;
  revision: number;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
}

/** The list-row shape: everything except the messages. */
export type ChatSummary = Omit<StoredChat, "messages">;

/** What a save request carries; validated before use. */
export interface ChatSaveInput {
  revision?: unknown;
  messages?: unknown;
  title?: unknown;
}

function chatPath(root: string, id: unknown): string {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new ChatError('Invalid conversation id');
  return join(root, '.career-ops-web', 'chats', `${id}.json`);
}
export function readChat(root: string, id: string): StoredChat | null {
  const file = chatPath(root, id);
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch (err) { if ((err as { code?: string }).code === 'ENOENT') return null; throw err; }
  try {
    const parsed: unknown = JSON.parse(raw);
    const chat = parsed as Record<string, unknown> | null;
    if (!chat || chat.id !== id || chat.version !== 1 || !Number.isSafeInteger(chat.revision) || (chat.revision as number) < 1
      || typeof chat.title !== 'string' || typeof chat.updatedAt !== 'string') throw new Error('Invalid document');
    return {
      version: 1,
      id,
      revision: chat.revision as number,
      title: chat.title,
      updatedAt: chat.updatedAt,
      messages: cleanMessages(chat.messages),
    };
  } catch { throw new ChatError(`Conversation ${id} is damaged; its file was not changed`, 409); }
}

export function listChats(root: string): { chats: ChatSummary[]; errors: Array<{ id: string; error: string }> } {
  let files: string[];
  try { files = readdirSync(join(root, '.career-ops-web', 'chats')); }
  catch (err) { if ((err as { code?: string }).code === 'ENOENT') return { chats: [], errors: [] }; throw err; }
  const chats: ChatSummary[] = [], errors: Array<{ id: string; error: string }> = [];
  for (const file of files.filter(f => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/.test(f))) {
    const id = file.slice(0, -5);
    try {
      const chat = readChat(root, id);
      if (chat) {
        const { messages: _messages, ...summary } = chat;
        chats.push(summary);
      }
    } catch (err) {
      // Isolate damaged documents, but do not disguise filesystem failures.
      if (!(err instanceof ChatError)) throw err;
      errors.push({ id, error: err.message });
    }
  }
  return { chats: chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), errors };
}

// One lock protocol for the whole web (#5358): the shared dir-lock, not a
// private exclusive-create of a `.lock` file. It carries stale-owner recovery,
// an owner stamp and a release that cannot delete a lock someone else now
// holds — all of which the old file lock lacked.
const CHAT_LOCK_STALE_MS = 15_000;
function withLock<T>(root: string, id: string, operation: (file: string) => T): T {
  const file = chatPath(root, id);
  mkdirSync(join(root, '.career-ops-web', 'chats'), { recursive: true });
  const lock = tryAcquireDirLockSync(`${file}.lock`, { staleMs: CHAT_LOCK_STALE_MS, createParent: true });
  if (!lock) throw new ChatError('Conversation is busy; retry saving', 409);
  try { return operation(file); }
  finally { lock.release(); }
}

export function saveChat(root: string, id: string, input: ChatSaveInput | null | undefined): StoredChat {
  if (!input || !Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new ChatError('Conversation revision required');
  const revision = input.revision as number;
  let messages: ChatMessage[];
  try { messages = cleanMessages(input.messages); }
  catch (err) { throw new ChatError(err instanceof Error ? err.message : String(err)); }
  if (!messages.some(m => m.role === 'user')) throw new ChatError('Empty conversations are not saved');
  if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100)) throw new ChatError('Title must contain 1–100 characters');
  const requestedTitle = typeof input.title === 'string' ? input.title.trim() : '';
  if (Buffer.byteLength(JSON.stringify(messages)) > MAX_CHAT_BYTES) throw new ChatError('Conversation is too large to save', 413);
  return withLock(root, id, (file) => {
    const prior = readChat(root, id);
    if (revision === 0 && prior && JSON.stringify(prior.messages) === JSON.stringify(messages) && (!requestedTitle || requestedTitle === prior.title)) return prior;
    if ((prior?.revision ?? 0) !== revision) throw new ChatError('Conversation changed in another tab. Reload before editing; your unsaved text is still visible.', 409);
    const chat: StoredChat = {
      version: 1, id, revision: revision + 1,
      title: requestedTitle || prior?.title || conversationTitle(messages),
      updatedAt: new Date().toISOString(),
      messages,
    };
    const temp = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(chat), { mode: 0o600, flag: 'wx' }); renameSync(temp, file); }
    finally { try { unlinkSync(temp); } catch (err) { if ((err as { code?: string }).code !== 'ENOENT') console.error('chat temp cleanup failed', err); } }
    return chat;
  });
}

export function deleteChat(root: string, id: string, revision: number): void {
  withLock(root, id, (file) => {
    const prior = readChat(root, id);
    if (!prior) return;
    if (prior.revision !== revision) throw new ChatError('Conversation changed in another tab; reload before deleting', 409);
    unlinkSync(file);
  });
}
