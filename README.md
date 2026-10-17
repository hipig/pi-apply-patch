# pi-apply-patch

为 Pi 提供纯 TypeScript 实现的、兼容 Codex 补丁格式的 `apply_patch` 工具。

它不会启动 `codex`、`git apply`、shell 或任何其他外部进程，适合未安装 Codex CLI 的环境。

## 功能

- 只注册一个工具：`apply_patch`
- 支持 `Add File`、`Update File`、`Delete File` 和 `Move to`
- 支持单个补丁中的多个文件、多个 hunk 和部分应用
- 写入前检查整份补丁的格式、路径安全和文件类型
- 提交失败时恢复已尝试修改的文件
- 限制写入当前工作区，阻止绝对路径、目录穿越和符号链接逃逸
- 保留现有文本文件的 CRLF/LF 换行风格
- 不修改二进制文件或非 UTF-8 文件
- 工具结果包含每个文件的 line-numbered diff、unified patch 和增删统计
- 在 Pi TUI 中按文件显示彩色修改差异，支持展开查看完整结果

## 安装

本地安装：

```powershell
pi install 'D:\Pi Extensions\pi-apply-patch'
```

也可以在 `~/.pi/agent/settings.json` 的 `packages` 中加入：

```json
"D:\\Pi Extensions\\pi-apply-patch"
```

不要同时启用其他注册同名 `apply_patch` 的扩展。修改配置后请重新加载 Pi。

## 工具协议

参数：

```json
{
  "input": "*** Begin Patch\n...\n*** End Patch"
}
```

示例：

```text
*** Begin Patch
*** Update File: src/example.ts
@@
-const enabled = false;
+const enabled = true;
*** Add File: src/new-file.ts
+export const value = 1;
*** Delete File: src/unused.ts
*** End Patch
```

所有路径都相对于当前 Pi 工作区。更新上下文必须唯一，执行规则如下：

- 普通更新会保存匹配成功的 hunk；找不到上下文或存在歧义的 hunk 会跳过，并集中列出。
- 新增目标已存在，或更新、删除、移动的源文件不存在时，跳过该文件操作，继续处理其他路径。
- 移动及其附带修改作为整体；目标已存在或任一 hunk 失败时，源文件和目标文件均不变。
- 某个操作未完成后，后续涉及同一路径的操作会标记为受阻，不再执行。
- 格式、路径安全或文件类型检查失败时，整批不写入。

部分成功后，应读取当前文件，只修正未应用或受阻的修改，不要重新发送原始整份补丁。部分保存不保证代码整体可用，仍需修复未完成项并验证结果。

结果正文包含简短摘要和全部未应用项的定位信息。执行状态分为 `complete`（全部完成）、`partial`（部分完成）和 `failed`（全部失败）；全部失败时，工具会报错并列出未完成项。

结构化 `details` 包含逐项结果 `outcomes`、实际修改差异 `files` 和统计 `summary`。单文件更新示例：

```json
{
  "status": "complete",
  "outcomes": [
    {
      "operation": 1,
      "kind": "update",
      "path": "src/example.ts",
      "lineNumber": 2,
      "status": "complete",
      "hunks": [
        { "hunk": 1, "lineNumber": 3, "status": "applied", "mode": "exact" }
      ]
    }
  ],
  "files": [
    {
      "path": "src/example.ts",
      "kind": "update",
      "diff": "-1 const enabled = false;\n+1 const enabled = true;",
      "patch": "--- src/example.ts\n+++ src/example.ts\n@@ -1 +1 @@\n-const enabled = false;\n+const enabled = true;",
      "additions": 1,
      "deletions": 1
    }
  ],
  "summary": { "files": 1, "additions": 1, "deletions": 1 }
}
```

`operation` 和 `hunk` 从 1 开始编号，`lineNumber` 指原始补丁中的行号。操作状态还可为 `blocked`（受阻）；hunk 状态为 `applied`、`failed` 或 `blocked`。失败原因通过 `failure.code` 和 `failure.message` 返回。

大 diff 会在展示详情中截断并标记 `truncated`，但文件写入仍使用完整补丁结果。

## 开发验证

```powershell
npm install
npm run check
npm pack --dry-run
```

## 限制

提交前的解析和预检不会产生文件副作用；普通写入错误会触发回滚。跨多个文件的修改不承诺在进程崩溃或系统断电时具备文件系统级原子性。
