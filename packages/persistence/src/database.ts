import type { ModelSettingsRecord, ProviderProfile, ThreadRecord } from "./types";

export type StoreName = "projects" | "threads" | "messages" | "runs" | "settings" | "logs" | "providerProfiles" | "attachments" | "modelProbes";

const DATABASE_NAME = "browser-agent-runtime";
const DATABASE_VERSION = 7;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败。"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 事务已中止。"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB 事务失败。"));
  });
}

export class BrowserDatabase {
  private databasePromise?: Promise<IDBDatabase>;

  open(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          reject(new Error("当前环境不支持 IndexedDB。"));
          return;
        }
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          const transaction = request.transaction;
          if (!database.objectStoreNames.contains("projects")) database.createObjectStore("projects", { keyPath: "id" });
          if (!database.objectStoreNames.contains("threads")) {
            const store = database.createObjectStore("threads", { keyPath: "id" });
            store.createIndex("projectId", "projectId", { unique: false });
            store.createIndex("updatedAt", "updatedAt", { unique: false });
          }
          if (!database.objectStoreNames.contains("messages")) {
            const store = database.createObjectStore("messages", { keyPath: "id" });
            store.createIndex("threadId", "threadId", { unique: false });
            store.createIndex("threadSequence", ["threadId", "sequence"], { unique: true });
          }
          if (!database.objectStoreNames.contains("runs")) {
            const store = database.createObjectStore("runs", { keyPath: "id" });
            store.createIndex("threadId", "threadId", { unique: false });
          }
          if (!database.objectStoreNames.contains("settings")) database.createObjectStore("settings", { keyPath: "key" });
          if (!database.objectStoreNames.contains("logs")) {
            const store = database.createObjectStore("logs", { keyPath: "id" });
            store.createIndex("timestamp", "timestamp", { unique: false });
            store.createIndex("level", "level", { unique: false });
          }
          if (!database.objectStoreNames.contains("attachments")) {
            const store = database.createObjectStore("attachments", { keyPath: "id" });
            store.createIndex("threadId", "threadId", { unique: false });
            store.createIndex("messageId", "messageId", { unique: false });
          }
          if (!database.objectStoreNames.contains("providerProfiles")) {
            const profiles = database.createObjectStore("providerProfiles", { keyPath: "id" });
            const now = new Date().toISOString();
            for (const profile of builtInProfiles(now)) profiles.put(profile);
            if (transaction && database.objectStoreNames.contains("settings")) {
              const legacyRequest = transaction.objectStore("settings").get("model");
              legacyRequest.onsuccess = () => {
                const legacy = legacyRequest.result as ModelSettingsRecord | undefined;
                if (!legacy) return;
                const profile = legacyProfile(legacy, now);
                profiles.put(profile);
                if (database.objectStoreNames.contains("threads")) {
                  const cursorRequest = transaction.objectStore("threads").openCursor();
                  cursorRequest.onsuccess = () => {
                    const cursor = cursorRequest.result;
                    if (!cursor) return;
                    const thread = cursor.value as ThreadRecord;
                    if (!thread.modelSelection) cursor.update({ ...thread, modelSelection: { providerProfileId: profile.id, modelId: legacy.model } });
                    cursor.continue();
                  };
                }
              };
            }
          }
          if (!database.objectStoreNames.contains("modelProbes")) {
            const store = database.createObjectStore("modelProbes", { keyPath: "id" });
            store.createIndex("providerModel", ["providerProfileId", "modelId"], { unique: false });
          }
          for (const obsolete of ["tasks", "transactions"]) {
            if (database.objectStoreNames.contains(obsolete)) database.deleteObjectStore(obsolete);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("无法打开 IndexedDB。"));
      });
    }
    return this.databasePromise;
  }

  async get<T>(storeName: StoreName, key: IDBValidKey): Promise<T | undefined> {
    const database = await this.open();
    return requestResult(database.transaction(storeName, "readonly").objectStore(storeName).get(key)) as Promise<T | undefined>;
  }

  async getAll<T>(storeName: StoreName): Promise<T[]> {
    const database = await this.open();
    return requestResult(database.transaction(storeName, "readonly").objectStore(storeName).getAll()) as Promise<T[]>;
  }

  async getAllFromIndex<T>(storeName: StoreName, indexName: string, query: IDBValidKey | IDBKeyRange): Promise<T[]> {
    const database = await this.open();
    return requestResult(database.transaction(storeName, "readonly").objectStore(storeName).index(indexName).getAll(query)) as Promise<T[]>;
  }

  async put<T>(storeName: StoreName, value: T): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    await transactionDone(transaction);
  }

  async delete(storeName: StoreName, key: IDBValidKey): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(key);
    await transactionDone(transaction);
  }

  async deleteByIndex(storeName: StoreName, indexName: string, query: IDBValidKey | IDBKeyRange): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const keys = await requestResult(store.index(indexName).getAllKeys(query));
    for (const key of keys) store.delete(key);
    await transactionDone(transaction);
  }

  async clear(storeName: StoreName): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).clear();
    await transactionDone(transaction);
  }
}

function builtInProfiles(now: string): ProviderProfile[] {
  return [
    { id: "builtin-openai", name: "OpenAI", kind: "openai", endpoint: "https://api.openai.com/v1/responses", modelsEndpoint: "https://api.openai.com/v1/models", defaultModelId: "gpt-5.6", modelsDevProviderId: "openai", builtIn: true, createdAt: now, updatedAt: now },
    { id: "builtin-deepseek", name: "DeepSeek", kind: "deepseek", endpoint: "https://api.deepseek.com/chat/completions", modelsEndpoint: "https://api.deepseek.com/models", defaultModelId: "deepseek-chat", modelsDevProviderId: "deepseek", builtIn: true, createdAt: now, updatedAt: now },
    { id: "builtin-gateway", name: "Gateway", kind: "gateway", endpoint: "http://127.0.0.1:8787", defaultModelId: "gpt-5.6", modelsDevProviderId: "openai", builtIn: true, createdAt: now, updatedAt: now }
  ];
}

function legacyProfile(settings: ModelSettingsRecord, now: string): ProviderProfile {
  const id = settings.mode === "gateway" ? "builtin-gateway" : settings.mode === "deepseek" ? "builtin-deepseek" : "builtin-openai";
  const name = settings.mode === "gateway" ? "Gateway" : settings.mode === "deepseek" ? "DeepSeek" : "OpenAI";
  const kind = settings.mode === "direct" ? "openai" : settings.mode;
  const profile: ProviderProfile = {
    id,
    name,
    kind,
    endpoint: settings.endpoint,
    defaultModelId: settings.model,
    modelsDevProviderId: settings.mode === "deepseek" ? "deepseek" : "openai",
    builtIn: true,
    createdAt: now,
    updatedAt: now
  };
  if (settings.mode !== "gateway") profile.modelsEndpoint = inferModelsEndpoint(settings.endpoint);
  return profile;
}

function inferModelsEndpoint(endpoint: string): string {
  return `${endpoint.trim().replace(/\/(?:responses|chat\/completions)\/?$/i, "").replace(/\/$/, "")}/models`;
}
