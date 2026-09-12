# dsh-ide-lite 项目规范

> 请先阅读本文件了解项目规范和项目说明。注意，**凡是涉及插件代码文件改动的，插件安装路径和本地项目文件夹要同步修改**；本地 commit 和仓库推送**待我确认后再执行**。

## 1. 目录

| 位置 | 路径 |
|---|---|
| 本地项目（唯一工作副本） | `C:\Users\HW\dsh-ide-lite-staging` |
| 插件安装路径 | `C:\Users\HW\.dsh\profiles\web\node_modules\@justarook1e\dsh-ide-lite` |
| 仓库 | https://github.com/justarook1e/dsh-ide-lite |
| npm | `@justarook1e/dsh-ide-lite` |
| 运行时状态（插件自建，可删） | `C:\Users\HW\.dsh\dsh-file-edit-state` |

关键文件：

```
package.json              # name/version、dsh.bundle、dsh.client、files
cordis.patch.yml          # bundle patch：id（运行时标识）+ name（必须=包名）
host/index.mjs            # 宿主半区：扫描/基线/diff/接受拒绝/终端/RPC
client/dist/client.js     # 浏览器半区（手工维护的静态 bundle，无构建步骤）
install.ps1               # 安装脚本，源优先级 npm → 本地 → GitHub
README.md / PROJECT.md / CONSTITUTION.md
```

## 2. 功能简述

DSH WebUI 的轻量 IDE 侧边栏插件，三块能力：

1. **工作区文件浏览与编辑** — 文件树（按层加载、Git 着色、`.gitignore` 灰显）、多标签、语法高亮、Markdown 渲染、直接编辑（撤销/重做、保存/自动保存）。
2. **Agent 变更审阅** — 会话内 agent 改动的 +/− 列表、行级 diff、逐块/逐文件接受与拒绝（基线制）、拒绝可撤销；大文件支持按需加载与锚点 diff。
3. **集成终端与运行** — 顶栏「终端」标签，流式输出（ANSI）、中断、stdin 交互、命令历史；「运行」按钮自动识别项目入口（Node/Python/Rust/Go/.NET/Java/Make/PHP/Ruby/Compose）并优先使用项目内本地运行时。

## 3. 关键踩坑

1. **PowerShell 5.1 会毁中文**：`Get-Content -Raw` 按 GBK 解码、`Set-Content -Encoding utf8` 会加 BOM。改文本文件一律用编辑器工具，不要用 PS 读写。
2. **客户端 bundle 的注册 id 必须等于包名**：`client/dist/client.js` 顶部 `__ModuleLoader__.load({ id })` 必须是 `@justarook1e/dsh-ide-lite`。加载器按 boot-graph 的 entry id（＝包名）建工厂索引，不一致会报 `loaded without registering`，插件在浏览器端整体失效。
3. **`cordis.patch.yml` 的 `name` 必须是完整包名**：`name` 是按 profile 根解析的模块标识符；`id` 才是运行时标识，**保持 `dsh-file-edit` 不变**，改了会丢状态并破坏兼容。
4. **`--dump-config` 通过 ≠ 能跑**：它只验证组合解析，不执行客户端 bundle。涉及 bundle 的改动必须在浏览器里真跑（或至少用桩替换 `__ModuleLoader__` 执行一遍、核对注册 id）。
5. **pnpm 有 24h 供应链冷却**：新发布版本会被静默解析成上一个版本。profile 的 `pnpm-workspace.yaml` 已设 `minimumReleaseAge: 0`；升级时建议显式写版本号。
6. **git 依赖升级无路可走**：`github:owner/repo#<sha>` 钉死 commit，`pnpm update` 不会前进。改用 npm 后 spec 是 `^1.31.1`，与 `dsh-session-notification` 同构。
7. **GitHub Actions 必须带 token**：Actions 里 `github:` 依赖会认证失败，用 npm 包。
8. **`SPDX-License-Identifier` 会让 pnpm 安装失败**：不要加。
9. **终端命令不受 agent 沙箱限制**（等同本机终端），属已知设计。
10. **`state/blobs/` 会失控增长**：曾达 2.19 GB / 75,675 文件；删掉只丢「拒绝」的历史基线，不影响代码文件。
11. **发版必须改 `package.json` 版本号**：tag 与版本号不一致时 release workflow 会直接拒绝发布（这是刻意的门禁）。
12. **升级/卸载后必须重启 `pnpm dsh web` 并 Ctrl+F5**：宿主半区重启才重载，浏览器半区需要刷新。

## 4. 交接

> 本节为**覆盖修改**，不是按版本累加：每次只写当前未完成的最新状态，完成后清空。

（暂无）
