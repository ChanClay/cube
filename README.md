# Cube

**Mirror of Dreams**（窥梦之镜）。网页端一体化项目，Next.js 15（App Router）单端口运行在 **4500**。

## 快速开始

```bash
make setup   # 安装依赖 + 生成 .env.local（填入 Key）
make dev     # http://localhost:4500
```

不用 make 也可以：

```bash
npm install
cp .env.example .env.local   # 填入 Key
npm run dev                  # http://localhost:4500
```

### 常用命令

```bash
make              # 列出所有命令
make setup        # 一键初始化
make dev          # 开发服务器
make build        # 生产构建
make start        # 生产模式启动
make check        # 类型检查 + 构建
make stop         # 停止占用端口的进程
make restart      # 停止后重启
make clean        # 清理 .next
make clean-data   # 清理导出成片与临时文件（.data）
make db           # 查看 MySQL 表统计
make logs         # 查看视频调用错误日志（最近 50 条）
make migrate      # 从旧 SQLite 迁移数据（幂等）
make distclean    # 连 node_modules 一起清理
```

端口通过变量覆盖：`make dev PORT=4600`。

未填 Key 也能启动：剧本生成只依赖 `LLM_API_KEY`；未填 `VIDEO_API_KEY` 时「生成视频」会直接提示未配置。左栏「加载示例剧本」可预览完整交互，访问 `/?demo=1` 直接打开示例剧本。

## 环境变量

全部配置写在 `.env.local`（参考 `.env.example`，该文件已 gitignore）。

### 剧本生成（任意 OpenAI 兼容接口）

| 变量 | 说明 |
| --- | --- |
| `LLM_BASE_URL` | 接口地址，如 `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | API Key |
| `LLM_MODEL` | 模型名，如 `deepseek-chat` / `kimi-k2-0905-preview` / `glm-4.6` |
| `LLM_TIMEOUT_MS` | 超时时间，默认 180000 |
| `LLM_MAX_TOKENS` | 单次调用的输出预算，默认 6000；思考型模型的 reasoning tokens 也算在里面 |
| `LLM_THINKING` | 是否开启思考模式，默认 `false`：本项目只要 JSON，思考过程会把预算吃光导致正文为空 |
| `SCRIPT_REVIEW` | 成稿后是否允许审片 agent 修一次，默认 `true`；只检测到硬伤时才额外发请求，正常输出不会变慢 |
| `SCRIPT_LOCALIZE` | 是否把定稿的中文描述单独翻成英文提示词，默认 `true`；关掉会退回「分镜阶段顺手写英文」，中英更容易对不上 |

模型需支持 `response_format: { type: "json_object" }`；不支持时会摘掉该参数重发，退化为「从返回文本中提取 JSON」。同理，服务端不认 `thinking` 参数时也会自动去掉。被 `max_tokens` 截断或正文为空时会自动放大一倍以上预算重试一次，仍失败才报错（错误里会带上 `finish_reason` 与 `reasoning_tokens`）。

### 视频生成（通义万相 wan3.0）

唯一接入的视频模型：`wan3.0-video`（可选 `wan3.0-video-prime`）。All-in-One 多模态，输入支持文本 / 图片 / 音频 / 视频 / 文档 / 网页。

| 变量 | 说明 |
| --- | --- |
| `VIDEO_API_KEY` | 阿里云百炼 DashScope API Key（`sk-` 开头） |
| `VIDEO_BASE_URL` | 原生异步接口地址，默认 `https://cn-beijing.maas.qianwenaiapi.com/api/v1`（**不要**用 `/compatible-mode/v1`） |
| `VIDEO_MODEL` | 留空默认 `wan3.0-video`；可选 `wan3.0-video-prime` |
| `VIDEO_RESOLUTION` | 兜底画质：`480p` / `720p` / `1080p`。实际画质按项目设置（创建项目时选择，默认 `480p`） |
| `VIDEO_RATIO` | 兜底画幅：`21:9` / `16:9` / `4:3` / `1:1` / `3:4` / `9:16` / `adaptive`。实际画幅按项目设置（默认 `16:9`），带首帧 / 尾帧的镜头自动用 `adaptive` |
| `VIDEO_DURATION` | 兜底时长（秒），wan3.0 支持 2~30，实际以每个镜头的 duration 为准 |
| `VIDEO_AUDIO` | 是否输出原生有声视频（台词 / BGM / 音效），默认 `true` |
| `VIDEO_AUDIO_ON_CARRY` | 承接上一镜末帧的镜头是否也生成音频，默认 `false`：画面接着上一镜、声音却重新生成会断档，这类镜头直接静音 |
| `VIDEO_REFERENCE_PREV_FRAME` | 「同场景硬切带上一镜末帧当 `reference_image`」的全局总开关，默认 `true`。逐镜的默认值由分镜阶段写进剧本（`Shot.referencePrevFrame`），这里置 `0` 可以一次性全关，适合 A/B 对比 |
| `VIDEO_PROMPT_EXTEND` | 提示词智能扩写，默认 `false`。本项目逐镜提示词已经对齐过（固定英文外貌 / 空间短语 + 标准景别运镜），交给服务端二次改写会换掉景别与运镜，人物和镜头语言都会漂移；只有提示词很短时才建议打开 |

```env
VIDEO_API_KEY=sk-your-dashscope-key
VIDEO_MODEL=wan3.0-video
VIDEO_RESOLUTION=480p
VIDEO_RATIO=16:9
VIDEO_AUDIO=true
```

走百炼 MaaS 异步接口：`POST /services/aigc/video-generation/video-synthesis`（需 `X-DashScope-Async: enable`），创建后轮询 `GET /tasks/{task_id}`。

注意 wan3.0 的参数与 wan2.x 不通用：wan3.0 用 `parameters.resolution`（`480P` / `720P` / `1080P`）+ `parameters.ratio` + `duration`，wan2.x 用 `size`（如 `1280*720`）。本实现按 wan3.0 请求，代码见 `lib/providers/video/wan.ts`。画幅 / 画质在创建项目时选择（默认 480p / 16:9），存在项目表里；带首帧 / 尾帧的镜头比例由素材决定，会自动改用 `adaptive`，`VIDEO_RATIO` / `VIDEO_RESOLUTION` 只作为兜底。

### 站点

| 变量 | 说明 |
| --- | --- |
| `PUBLIC_BASE_URL` | 站点对外地址，如 `https://cube.example.com`。配置后本地上传的素材会被拼成绝对地址交给视频模型；留空则用请求来源（通常 `localhost`，云端模型访问不到） |

## 使用流程

0. **项目列表（`/`）**：首页展示全部项目卡片（剧本数 · 更新时间），点击进入项目，`×` 删除项目（连带其下剧本）。顶部输入名称即可新建。
1. **项目工作台（`/projects/[id]`）**：一个项目下可以有多份剧本。
   - 左栏「故事素材」：先选「故事创意」或「小说 / 章节」。
     - 故事创意：一段想法或梗概，内部先由故事架构师规划蓝图，再由分镜编剧写画面，最后审片一次（见「剧本 agent（三步）」）
     - 小说 / 章节：粘贴或导入 txt / md（200~30000 字）。镜头数量、每镜时长与总时长由改编模型按剧情决定，不再让用户手填；先压成一条主线，再走同样的分镜链路（见「小说 / 章节改编」）
     - 每次生成都会新增一份剧本
     - **按镜头数量**：手动指定镜头数（1–12）与单镜时长（2–30 秒滑块）
     - **按总时长**：只给视频总时长（2–360 秒，按 1 秒粒度调整）。勾选「保证完整性」（默认开启）时分镜数量取最少（`ceil(总时长 / 10)`），每镜尽量凑满 10 秒；关闭后不预设镜头数，只给 AI 一个合法区间（`ceil(总时长/10)` ~ `min(12, 总时长/2)`），由它按剧情自己判断切几刀并分配每镜时长。两种方式下每镜时长都在 2–30 秒之间，总和等于设定的总时长
       - 为什么按 10 秒切：30 秒只是接口上限，不是质量上限。一次生成 20~30 秒时后半段动作会明显变慢、肢体开始糊在一起，这类长镜头是成片「不流畅」的主要来源；镜头数上限 12 / 总时长 360 秒时仍会回落到 30 秒长镜
   - 右栏顶部下拉切换本项目下的剧本
2. **分镜剧本**：LLM 返回结构化分镜，每镜头含中文画面描述、**秒级节奏（第几秒到第几秒在做什么）**、英文视频提示词、景别、运镜、旁白，均可编辑；镜头头部显示这一镜在成片里的绝对时间码（如 `00:12–00:19`），秒级节奏按 `0–2s / 2–5s` 逐段列出。
   - **角色卡 / 场景卡**：剧本头部与角色卡同级展示场景卡。两张卡都可以改名 / 改描述，并各自挂一张参考图——点「生成配图」调万相文生图，或「上传」用本地图片；点缩略图或展开后的配图可看大图（Esc / 点背景关闭）。改角色名会同步更新各镜头的出场角色标注。
   - 卡片配图会作为首帧的**兜底**参与生成（见下一节的首帧优先级）。
3. **生成视频**：单镜头点击「生成视频」，或点「全部生成」进入串行队列（并发 = 1）：一次只提交一镜，等它成功后再用 ffmpeg 抽该视频的**末帧**，作为下一镜的 `first_frame` 传进去，保证画面承接。页面每 5 秒轮询一次任务状态，完成后直接内联播放，可打开原视频。
   - **衔接方式（transition）**：每一镜有一项 `same-take` / `hard-cut` / `time-jump`，由分镜阶段产出（镜头卡片上可改，鼠标悬停能看到判定依据）。它是素材决策的唯一依据：
     - `same-take`（承接上一镜）：抽上一镜末帧当首帧，**本镜不能再传参考图**——wan3.0 的首尾帧与 `reference_*` 互斥；
     - `hard-cut` / `time-jump`：走角色卡 / 场景卡的 `reference_image`，画面不接帧。
     分镜的判断会再过一层确定性否决（`lib/agents/storyboard.ts` 的 `resolveTransitions`）：换场景、景别跨 2 档以上、首尾状态对不上、有人物的镜头超过 8 秒、连续接帧超过 2 次，一律改判 `hard-cut`，否决原因写进 `transitionReason`。模型没写 transition 时，只有首尾状态重合度 ≥ 0.4 才推定承接，否则按剪辑点处理。
   - **首帧优先级**（单镜生成与串行队列一致，仅 `same-take` 镜头会走到这里）：
     1. 用户手动指定的首帧 —— 永远优先，不会被覆盖
     2. 上一镜视频的**末帧**（单镜生成时只在上一镜已成功的情况下才抽）：抽的是结尾前 `0.1s` 的无损 PNG，早先取 `-0.4s` + JPEG，接缝处会把上一镜最后 0.4 秒重演一遍、并带进一层压缩噪点
     3. 上一镜末帧拿不到时（第一镜 / 上一镜没成 / 抽帧失败 / 云端下载不到），退回**场景卡配图**，再退到**出场角色卡配图**
   - 场景图排在角色图前：首帧是一整帧画面，场景空镜比「纯色背景的单人设定图」更接近真实构图，模型不容易被带成棚拍。
   - **成片本地化**：通义万相返回的 `video_url` 只保留 24 小时。任务一成功就立刻把视频下载到 `.data/videos/`，`videoUrl` 换成站内地址 `/api/videos/{file}`（支持 Range，Safari 可拖进度条）。历史任务若仍挂着临时地址且未超过 24 小时，轮询时会自动补转存；超过 24 小时的链接已被云端删除，无法恢复。
   - 抽帧图（`.png`，旧数据仍有 `.jpg`）存在 `.data/frames/`，通过 `/api/frames/{file}` 对外提供；云端模型必须能下载到它，所以要配置 `PUBLIC_BASE_URL`。未配置（或地址是 localhost / 局域网 IP）时会退回配图兜底并给出提示。
   - 该镜头带参考图 / 参考视频 / 文档 / 网页（与首帧互斥）时，不注入任何首帧；判定为 `hard-cut` 的镜头即便抽到了末帧也不会用。
   - **同场硬切的风格锚点（每镜 `referencePrevFrame`）**：`hard-cut` 且与上一镜同场景时，上一镜末帧会作为 `reference_image` 追加在卡片之后（槽位不够时先丢它），并在提交的提示词末尾追一句限定——只匹配参考图的光线与场景材质，景别 / 机位 / 构图按本镜描述执行。它不会变成底图，所以不会把上一镜的人数或构图带进来。
     - 默认值在生成分镜时写进剧本：同场硬切 = `true`，承接动作 / `time-jump` / 换场景 = `false`（见 `storyboard.ts` 的 `resolveReferenceFrames`）。模型写 `true` 只在同场硬切里被采纳，写 `false` 一律尊重。
     - 镜头卡片上可以直接改（「末帧参考」勾选框）；换场景或选成「承接上一镜」时该选项自动不可用。
     - `VIDEO_REFERENCE_PREV_FRAME` 是全局总开关，置 `0` 后所有镜头都不带。
     - **参考图里是谁必须点名**：末帧是像素，模型不知道图里站的是谁，只写「匹配光线」的话它只会把参考图当调色板。所以提交时会追加 `The reference image is the last frame of the previous shot and shows 老陈 — the same person described above, not an additional character. Keep only their faces and wardrobe consistent; do not duplicate them.`，后面才是「只借光线 / 材质、构图按本镜描述」的限定。名字来自 `prevFrameCast(prev)`：优先用 `Shot.lastFrameCast`（留给视觉识别 / 人工确认写入），没有时退回上一镜的 `characterNames`——那只是分镜时的意图，精度有限。
     - **不许说「保持位置」**：换机位时位置必然变，`keep positions` 会和 `keep the camera angle described above` 直接冲突，模型会把参考图里的人留在原位、再按文字画一个，于是同一个人出现两次。只锁脸和服装，并显式 `do not duplicate`。
     - **单人镜头给人数上限**：`characterNames` 只有一个时追加 `Only one person appears in frame`。
     - **卡片与末帧同时传，不做身份去重**：试过「末帧里已经出现的人就不传他的卡」，结果整段视频彻底失去参考——末帧是一张整帧场景图，wan3.0 把它当环境 / 光线 / 风格参考，不会当成某个具体人物，删掉角色卡等于把身份参考一起删了。重复人物改由提示词约束（只锁脸和服装、`do not duplicate`、单人镜头给人数上限）。
     - 重算某镜提示词（`/api/shot/refine`）时也会把同一份名单与上一镜 `exitState` 一起喂给模型，并要求「本镜开头的人物与名单完全一致，需要新角色时写成过程中走进画面」。
   - 两条路径的音频策略不同：接帧镜头默认静音（声音重新生成会断档），参考图镜头正常出音轨，还能同时传 `reference_audio` 锁音色。
4. **合成成片**：2 个以上镜头完成后点「合成成片」，服务端下载各镜头并用 ffmpeg 拼接为一个 MP4，可播放/下载。

## 台词与声音

wan3.0 原生生成人声台词、BGM 和音效（`parameters.audio` 默认 `true`），但**台词必须写进 prompt** 才会被说出来：

- 分镜输出 `narration`（这一镜要说的话）和 `narrationType`：`dialogue` 是角色开口、会驱动口型；`voiceover` 是画外旁白、人物闭嘴
- `dialogue` 还会输出 `speaker`（谁在说，必须是本镜 `characters` 里的名字）。多人物镜头会把说话人写进提示词，避免模型挑错人开口
- 提交生成时由 `lib/dialogue.ts` 拼接到画面描述末尾，画面描述保持纯英文，台词保留原文（官方支持中英混写）
- 镜头卡片上的台词框可直接编辑，类型下拉逐个切换；切成角色台词时可指定说话人。旧剧本没有 `speaker` 时保持原行为，一律按 `voiceover` 处理，避免旁白变成人物开口
- 台词要短：一句 10~20 字，5 秒左右的镜头最多一句；同一句台词只表达一个意思
- 首帧/首尾帧模式**不能**同时传 `reference_audio`，所以音色不可指定。想要固定音色只能放弃首尾帧衔接，改走全模态参考模式（`reference_image` + `reference_audio`）

## 素材与配图

镜头的多模态素材直接在镜头卡片里添加（首帧 / 尾帧 / 参考图 / 参考视频 / 参考音频 / 文档 / 网页）：

| 来源 | 存储 | 说明 |
| --- | --- | --- |
| 本地文件上传 | `.data/uploads/`，通过 `/api/uploads/{file}` 访问 | 单个 ≤ 32MB；支持图片 / 音频 / 视频 / PDF / Office 文档 / 文本 |
| 公网 URL | 只存链接 | 必须是 `http(s)://` 且公网可访问 |

素材类型沿用视频模型的语义；首帧 / 尾帧与参考类素材互斥，文档与网页二选一。

### 角色卡 / 场景卡配图

剧本头部的角色卡、场景卡各挂一张参考图，有两种来源：

- **生成配图**：`POST /api/image` → 万相文生图（默认 `wan2.6-t2i`）。请求里除了中文的「名称：外形描述」，还会带上蓝图锁定的 `promptEn`（固定英文外貌 / 空间短语），保证卡片和逐镜视频里长得一样；描述命中机甲 / 义体 / 装甲 / 全息等科技词时，`lib/image-prompt.ts` 会自动追加一层「科技细节」（分件、接缝、发光线条、金属反射、磨损），否则文生图对「科技角色」的默认输出是光滑的塑料块。接口返回的图片地址只保留 24 小时，服务端会立刻下载并转存到 `.data/uploads/`，前端拿到的是站内永久地址
- **上传**：复用 `/api/uploads`
- 换图时**不删除**旧文件：旧图可能已经被某个镜头的首帧引用着，删掉会让那条任务直接 404

配图在「上一镜末帧拿不到」时作为首帧兜底；只要末帧可用，配图就不会被提交。因为首帧需要云端可下载，配图同样依赖 `PUBLIC_BASE_URL`。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `IMAGE_API_KEY` | 复用 `VIDEO_API_KEY` | 百炼 API Key |
| `IMAGE_BASE_URL` | 复用 `VIDEO_BASE_URL` | 文生图接口地址 |
| `IMAGE_MODEL` | `wan2.6-t2i` | `wan2.6` 及以上（含 `wan2.7-image`）走多模态同步协议；`wan2.5` 及以下自动切换成异步轮询 |

> 注意：镜头素材里的本地文件存在本机，通义万相在云端拉取，无法访问 `localhost`。要让本地上传的素材真正参与生成，需要配置 `PUBLIC_BASE_URL` 指向公网可访问地址（反向代理 / 对象存储），否则请改用公网 URL。

## 成片合成

需要本机有 ffmpeg（`brew install ffmpeg`），也可以用 `FFMPEG_PATH` 指定可执行文件路径。检测不到时按钮禁用并给出安装提示。

同时会找 ffprobe（`FFPROBE_PATH`，或 `FFMPEG_PATH` 同目录，或 PATH）读每段素材的真实帧率与视频流时长；找不到时退回只读 ffmpeg 文件头，合成不会失败，但时长精度差一帧。

- 只合并「已生成完成」的镜头，严格按剧本顺序拼接
- 每个片段先 `scale（lanczos）+ pad` 到统一尺寸再 `concat`，源视频分辨率/帧率不一致也不会失败
- **帧率跟素材走**：用 ffprobe 取各片段的真实帧率，成片按其中最高的那个锁定 CFR（原来写死 30，24fps 素材会被补重复帧，运动看着一顿一顿）
- **时长按视频流算**：容器时长取的是音视频里较长的一条（模型常给 8.00s 画面 + 8.03s 音轨），按它裁剪/补静音会让音频每镜多出几十毫秒，拼到后面就是音画不同步
- 输出 H.264（`-preset medium -crf 18`）+ `faststart`：素材本身已经压过一次，`veryfast / crf20` 会在运动画面里留下块状拖影
- 任一镜头带声音就保留音轨：统一 48kHz 立体声、AAC 192k，按镜头时长裁剪/补静音后再拼；所有镜头都无声时自动退化为纯画面输出（`VIDEO_AUDIO=false` 走这条）
- 输出尺寸跟随项目的画幅 / 画质设置（创建项目时选择）：480p+16:9 → 854×480，720p+16:9 → 1280×720，1080p+16:9 → 1920×1080，9:16 自动变成 480×854 / 720×1280，1:1 → 480×480 / 720×720
- 产物保存在 `.data/exports/`，自动保留最近 10 个；`GET /api/exports/{file}` 支持 Range 拖动播放

## 剧本 agent（四步）

一次性让模型吐全部镜头，很容易「每镜各自成立、彼此接不起来」，人物外形和场景光线也会逐镜漂移。生成剧本现在是四步：

```
创意 ──▶ 故事架构师 ──▶ 蓝图（主题/人物/场景/状态链） ──▶ 分镜编剧 ──▶ 成稿
                                                              ──▶ 提示词译者（中→英）──▶ 审片编辑 ──▶ 分镜脚本
```

**第一步 `lib/agents/continuity.ts`（故事架构师）**：不写分镜文案，只定故事与结构。

- 故事层：`logline`（谁 + 想要什么 + 阻碍 + 代价）、`theme`（可被画面证明的判断）、`tone`（基调与节奏）
- 人物：`role` 叙事功能；`desc` 是可拍摄的中文外形设定，必须按 8 项写全——廓形、头部（脸型 / 发型发色 / 神态）、上装（版型 / 颜色 / 材质）、下装与鞋、装备 / 义体（位置 / 材质 / 发光处）、配色（主色 / 辅色 / 发光色）、随身道具、气质体态；`promptEn` 是 20~35 词的固定英文外貌短语，按同样顺序覆盖，全片逐字复用
- 场景：`desc` 地点 / 空间尺度 / 时间 / 光源方向与色温 / 陈设与材质、`promptEn` 15~25 词的固定英文空间短语
- 科幻 / 未来科技题材必须写到具体技术名词与材质（拉丝钛、哑光碳纤维、半透明聚合物、陶瓷装甲、全息喷绘…）与分件、光源位置，不许写「高科技感」这类空话——否则角色卡配图和视频里都只剩一团光滑的默认质感
- 状态链：每个节拍给出 `beat`（开场钩子 / 激励事件 / 高潮 / 余韵…）、`emotion`（1~5 情绪曲线）、`entry` / `action` / `exit`、景别与运镜

硬约束：相邻镜头的 action 首尾相接、不允许凭空换场地、角色外形与场景光线全片锁定、景别按「建立 → 逼近 → 细节 → 释放」推进、情绪最高点落在后 1/3。蓝图缺动作 / 缺交接时会带着问题清单重试一次。

**第二步 `lib/agents/storyboard.ts`（分镜编剧）**：把蓝图塞进提示词，逐镜写画面、秒级节奏、英文视频提示词与台词。每一镜必须显式写出 `entryState`（第一帧的画面事实）与 `exitState`（最后一帧的画面事实），且本镜 `entryState` 必须与上一镜 `exitState` 是同一个状态——连贯性不再靠「记得上一镜」，而是靠一条写在纸上的状态链；合并 / 拆分节拍时 entry / exit 整体继承，缺首尾状态时用蓝图兜底。每一镜还要写 `beatSheet`：把这个镜头的秒数切成 2~4 段，逐段交代「第几秒到第几秒发生什么可见变化」（2~4 秒切 2 段、10 秒以上切 3~4 段），不许写「情绪渐强」这类拍不出来的东西。蓝图节拍数与目标镜数不一致时，多就合并、少就拆解，不新增剧情。写完做确定性收口：时间轴按实际时长重算（首段必须从 0 开始、末段必须到 duration、中间不留白不重叠）、角色卡 / 场景卡以蓝图为准、错位的名字映射回卡上、中文描述里点名的角色自动补进 `characters`、台词按时长截断、镜数与总时长对齐。

**第三步 `lib/agents/localize.ts`（提示词译者）**：中文定稿后单独调一次模型，把每一镜的 `description` 逐句翻成英文 `videoPrompt`。输入里带上角色 / 场景的固定英文短语与标准景别、运镜词，规则是「只翻译不创作」：中文没有的元素不许加，中文写了的不许漏。这样中英文不再是各自发挥的两份稿子（`SCRIPT_LOCALIZE=false` 可关闭，回退到分镜阶段顺手写英文）。

**第四步 `lib/agents/review.ts`（审片编辑）**：先做不发请求的体检——镜数、英文提示词长度、禁用词（字幕 / 水印 / logo / 分屏）、台词长度、角色与场景引用、重复提示词，以及两组新增的硬伤：**跨镜连贯性**（上一镜 `exitState` 与本镜 `entryState` 是否还是同一个状态，刻意跳转需写明「片刻后 / 次日」等转场词）与**中英一致性**（英文里的景别 / 运镜是否与 `shotSize` / `cameraMove` 对得上、有没有用上蓝图锁定的外貌与空间短语）。有硬伤才额外调用一次模型修复（`SCRIPT_REVIEW=false` 可关闭）；修复失败保留原稿，不让生成失败。

公共规范收在 `lib/agents/spec.ts`（景别 / 运镜的英文对照表、提示词 / 台词 / 连贯性约束与清洗、状态相似度），分镜写作、提示词翻译、单镜重算（`/api/shot/refine`）、审片共用同一份，避免各处规则漂移。

降级：蓝图规划失败会退回一次性生成，翻译失败会保留分镜阶段写好的英文，都会往 `.data/logs/agent.log` 记一条 warn。正常生成是 3 次 LLM 调用（蓝图 / 分镜 / 翻译），触发审片时才多一次。

## 小说 / 章节改编

「小说 / 章节」模式不是把整章原文直接交给规划 agent，而是先压缩再分镜：

```
原文 ──▶（>8000 字先分段摘要）──▶ 改编 agent ──▶ 蓝图 + 梗概 ──▶ 分镜链路
```

- 输入 200~30000 字；超过 8000 字按段落切成最多 5 段，每段先摘要，再合成蓝图（map-reduce）
- 镜头数量、每镜时长、总时长全部由改编蓝图按剧情决定（1~12 镜、每镜 2~30 秒、总时长 30~360 秒），用户不需要手填
- 只保留一条主线、2~4 个人物、1~4 个场景，保留主角、核心冲突、关键道具与结局方向；删副线、次要人物、过场
- 改编输出 `treatment`（300~500 字梗概），作为「故事创意」传给分镜 agent，也回填到剧本信息；整章原文不入库
- 一次改编对应一份 6 分钟内的短片；整本小说请按章多次生成
- 改编失败会直接报错，不会悄悄退回「把整章当创意」，避免生成一份更差的稿

## 排查视频生成失败

四处来源，按排查顺序：

| 位置 | 能看到什么 |
| --- | --- |
| 镜头卡片 | 该镜头最近一次失败的原因（`job.error`），刷新页面后从库里恢复 |
| 服务端终端 | `make dev` 的终端会打印 `[video:create]` / `[video:sync]` 结构化错误 |
| `.data/logs/video.log` | 同上内容的 JSON 行，`make logs` 看最近 50 条，或 `tail -f .data/logs/video.log` |
| MySQL `video_jobs.error` | 已提交到 provider 的任务失败原因 |

```bash
make logs                    # 最近 50 条视频调用错误
tail -f .data/logs/video.log # 实时跟踪
```

注意两类失败的差异：

- **任务没能提交成功**（Key 未配置、素材非法、网络错误）：按设计**不写库**，只能从终端日志或 `.data/logs/video.log` 追溯
- **任务已提交、provider 判为失败**：写入 `video_jobs`（`status='failed'`）并记日志，前端刷新后仍能看到

日志超过 2MB 会滚动一次，保留 `video.log` 与 `video.log.1`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 环境状态（LLM / 视频模型 / ffmpeg / 数据库） |
| GET / POST | `/api/projects` | 项目列表 / 新建项目 `{ name?, description? }` |
| GET | `/api/projects/[id]` | 项目详情 + 其下剧本列表 `{ project, scripts }` |
| PATCH / DELETE | `/api/projects/[id]` | 改名、改描述 / 删除项目（连带剧本） |
| POST | `/api/script` | `{ idea, source?, style, shotCount, duration }` → `{ script, meta }`；`source=novel` 时 `idea` 是小说原文，`shotCount` / `duration` 被忽略（由改编蓝图决定），`meta.adaptedIdea` 返回压缩梗概 |
| POST | `/api/image` | `{ prompt, kind, style? }` → 万相文生图并转存本地，返回 `{ media }` |
| GET | `/api/scripts` | 剧本列表 `{ scripts }`，`?limit=20&projectId=` |
| POST | `/api/scripts` | 保存剧本 `{ id?, projectId?, idea, script }` → `{ script }` |
| GET | `/api/scripts/latest` | 最近一份剧本 `{ script }`，`?projectId=` |
| GET / DELETE | `/api/scripts/[id]` | 读取 / 删除指定剧本 |
| POST | `/api/uploads` | 上传素材文件（multipart，字段 `file`）→ `{ media }` |
| GET / DELETE | `/api/uploads/[file]` | 读取 / 删除本地上传的素材文件 |
| GET | `/api/video` | 全部视频任务（非终态任务会同步一次 provider） |
| POST | `/api/video` | `{ shotId, prompt, duration }` → `{ job }` |
| GET | `/api/video/[id]` | 单个任务，自动向 provider 同步最新状态 |
| POST | `/api/compose` | `{ shotIds }` → 合成 MP4，返回 `{ url, bytes, clips, size }` |
| GET | `/api/exports/[file]` | 播放/下载合成产物（支持 Range） |

## 数据库（MySQL）

存储用本地 MySQL，连接串写在 `.env.local`：

```env
DATABASE_URL=mysql://root:密码@127.0.0.1:3306/ai_video
```

首次访问自动建库（`utf8mb4`）与建表，无需手动执行 SQL：

```sql
projects    -- 项目：名称、描述、素材文件夹 JSON（groups_json）、时间戳
scripts     -- 剧本：所属 project_id、原始创意、标题、风格、完整分镜 JSON（保留最近 200 份）
video_jobs  -- 视频任务：状态、provider 任务 id、视频地址、提示词、错误（保留最近 300 条）
```

- 连接池用 `mysql2`，单例复用；表结构见 `lib/db.ts`
- 旧库升级自动执行：给 `scripts` 补 `project_id` 列与索引，并把没有归属的历史剧本收进「默认项目」（`id = default`）
- 剧本编辑后 1.2 秒防抖写库，刷新页面从 MySQL 恢复（不依赖 localStorage）
- 查看：`make db`；从旧 SQLite 迁移：`make migrate`（幂等，可重复执行）
- 备份：`mysqldump -u root -p ai_video > backup.sql`
- 换 Postgres 只需替换 `lib/db.ts` + `lib/store.ts` / `lib/script-store.ts` 的 SQL 方言，接口层不动

## 项目结构

```
Makefile              常用命令（make dev / build / start ...）
app/
  page.tsx              项目列表主页（新建 / 删除 / 进入项目）
  projects/[id]/page.tsx  项目工作台（素材库、创意、剧本、轮询、导出）
  api/                  health / projects / script(s) / video / shot / frames / uploads / compose 路由
components/             TopBar · ProjectMediaPanel · IdeaForm · ScriptView · ShotCard
scripts/
  migrate-sqlite-to-mysql.mjs  旧 SQLite 数据迁移
  db-stats.mjs                 表统计（make db）
lib/
  db.ts                 MySQL 连接池、建表与旧库迁移（mysql2）
  project-store.ts      项目读写 + 素材库校验
  store.ts              视频任务读写
  script-store.ts       剧本读写（按 projectId 归属）
  uploads.ts            本地上传目录与大小限制
  logger.ts             视频调用错误日志（终端 + .data/logs/video.log）
  client.ts             前端 API 封装
  config.ts             环境变量读取与就绪判断
  video-service.ts      创建任务、状态同步
  compose.ts            下载 + ffmpeg 拼接成片（导出到 .data/exports）
  frame.ts              从镜头视频抽关键帧（导出到 .data/frames，供下一镜当首帧）
  agents/              所有「让模型做判断」的逻辑，与存储 / 路由 / 视频 provider 分离
    index.ts            统一出口
    spec.ts             影视语言规范（景别 / 运镜 / 提示词 / 台词约束与清洗）
    llm.ts              LLM 调用与 JSON 提取（最底层，其余 agent 共用）
    adaptation.ts       小说 / 章节改编（分段摘要 → 压缩蓝图 + 梗概）
    continuity.ts       故事架构师（主题 / 人物 / 场景 + entry/exit 状态链）
    storyboard.ts       分镜编剧（照蓝图写画面与提示词 + 时长 / 引用收口）
    review.ts           审片编辑（确定性体检 + 只修复有硬伤的镜头）
  media.ts              素材类型与校验（前后端共用）
  providers/video/      通义万相 wan3.0（types.ts / index.ts / wan.ts）
```

若将来接入其它视频平台：实现 `lib/providers/video/types.ts` 中的 `VideoProvider` 接口，在 `lib/providers/video/index.ts` 注册即可。

## 说明

- 剧本与视频任务都保存在本地 MySQL，刷新/重启不丢，换浏览器也能恢复。
- `.env.local` 中含数据库密码与 API Key，已被 gitignore，请勿提交或外传。
- 视频 URL 由平台提供，通常有有效期，需要长期保存请及时下载或合成导出。
- `npm run build && npm start` 同样是 4500 端口；生产模式同样使用 `.data/app.db`。

## 许可

[MIT](./LICENSE) © 2026 ChanClay
