import { BrowserDatabase } from "./database";
import { ConversationRepository, ProjectRepository } from "./repositories";

const LEGACY_CONVERSATION_KEY = "browser-agent-runtime:conversations";

interface LegacyConversation {
  id?: string;
  projectName?: string;
  title?: string;
  updatedAt?: string;
  messages?: Array<{ role?: string; content?: string; at?: string }>;
}

export async function migrateLegacyConversations(database: BrowserDatabase): Promise<number> {
  if (typeof localStorage === "undefined") return 0;
  const raw = localStorage.getItem(LEGACY_CONVERSATION_KEY);
  if (!raw) return 0;
  let legacy: LegacyConversation[];
  try { legacy = JSON.parse(raw) as LegacyConversation[]; } catch { return 0; }
  if (!Array.isArray(legacy)) return 0;
  const projects = new ProjectRepository(database);
  const conversations = new ConversationRepository(database);
  const projectIds = new Map<string, string>();
  let migrated = 0;
  for (const item of legacy) {
    if (!item.id || !item.projectName) continue;
    let projectId = projectIds.get(item.projectName);
    if (!projectId) {
      projectId = crypto.randomUUID();
      projectIds.set(item.projectName, projectId);
      const at = item.updatedAt ?? new Date().toISOString();
      await projects.put({ id: projectId, name: item.projectName, permissionHint: "missing", legacyRelinkRequired: true, createdAt: at, lastOpenedAt: at });
    }
    const updatedAt = item.updatedAt ?? new Date().toISOString();
    await conversations.putThread({ id: item.id, projectId, title: item.title ?? "历史对话", createdAt: updatedAt, updatedAt });
    for (const message of item.messages ?? []) {
      if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") continue;
      const value = { threadId: item.id, role: message.role, kind: message.role, content: message.content } as const;
      await conversations.appendMessage(message.at ? { ...value, createdAt: message.at } : value);
    }
    migrated += 1;
  }
  localStorage.removeItem(LEGACY_CONVERSATION_KEY);
  return migrated;
}

export async function requestPersistentBrowserStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try { return await navigator.storage.persist(); } catch { return false; }
}
