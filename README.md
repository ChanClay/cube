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

## 文档

- [视频模型](./docs/video-models.md)：HappyHorse 1.1 / wan3.0 / Seedance 2.5 的生成模式分流、素材限制、音轨、接口参数与全部环境变量
- [文生图模型](./docs/image-models.md)：角色卡 / 场景卡配图用的万相模型、协议差异与提示词增强

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

### 视频生成（阿里云百炼，每个剧本自己选模型）

接入两个模型，**创建剧本时选定**（存在 `Script.videoModel` 上，生成视频时按它路由 provider，不再全局切换）。能力表在 `lib/video-models.ts`，前后端共用：

| 模型 | provider | 单镜时长 | 素材 | 音轨 |
| --- | --- | --- | --- | --- |
| `happyhorse-1.1` | `happyhorse` | **3~15 秒** | 首帧 / 参考图（≤9 张） | 原生音视频联合生成，**始终带音轨、不可关** |
| `wan3.0-video` | `wan` | **2~30 秒** | 首尾帧 + 参考图 / 视频 / 音频 / 文档 / 网页 | 原生，可用 `audio` 开关 |
| `seedance-2.5` | `seedance` | **4~30 秒** | 首尾帧 + 参考图 / 视频 / 音频 | `generate_audio` 开关（火山方舟） |

最小配置（百炼）：

```env
VIDEO_API_KEY=sk-your-dashscope-key
VIDEO_BASE_URL=https://cn-beijing.maas.qianwenaiapi.com/api/v1
```

用 Seedance 另配一套火山方舟的 Key（与百炼不通用）：

```env
VIDEO_SEEDANCE_API_KEY=your-ark-api-key
VIDEO_MODEL_SEEDANCE=doubao-seedance-2-5-260628
```

生成模式分流、素材限制、音轨差异、接口参数与全部 `VIDEO_*` 变量见 [docs/video-models.md](./docs/video-models.md)。

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
     - **视频模型**：创建前先选模型（默认 wan3.0，下拉顺序 wan3.0 / Seedance 2.5 / HappyHorse 1.1），单镜时长区间、总时长上限、生成时走的接口都由它决定，创建后固定；编辑既有剧本时回填原模型。能力表见 `lib/video-models.ts`
     - 每次生成都会新增一份剧本
     - **按镜头数量**：手动指定镜头数（1–12）与单镜时长（滑块范围随模型：wan3.0 2–30 秒 / HappyHorse 3–15 秒）
     - **按总时长**：只给视频总时长（下限 = 单镜下限，上限 = 单镜上限 × 12），按 1 秒粒度调整。不预设镜头数，只给 AI 一个合法区间（`ceil(总时长/单镜上限)` ~ `min(12, 总时长/单镜下限)`），由它按剧情自己判断切几刀并分配每镜时长——串联性强的段落（追逐、穿行、对峙）会合并成一个镜头，用秒级节拍承载，不再被切成等长的几段。每镜时长都在模型的单镜区间内，总和等于设定的总时长
       - 为什么下限按单镜上限算：10 秒是质量线（超过之后后半段动作会变慢、肢体开始糊），但一镜到底的段落本来就该长，把它逼成 10 秒一刀只会把连续动作切碎。所以质量提示写进提示词让 AI 自己权衡，区间下限只受接口的单镜上限限制
   - 右栏顶部下拉切换本项目下的剧本
2. **分镜剧本**：LLM 返回结构化分镜，每镜头含中文画面描述、**秒级节奏（第几秒到第几秒在做什么）**、英文视频提示词、景别、运镜、旁白，均可编辑；镜头头部显示这一镜在成片里的绝对时间码（如 `00:12–00:19`），秒级节奏按 `0–2s / 2–5s` 逐段列出。
   - **角色卡 / 场景卡**：剧本头部与角色卡同级展示场景卡。两张卡都可以改名 / 改描述，并各自挂一张参考图——点「生成配图」调万相文生图，或「上传」用本地图片；点缩略图或展开后的配图可看大图（Esc / 点背景关闭）。改角色名会同步更新各镜头的出场角色标注。
   - 卡片配图会作为首帧的**兜底**参与生成（见下一节的首帧优先级）。
3. **生成视频**：单镜头点击「生成视频」，或点「全部生成」进入串行队列（并发 = 1）：一次只提交一镜，等它成功后再用 ffmpeg 抽该视频的**末帧**，作为下一镜的 `first_frame` 传进去，保证画面承接。页面每 5 秒轮询一次任务状态，完成后直接内联播放，可打开原视频。
   - **衔接方式（transition）**：每一镜有一项 `same-take` / `hard-cut` / `time-jump`，由分镜阶段产出（镜头卡片上可改，鼠标悬停能看到判定依据）。它是素材决策的唯一依据：
     - `same-take`（承接上一镜）：抽上一镜末帧当首帧，**本镜不能再传参考图**——三个模型都把首帧与 `reference_*` 视为互斥（HappyHorse 更极端：`first_frame` 走 i2v、`reference_image` 走 r2v，是两个模型）；
     - `hard-cut` / `time-jump`：走角色卡 / 场景卡的 `reference_image`，画面不接帧。
     分镜的判断会再过一层确定性否决（`lib/agents/storyboard.ts` 的 `resolveTransitions`）：换场景、景别跨 2 档以上、首尾状态对不上、有人物的镜头超过 8 秒、连续接帧超过 2 次，一律改判 `hard-cut`，否决原因写进 `transitionReason`。模型没写 transition 时，只有首尾状态重合度 ≥ 0.4 才推定承接，否则按剪辑点处理。
   - **首帧优先级**（单镜生成与串行队列一致，仅 `same-take` 镜头会走到这里）：
     1. 用户手动指定的首帧 —— 永远优先，不会被覆盖
     2. 上一镜视频的**末帧**（单镜生成时只在上一镜已成功的情况下才抽）：抽的是结尾前 `0.1s` 的无损 PNG，早先取 `-0.4s` + JPEG，接缝处会把上一镜最后 0.4 秒重演一遍、并带进一层压缩噪点
     3. 上一镜末帧拿不到时（第一镜 / 上一镜没成 / 抽帧失败 / 云端下载不到），退回**场景卡配图**，再退到**出场角色卡配图**
   - 场景图排在角色图前：首帧是一整帧画面，场景空镜比「纯色背景的单人设定图」更接近真实构图，模型不容易被带成棚拍。
   - **成片本地化**：视频模型返回的 `video_url` 只保留 24 小时。任务一成功就立刻把视频下载到 `.data/videos/`，`videoUrl` 换成站内地址 `/api/videos/{file}`（支持 Range，Safari 可拖进度条）。历史任务若仍挂着临时地址且未超过 24 小时，轮询时会自动补转存；超过 24 小时的链接已被云端删除，无法恢复。
   - 抽帧图（`.png`，旧数据仍有 `.jpg`）存在 `.data/frames/`，通过 `/api/frames/{file}` 对外提供；云端模型必须能下载到它，所以要配置 `PUBLIC_BASE_URL`。未配置（或地址是 localhost / 局域网 IP）时会退回配图兜底并给出提示。
   - 该镜头带参考图（与首帧互斥）时，不注入任何首帧。
   - **上一镜末帧怎么用（每镜 `referencePrevFrame`）**：按「同场景 + 景别跨度」分档，见 `lib/skills/shot-media.ts` 的 `prevFrameUsage`：
     - 同景别（跨度 0）的 `same-take` / `hard-cut`：末帧作为真 `first_frame`，本镜第一帧与上一镜最后一帧完全相同，接缝不会跳；代价是本镜传不了卡片。
     - 跨 1 档，或标了 `hiddenCut`（遮挡 / 甩镜 / 暗部转场）：末帧降级为 `reference_image`，追加在卡片之后只借光线与材质，景别 / 机位 / 构图按本镜描述重新构图。
     - 跨 2 档以上、`time-jump`、换场景：不接帧，走角色卡 / 场景卡。
     - 首帧只用在同景别：景别一变，硬把上一镜构图当首帧，这一镜就只能从旧构图里拉远 / 推近，分镜写的剪辑点变成一次突兀的运镜。
     - 默认值在生成分镜时写进剧本（见 `storyboard.ts` 的 `resolveReferenceFrames`）。它只做否决，不预设 `true`；同场硬切留「自动」，由景别跨度决定当首帧还是当参考图。模型写 `false` 一律尊重。
     - 镜头卡片上可以直接改（同景别是「末帧接住」，跨景别是「末帧参考」）；景别跨 2 档以上时该选项不可用，旁边会多出「遮挡转场」开关。
     - `VIDEO_REFERENCE_PREV_FRAME` 是全局总开关，置 `0` 后所有镜头都不带。
     - **参考图里是谁必须点名**：末帧是像素，模型不知道图里站的是谁，只写「匹配光线」的话它只会把参考图当调色板。所以提交时会追加 `The reference image is the last frame of the previous shot and shows 老陈 — the same person described above, not an additional character. Keep only their faces and wardrobe consistent; do not duplicate them.`，后面才是「只借光线 / 材质、构图按本镜描述」的限定。名字来自 `prevFrameCast(prev)`：优先用 `Shot.lastFrameCast`（留给视觉识别 / 人工确认写入），没有时退回上一镜的 `characterNames`——那只是分镜时的意图，精度有限。
     - **不许说「保持位置」**：换机位时位置必然变，`keep positions` 会和 `keep the camera angle described above` 直接冲突，模型会把参考图里的人留在原位、再按文字画一个，于是同一个人出现两次。只锁脸和服装，并显式 `do not duplicate`。
     - **单人镜头给人数上限**：`characterNames` 只有一个时追加 `Only one person appears in frame`。
     - **卡片与末帧同时传，不做身份去重**：试过「末帧里已经出现的人就不传他的卡」，结果整段视频彻底失去参考——末帧是一张整帧场景图，模型把它当环境 / 光线 / 风格参考，不会当成某个具体人物，删掉角色卡等于把身份参考一起删了。重复人物改由提示词约束（只锁脸和服装、`do not duplicate`、单人镜头给人数上限）。
     - 重算某镜提示词（`/api/shot/refine`）时也会把同一份名单与上一镜 `exitState` 一起喂给模型，并要求「本镜开头的人物与名单完全一致，需要新角色时写成过程中走进画面」。
   - 三个模型都原生出音轨：HappyHorse 1.1 是音视频联合生成、且无法关闭；wan3.0（`audio`）与 Seedance 2.5（`generate_audio`）由 `VIDEO_AUDIO` 控制。
4. **合成成片**：2 个以上镜头完成后点「合成成片」，服务端下载各镜头并用 ffmpeg 拼接为一个 MP4，可播放/下载。

## 台词与声音

三个模型都会原生出声，差别只在能不能关：HappyHorse 1.1 是音视频联合生成、**音轨不可关闭**，也不接受 `reference_audio` 指定音色；wan3.0 与 Seedance 2.5 可以用 `VIDEO_AUDIO` 关掉。细节见 [docs/video-models.md](./docs/video-models.md)。

三个模型都必须**把台词写进 prompt 才会被说出来**，写法一致：

- 分镜输出 `narration`（这一镜要说的话）和 `narrationType`：`dialogue` 是角色开口、会驱动口型；`voiceover` 是画外旁白、人物闭嘴
- `dialogue` 还会输出 `speaker`（谁在说，必须是本镜 `characters` 里的名字）。多人物镜头会把说话人写进提示词，避免模型挑错人开口
- **一镜只有一个说话人**：`speaker` 是单值，`narration` 里也只能有这一个人说的话。两个人的对白必须拆成两镜（A 的镜头 → `hard-cut` 反打 B 的镜头）；一镜塞两句会被审片判 `multi-speaker` 并拆镜，台词也会在成片里只剩一句
- **开场旁白**：第一镜是空镜 / 大远景时，用一句 `voiceover` 交代前情（谁 / 在哪 / 为什么打），第二镜再进人物台词——背景由旁白交代，人物的第一句话就不必自我解释。全片一句旁白都没有、开场又无口播时，审片报 `no-opening-voiceover`
- 提交生成时由 `lib/skills/dialogue.ts` 拼接到画面描述末尾，画面描述保持纯英文，台词保留原文
- 镜头卡片上的台词框可直接编辑，类型下拉逐个切换；切成角色台词时可指定说话人。旧剧本没有 `speaker` 时保持原行为，一律按 `voiceover` 处理，避免旁白变成人物开口
- 台词要短：一句 10~20 字，5 秒左右的镜头最多一句；同一句台词只表达一个意思
- HappyHorse 无法用 `reference_audio` 锁音色（接口只收图片），音色只能靠文字描述；想固定音色只能用 wan3.0
- 不想要人声时把 `narrationType` 切成 `none`（模型只出环境音 / 拟音）；HappyHorse 的音轨本身关不掉，需要绝对静音只能后期处理
- 合成阶段会保留各镜头自带的音轨，全部无声时自动输出纯画面 MP4

## 素材与配图

镜头的素材直接在镜头卡片里添加，可选类型**按剧本的视频模型过滤**（`lib/skills/media.ts` 的 `mediaTypesFor`）：

- **wan3.0**：首帧 / 尾帧 / 参考图 / 参考视频 / 参考音频 / 文档 / 网页（全模态）
- **HappyHorse 1.1**：首帧 / 尾帧 / 参考图（只吃图片，JPEG / PNG / WEBP，≤20MB）
- **Seedance 2.5**：首帧 / 尾帧 / 参考图 / 参考视频 / 参考音频（不支持文档、网页；2.5 / 2.0 系列不接受含真人人脸的参考素材）

| 来源 | 存储 | 说明 |
| --- | --- | --- |
| 本地文件上传 | `.data/uploads/`，通过 `/api/uploads/{file}` 访问 | 单个 ≤ 32MB |
| 公网 URL | 只存链接 | 必须是 `http(s)://` 且公网可访问 |

素材类型沿用视频模型的语义；首帧 / 尾帧与参考类素材互斥——HappyHorse 下就是 i2v（只有一张帧图）与 r2v（走参考图）二选一。

### 角色卡 / 场景卡配图

剧本头部的角色卡、场景卡各挂一张参考图，有两种来源：

- **生成配图**：`POST /api/image` → 万相文生图（默认 `wan2.6-t2i`）。请求里除了中文的「名称：外形描述」，还会带上蓝图锁定的 `promptEn`（固定英文外貌 / 空间短语），保证卡片和逐镜视频里长得一样；接口返回的图片地址只保留 24 小时，服务端会立刻下载并转存到 `.data/uploads/`，前端拿到的是站内永久地址。模型选择、协议差异与提示词增强见 [docs/image-models.md](./docs/image-models.md)
- **上传**：复用 `/api/uploads`
- 换图时**不删除**旧文件：旧图可能已经被某个镜头的首帧引用着，删掉会让那条任务直接 404

配图在「上一镜末帧拿不到」时作为首帧兜底；只要末帧可用，配图就不会被提交。因为首帧需要云端可下载，配图同样依赖 `PUBLIC_BASE_URL`。

> 注意：镜头素材里的本地文件存在本机，视频模型在云端拉取，无法访问 `localhost`。要让本地上传的素材真正参与生成，需要配置 `PUBLIC_BASE_URL` 指向公网可访问地址（反向代理 / 对象存储），否则请改用公网 URL。

## 成片合成

需要本机有 ffmpeg（`brew install ffmpeg`），也可以用 `FFMPEG_PATH` 指定可执行文件路径。检测不到时按钮禁用并给出安装提示。

同时会找 ffprobe（`FFPROBE_PATH`，或 `FFMPEG_PATH` 同目录，或 PATH）读每段素材的真实帧率与视频流时长；找不到时退回只读 ffmpeg 文件头，合成不会失败，但时长精度差一帧。

- 只合并「已生成完成」的镜头，严格按剧本顺序拼接
- 每个片段先 `scale（lanczos）+ pad` 到统一尺寸再 `concat`，源视频分辨率/帧率不一致也不会失败
- **帧率跟素材走**：用 ffprobe 取各片段的真实帧率，成片按其中最高的那个锁定 CFR（原来写死 30，24fps 素材会被补重复帧，运动看着一顿一顿）
- **时长按视频流算**：容器时长取的是音视频里较长的一条（模型常给 8.00s 画面 + 8.03s 音轨），按它裁剪/补静音会让音频每镜多出几十毫秒，拼到后面就是音画不同步
- 输出 H.264（`-preset medium -crf 18`）+ `faststart`：素材本身已经压过一次，`veryfast / crf20` 会在运动画面里留下块状拖影
- 任一镜头带声音就保留音轨：统一 48kHz 立体声、AAC 192k，按镜头时长裁剪/补静音后再拼；HappyHorse 1.1 和打开音轨的 wan3.0 都带音轨，所以成片通常是带声音的（全部无声时才退化为纯画面输出）
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
- 对白：凡这一镜有人开口，就给该节拍写 `dialogue` —— `speaker`（唯一说话人）、`intent`（这句要达成什么）、`subtext`（为什么不明说）、`effect`（对方听完的可见变化）、`listener`（听者，决定反打镜头里出现谁）。**两个人开口 = 两个节拍 = 两个镜头**，一问一答不许压进同一节拍

硬约束：相邻镜头的 action 首尾相接、不允许凭空换场地、角色外形与场景光线全片锁定、景别按「建立 → 逼近 → 细节 → 释放」推进、情绪最高点落在后 1/3。蓝图缺动作 / 缺交接时会带着问题清单重试一次。

**第二步 `lib/agents/storyboard.ts`（分镜编剧）**：把蓝图塞进提示词，逐镜写画面、秒级节奏、英文视频提示词与台词。对白按「话轮」拆镜：先排谁先说 / 谁接 / 谁沉默，一个话轮一个镜头，换人开口就是一次 `hard-cut` 反打（守轴线、说话人的镜头里留听者的肩或侧脸、关键台词之后给听者一个不开口的反应镜头）。每一镜必须显式写出 `entryState`（第一帧的画面事实）与 `exitState`（最后一帧的画面事实），且本镜 `entryState` 必须与上一镜 `exitState` 是同一个状态——连贯性不再靠「记得上一镜」，而是靠一条写在纸上的状态链；合并 / 拆分节拍时 entry / exit 整体继承，缺首尾状态时用蓝图兜底。每一镜还要写 `beatSheet`：把这个镜头的秒数切成 2~4 段，逐段交代「第几秒到第几秒发生什么可见变化」（2~4 秒切 2 段、10 秒以上切 3~4 段），不许写「情绪渐强」这类拍不出来的东西。蓝图节拍数与目标镜数不一致时，多就合并、少就拆解，不新增剧情。写完做确定性收口：时间轴按实际时长重算（首段必须从 0 开始、末段必须到 duration、中间不留白不重叠）、角色卡 / 场景卡以蓝图为准、错位的名字映射回卡上、中文描述里点名的角色自动补进 `characters`、台词按时长截断、镜数与总时长对齐。

**第三步 `lib/agents/localize.ts`（提示词译者）**：中文定稿后单独调一次模型，把每一镜的 `description` 逐句翻成英文 `videoPrompt`。输入里带上角色 / 场景的固定英文短语与标准景别、运镜词，规则是「只翻译不创作」：中文没有的元素不许加，中文写了的不许漏。这样中英文不再是各自发挥的两份稿子（`SCRIPT_LOCALIZE=false` 可关闭，回退到分镜阶段顺手写英文）。

**第四步 `lib/agents/review.ts`（审片编辑）**：先做不发请求的体检——镜数、英文提示词长度、禁用词（字幕 / 水印 / logo / 分屏）、台词长度、**一镜多人说话**（`multi-speaker`）、**台词复述画面**（`dialogue-flat`）、角色与场景引用、重复提示词，以及两组新增的硬伤：**跨镜连贯性**（上一镜 `exitState` 与本镜 `entryState` 是否还是同一个状态，刻意跳转需写明「片刻后 / 次日」等转场词）与**中英一致性**（英文里的景别 / 运镜是否与 `shotSize` / `cameraMove` 对得上、有没有用上蓝图锁定的外貌与空间短语）。有硬伤才额外调用一次模型修复（`SCRIPT_REVIEW=false` 可关闭）；`multi-speaker` 的修法是拆镜，所以修复后镜数可能比原目标多一镜，收口会按修复后的镜数执行；修复失败保留原稿，不让生成失败。

公共规范收在 `lib/skills/spec.ts`（景别 / 运镜的英文对照表、提示词 / 台词 / 连贯性约束与清洗、状态相似度），分镜写作、提示词翻译、单镜重算（`/api/shot/refine`）、审片共用同一份，避免各处规则漂移。

降级：蓝图规划失败会退回一次性生成，翻译失败会保留分镜阶段写好的英文，都会往 `.data/logs/agent.log` 记一条 warn。正常生成是 3 次 LLM 调用（蓝图 / 分镜 / 翻译），触发审片时才多一次。

## 小说 / 章节改编

「小说 / 章节」模式不是把整章原文直接交给规划 agent，而是先压缩再分镜：

```
原文 ──▶（>8000 字先分段摘要）──▶ 改编 agent ──▶ 蓝图 + 梗概 ──▶ 分镜链路
```

- 输入 200~30000 字；超过 8000 字按段落切成最多 5 段，每段先摘要，再合成蓝图（map-reduce）
- 镜头数量、每镜时长、总时长全部由改编蓝图按剧情决定（1~12 镜，单镜与总时长区间随剧本选的模型：wan3.0 2~30 秒 / 2~360 秒，HappyHorse 3~15 秒 / 3~180 秒），用户不需要手填
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
| POST | `/api/script` | `{ idea, source?, style, mode?, shotCount, duration, videoModel? }` → `{ script, meta }`；`videoModel` 决定单镜时长区间并写入 `script.videoModel`，不传按 wan3.0；`source=novel` 时 `idea` 是小说原文，`shotCount` / `duration` 被忽略（由改编蓝图决定），`meta.adaptedIdea` 返回压缩梗概 |
| POST | `/api/image` | `{ prompt, kind, style? }` → 万相文生图并转存本地，返回 `{ media }` |
| GET | `/api/scripts` | 剧本列表 `{ scripts }`，`?limit=20&projectId=` |
| POST | `/api/scripts` | 保存剧本 `{ id?, projectId?, idea, script }` → `{ script }` |
| GET | `/api/scripts/latest` | 最近一份剧本 `{ script }`，`?projectId=` |
| GET / DELETE | `/api/scripts/[id]` | 读取 / 删除指定剧本 |
| POST | `/api/uploads` | 上传素材文件（multipart，字段 `file`）→ `{ media }` |
| GET / DELETE | `/api/uploads/[file]` | 读取 / 删除本地上传的素材文件 |
| GET | `/api/video` | 全部视频任务（非终态任务会同步一次 provider） |
| POST | `/api/video` | `{ shotId, prompt, duration, ratio?, resolution?, media?, videoModel? }` → `{ job }`；`videoModel` 决定走哪个 provider 并夹时长，不传按 wan3.0 |
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

- 连接池用 `mysql2`，单例复用；表结构见 `lib/services/db.ts`
- 旧库升级自动执行：给 `scripts` 补 `project_id` 列与索引，并把没有归属的历史剧本收进「默认项目」（`id = default`）
- 剧本编辑后 1.2 秒防抖写库，刷新页面从 MySQL 恢复（不依赖 localStorage）
- 查看：`make db`；从旧 SQLite 迁移：`make migrate`（幂等，可重复执行）
- 备份：`mysqldump -u root -p ai_video > backup.sql`
- 换 Postgres 只需替换 `lib/services/db.ts` + `lib/services/store.ts` / `lib/services/script-store.ts` 的 SQL 方言，接口层不动

## 项目结构

```
Makefile              常用命令（make dev / build / start ...）
app/
  page.tsx              项目列表主页（新建 / 删除 / 进入项目）
  projects/[id]/page.tsx  项目工作台（素材库、创意、剧本、轮询、导出）
  api/                  health / projects / script(s) / video / shot / frames / uploads / compose 路由
components/             TopBar · ProjectMediaPanel · IdeaForm · ScriptView · ShotCard
docs/                  模型文档（视频模型 / 文生图模型）
scripts/
  migrate-sqlite-to-mysql.mjs  旧 SQLite 数据迁移
  db-stats.mjs                 表统计（make db）
lib/
  client.ts             前端 API 封装
  config.ts             环境变量读取与就绪判断
  types.ts              领域类型（Script / Shot / Project / VideoJob ...）
  video-options.ts      画幅 / 画质 / 时长的合法取值
  agents/               所有「让模型做判断」的逻辑
    index.ts            统一出口
    llm.ts              LLM 调用与 JSON 提取（最底层，其余 agent 共用）
    adaptation.ts       小说 / 章节改编（分段摘要 → 压缩蓝图 + 梗概）
    continuity.ts       故事架构师（主题 / 人物 / 场景 + entry/exit 状态链）
    storyboard.ts       分镜编剧（照蓝图写画面与提示词 + 时长 / 引用收口）
    localize.ts         提示词译者（中文定稿后单独翻英文）
    review.ts           审片编辑（确定性体检 + 只修复有硬伤的镜头）
  skills/               确定性能力：规则、提示词构造、纯计算
    spec.ts             影视语言规范（景别 / 运镜 / 提示词 / 台词约束与清洗）
    shot-plan.ts        镜数与时长规划（shotLimits(模型)：单镜区间、最多 12 镜）
    style-presets.ts    视觉风格预设与展开
    image-prompt.ts     文生图提示词（科技细节增强）
    dialogue.ts         逐镜视频提示词拼装（台词 / 素材）
    shot-media.ts       单镜素材决策（接帧 / 卡片兜底）
    media.ts            素材类型与校验（前后端共用）
    blank-script.ts     空剧本构造
    demo-script.ts      示例剧本（未配 LLM 时预览）
    format.ts           相对时间格式化
  services/             存储、文件与视频链路等 I/O
    db.ts               MySQL 连接池、建表与旧库迁移（mysql2）
    auth.ts             注册 / 登录 / 会话
    project-store.ts    项目读写 + 素材库校验
    store.ts            视频任务读写
    script-store.ts     剧本读写（按 projectId 归属）
    queue-store.ts      串行队列标记
    uploads.ts          本地上传目录与大小限制
    logger.ts           视频调用错误日志（终端 + .data/logs/video.log）
    video-service.ts    创建任务、状态同步
    videos.ts           成片文件索引
    compose.ts          下载 + ffmpeg 拼接成片（导出到 .data/exports）
    frame.ts            从镜头视频抽关键帧（导出到 .data/frames，供下一镜当首帧）
  providers/video/      阿里云百炼：HappyHorse 1.1 + 万相 wan3.0（types.ts / index.ts / happyhorse.ts / wan.ts）
```

## 说明

- 剧本与视频任务都保存在本地 MySQL，刷新/重启不丢，换浏览器也能恢复。
- `.env.local` 中含数据库密码与 API Key，已被 gitignore，请勿提交或外传。
- 视频 URL 由平台提供，通常有有效期，需要长期保存请及时下载或合成导出。
- `npm run build && npm start` 同样是 4500 端口；生产模式同样使用 `.data/app.db`。

## 许可

[MIT](./LICENSE) © 2026 ChanClay
