import assert from "node:assert/strict";
import test from "node:test";
import { SkillRegistry, skillFromMarkdown } from "../packages/skill-core/src/index";

const systemMarkdown = "---\nname: system-review\ndescription: 系统审查流程\n---\n# System";
const userMarkdown = "---\nname: user-review\ndescription: 用户审查流程\n---\n# User";
const projectMarkdown = "---\nname: project-review\ndescription: 项目审查流程\n---\n# Project";

test("SkillRegistry 保留三种来源并按项目、用户、系统优先级生效", () => {
  const registry = new SkillRegistry();
  registry.register(skillFromMarkdown("review", systemMarkdown, "builtin"));
  registry.register(skillFromMarkdown("review", userMarkdown, "user"));
  registry.register({ ...skillFromMarkdown("review", projectMarkdown, "project"), scopeId: "project-1" });

  assert.equal(registry.listAll().length, 3);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.inspect("review").source, "project");
  assert.equal(registry.inspect("review").description, "项目审查流程");
});

test("禁用当前高优先级 Skill 不会静默回退到同名低优先级 Skill", async () => {
  const registry = new SkillRegistry();
  registry.register(skillFromMarkdown("review", systemMarkdown, "builtin"));
  const project = { ...skillFromMarkdown("review", projectMarkdown, "project"), scopeId: "project-1" };
  registry.register(project);
  const reference = registry.listAll().find((skill) => skill.source === "project")?.key;
  assert.ok(reference);
  await registry.setEnabled(reference, false, false);
  assert.equal(registry.list().some((skill) => skill.id === "review"), false);
  assert.throws(() => registry.inspect("review"), /Skill 已禁用/);
});
