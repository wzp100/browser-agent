import type { ProjectFileService } from "../../workspace-contracts/src/index";

export interface ProjectInstructions { path: string; content: string; truncated: boolean; }

export async function loadProjectInstructions(workspace: ProjectFileService, enabled: boolean): Promise<ProjectInstructions | undefined> {
  if (!enabled) return undefined;
  for (const path of ["/.browser-agent/instructions.md", "/AGENTS.md"]) {
    if (!await workspace.exists(path)) continue;
    const content = (await workspace.readText(path)).content;
    return { path, content: content.slice(0, 50_000), truncated: content.length > 50_000 };
  }
  return undefined;
}
