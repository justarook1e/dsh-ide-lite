# dsh-ide-lite

DSH WebUI 的轻量 IDE 插件：把「文件」和「终端」两个标签页加进会话界面。

## 功能

**工作区侧边栏**（替换原生浏览器）：项目文件树（按层加载、Git 状态着色、`.gitignore` 灰显、单击/双击打开）＋ 会话历史（新建/切换/置顶/删除、批量删除）。

**文件浏览与编辑**：顶栏「文件」标签，浏览器式标签条（拖拽排序、关闭/全部关闭、未保存圆点）；24 语言语法高亮、Markdown 渲染、Sticky Scroll 作用域导航；直接编辑并支持跨行选择、多行粘贴、缩进/反缩进；独立的撤销/重做栈（只撤销用户编辑，绝不撤销 AI 改动），按（工作区, 路径）持久化，重启后仍可撤销；Ctrl+S 保存、切换会话/关闭标签时提示保存、AI 改动后自动保存。

**Agent 变更审阅**：输入框上方的修改文件列表（+/− 统计、逐文件或全部接受/拒绝、撤销上次拒绝）；行级 diff，支持块级/文件级接受与拒绝；基线制——接受即新基线，拒绝把基线写回磁盘（新增文件拒绝即删除）；二进制可还原。大文件不再整文件降级：按需加载内容并保留内容指纹，40,000 行以上只渲染改动块。

**文件内搜索**：Ctrl+F，选中文本自动填入，琥珀色高亮、▲▼ 导航、Esc 关闭。

**即时更新**：agent 改/增/删文件后约 1.5 秒内出现在界面（SSE 唤醒）；CRLF/LF 等纯换行符变化不算改动，不进审阅。

**集成终端**：「终端」标签，工作目录＝会话工作区，逐条命令独立进程（`cd` 保持）；ANSI 颜色、`\r` 进度条、运行中可「中断」或向 stdin 输入以回答交互提示；↑↓ 命令历史、Ctrl+L 清空。注意：终端命令不受 agent 沙箱限制（等同本机终端）。

**项目运行按钮**：文件工具栏右侧，自动识别项目入口并按「项目本地运行时优先、全局兜底」排序——Node（读锁文件判定 pnpm/yarn/bun/npm）、Python、Rust、Go、.NET、Java、Make、PHP、Ruby、Docker Compose、`run.ps1`/`run.sh`。左键：唯一候选直接跑，多候选弹列表；右键：总是弹列表先看用哪个解释器；运行中左键＝中断。

## 安装

```powershell
cd C:\Users\HW\deepseek-harness
pnpm dsh plugin --profile web add @justarook1e/dsh-ide-lite
```

装完**重启** `pnpm dsh web`，页面 Ctrl+F5。升级把包名换成 `@justarook1e/dsh-ide-lite@latest` 重跑即可。

亦可用脚本（幂等）：`irm https://raw.githubusercontent.com/justarook1e/dsh-ide-lite/main/install.ps1 | iex`

卸载：`pnpm dsh plugin --profile web remove @justarook1e/dsh-ide-lite`，重启生效；再手动删 `~\.dsh\dsh-file-edit-state`（运行期审阅状态，可选）。

## 发版

改 `package.json` 版本号 → 提交推送 → 打 tag 推送，workflow 校验版本号与 tag 一致后自动发布到 npm：

```powershell
git push origin main
git tag v1.31.2; git push origin v1.31.2
```

## 已知限制

- 替换了原生 WorkspaceBrowser：无搜索、分组/排序菜单、重命名/删除/归档对话框（保留添加工作区、打开/新建会话）。
- 审阅扫描上限 8000 条目 / 16 层；单目录文件树显示上限 4000 条；`>64MB` 文本只有整文件接受/拒绝。
- Agent 通过 shell/pwsh 执行的改动无法区分同窗口内的人工操作，会保守归入审阅。
- 项目运行按钮的入口识别是启发式的，本地运行时只搜索约定目录与「打包目录」形状，不做全树递归。
- 浏览器通知需页面获得用户激活，sound 播放受浏览器 autoplay 策略约束。
- 状态目录的 `blobs/` 会随大文件基线快照增长，可安全删除。

## 开发

无构建步骤：`client/dist/client.js` 为手工维护的静态 bundle。改完直接同步到插件安装路径并重启 + 刷新。

```powershell
# 同步到安装路径
Copy-Item .\package.json,.\cordis.patch.yml,.\host\,.\client\ "$env:USERPROFILE\.dsh\profiles\web\node_modules\@justarook1e\dsh-ide-lite\" -Recurse -Force
```

## 许可证

MIT。客户端 bundle 内嵌 markdown-it v15 UMD 构建（含 linkify-it、mdurl、uc.micro），均为 MIT，声明见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

> 本项目全部代码由 DeepSeek-V4-Pro 与 DeepSeek-V4-Flash 生成。
