# Personal Immersive Translator

> 一个本地优先的 Chrome 页面翻译插件，通过已登录的 Codex CLI 使用 GPT-5.3-Codex-Spark。

[English README](./README.md)

Personal Immersive Translator 是一个个人版页面翻译插件。Chrome 插件只负责采集页面文本和回填译文；真正的模型调用交给本机 Node.js server。默认情况下，server 会常驻一个 Codex app-server，并复用你已经通过 ChatGPT 登录的 Codex 会话。

## 功能

- 翻译当前 Chrome 页面。
- 页面内悬浮 `译` 按钮，支持快捷操作。
- 悬浮球可拖动，并自动吸附到页面左右边缘。
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
6. 使用页面里的 `译` 悬浮球，或点击扩展 popup 进行翻译。

`chrome://extensions` 这类浏览器内部页面无法翻译，这是 Chrome 对 content script 的限制。

## 悬浮球

插件会在普通网页中注入一个小的 `译` 悬浮球。

- 拖动后会自动吸附到页面左侧或右侧。
- 点击可以打开快捷菜单。
- 支持 Translate、Clear、Hide Floating。
- 如果隐藏了悬浮球，可以在扩展 popup 中打开 `Advanced -> Show floating button`。

## 配置

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
npm run doctor
npm run start:codex
npm run start:api
```

## 说明

ChatGPT 订阅额度和 OpenAI API 计费是分开的。本项目默认使用官方 Codex CLI 的登录路径，适合作为个人自用的订阅能力桥接。OpenAI API 后端是可选项，并会走单独 API 计费。
