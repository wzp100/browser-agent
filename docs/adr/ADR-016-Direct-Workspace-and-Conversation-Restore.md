# ADR-016 真实项目目录与对话恢复

状态：Accepted，取代 ADR-002、ADR-003、ADR-009 和 ADR-010 在浏览器主执行链路中的工作区隔离决策。

项目以 IndexedDB 中的稳定 `projectId` 和 `FileSystemDirectoryHandle` 标识，对话通过 `projectId` 关联项目。恢复对话时同时恢复目录句柄并重新校验浏览器读写权限。

用户最新产品要求是 Agent 和终端直接作用于真实文件夹，因此 `WorkspaceProjection` 和 Artifact 发布不再位于浏览器主路径。WebContainer 仍是浏览器技术沙箱，但 `/workspace` 与真实目录双向同步；所有直接写入在操作前记录 OPFS 恢复数据，覆盖使用 fingerprint 检测并发冲突。

模型改为按需 Tool Calling，不再接收整个项目快照。对话、工具事件和终端记录持续保存，直到用户手动删除对应对话。
