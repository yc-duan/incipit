# incipit

*a quiet typesetting patch for long-form reading*

---

 Vscode 的 Claude Code 插件聊天界面是为代码对话设计的——简洁的线框元素、工程风格的无衬线字体、偶尔出现的高饱和警示色。作为一个编程工具，这没有问题。但 Claude 的实际产出远不止代码：数学推导、长篇技术写作、中英文混杂的学术讨论，这些内容在一个面向代码的界面里读起来并不舒服，数学公式甚至完全没有渲染。

incipit 把这个聊天面板改造成一个经过完整设计的阅读环境，这是一个纯前端改造，不涉及任何功能添加和网络请求的修改。让 Claude Code 不只是写代码的地方，也能胜任长期的阅读、学习和科研工作。它是一个本地安装器，跑一次，重载 VS Code，不需要额外依赖，随时可以还原。

---

<p align="center">
  <img src="docs/screenshots/math.png" width="360" alt="KaTeX 数学公式渲染" />
  <img src="docs/screenshots/blockquotes.png" width="360" alt="嵌套引用与下划线链接" />
</p>
<p align="center">
  <img src="docs/screenshots/tables.png" width="360" alt="Booktabs 风格表格与特性矩阵" />
  <img src="docs/screenshots/lists.png" width="360" alt="有序与无序列表、复选框样式" />
</p>
<p align="center">
  <img src="docs/screenshots/code.png" width="360" alt="行内与多行代码块、语法高亮" />
  <img src="docs/screenshots/toolcalls.png" width="360" alt="工具调用、路径截断与 +N/-M 行数统计" />
</p>

---

## 安装

需要 Node.js 16 或更新。

通过下列命令安装
```bash
npm install -g incipit
```

然后终端输入incipit，可进入到交互界面：

```bash
incipit
```

第一次运行会先选语言，之后进入交互菜单，你可以看到当前的扩展路径和备份状态，选择应用或还原。每次应用前会自动备份；settings.json 只备份修改过的那几个键，不做整文件副本，避免还原时意外波及你其他的 VS Code 配置。

如果不想进菜单：

```bash
incipit apply     # 直接应用
incipit restore   # 直接还原
```

注意：本项目不是一个重写的claude code，它是更改本地安装的文件的渲染层，所以claude code本体更新，需要重新incipit apply

---

## 它做了什么

incipit 对聊天界面做了完整的重新设计，覆盖排版、渲染、交互和可观测性。

**排版与视觉。** 正文换成衬线字体（英文 IBM Plex Serif，中文 Noto Sans SC），行距、段距、标题层级按正式排版比例重新设定。在 Windows 上，字号和字体参数经过额外的针对性调校，确保 ClearType 次像素渲染处于最佳状态，衬线字体在屏幕上清晰锐利而不发毛。整套色彩方案重新设计为暖色调暗底，只保留一个克制的强调色，原始界面里的高饱和警示元素被收敛到统一的视觉语言中。

**数学公式。** Claude 的回复经常包含数学内容，但原始界面不做任何渲染，公式以源码形式显示。incipit 让行内公式和独立段落公式都能就地排版为数学符号。渲染在本地完成，不联网。

**交互修复。** Claude Code 原生的问题：你手动展开的 thinking 块，所有thinking会自动打开，导致视点漂移。incipit 修复了这个行为，thinking块仅展开用户当前选中的。用户消息的气泡上方加了复制按钮，过长的消息可以折叠和展开。

**工具调用。** Claude Code 的每条消息都嵌着工具调用（读文件、改文件、跑命令、查代码）。原生处理比较粗糙：Edit 默认折叠成 `Added X lines`，看不到改了什么；其他工具的展开内容占满视口，长对话被 diff 编辑器淹没。incipit 重写了这一层——Edit / MultiEdit / Write 类的改动会算出精确的 `+N / -M` 行数放在文件名右侧，其他工具保留宿主的一行简短描述作为标识。所有工具调用默认折叠，展开箭头和 thinking 块共用同一套动画，点击整行任意位置切换展开，文件路径保持可选中。

**上下文与缓存监控。** 输入框底部有一个常驻的小按钮，显示当前上下文大小和缓存命中率。点开可以看到最近几轮的明细和整个会话的累计统计。这些数据来自 Claude Code 写在本地的日志，不经过任何网络请求。

**命令行工具。** 直接运行 `incipit` 进入交互菜单，显示当前扩展路径和备份状态，用方向键或 j/k 导航、空格切换、回车进入，支持中英双语（首次启动会提示选择）。菜单里可以打开/关闭数学公式、会话徽章、工具调用折叠，切换正文字号（12/13/14 三档）。每次启动会检查 npm 上是否有新版本（12 小时缓存，可用 `--no-update-check` 关闭），有新版本时询问是否代跑升级。`incipit apply` 和 `incipit restore` 作为非交互子命令（CI、脚本场景）不弹任何 prompt。

---

## 合规性

这是一个纯前端改造项目，没有侵入任何模型工具调用层，网络请求层。

Claude供应商的用户协议约束的是你和他们服务之间的关系：不能滥用 API、不能绕开限速、不能伪造身份、不能干扰服务端协议。incipit 完全不在这个范围里——它只改你本地屏幕上的渲染方式，和Claude模型供应商的服务器之间没有任何连接。你发出的每一个字节，装它之前和之后是一样的。

---

## 还原

```bash
incipit restore
```

进入还原菜单后，你会看到所有可用的备份。选一个，确认，被改过的文件就会写回备份时的状态。你在 VS Code settings 里自己做的其他配置不受影响。

另一种办法：在 VS Code 里右键 Claude Code 扩展，选 Reinstall Extension，整个扩展目录会被重建为官方原版。备份目录 `~/.incipit-backup/` 不受影响，想重新应用再跑一次 `incipit` 即可。

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
