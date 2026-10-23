# Transub 译流

为任意网页视频叠加实时双语字幕的 Chrome / Edge 扩展（Manifest V3）。声音优先在本机用 Whisper 识别，原文与译文以可拖动的字幕层显示在视频上方，并支持导出 SRT / VTT / TXT。

- 本地 ASR：Whisper Tiny / Base / Small，WebGPU 优先、WASM 回退；首次使用需下载模型。
- 远程 ASR：任何 OpenAI 兼容的 `/v1/audio/transcriptions` 接口。
- 翻译：任意 OpenAI 兼容 Chat Completions 接口，可保存多组配置并一键切换。
- 字幕：拖拽定位、字号 / 颜色 / 背景透明度 / 最大宽度 / 隐藏延时均可调，自动跟随网页全屏。
- 导出：完整双语、仅原文、仅译文；SRT / VTT 带时间轴，TXT 可选时间戳。

## 快速开始

要求：Node.js 20+，Chrome / Edge 116+。

```bash
npm install
npm run typecheck
npm run build
```

然后打开 `chrome://extensions`（Edge 为 `edge://extensions`）：

1. 开启右上角「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本项目下的 `dist/` 目录。
3. 若需处理本地视频文件，在扩展详情中开启「允许访问文件网址」。

修改代码后重新执行 `npm run build`，并在扩展管理页点击刷新。

## 使用

1. **配置 AI**：点击扩展图标 → 右上角齿轮打开设置。在「AI 翻译」中填入 Base URL、API Key、模型名，可保存多组配置并设当前使用的一组。支持 OpenAI、DeepSeek、硅基流动、月之暗面、Groq、Ollama 本地等预设。
2. **配置识别**：在「语音识别」选择本地 Whisper（推荐）或远程 ASR 接口，按网络情况选择模型下载源。
3. **开始字幕**：在有视频的页面点击扩展图标 →「开始字幕」。首次使用本地模型需要等待下载；页面开始播放声音后即会出现字幕。
4. **调整样式**：字幕条可直接拖动；位置、字号、颜色、背景等在「字幕外观」中调整，预览实时生效。
5. **导出**：在弹窗「导出字幕」中选择格式、内容和是否带时间戳。

字幕条悬停时会出现拖动手柄，可拖动改变位置；设置中的「恢复默认位置」可重置。

## 架构

```
弹窗 / 设置页 (React)
        │ chrome.runtime 消息
        ▼
Service Worker（后台）
  ├─ 会话生命周期、状态持久化（storage.session）
  ├─ 翻译队列：串行调用 AI，流式回填译文
  ├─ 导出：SRT / VTT / TXT → chrome.downloads
  └─ 与内容脚本、离屏文档通信
        │ streamId / START_CAPTURE
        ▼
离屏文档（offscreen document）
  ├─ tabCapture 音频流（并回放，保证标签页仍有声音）
  ├─ AudioWorklet 能量 VAD 切分 → 16 kHz PCM → WAV
  ├─ 本地 Whisper（transformers.js + ONNX Runtime WebGPU/WASM）
  └─ 远程 ASR（audio/transcriptions）
        │ ASR_SEGMENT
        ▼
Service Worker → 翻译 → 内容脚本
        ▼
内容脚本：Shadow DOM 双语字幕悬浮层
  ├─ 挂载到全屏容器，监听 fullscreenchange
  ├─ 拖拽 / 自动重挂载 watchdog
  └─ 字幕样式实时同步
```

### 目录结构

```
public/
  manifest.json           MV3 清单
  audio-processor.js      AudioWorklet：采集、VAD、重采样
src/
  background/index.ts     会话编排、翻译队列、消息路由、导出
  offscreen/
    index.ts              离屏文档入口与消息处理
    audio-capture.ts      tabCapture + AudioContext + 音频切分
    local-asr.ts          本地 Whisper 推理（WebGPU / WASM）
  content/index.ts        字幕悬浮层、拖拽、全屏与音视频锚点
  shared/
    types.ts              共享类型与消息协议
    settings.ts           设置默认值、校验、读写
    constants.ts          厂商预设、语言、Whisper 模型
    api.ts                OpenAI 兼容翻译 / ASR 请求与错误归一化
    subtitles.ts          SRT / VTT / TXT 生成
  options/                设置页（AI、ASR、外观、通用）
  popup/                  工具栏弹窗（启动、状态、切换配置、导出）
  ui/                     共享主题、图标、品牌组件
scripts/
  build.mjs               三份构建 + ORT WASM 复制
  gen-icons.mjs           生成 PNG 图标
dist/                     构建产物（加载此目录）
```

### 关键设计

- **离屏文档持有音频**：MV3 Service Worker 不能持有 `MediaStream` / `AudioContext`，因此由 offscreen document 完成采集与 ASR；后台只做编排。
- **音频回放**：捕获标签页音频后，离屏文档将同一路音频接回输出，避免开始字幕后视频静音。
- **串行翻译队列**：识别片段按顺序翻译，避免并发请求乱序；流式响应会持续更新当前字幕的译文。
- **时间轴**：片段以「开始捕获」为零点。启动时读取视频 `currentTime` 作为 `baseTime`，导出时加到每个片段上，使时间轴尽量贴近原视频。
- **样式单一来源**：内容脚本、设置页预览、弹窗共享同一份设置数据（`chrome.storage.local`），修改后即时广播。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `tabCapture` | 获取当前标签页音频流 |
| `offscreen` | 创建离屏文档，承载音频与本地推理 |
| `storage` / `unlimitedStorage` | 保存设置、会话状态与模型缓存 |
| `downloads` | 另存字幕文件 |
| `scripting` / `activeTab` | 按需向当前标签页注入字幕层 |
| `<all_urls>` | 在任意站点显示字幕，并访问你配置的 AI / ASR 接口 |
| `wasm-unsafe-eval` | 本地 Whisper 的 ONNX Runtime WASM |

## 隐私

- 本地识别模式下，音频不上传；识别出的**文字**会发送给你配置的翻译服务。
- 远程 ASR 模式下，音频片段会上传到你填写的 ASR 服务。
- API Key 与设置以明文保存在浏览器扩展存储中（`chrome.storage.local`），不会同步到云端，但本机其他可读取扩展数据的程序可能看到。请勿在共享电脑上保存长期 Key。
- 本地 Ollama 等自建服务是否可用取决于其 CORS / 网络配置。

## 已知限制

- **同一时间只支持一个标签页、一个会话**。在另一个标签页启动会先停止原会话。
- **DRM 内容**：Netflix 等受保护视频的音频可能无法被捕获（表现为无声音或无声片段），且受保护视频层可能无法叠加字幕。这是浏览器 / DRM 限制，不是所有影片都能使用。
- **原生视频全屏**：浏览器原生 `<video>` 全屏时，网页无法在其上绘制任何元素。YouTube、Bilibili 等使用容器全屏通常正常；遇到原生全屏请退出全屏或使用网页播放器模式。
- **时间戳漂移**：字幕时间以开始捕获为基准。中途暂停、拖动进度条、切换视频后，导出时间轴会与被拖动后的视频进度不一致。建议从视频开头附近启动，或重新开始会话。
- **换页 / 刷新**：刷新页面会中断当前会话，需要重新启动。
- **iframe 内视频**：内容脚本未注入子框架（`all_frames: false`），嵌入在 iframe 中的播放器可能无法显示字幕。
- **识别质量**：本地 Tiny 模型速度快但准确率有限；背景音乐、多人重叠说话、强噪声会明显降低识别效果。VAD 会跳过静音片段，纯音乐不一定产生字幕。
- **首次模型下载**：约 40 MB 至数百 MB，取决于模型；下载期间需保持页面打开。国内网络可在设置中切换 hf-mirror。
- **性能**：本地 Small 模型 + WASM 回退可能无法实时跟上语音；WebGPU 可用性和驱动相关。
- **翻译延迟**：取决于所配置 API 的速度与网络，字幕通常比原声晚 1–3 秒。
- **网站改版**：依赖通用 DOM 定位视频与全屏容器，极端自定义播放器可能无法自动挂载，可刷新后重试。
- **导出为参考时间轴**：翻译字幕与原文同一时间段显示，不提供逐词时间戳。

## 后续扩展

当前结构为后续功能预留了清晰边界：

- **配音 / TTS**：在 `background` 翻译队列产出译文后，增加 TTS 请求，由离屏文档播放合成音频，并做闪避（ducking）压低原声。
- **更多 ASR**：在 `offscreen` 增加引擎实现，保持 `OffscreenRequest` / `OffscreenEvent` 协议即可。
- **术语表 / 上下文**：`AiProfile.customPrompt` 已进入翻译请求，可扩展为术语表与前后文窗口。
- **多会话**：后台目前刻意限制单会话；若需多标签页，可将会话状态改为按 tabId 索引，并为每页创建独立离屏音频图。
