export interface SkillFile { path: string; content: string; }
export interface SkillDescriptor {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "user" | "organization" | "generated";
  instructions: string;
  files: SkillFile[];
  version?: string;
  enabled?: boolean;
  permissions?: Array<"workspace-read" | "workspace-write" | "network" | "runtime-execute">;
  updatedAt: string;
}

export interface SkillSummary { id: string; name: string; description: string; source: SkillDescriptor["source"]; version?: string; enabled?: boolean; permissions?: NonNullable<SkillDescriptor["permissions"]>; }

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDescriptor>();
  constructor(private readonly store?: BrowserSkillStore) {}
  register(skill: SkillDescriptor): void { validateSkill(skill); this.skills.set(skill.id, { ...skill, enabled: skill.enabled !== false, permissions: skill.permissions ?? [] }); }
  list(): SkillSummary[] { return this.summaries(false); }
  listAll(): SkillSummary[] { return this.summaries(true); }
  inspect(id: string): SkillDescriptor { const skill = this.skills.get(id); if (!skill) throw new Error(`未安装 Skill：${id}`); if (skill.enabled === false) throw new Error(`Skill 已禁用：${id}`); return skill; }
  inspectInstalled(id: string): SkillDescriptor { const skill = this.skills.get(id); if (!skill) throw new Error(`未安装 Skill：${id}`); return skill; }
  async install(skill: SkillDescriptor): Promise<void> { this.register(skill); await this.store?.save(skill); }
  async setEnabled(id: string, enabled: boolean): Promise<void> { const skill = this.inspectInstalled(id); const updated = { ...skill, enabled, updatedAt: new Date().toISOString() }; this.register(updated); await this.store?.save(updated); }
  async uninstall(id: string): Promise<void> { if (!this.skills.has(id)) return; this.skills.delete(id); await this.store?.delete(id); }
  async loadPersisted(): Promise<void> { for (const skill of await this.store?.list() ?? []) this.register(skill); }
  private summaries(includeDisabled: boolean): SkillSummary[] {
    return [...this.skills.values()].filter((skill) => includeDisabled || skill.enabled !== false).map(({ id, name, description, source, version, enabled, permissions }) => ({ id, name, description, source, ...(version ? { version } : {}), enabled: enabled !== false, permissions: permissions ?? [] }));
  }
}

export class BrowserSkillStore {
  async save(skill: SkillDescriptor): Promise<void> {
    const root = await skillRoot();
    const directory = await root.getDirectoryHandle(skill.id, { create: true });
    const handle = await directory.getFileHandle("skill.json", { create: true });
    const writer = await handle.createWritable();
    await writer.write(JSON.stringify(skill));
    await writer.close();
  }
  async list(): Promise<SkillDescriptor[]> {
    const root = await skillRoot();
    const skills: SkillDescriptor[] = [];
    for await (const entry of root.values()) {
      if (entry.kind !== "directory") continue;
      try {
        const file = await (await entry.getFileHandle("skill.json")).getFile();
        skills.push(JSON.parse(await file.text()) as SkillDescriptor);
      } catch { /* Invalid user Skill is ignored and can be reinstalled. */ }
    }
    return skills;
  }
  async delete(id: string): Promise<void> {
    const root = await skillRoot();
    try { await root.removeEntry(id, { recursive: true }); }
    catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
  }
}

export function skillFromMarkdown(id: string, markdown: string, source: SkillDescriptor["source"], files: SkillFile[] = []): SkillDescriptor {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  const fields = new Map<string, string>();
  for (const line of frontmatter?.[1]?.split(/\r?\n/) ?? []) {
    const separator = line.indexOf(":");
    if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, ""));
  }
  const version = fields.get("version");
  return {
    id,
    name: fields.get("name") || id,
    description: fields.get("description") || firstParagraph(markdown) || id,
    source,
    instructions: markdown,
    files,
    ...(version ? { version } : {}),
    enabled: true,
    permissions: parsePermissions(fields.get("permissions")),
    updatedAt: new Date().toISOString()
  };
}

export function validateSkill(skill: SkillDescriptor): void {
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(skill.id)) throw new Error("Skill id 只能包含字母、数字、下划线和连字符。 ");
  if (!skill.instructions.trim()) throw new Error("SKILL.md 不能为空。 ");
  const validPermissions = new Set(["workspace-read", "workspace-write", "network", "runtime-execute"]);
  for (const permission of skill.permissions ?? []) if (!validPermissions.has(permission)) throw new Error(`Skill 权限无效：${permission}`);
  for (const file of skill.files) if (file.path.includes("..") || file.path.startsWith("/") || file.path.includes("\\")) throw new Error(`Skill 文件路径越界：${file.path}`);
}

function parsePermissions(value: string | undefined): NonNullable<SkillDescriptor["permissions"]> {
  if (!value) return [];
  return value.replace(/^\[|\]$/g, "").split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean) as NonNullable<SkillDescriptor["permissions"]>;
}

type SkillDirectoryHandle = FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemFileHandle | SkillDirectoryHandle> };

async function skillRoot(): Promise<SkillDirectoryHandle> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) throw new Error("当前浏览器不支持 OPFS，无法持久化 Skill。 ");
  const root = await navigator.storage.getDirectory() as SkillDirectoryHandle;
  const home = await root.getDirectoryHandle("agent-home", { create: true });
  return home.getDirectoryHandle("skills", { create: true }) as Promise<SkillDirectoryHandle>;
}

function firstParagraph(markdown: string): string {
  return markdown.replace(/^---[\s\S]*?---/, "").split(/\n\s*\n/).map((part) => part.replace(/^#+\s*/gm, "").trim()).find(Boolean)?.slice(0, 300) ?? "";
}
