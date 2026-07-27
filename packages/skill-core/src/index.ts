export interface SkillFile { path: string; content: string; }
export interface SkillDescriptor {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "user" | "organization" | "generated" | "project";
  scopeId?: string;
  instructions: string;
  files: SkillFile[];
  version?: string;
  enabled?: boolean;
  permissions?: Array<"workspace-read" | "workspace-write" | "network" | "runtime-execute">;
  updatedAt: string;
}

export interface SkillSummary {
  id: string;
  key?: string;
  name: string;
  description: string;
  source: SkillDescriptor["source"];
  scopeId?: string;
  version?: string;
  enabled?: boolean;
  permissions?: NonNullable<SkillDescriptor["permissions"]>;
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDescriptor>();
  constructor(private readonly store?: BrowserSkillStore) {}
  register(skill: SkillDescriptor): void {
    validateSkill(skill);
    this.skills.set(skillKey(skill), { ...skill, enabled: skill.enabled !== false, permissions: skill.permissions ?? [] });
  }
  clearSource(source: SkillDescriptor["source"]): void {
    for (const [key, skill] of this.skills) if (skill.source === source) this.skills.delete(key);
  }
  list(): SkillSummary[] { return this.effectiveSkills().filter((skill) => skill.enabled !== false).map((skill) => toSummary(skill)); }
  listAll(): SkillSummary[] { return [...this.skills.entries()].map(([key, skill]) => toSummary(skill, key)).sort(compareSkills); }
  inspect(id: string): SkillDescriptor {
    const skill = this.effectiveSkills().find((candidate) => candidate.id === id);
    if (!skill) throw new Error(`未安装 Skill：${id}`);
    if (skill.enabled === false) throw new Error(`Skill 已禁用：${id}`);
    return skill;
  }
  inspectInstalled(reference: string): SkillDescriptor {
    const direct = this.skills.get(reference);
    if (direct) return direct;
    const skill = this.effectiveSkills().find((candidate) => candidate.id === reference);
    if (!skill) throw new Error(`未安装 Skill：${reference}`);
    return skill;
  }
  async install(skill: SkillDescriptor): Promise<void> { this.register(skill); await this.store?.save(skill); }
  async setEnabled(reference: string, enabled: boolean, persist = true): Promise<void> {
    const skill = this.inspectInstalled(reference);
    const updated = { ...skill, enabled, updatedAt: new Date().toISOString() };
    this.register(updated);
    if (persist) await this.store?.save(updated);
  }
  async uninstall(reference: string): Promise<void> {
    const skill = this.inspectInstalled(reference);
    const key = skillKey(skill);
    if (!this.skills.has(key)) return;
    this.skills.delete(key);
    if (skill.source !== "project") await this.store?.delete(skill);
  }
  async loadPersisted(): Promise<void> { for (const skill of await this.store?.list() ?? []) this.register(skill); }
  private effectiveSkills(): SkillDescriptor[] {
    const effective = new Map<string, SkillDescriptor>();
    for (const skill of this.skills.values()) {
      const current = effective.get(skill.id);
      if (!current || skillPriority(skill.source) > skillPriority(current.source)) effective.set(skill.id, skill);
    }
    return [...effective.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }
}

export class BrowserSkillStore {
  async save(skill: SkillDescriptor): Promise<void> {
    const root = await skillRoot();
    const directory = await root.getDirectoryHandle(storedSkillDirectory(skill), { create: true });
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
  async delete(skill: Pick<SkillDescriptor, "id" | "source" | "scopeId">): Promise<void> {
    const root = await skillRoot();
    try { await root.removeEntry(storedSkillDirectory(skill), { recursive: true }); }
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
  if (skill.source === "project" && !skill.scopeId) throw new Error("项目 Skill 必须包含项目 scopeId。");
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

function skillKey(skill: Pick<SkillDescriptor, "id" | "source" | "scopeId">): string {
  return `${skill.source}:${skill.scopeId ?? "global"}:${skill.id}`;
}

function storedSkillDirectory(skill: Pick<SkillDescriptor, "id" | "source" | "scopeId">): string {
  return [skill.source, skill.scopeId ?? "global", skill.id].map((part) => part.replace(/[^a-z0-9_-]/gi, "-")).join("--");
}

function skillPriority(source: SkillDescriptor["source"]): number {
  if (source === "project") return 4;
  if (source === "user" || source === "organization" || source === "generated") return 3;
  return 1;
}

function toSummary(skill: SkillDescriptor, key?: string): SkillSummary {
  const summary: SkillSummary = {
    id: skill.id,
    ...(key ? { key } : {}),
    name: skill.name,
    description: skill.description,
    source: skill.source,
    ...(skill.scopeId ? { scopeId: skill.scopeId } : {}),
    ...(skill.version ? { version: skill.version } : {}),
    enabled: skill.enabled !== false,
    permissions: skill.permissions ?? []
  };
  return summary;
}

function compareSkills(left: SkillSummary, right: SkillSummary): number {
  const sourceOrder = skillPriority(right.source) - skillPriority(left.source);
  return sourceOrder || left.name.localeCompare(right.name, "zh-CN");
}
