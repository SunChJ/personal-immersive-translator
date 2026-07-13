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
- 首批优先返回、后续按字符预算批处理，兼顾首屏速度和长页面吞吐。
- 相同全文只请求一次，并把译文准确回填到每个 DOM 位置。
- 替换模式不会销毁原始链接和行内节点，清除后可完整恢复。
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
cd /path/to/personal-immersive-translator
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

默认预热会初始化 Codex app-server 并验证一个临时 thread，但不会额外发起模型 turn。如需关闭：

```bash
export CODEX_PREWARM=0
```

codex-app 后端默认最多并发执行 3 个 FIFO 翻译 turn。每个 turn 都使用新的临时 thread，并在结束后删除，不会在不同网页之间共享对话历史。可按需调整上限：

```bash
export CODEX_APP_MAX_CONCURRENCY=3
```

## 常用命令

```bash
npm run check:version
npm run doctor
npm run verify
npm run observe
npm run start:codex
npm run start:api
```

## 验证与性能观测

完整验证不会调用真实模型，而是使用确定性的本地假后端：

```bash
npm run verify
```

它依次执行版本检查、纯逻辑单元测试、真实 Chrome DOM 注入测试、server 集成测试，以及并发压力 smoke test。也可以分开运行：

```bash
npm run test:unit
npm run test:batch
npm run test:server
npm run test:stress
```

保存优化前后两份相同配置的结果，即可进行回归判定：

```bash
npm run perf -- --requests 200 --concurrency 24 --items 40 \
  --unique-ratio 0.25 --delay-ms 50 \
  --output artifacts/perf/baseline.json

# 修改代码后，用相同参数生成 current.json
npm run perf -- --requests 200 --concurrency 24 --items 40 \
  --unique-ratio 0.25 --delay-ms 50 \
  --output artifacts/perf/current.json

npm run perf:compare -- \
  artifacts/perf/baseline.json artifacts/perf/current.json
```

报告包含 p50/p95/p99、吞吐、错误率、后端调用量、去重/缓存/并发合并节省量；默认在 p95 或吞吐回归超过 10%、后端 items 增加、错误率增加时返回非零退出码。`artifacts/perf/` 已忽略，不会污染 Git。

本机装有 `hyperfine` 时，可以重复测量包括进程启动在内的完整墙钟时间：

```bash
npm run perf:hyperfine
```

结果同时保存到 `artifacts/perf/hyperfine.json`。

运行真实 translator 时，可读取匿名实时指标或持续观察：

```bash
npm run observe
npm run observe -- --watch 2
npm run observe -- --reset
```

单次观测结果为 `FAIL` 时命令返回非零退出码。`GET /metrics` 仅包含请求数、成功率、items、cache/coalesced/backend miss、最近最多 2048 次请求的 P50/P95/P99 和运行时 gauge，不保存原文、译文或 DOM ID。重置指标使用 token 鉴权，且不会清除翻译缓存。

## 版本管理

项目使用 semver。每次面向 release 的变更，都需要同步 `package.json`、`extension/manifest.json` 和 `CHANGELOG.md`。推送前运行 `npm run check:version`。

## 说明

ChatGPT 订阅额度和 OpenAI API 计费是分开的。本项目默认使用官方 Codex CLI 的登录路径，适合作为个人自用的订阅能力桥接。OpenAI API 后端是可选项，并会走单独 API 计费。
