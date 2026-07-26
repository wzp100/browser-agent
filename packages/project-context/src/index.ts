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

export interface TaskTemplate { id: string; name: string; prompt: string; requiresWrite: boolean; }

export const BUILTIN_TASK_TEMPLATES: TaskTemplate[] = [
  { id: "project-health", name: "项目健康检查", prompt: "检查当前项目的结构、配置、依赖、测试与明显风险，给出带文件证据的健康报告，不修改文件。", requiresWrite: false },
  { id: "fix-tests", name: "修复测试失败", prompt: "运行项目已有测试，定位失败根因，实施最小修复并重新验证。", requiresWrite: true },
  { id: "readonly-review", name: "只读代码审查", prompt: "只读审查当前项目，按严重度报告可复现的问题和具体文件位置，不修改文件。", requiresWrite: false },
  { id: "change-verify", name: "修改并验证", prompt: "先检查现状，再实施请求中的修改，并运行与风险相称的测试和构建验证。", requiresWrite: true },
  { id: "csv-report", name: "CSV 分析报告", prompt: "分析项目中的 CSV 数据，生成经过验证的 XLSX 汇总和 Markdown 结论。", requiresWrite: true },
  { id: "word-report", name: "Word 报告", prompt: "根据项目现有资料生成结构清晰、经过重新解析验证的 DOCX 报告。", requiresWrite: true },
  { id: "ppt-briefing", name: "PPT 汇报", prompt: "根据项目现有资料生成多页、经过重新解析验证的 PPTX 汇报。", requiresWrite: true },
  { id: "pdf-output", name: "PDF 输出", prompt: "根据项目现有资料生成经过重新解析验证的 PDF 报告。", requiresWrite: true }
];
