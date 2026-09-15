# pi-apply-patch

为 Pi 提供纯 TypeScript 实现的、兼容 Codex 补丁格式的 `apply_patch` 工具。

它不会启动 `codex`、`git apply`、shell 或任何其他外部进程，适合未安装 Codex CLI 的环境。

## 功能

- 只注册一个工具：`apply_patch`
- 支持 `Add File`、`Update File`、`Delete File` 和 `Move to`
- 支持单个补丁中的多个文件和多个 hunk
- 写入前完成整份补丁的解析和上下文校验
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

所有路径都相对于当前 Pi 工作区。更新上下文必须唯一；找不到或存在歧义时，工具会失败且不会开始写入。

执行结果的正文只包含简短摘要，结构化 `details` 中包含 `files` 和 `summary`：

```json
{
  "files": [
    {
      "path": "src/example.ts",
      "kind": "update",
      "diff": " 1 const enabled = false;\n-2 const value = 0;\n+2 const value = 1;",
      "patch": "--- src/example.ts\n+++ src/example.ts\n@@ -1,2 +1,2 @@\n const enabled = false;\n-const value = 0;\n+const value = 1;",
      "additions": 1,
      "deletions": 1
    }
  ],
  "summary": { "files": 1, "additions": 1, "deletions": 1 }
}
```

大 diff 会在展示详情中截断并标记 `truncated`，但文件写入仍使用完整补丁结果。

## 开发验证

```powershell
npm install
npm run check
npm pack --dry-run
```

## 限制

提交前的解析和预检不会产生文件副作用；普通写入错误会触发回滚。跨多个文件的修改不承诺在进程崩溃或系统断电时具备文件系统级原子性。
