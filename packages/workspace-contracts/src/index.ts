export type BrowserWritableFileStream = { write(data: Uint8Array | string): Promise<void>; seek?(position: number): Promise<void>; close(): Promise<void> };
export type BrowserFileHandle = { kind: "file"; name: string; getFile(): Promise<File>; createWritable(options?: { keepExistingData?: boolean }): Promise<BrowserWritableFileStream> };
export type BrowserDirectoryHandle = {
  kind: "directory";
  name: string;
  values(): AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BrowserDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  isSameEntry?(other: BrowserDirectoryHandle): Promise<boolean>;
  queryPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
};

export async function resolveDirectoryPermission(
  handle: BrowserDirectoryHandle,
  action: "query" | "request",
  mode: "read" | "readwrite" = "readwrite"
): Promise<PermissionState> {
  const method = action === "query" ? handle.queryPermission : handle.requestPermission;
  // OPFS handles are origin-scoped and omit the File System Access permission API.
  return method ? method.call(handle, { mode }) : "granted";
}

export * from "./project-file-service";
export * from "./project-log-sink";
export * from "./workspace-file-links";
