# dsh-ide-lite

DSH WebUI 的轻量 IDE 插件：把「文件」和「终端」两个标签页加进会话界面。

> ⚠️ **测试版**：含实验性的文件编辑、撤销/重做与自动保存，请对重要文件与会话数据做好备份。
>
> 适配 DSH（deepseek-harness）`dsh-v0.1.5-rc.1`。

## 功能

- **工作区侧边栏**（替换原生浏览器）：项目文件树（按层加载、Git 状态着色、`.gitignore` 灰显）＋ 会话历史（新建/切换/置顶/删除）。
- **文件浏览与编辑**：「文件」标签内的浏览器式标签条（拖拽排序、未保存标记）；24 语言语法高亮、Markdown 渲染、代码作用域粘性导航；直接编辑，独立撤销/重做栈只撤销你的编辑、绝不撤销 AI 改动，且重启后仍可撤销；Ctrl+S 保存、AI 改动后自动保存。
- **Agent 变更审阅**：修改文件列表（+/− 统计、逐文件或全部接受/拒绝、撤销上次拒绝）＋ 行级 diff（块级/文件级接受与拒绝）。基线制：接受即新基线，拒绝把基线写回磁盘，新增文件拒绝即删除，二进制可还原。
- **大文件可用**：按需加载内容并保留内容指纹，不再因体积或行数退化成「只能整文件接受/拒绝」。
- **即时更新**：agent 改/增/删文件后约 1.5 秒内出现在界面；纯换行符变化（CRLF/LF）不算改动，不会误报。
- **集成终端**：「终端」标签，工作目录＝会话工作区，逐条命令独立进程（`cd` 保持）；ANSI 颜色、进度条重写、可中断、可向运行中的进程输入以回答交互提示、命令历史。注意：终端命令不受 agent 沙箱限制（等同本机终端）。
- **项目运行按钮**：自动识别项目入口（Node / Python / Rust / Go / .NET / Java / Make / PHP / Ruby / Docker Compose / 脚本），并优先使用项目内的本地运行时；一键运行与停止。

## 安装

```powershell
pnpm dsh plugin --profile web add @justarook1e/dsh-ide-lite
```

装完**重启** `pnpm dsh web`，然后 **Ctrl+F5** 刷新页面。

亦可用脚本（幂等，可重复执行）：

```powershell
irm https://raw.githubusercontent.com/justarook1e/dsh-ide-lite/main/install.ps1 | iex
```

## 升级

```powershell
pnpm dsh plugin --profile web add @justarook1e/dsh-ide-lite@latest
```

## 卸载

```powershell
pnpm dsh plugin --profile web remove @justarook1e/dsh-ide-lite
```

重启生效。可选：删除运行期审阅状态目录 `~\.dsh\dsh-file-edit-state`（会丢历史「拒绝」基线，不影响任何代码文件）。

## 文档

本 README 是唯一随 npm 包发布的文档。项目规范、踩坑记录与交接说明见仓库中的 [DEV.md](https://github.com/justarook1e/dsh-ide-lite/blob/main/DEV.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。客户端 bundle 内嵌 markdown-it v15（含 linkify-it、mdurl、uc.micro），声明见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

> 本项目全部代码由 DeepSeek-V4-Pro 与 DeepSeek-V4-Flash 生成。
