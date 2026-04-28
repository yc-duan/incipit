# incipit

*A frontend rework of the official Claude Code VS Code extension — surface redrawn, engine untouched.*

---

incipit 把 Claude Code 在 VS Code 里的整套前端——正文排版、数学渲染、tool call 折叠、diff、本地历史的编辑——按文学风格重新设计，工程信息也归并到统一的视觉语言。没有更改，侵入任何模型请求、鉴权、tool schema、CLI spawn 协议；装它前后，服务端那一侧看到的字节完全相同。

跑一次，重载 VS Code 即可，不需要额外依赖。每次 Claude Code 升级覆盖前端文件后，重跑一次。备份按版本保存，随时还原。

---

## 它是补丁，不是独立扩展

incipit 修改的是 Claude Code 官方扩展在你磁盘上的文件，本身不是 VS Code 插件，也不替代官方扩展。Claude 订阅、API key、登录态、MCP 配置、tool schema、权限设置——一切官方逻辑——都跟没装它的时候一样。

撤掉它，扩展立刻回到出厂状态。

---

## 安装

需要 Node.js 16 或更新版本。

```bash
npm install -g incipit@latest
```

`incipit` 是终端 CLI，必须全局安装。`npm install incipit`（不带 `-g`）是 npm 装本地依赖的写法，会把包丢进当前目录的 `node_modules/`，既不会注册到系统 PATH，也跑不到正确版本。

装好后直接运行：

```bash
incipit
```

首次启动会 CLI 语言选择，之后进入交互菜单：

<p align="center">
  <img src="docs/screenshots/cli-menu-zh.png" width="420" alt="incipit CLI 主菜单：应用补丁 / 还原备份 / 配置 / 管理目标位置 / CLI 界面语言" />
  <img src="docs/screenshots/cli-configure-zh.png" width="420" alt="incipit 配置子菜单：数学公式渲染、会话用量、正文字号、主题色" />
</p>

菜单操作：

- **Apply / Restore**：应用补丁或回滚到 apply 之前的状态。每次 apply 前自动备份，按 Claude Code 版本保存完整快照（含整份 `webview/`），还原时不会动你其他的 VS Code 配置。
- **Configure**：开关数学公式渲染、会话用量徽章；切换正文字号（12 / 13 / 14）和暖黑 / 暖白主题。
- **Manage Claude Code targets**：自动探测 VS Code / Cursor / Insiders / VSCodium / Windsurf / Antigravity，也支持手动指定扩展目录。
- **CLI language**：随时切换中英文。

跳过菜单直接执行：

```bash
incipit apply     # 直接应用
incipit restore   # 打开轻量还原选择器
```

Claude Code 扩展每次更新后，本地补丁会被官方文件覆盖，重跑 `incipit` 并应用即可。更新 incipit 自身用同一条全局安装命令。

卸载 incipit CLI：

```bash
npm uninstall -g incipit
```

仅移除 `incipit` cli 本身，不会自动还原已应用到 Claude Code 扩展里的补丁，也不会删除 `~/.incipit/` / `~/.incipit-backup/`。

---

## 界面

文学风格界面——暖黑底色，米色调衬线字体，色域窄到只剩同色相的明度阶差，陶土红只在链接、强调和底部状态行克制地点出。

<p align="center">
  <img src="docs/screenshots/panel.png" width="420" alt="incipit 聊天面板整体外观：暖黑底色、米色衬线正文、底部状态行" />
</p>

排版本身是界面在做的事：数学渲染，表格呈现booktabs，代码块的语法色被压低，工具调用收成一行，展开层用暗红暗绿做 diff，字符级差异再以淡彩在行内细描。

工程信息归并为统一的文学风格——工具调用、diff、状态行的字体、色相、强调方式都与正文风格一致。

<p align="center">
  <img src="docs/screenshots/tools.png" width="420" alt="incipit 工具调用展开块：暗红暗绿 diff 底色、克制行号、字符级行内淡彩，与正文同调" />
</p>

---

## 上下文与缓存

输入框上方的状态行常驻显示当前上下文体量和缓存命中率，数字随每一次发出和回复实时刷新。点开后展开一个浮层，列出最近几轮的 token 用量和缓存比例，以及整段会话的累计统计。

<p align="center">
  <img src="docs/screenshots/usage.png" width="420" alt="incipit 上下文与缓存徽章：状态行常驻数字与点开后的会话用量浮层" />
</p>

数据来自 Claude Code 本地的 JSONL 转录，**不经由任何网络，不调用任何模型请求。**

---

## diff

Edit / Write 的 diff 不保留宿主默认的双栏 Monaco：文件名 + `+N −M` 位于头部，删除行铺一层暗红底色，新增行铺一层暗绿，行号克制，字符级差异在行内再做一次同色相但更显的二次着色。短 diff 直接展开，长 diff 折成卡片，点 `Click to expand` 在浮层里看完整。

<p align="center">
  <img src="docs/screenshots/diff-warm-black.png" width="360" alt="incipit diff 暖黑主题：酒红 / 森林绿底色，字符级行内二次着色" />
  <img src="docs/screenshots/diff-warm-white.png" width="360" alt="incipit diff 暖白主题：浅粉红 / 浅粉绿底色，字符级行内二次着色" />
</p>

暖黑主题下是酒红 / 森林绿，暖白主题下是浅粉红 / 浅粉绿。不同主题所有元素经过独立且统一的设计。

---

## 数学渲染

完整的，支持各类复杂情况的公式渲染。

<p align="center">
  <img src="docs/screenshots/math-blocks.png" width="360" alt="incipit 公式渲染：显示块、求和 / 积分 / 极限 / 连乘、矩阵与对齐方程" />
  <img src="docs/screenshots/math-in-prose.png" width="360" alt="incipit 公式渲染：列表项、blockquote、表格单元格内的行内与块级公式" />
</p>

KaTeX 按需加载，当前回复里没有公式就不启动数学链路。字号 1.21em，与衬线正文和 CJK 混排时笔画粗细对得齐。
同时修复了KaTeX原生的括号被撑大的问题。

---

## 对话历史编辑

- 每条用户消息底部，都有图标：edit / rerun / fork / more。

<p align="center">
  <img src="docs/screenshots/actions.png" width="420" alt="incipit 用户消息底部的动作行：edit / rerun / fork / more 四个克制小图标" />
</p>

- Edit (内联编辑)：在消息原位展开编辑器。AI消息同样支持编辑。所有输出块均可支持编辑。

<p align="center">
  <img src="docs/screenshots/edit-assistant.png" width="420" alt="incipit 内联编辑器：AI 回合的就地编辑——透明面板、衬线正文、底部 × / ✓ 两个动作图标" />
</p>

- 附件管理：消息展示历史附加的 IDE 文件引用、代码选区及图片。支持点击移除现有附件，也可直接拖拽或粘贴引入新图片。
本地保存机制：点击保存仅改写本地 JSONL 对话记录文件，不触发任何网络请求。
重发逻辑：编辑功能仅负责修改本地上下文状态。若需将修改后的内容提交给模型，需在保存后配合使用 Rerun 功能。

<p align="center">
  <img src="docs/screenshots/edit-user.png" width="420" alt="incipit 内联编辑器：用户消息的就地编辑——顶部 chip strip 含图片附件 chip 与添加按钮" />
</p>

- Rerun (重试)：仅用户消息处可用，允许在任何用户消息处执行。移除后续对话全部上下文，通过 Claude Code 原生接口（session.send）在同一的sessionid下原样重发当前消息，完整保留图文及 IDE 引用结构。**这意味着改用户消息及以前的上下文，缓存保留**

- Fork (分支)：调用宿主APP forkConversation 接口，将当前及之前的上下文复制到新会话，原会话保留。

- More (更多菜单)：
包含 代码回滚 (Rewind) 及其组合操作（回滚并 Rerun、回滚并 Fork）。回滚通过调用 session.rewindCode 撤销后续所有磁盘文件更改。
包含 Copy as text / markdown 复制选项。

Incipit 的本地历史能力遵循原则：不伪造模型上下文，不自行构造 Claude Code 的消息树，也不绕开 Claude Code 的会话协议。涉及 rerun、edit、rewind、fork 等操作，Incipit 只在本地 JSONL 上执行可验证的最小变更：截断历史时保留合法前缀，删除用户消息及其后续派生内容，避免留下孤立的 assistant/tool_use/tool_result 片段；随后重新发送、代码回滚和会话分叉均交回 Claude Code 的原生接口处理，如 `session.send`、`rewindCode`、`forkConversation` 等。

为了避免不可逆写盘造成损坏状态，Incipit 在执行前会做严格的 preflight 校验：必须能确认当前 session id、目标 JSONL、宿主 SessionState 以及相关原生接口都可用，否则操作会被直接拦截。rerun 截断后如果后续发送失败，Incipit 还会在确认 transcript 尚未产生新追加内容的前提下恢复原始 JSONL。这样做的目标是确保本地历史变更不会产生违反 Claude Code / Anthropic messages 结构约束的异常上下文，例如悬空的 tool result、错误的角色顺序、错位的会话分支或不一致的文件状态。

---

## 合规性

这是一个纯前端改造项目，没有侵入任何模型工具调用层，网络请求层。

Claude供应商的用户协议约束的是你和他们服务之间的关系：不能滥用 API、不能绕开限速、不能伪造身份、不能干扰服务端协议。incipit 完全不在这个范围里——它只改你本地屏幕上的渲染方式，和Claude模型供应商的服务器之间没有任何连接。你发出的每一个字节，装它之前和之后是一样的。

---

## 还原

```bash
incipit restore
```

进入还原菜单，CLI 会先锁定当前 Claude Code 目标，只显示同版本、同扩展目录的备份。不同 Claude Code 版本的备份不会互相还原；同一个备份名可以同时存在于不同版本下面。选一个，确认，被改过的扩展文件就会写回 apply 之前的状态，复制进 `webview/` 的资源也会被清掉。你在 VS Code settings 里自己做的其他配置不受影响。

---

## 平台

Windows 11 下经过充分测试，日用稳定。

Linux 和 macOS 理论上可以正常工作，但目前没有实机验证。如果遇到问题，提 issue 时附上你的 Claude Code 扩展版本号和报错信息。

Claude Code 扩展每次更新后，补丁会被一并覆盖。再跑一次 `incipit` 即可，通常十秒内完成。

---

## 为什么不做成 VS Code 插件

VS Code 的扩展之间有严格的沙箱隔离，一个插件没有办法向另一个插件的界面注入脚本或样式。要改变 Claude Code 聊天界面的渲染，唯一的途径是直接修改它在本地磁盘上的文件。这就是 incipit 走补丁路线的原因。

如果Claude Code官方将来提供官方的主题或样式注入接口，这个项目会第一时间迁移过去，届时补丁方案归档。

---

## 致谢

感谢 [linuxdo](https://linux.do/) 社区的交流、分享与反馈。

---

## License

MIT. 见 [LICENSE](LICENSE)。

---
