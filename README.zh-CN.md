# Personal Immersive Translator

> 一个本地优先的 Chrome 页面翻译插件，通过已登录的 Codex CLI 使用 GPT-5.3-Codex-Spark。

[English README](./README.md) · [Changelog](./CHANGELOG.md)

Personal Immersive Translator 是一个个人版页面翻译插件。Chrome 插件只负责采集页面文本和回填译文；真正的模型调用交给本机 Node.js server。默认情况下，server 会常驻一个 Codex app-server，并复用你已经通过 ChatGPT 登录的 Codex 会话。

## 功能

- 翻译当前 Chrome 页面。
- 可以选择常用目标语言，也可以输入任意自定义语言。
- 页面内悬浮翻译按钮，支持快捷操作。
- 悬浮球可拖动，并自动吸附到页面左右边缘。
- 浏览器工具栏 popup 和页面悬浮菜单提供同一组核心控制。
- 优先翻译当前可见区域，提升体感速度。
- 按段落/标题/list item 等块级结构翻译，而不是打碎文本节点。
- 通过稳定的 `pitId` 将译文匹配回原 DOM 块，降低错位风险。
- 本地翻译缓存，重复文本几乎瞬时返回。
- 默认使用已登录的 Codex CLI，也支持 OpenAI API 后端。

## 架构

```text
Chrome extension
  -> 本地 server: http://127.0.0.1:8787
    -> 常驻 Codex app-server
      -> gpt-5.3-codex-spark
```

插件不会保存 API key 或 ChatGPT token。它只连接本机 server；server 在你的机器上管理 Codex 进程。

## 环境要求

- macOS
- Chrome
- Node.js 18+
- 已登录 ChatGPT 的 Codex CLI：

```bash
codex login
codex login status
```

## 快速开始

双击：

```text
Start Translator.command
```

或者手动运行：

```bash
cd /Users/samsoncj/develop/codex-playground/personal-immersive-translator
npm run doctor
npm run start:codex
```

翻译时保持这个终端窗口打开。

## 加载 Chrome 插件

1. 打开 `chrome://extensions`。
2. 打开 Developer mode。
3. 点击 Load unpacked。
4. 选择 `extension/` 文件夹。
5. 打开普通网页。
6. 使用页面里的悬浮球，或点击扩展 popup 进行翻译。

`chrome://extensions` 这类浏览器内部页面无法翻译，这是 Chrome 对 content script 的限制。

## 悬浮球

插件会在普通网页中注入一个小的悬浮球。

- 拖动后会自动吸附到页面左侧或右侧。
- 左键点击可以在翻译和原文之间切换。
- 右键点击会打开悬浮菜单，包含 server 状态、目标语言、模式和快捷操作。
- 如果隐藏了悬浮球，可以在扩展 popup 中打开 `Advanced -> Show floating button`。

## 配置

扩展 popup 内置常用目标语言，例如中文、英文、日文、韩文、法文、德文、西班牙文、葡萄牙文、意大利文、俄文、阿拉伯文、印地文、越南文、泰文和印尼文。选择 `Custom...` 后可以输入任何其他目标语言或地区变体，例如 `Dutch` 或 `Brazilian Portuguese`。

默认后端是常驻 Codex app-server：

```bash
export TRANSLATOR_BACKEND="codex-app"
export CODEX_MODEL="gpt-5.3-codex-spark"
```

其他后端：

```bash
# 兼容模式。每个批次都会启动一次 codex exec，速度较慢。
export TRANSLATOR_BACKEND="codex"

# OpenAI API 后端。需要 OPENAI_API_KEY，单独走 API 计费。
export TRANSLATOR_BACKEND="openai"
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-5.4-mini"
```

如需关闭预热：

```bash
export CODEX_PREWARM=0
```

## 常用命令

```bash
npm run check:version
npm run doctor
npm run start:codex
npm run start:api
```

## 版本管理

项目使用 semver。每次面向 release 的变更，都需要同步 `package.json`、`extension/manifest.json` 和 `CHANGELOG.md`。推送前运行 `npm run check:version`。

## 说明

ChatGPT 订阅额度和 OpenAI API 计费是分开的。本项目默认使用官方 Codex CLI 的登录路径，适合作为个人自用的订阅能力桥接。OpenAI API 后端是可选项，并会走单独 API 计费。
