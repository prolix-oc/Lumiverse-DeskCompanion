import type { SpindleAPI } from "lumiverse-spindle-types";
import { DeskError, identifier, MAX_QUESTION, MAX_REPLY, record } from "./protocol";

export interface Exchange { user: string; assistant: string }
export const historyPath = (characterId: string) => {
  if (!identifier(characterId)) throw new Error("Invalid character history");
  return `companion-history-${characterId}.json`;
};

/** Text only, per account and character. Never retain capture handles or media. */
export function createHistory(api: SpindleAPI) {
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const next = (queues.get(userId) ?? Promise.resolve()).catch(() => {}).then(work)
      .catch(() => { throw new DeskError("HISTORY_FAILED"); });
    queues.set(userId, next);
    void next.finally(() => { if (queues.get(userId) === next) queues.delete(userId); }).catch(() => {});
    return next;
  }
  async function read(userId: string, characterId: string, limit: number): Promise<Exchange[]> {
    if (!limit) return [];
    const saved = await api.userStorage.getJson<unknown>(historyPath(characterId), { userId, fallback: [] });
    if (!Array.isArray(saved) || saved.some(turn => !record(turn) || typeof turn.user !== "string" || !turn.user.trim()
      || turn.user.length > MAX_QUESTION || typeof turn.assistant !== "string" || !turn.assistant.trim() || turn.assistant.length > MAX_REPLY)) {
      throw new Error("Conversation history could not be read");
    }
    return saved.slice(-limit).map(turn => ({ user: turn.user, assistant: turn.assistant }));
  }
  return {
    read: (userId: string, characterId: string, limit: number) => serial(userId, () => read(userId, characterId, limit)),
    append: (userId: string, characterId: string, limit: number, turn: Exchange, signal?: AbortSignal) => serial(userId, async () => {
      if (!limit || signal?.aborted) return;
      const history = await read(userId, characterId, limit);
      if (signal?.aborted) return;
      await api.userStorage.setJson(historyPath(characterId), [...history, { user: turn.user, assistant: turn.assistant }].slice(-limit), { userId });
      // Keep cancelled work out even if cancellation arrives during the write.
      // The per-account queue also ensures a following Clear remains the last write.
      if (signal?.aborted) await api.userStorage.setJson(historyPath(characterId), history, { userId });
    }),
    trim: (userId: string, characterId: string, limit: number) => serial(userId, async () => {
      if (characterId) await api.userStorage.setJson(historyPath(characterId), await read(userId, characterId, limit), { userId });
    }),
    clear: (userId: string, characterId: string) => serial(userId, async () => {
      if (characterId) await api.userStorage.setJson(historyPath(characterId), [], { userId });
    }),
  };
}
