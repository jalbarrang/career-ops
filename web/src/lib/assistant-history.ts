// Shared by the browser and route. History is conversational context, never a
// new source of verified CV facts. Keep storage complete; bound model input only.
export const MAX_CHAT_BYTES = 1_000_000;

export type ChatRole = 'user' | 'assistant';

export interface TextPart {
  type: 'text' | 'note';
  text: string;
}

export interface CardPart {
  type: 'card';
  jobId: string;
}

export interface BatchPart {
  type: 'batch';
  batchId: string;
  jobIds: string[];
}

/** One rendered part of an assistant message. */
export type ChatPart = TextPart | CardPart | BatchPart;

/** One stored message. */
export interface ChatMessage {
  role: ChatRole;
  parts: ChatPart[];
}

/** A conversation turn as the route receives it from the client. */
export interface ChatTurn {
  role: ChatRole;
  content: string;
}

export function cleanMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input) || input.length > 2000) throw new Error('Invalid conversation messages');
  return input.map((raw): ChatMessage => {
    const m = raw as Record<string, unknown> | null;
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) throw new Error('Invalid message role');
    const parts: unknown = Array.isArray(m.parts)
      ? m.parts
      : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : null;
    if (!parts) throw new Error('Invalid message parts');
    const cleaned: ChatPart[] = [];
    for (const partRaw of parts as unknown[]) {
      const p = partRaw as Record<string, unknown> | null;
      if (!p || typeof p !== 'object') throw new Error('Invalid message part');
      if ((p.type === 'text' || p.type === 'note') && typeof p.text === 'string') {
        cleaned.push({ type: p.type, text: p.text });
        continue;
      }
      if (p.type === 'card' && typeof p.jobId === 'string') {
        cleaned.push({ type: 'card', jobId: p.jobId });
        continue;
      }
      if (p.type === 'batch' && typeof p.batchId === 'string' && Array.isArray(p.jobIds) && p.jobIds.every((id) => typeof id === 'string')) {
        cleaned.push({ type: 'batch', batchId: p.batchId, jobIds: p.jobIds as string[] });
        continue;
      }
      // Confirm callbacks exist only in the live component; never resurrect them.
      if (p.type === 'confirm' && p.state === 'pending') continue;
      if (p.type === 'confirm' && (p.state === 'done' || p.state === 'cancelled') && typeof p.summary === 'string') {
        cleaned.push({ type: 'note', text: `${p.summary} (${p.state})` });
        continue;
      }
      throw new Error('Invalid message part');
    }
    return { role: m.role, parts: cleaned };
  });
}

export function conversationTitle(messages: readonly ChatMessage[]): string {
  return messages.find(m => m.role === 'user')?.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map(p => p.text).join(' ').trim().slice(0, 80) || 'New chat';
}

export function buildConversationContext(input: unknown = []): string {
  if (!Array.isArray(input) || input.length > 2000 || input.some((m) => {
    const turn = m as Record<string, unknown> | null;
    return !turn || (turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.content !== 'string';
  })) {
    throw new Error('Invalid conversation history');
  }
  const turns = input as ChatTurn[];
  const recent = turns.slice(-24);
  const older = turns.slice(0, -24).filter(m => m.role === 'user');
  const excerpts = older.map(m => `User excerpt: ${m.content.slice(0, 400)}`).join('\n').slice(0, 8000);
  let remaining = 24000;
  const tail: string[] = [];
  for (const m of [...recent].reverse()) {
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`;
    if (line.length > remaining) {
      if (remaining > 40) tail.unshift(`${line.slice(0, remaining - 20)} [excerpt]`);
      break;
    }
    tail.unshift(line);
    remaining -= line.length + 1;
  }
  return [excerpts ? `Earlier user statements (excerpts; not verified profile facts):\n${excerpts}` : '', tail.join('\n')].filter(Boolean).join('\n\n');
}
