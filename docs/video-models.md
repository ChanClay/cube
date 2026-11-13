# 视频模型

接入三个模型，**创建剧本时选定**（存在 `Script.videoModel` 上，生成视频时按它路由 provider，不再全局切换）。能力表在 `lib/video-models.ts`，前后端共用：

| 模型 | provider | 单镜时长 | 素材 | 音轨 |
| --- | --- | --- | --- | --- |
| `happyhorse-1.1` | `happyhorse` | **3~15 秒** | 首帧 / 参考图（≤9 张） | 原生音视频联合生成，**始终带音轨、不可关** |
| `wan3.0-video` | `wan` | **2~30 秒** | 首尾帧 + 参考图 / 视频 / 音频 / 文档 / 网页 | 原生，可用 `audio` 开关 |
| `seedance-2.5` | `seedance` | **4~30 秒** | 首尾帧 + 参考图 / 视频 / 音频 | `generate_audio` 开关（2.0 / 2.5 系列才有） |

分镜规划按剧本的模型走：按镜头数模式下滑块范围、按总时长模式下的镜数区间（`总时长 / 单镜上限` 起、`总时长 / 单镜下限` 止）、AI 提示词里写的时长规则，全部由这张表推导；旧剧本没有 `videoModel` 字段，按 wan3.0 处理。

## HappyHorse 1.1

在百炼上按生成模式拆成三个模型 ID，本实现按这一镜的素材自动分流（代码见 `lib/providers/video/happyhorse.ts` 的 `planMedia` / `buildBody`）：

| 模式 | 模型 ID | 触发条件 | 请求差异 |
| --- | --- | --- | --- |
| t2v 文生视频 | `happyhorse-1.1-t2v` | 没有任何图片素材 | 只发 `input.prompt`，`parameters` 带 `ratio` |
| i2v 首帧生视频 | `happyhorse-1.1-i2v` | 只有一张帧图（首帧优先，无首帧时尾帧兜底） | `input.media` 有且仅有 1 个 `first_frame`；**不传 `ratio`**（画幅跟随首帧），`prompt` 可选 |
| r2v 参考生视频 | `happyhorse-1.1-r2v` | 有 `reference_image` | `input.media` 1~9 个 `reference_image`，顺序即提示词里的 `[Image N]`；`prompt` 必填；支持 `ratio` |

**素材限制**：只吃图片（JPEG / JPG / PNG / WEBP，≤20MB）。`last_frame` / `reference_video` / `reference_audio` / 文档 / 网页都不支持：首帧 + 尾帧同时给时 i2v 只取首帧，其余不支持的素材在提交前摘掉并在服务端日志告警。三种模式都没有 `prompt_extend`。镜头卡片的素材下拉会按剧本的模型过滤，HappyHorse 剧本里不会出现这些类型。

**音轨**：它是单流 Transformer 原生音视频联合生成，对白 / 环境音 / 拟音跟画面一起产出（音素级口型同步），所以 `parameters` 里没有 `audio` 字段——不是没有声音，而是**音轨不可关闭**。写进 prompt 的台词会被真的念出来；也因此没法用 `reference_audio` 指定音色。

## wan3.0

单模型全模态：首尾帧与 `reference_*` 互斥，带首帧 / 尾帧时画幅固定 `adaptive`，支持 `audio` 与 `prompt_extend`。

## Seedance（火山方舟）

平台是火山方舟（Volcengine Ark），接口与百炼完全不同：提示词和素材一起塞进 `content` 数组，用 `role` 标用途；分辨率 / 画幅 / 时长是 body 顶层字段（代码见 `lib/providers/video/seedance.ts`）。

| 场景 | 触发条件 | 请求差异 |
| --- | --- | --- |
| 文生视频 | 没有任何素材 | `content` 只有一条 `text`，带 `ratio` |
| 首帧 / 首尾帧 | 只有帧图（只有尾帧时当首帧） | `role=first_frame`（+ `last_frame`）；**不传 `ratio`**（画幅只能 `adaptive`，跟随首帧） |
| 全模态参考 | 有任一 `reference_*` | `reference_image` / `reference_video` / `reference_audio`；首帧 / 尾帧会被摘掉 |

**互斥**：首帧、首尾帧、全模态参考是三种互斥场景，混着传会被整单拒掉，所以和上面一样由 `planMedia` 自动分流，被摘掉的素材在服务端日志告警。

**限制**：时长 `[4, 30]` 秒；`resolution` 小写 `480p` / `720p` / `1080p`；`ratio` 支持 `21:9` / `16:9` / `4:3` / `1:1` / `3:4` / `9:16` / `adaptive`；文档与网页不支持。参考图本地统一按 9 张上限（2.5 接口本身允许 30 张）；2.5 / 2.0 系列**不接受含真人人脸的参考图 / 视频**。

**模型版本差异**（`VIDEO_MODEL_SEEDANCE` 填什么，就按哪个版本的能力走，判定见 `seedance.ts` 的 `profileFor`）：

| 版本 | 单镜时长 | 参考素材（r2v） | `generate_audio` |
| --- | --- | --- | --- |
| 2.0 / 2.5（默认，如 `doubao-seedance-2-5-260628`） | 4~30 秒 | 图片 / 视频 / 音频 | 有 |
| 1.0 lite | 2~12 秒 | 参考图（≤4 张） | 无 |
| 1.0 pro / pro-fast（如 `doubao-seedance-1-0-pro-fast-251015`） | 2~12 秒 | **不支持**，只有文生与首尾帧 | 无 |

1.0 pro / pro-fast 收到参考素材会回 `task_type r2v does not support model ...` 的 400，provider 在提交前就拦下并给出换模型的提示；时长会被自动夹进版本区间（剧本仍按 2.5 的 4~30 秒排片，超出部分服务端告警）。

**音轨**：`generate_audio` 默认 `true`，受 `VIDEO_AUDIO` 控制；1.0 pro 系列是无声模型，没有这个参数，provider 会按模型名自动跳过。

换模型版本（`VIDEO_MODEL_SEEDANCE`）时注意能力不同：1.0 pro / pro-fast 是 2~12 秒且**没有 r2v**，带参考素材的镜头会直接被拦下；1.0 lite 能给参考图但没有音轨。剧本的单镜区间仍按 `lib/video-models.ts` 的 4~30 秒排片，需要严格对齐 1.0 的话再改那张表。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `VIDEO_API_KEY` | 阿里云百炼 DashScope API Key（`sk-` 开头），HappyHorse / wan3.0 共用 |
| `VIDEO_BASE_URL` | 原生异步接口地址，默认 `https://cn-beijing.maas.qianwenaiapi.com/api/v1`（**不要**用 `/compatible-mode/v1`） |
| `VIDEO_MODEL_HAPPYHORSE` | HappyHorse 基础模型名，默认 `happyhorse-1.1`；三个模式 ID 由它派生（旧的 `VIDEO_MODEL` 仍兼容） |
| `VIDEO_MODEL_T2V` / `VIDEO_MODEL_I2V` / `VIDEO_MODEL_R2V` | 单独覆盖 HappyHorse 某个模式的模型 ID，留空则按基础名派生 |
| `VIDEO_MODEL_WAN` | wan3.0 模型 ID，默认 `wan3.0-video` |
| `VIDEO_SEEDANCE_API_KEY` | 火山方舟 API Key（也认 `ARK_API_KEY`），与百炼的 Key 不通用 |
| `VIDEO_SEEDANCE_BASE_URL` | 火山方舟接口地址，默认 `https://ark.cn-beijing.volces.com/api/v3` |
| `VIDEO_MODEL_SEEDANCE` | Seedance 模型 ID，默认 `doubao-seedance-2-5-260628`；也可填方舟 Endpoint ID。1.0 pro / pro-fast 不支持参考素材（r2v），详见上面的版本差异表 |
| `VIDEO_RESOLUTION` | 兜底画质：`480p` / `720p` / `1080p`。实际画质按项目设置（创建项目时选择，默认 `480p`） |
| `VIDEO_RATIO` | 兜底画幅：`21:9` / `16:9` / `4:3` / `3:4` / `4:5` / `5:4` / `1:1` / `9:21` / `9:16`。实际画幅按项目设置（默认 `16:9`）；HappyHorse i2v 画幅跟随首帧，wan3.0 带首尾帧固定 `adaptive` |
| `VIDEO_DURATION` | 兜底时长（秒），实际以每个镜头的 duration 为准（按模型区间夹住） |
| `VIDEO_WATERMARK` | HappyHorse / Seedance 是否打水印（「Happy Horse」/「AI 生成」），默认 `false`；wan3.0 没有这个开关 |
| `VIDEO_AUDIO` / `VIDEO_PROMPT_EXTEND` | 音轨开关（wan3.0 的 `audio` / Seedance 的 `generate_audio`）与提示词智能扩写（**只有 wan3.0**），默认 `true` / `false`。HappyHorse 1.1 的音轨始终生成且没有开关，两项对它都无效；Seedance 1.0 pro 是无声模型 |
| `VIDEO_REFERENCE_PREV_FRAME` | 「硬切镜头用上一镜末帧」的全局总开关，默认 `true`。同景别当首帧、跨景别当参考图，逐镜的默认值由分镜阶段写进剧本（`Shot.referencePrevFrame`），这里置 `0` 可以一次性全关，适合 A/B 对比 |

```env
VIDEO_API_KEY=sk-your-dashscope-key
VIDEO_MODEL_HAPPYHORSE=happyhorse-1.1
VIDEO_MODEL_WAN=wan3.0-video
VIDEO_RESOLUTION=480p
VIDEO_RATIO=16:9
VIDEO_WATERMARK=false
# 用 Seedance 时才需要：火山方舟的 Key 与百炼不通用
VIDEO_SEEDANCE_API_KEY=your-ark-api-key
```

## 接口与参数差异

百炼两个模型走 MaaS 异步接口：`POST /services/aigc/video-generation/video-synthesis`（需 `X-DashScope-Async: enable`），创建后轮询 `GET /tasks/{task_id}`，`video_url` 有效期 24 小时（服务层会立刻转存到本地）。Seedance 走火山方舟：`POST /contents/generations/tasks` → 轮询 `GET /contents/generations/tasks/{id}`，任务 ID 有效期 7 天。任务回查按 `VideoJob.provider` 找实现，换模型不影响已提交的任务。

注意三套参数互不通用：HappyHorse 用 `parameters.resolution`（`480P` / `720P` / `1080P`）+ `parameters.ratio` + `duration` + `watermark` + `seed`，没有 `audio`（音轨恒有）/ `prompt_extend`，i2v 传 `ratio` 会被当非法参数拒单；wan3.0 额外接受 `audio` / `prompt_extend` 与多模态素材；Seedance 用 `content` 数组 + 顶层 `resolution`（小写）/ `ratio` / `duration` / `generate_audio` / `watermark`，带帧图时不传 `ratio`。画幅 / 画质在创建项目时选择（默认 480p / 16:9），存在项目表里，`VIDEO_RATIO` / `VIDEO_RESOLUTION` 只作为兜底。

## 接入新模型

实现 `lib/providers/video/types.ts` 中的 `VideoProvider` 接口，在 `lib/providers/video/index.ts` 的 `FACTORIES` 注册，再到 `lib/video-models.ts` 的 `VIDEO_MODELS` 加一条能力（单镜区间、镜数上限），表单与分镜规划会自动跟着变。
