# Gloss 浏览器扩展

> 由 Gloss macOS App 内置的原生 Rust runtime 与独立 ChatGPT 登录驱动的沉浸式网页翻译扩展。

[English README](./README.md) · [Changelog](./CHANGELOG.md)

Gloss 扩展通过同一套 WXT 代码为 Chrome 和 Safari 提供整页、划词、双语和替换式翻译。模型调用统一交给原生 Gloss App，因此不再需要保持终端服务运行，浏览器也不会接触 ChatGPT 凭据。

## 功能

- 在 Chrome 或 Safari 中翻译当前页面。
- 可以选择常用目标语言，也可以输入任意自定义语言。
- 页面内悬浮翻译按钮，支持快捷操作。
- 悬浮球可拖动，并自动吸附到页面左右边缘。
- 浏览器工具栏 popup 和页面悬浮菜单提供同一组核心控制。
- 优先翻译当前可见区域，提升体感速度。
- 按段落/标题/list item 等块级结构翻译，而不是打碎文本节点。
- 通过稳定的 `pitId` 将译文匹配回原 DOM 块，降低错位风险。
- 首批优先返回、后续按字符预算批处理，兼顾首屏速度和长页面吞吐。
- 可以调整每批 item 数和字符预算，同时保留按 provider 限流的并发保护。
- Chrome 与 Safari 均支持 YouTube 字幕翻译，使用独立的播放时间窗队列和双语覆盖层。
- 划词译文可通过系统声音朗读，支持语速、长文本分句和单实例停止控制。
- 相同全文只请求一次，并把译文准确回填到每个 DOM 位置。
- 替换模式不会销毁原始链接和行内节点，清除后可完整恢复。
- 本地翻译缓存，重复文本几乎瞬时返回。
- 与 Gloss 原生端共享翻译代理、缓存和独立的 ChatGPT 会话。

## 架构

```text
Chrome 或 Safari extension
  -> 已鉴权的回环桥接：http://127.0.0.1:8787
    -> Gloss TranslationBroker
      -> Codex app-server
```

Gloss 会在私有 App 存储中生成随机的 256 位配对令牌。Chrome 从 App 管理的扩展副本读取；Safari 通过签名的原生扩展和 App Group 获取。桥接只监听 `127.0.0.1`，仅允许 Chrome 与 Safari 扩展来源，并且不会向浏览器暴露 ChatGPT 凭据。

## 环境要求

- macOS
- Chrome 或 Safari
- Gloss
- Node.js 20.12+（构建扩展时）

首次使用时，在 **Gloss 设置 → 登录 ChatGPT** 完成一次登录即可。正常使用 Gloss 不需要单独安装 Codex CLI 或 Node.js；只有从源码构建扩展时才需要 Node.js。

## 快速开始

从仓库根目录构建并打开 Gloss：

```bash
cd Gloss
./Scripts/build_app.sh
open dist/Gloss.app
```

构建脚本会在 `personal-immersive-translator` 依赖仓库中运行 WXT，打包 Chrome 产物并嵌入 Safari 扩展。完成后打开 **Gloss 设置 → 浏览器扩展**。

扩展开发命令：

```bash
cd /path/to/personal-immersive-translator
npm run verify
```

## 加载 Chrome 插件

1. 在 Gloss 设置中点击**显示扩展**。
2. 打开 `chrome://extensions`，启用 Developer mode。
3. 点击 **Load unpacked**，选择 Finder 中显示的 `BrowserExtension` 文件夹。
4. 如果 Chrome 请求**本地网络访问**，请选择允许；扩展需要借此连接 `127.0.0.1` 上的 Gloss。
5. 使用页面悬浮球或扩展 popup 翻译。

开发扩展源码时，运行 `npm run build:chrome`，加载 `.output/chrome-mv3`，并在扩展设置中粘贴 Gloss 提供的配对令牌。

`chrome://extensions` 这类浏览器内部页面无法翻译，这是 Chrome 对 content script 的限制。

## 启用 Safari 扩展

1. 构建并打开 `Gloss.app`。
2. 在 Gloss 设置中点击 **Safari 设置**。
3. 在 Safari 中启用 **Gloss Extension**，并按提示授予网页访问权限。

只开发扩展时，可运行 `npm run build:safari`，再打开 `safari/Gloss/Gloss.xcodeproj`。Xcode 工程直接引用 `.output/safari-mv3`；浏览器代码和 manifest 仍以 WXT 为唯一来源。

## 悬浮球

插件会在普通网页中注入一个小的悬浮球。

- 拖动后会自动吸附到页面左侧或右侧。
- 左键点击可以在翻译和原文之间切换。
- 右键点击会打开悬浮菜单，包含 server 状态、目标语言、模式和快捷操作。
- 如果隐藏了悬浮球，可以在扩展 popup 中打开 `Advanced -> Show floating button`。

## 翻译设置

扩展 popup 内置常用目标语言，例如中文、英文、日文、韩文、法文、德文、西班牙文、葡萄牙文、意大利文、俄文、阿拉伯文、印地文、越南文、泰文和印尼文。选择 `Custom...` 后可以输入任何其他目标语言或地区变体，例如 `Dutch` 或 `Brazilian Portuguese`。

后端和模型生命周期由 Gloss 统一管理。浏览器扩展只保存页面显示偏好、回环地址与每机配对令牌。

在 popup 的更多设置中可以调整 `Batch items`、`Batch characters` 和 `Speech speed`。默认值仍为每批 8 项、800 字符和 1 倍语速。

## YouTube 字幕

当视频带有人工或自动字幕时，Chrome 与 Safari 的 YouTube 播放器都会出现 `译` 按钮；也可以在 popup 中开启 `YouTube subtitles`。Gloss 先翻译当前起 50 秒的字幕，播放接近边界时预取后续 60 秒，拖动进度后则直接建立对应时间窗。字幕任务使用独立队列和字幕专用翻译 profile。

Safari 与 Chrome 都会把同一份字幕桥接直接注入网页的 Main World。Safari 请求 YouTube 网站访问权限时需要允许，字幕轨发现与 timed-text 请求才能运行。

## 文本朗读

完成划词翻译后点击结果卡片中的播放按钮即可朗读。朗读通过浏览器的系统语音引擎在本机完成；播放新的译文会停止上一次朗读，也可以再次点击停止。长文本会按句子切分，避免触发浏览器朗读长度限制。

## 旧版 Node 服务

现有 Node 服务继续作为开发与兼容性测试工具保留，但 Gloss 产品路径不再依赖它：

```bash
export TRANSLATOR_BACKEND="codex-app"
export CODEX_MODEL="gpt-5.3-codex-spark"
```

其他旧版后端：

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

它依次执行版本检查、纯逻辑单元测试、真实 Chrome DOM 注入测试、真实扩展/service worker 回环链路测试、server 集成测试，以及并发压力 smoke test。也可以分开运行：

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

项目使用 semver。每次面向 release 的变更，都需要同步 `package.json`、`wxt.config.ts` 和 `CHANGELOG.md`；Chrome 与 Safari manifest 均由 WXT 生成。推送前运行 `npm run check:version`。

## 说明

ChatGPT 订阅额度和 OpenAI API 计费是分开的。Gloss 默认使用内置的 Codex app-server 与独立 ChatGPT 登录，适合作为个人自用的订阅能力桥接。OpenAI API 后端是可选项，并会走单独 API 计费。
