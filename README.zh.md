# incipit

*a quiet typesetting patch for long-form reading*

---

 Vscode 的 Claude Code 插件聊天界面是为代码对话设计的——简洁的线框元素、工程风格的无衬线字体、偶尔出现的高饱和警示色。作为一个编程工具，这没有问题。但 Claude 的实际产出远不止代码：数学推导、长篇技术写作、中英文混杂的学术讨论，这些内容在一个面向代码的界面里读起来并不舒服，数学公式甚至完全没有渲染。

incipit 把这个聊天面板改造成一个经过完整设计的阅读环境，这是一个纯前端改造，不涉及任何功能添加和网络请求的修改。让 Claude Code 不只是写代码的地方，也能胜任长期的阅读、学习和科研工作。它是一个本地安装器，跑一次，重载 VS Code，不需要额外依赖，随时可以还原。

---

<p align="center">
  <img src="docs/screenshots/typography.png" width="360" alt="衬线排版与中英文混排" />
  <img src="docs/screenshots/math.png" width="360" alt="KaTeX 数学公式渲染" />
</p>
<p align="center">
  <img src="docs/screenshots/tables.png" width="360" alt="Booktabs 风格表格" />
  <img src="docs/screenshots/blockquotes.png" width="360" alt="嵌套引用与中英古文" />
</p>
<p align="center">
  <img src="docs/screenshots/toolcalls.png" width="360" alt="工具调用、用户气泡与上下文监控" />
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

第一次运行会先选语言，之后进入交互菜单，你可以看到当前的扩展路径和备份状态，选择应用或还原。每次应用前会自动备份。

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

**上下文与缓存监控。** 输入框底部有一个常驻的小按钮，显示当前上下文大小和缓存命中率。点开可以看到最近几轮的明细和整个会话的累计统计。这些数据来自 Claude Code 写在本地的日志，不经过任何网络请求。

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

## License

MIT. 见 [LICENSE](LICENSE)。
