import { json } from "@sveltejs/kit";
import { careerOpsRoot } from "@/lib/career-ops";
import { ChatError, listChats, readChat, saveChat, deleteChat } from "@/lib/assistant-chat-store.ts";
import { MAX_CHAT_BYTES } from "@/lib/assistant-history.ts";

function failure(error: unknown) {
  return json({ error: error instanceof ChatError ? error.message : "Could not access conversation history" }, { status: error instanceof ChatError ? error.status : 500 });
}
export async function GET({ request }: { request: Request }) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return json(listChats(careerOpsRoot()));
    const chat = readChat(careerOpsRoot(), id);
    return chat ? json(chat) : json({ error: "Conversation not found" }, { status: 404 });
  } catch (error) { return failure(error); }
}
export async function PUT({ request }: { request: Request }) {
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_CHAT_BYTES + 1000) throw new ChatError("Conversation is too large to save", 413);
    let body: Record<string, unknown> | undefined;
    try { body = JSON.parse(raw); } catch { throw new ChatError("Invalid JSON"); }
    return json(saveChat(careerOpsRoot(), body?.id, body));
  } catch (error) { return failure(error); }
}
export async function DELETE({ request }: { request: Request }) {
  try {
    const url = new URL(request.url);
    deleteChat(careerOpsRoot(), url.searchParams.get("id"), Number(url.searchParams.get("revision")));
    return json({ ok: true });
  } catch (error) { return failure(error); }
}
