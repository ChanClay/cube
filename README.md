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

模型需支持 `response_format: { type: "json_object" }`；不支持时会摘掉该参数重发，退化为「从返回文本中提取 JSON」。同理，服务端不认 `thinking` 参数时也会自动去掉。被 `max_tokens` 截断或正文为空时会自动放大一倍以上预算重试一次，仍失败才报错（错误里会带上 `finish_reason` 与 `reasoning_tokens`）。

### 视频生成（通义万相 wan3.0）

唯一接入的视频模型：`wan3.0-video`（可选 `wan3.0-video-prime`）。All-in-One 多模态，输入支持文本 / 图片 / 音频 / 视频 / 文档 / 网页。

| 变量 | 说明 |
| --- | --- |
| `VIDEO_API_KEY` | 阿里云百炼 DashScope API Key（`sk-` 开头） |
| `VIDEO_BASE_URL` | 原生异步接口地址，默认 `https://cn-beijing.maas.qianwenaiapi.com/api/v1`（**不要**用 `/compatible-mode/v1`） |
| `VIDEO_MODEL` | 留空默认 `wan3.0-video`；可选 `wan3.0-video-prime` |
| `VIDEO_RESOLUTION` | `480p` / `720p` / `1080p`，请求时自动转成 `480P` / `720P` / `1080P` |
| `VIDEO_RATIO` | `21:9` / `16:9` / `4:3` / `1:1` / `3:4` / `9:16` / `adaptive`（默认） |
| `VIDEO_DURATION` | 兜底时长（秒），wan3.0 支持 2~30，实际以每个镜头的 duration 为准 |
| `VIDEO_AUDIO` | 是否输出原生有声视频（台词 / BGM / 音效），默认 `true` |
| `VIDEO_AUDIO_ON_CARRY` | 承接上一镜末帧的镜头是否也生成音频，默认 `false`：画面接着上一镜、声音却重新生成会断档，这类镜头直接静音 |
| `VIDEO_PROMPT_EXTEND` | 提示词智能扩写，默认 `true` |

```env
VIDEO_API_KEY=sk-your-dashscope-key
VIDEO_MODEL=wan3.0-video
VIDEO_RESOLUTION=720p
VIDEO_RATIO=adaptive
VIDEO_AUDIO=true
```

走百炼 MaaS 异步接口：`POST /services/aigc/video-generation/video-synthesis`（需 `X-DashScope-Async: enable`），创建后轮询 `GET /tasks/{task_id}`。

注意 wan3.0 的参数与 wan2.x 不通用：wan3.0 用 `parameters.resolution`（`480P` / `720P` / `1080P`）+ `parameters.ratio` + `duration`，wan2.x 用 `size`（如 `1280*720`）。本实现按 wan3.0 请求，代码见 `lib/providers/video/wan.ts`。用首帧/尾帧、视频编辑、延长时建议 `VIDEO_RATIO=adaptive`。

### 站点

| 变量 | 说明 |
| --- | --- |
| `PUBLIC_BASE_URL` | 站点对外地址，如 `https://cube.example.com`。配置后本地上传的素材会被拼成绝对地址交给视频模型；留空则用请求来源（通常 `localhost`，云端模型访问不到） |

## 使用流程

0. **项目列表（`/`）**：首页展示全部项目卡片（剧本数 · 更新时间），点击进入项目，`×` 删除项目（连带其下剧本）。顶部输入名称即可新建。
1. **项目工作台（`/projects/[id]`）**：一个项目下可以有多份剧本。
   - 左栏「故事创意」：填写创意、选风格、镜头数（1–12）、单镜时长（2–30 秒滑块），点「生成剧本」（`⌘/Ctrl + Enter`）。内部先跑串联 agent 规划状态链，再由分镜 agent 写画面（见「分镜串联 agent」），每次生成都会新增一份剧本
   - 右栏顶部下拉切换本项目下的剧本
2. **分镜剧本**：LLM 返回结构化分镜，每镜头含中文画面描述、英文视频提示词、景别、运镜、旁白，均可编辑。
   - **角色卡 / 场景卡**：剧本头部与角色卡同级展示场景卡。两张卡都可以改名 / 改描述，并各自挂一张参考图——点「生成配图」调万相文生图，或「上传」用本地图片。改角色名会同步更新各镜头的出场角色标注。
   - 卡片配图会作为首帧的**兜底**参与生成（见下一节的首帧优先级）。
3. **生成视频**：单镜头点击「生成视频」，或点「全部生成」进入串行队列（并发 = 1）：一次只提交一镜，等它成功后再用 ffmpeg 抽该视频的**末帧**，作为下一镜的 `first_frame` 传进去，保证画面承接。页面每 5 秒轮询一次任务状态，完成后直接内联播放，可打开原视频。
   - **首帧优先级**（单镜生成与串行队列一致）：
     1. 用户手动指定的首帧 —— 永远优先，不会被覆盖
     2. 上一镜视频的**末帧**（单镜生成时只在上一镜已成功的情况下才抽）
     3. 上一镜末帧拿不到时（第一镜 / 上一镜没成 / 抽帧失败 / 云端下载不到），退回**场景卡配图**，再退到**出场角色卡配图**
   - 场景图排在角色图前：首帧是一整帧画面，场景空镜比「纯色背景的单人设定图」更接近真实构图，模型不容易被带成棚拍。
   - **成片本地化**：通义万相返回的 `video_url` 只保留 24 小时。任务一成功就立刻把视频下载到 `.data/videos/`，`videoUrl` 换成站内地址 `/api/videos/{file}`（支持 Range，Safari 可拖进度条）。历史任务若仍挂着临时地址且未超过 24 小时，轮询时会自动补转存；超过 24 小时的链接已被云端删除，无法恢复。
   - 抽帧图存在 `.data/frames/`，通过 `/api/frames/{file}` 对外提供；云端模型必须能下载到它，所以要配置 `PUBLIC_BASE_URL`。未配置（或地址是 localhost / 局域网 IP）时会退回配图兜底并给出提示。
   - 该镜头带参考图 / 参考视频 / 文档 / 网页（与首帧互斥）时，不注入任何首帧。
4. **合成成片**：2 个以上镜头完成后点「合成成片」，服务端下载各镜头并用 ffmpeg 拼接为一个 MP4，可播放/下载。

## 台词与声音

wan3.0 原生生成人声台词、BGM 和音效（`parameters.audio` 默认 `true`），但**台词必须写进 prompt** 才会被说出来：

- 分镜输出 `narration`（这一镜要说的话）和 `narrationType`：`dialogue` 是角色开口、会驱动口型；`voiceover` 是画外旁白、人物闭嘴
- 提交生成时由 `lib/dialogue.ts` 拼接到画面描述末尾，画面描述保持纯英文，台词保留原文（官方支持中英混写）
- 镜头卡片上的下拉可逐个切换类型；旧剧本没有这个字段，一律按 `voiceover` 处理，避免旁白变成人物开口
- 台词要短：一句 10~20 字，5 秒左右的镜头最多一句
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

- **生成配图**：`POST /api/image` → 万相文生图（默认 `wan2.6-t2i`）。接口返回的图片地址只保留 24 小时，服务端会立刻下载并转存到 `.data/uploads/`，前端拿到的是站内永久地址
- **上传**：复用 `/api/uploads`
- 换图时**不删除**旧文件：旧图可能已经被某个镜头的首帧引用着，删掉会让那条任务直接 404

配图在「上一镜末帧拿不到」时作为首帧兜底；只要末帧可用，配图就不会被提交。因为首帧需要云端可下载，配图同样依赖 `PUBLIC_BASE_URL`。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `IMAGE_API_KEY` | 复用 `VIDEO_API_KEY` | 百炼 API Key |
| `IMAGE_BASE_URL` | 复用 `VIDEO_BASE_URL` | 文生图接口地址 |
| `IMAGE_MODEL` | `wan2.6-t2i` | `wan2.6` 系列走同步协议；`wan2.5` 及以下自动切换成异步轮询 |

> 注意：镜头素材里的本地文件存在本机，通义万相在云端拉取，无法访问 `localhost`。要让本地上传的素材真正参与生成，需要配置 `PUBLIC_BASE_URL` 指向公网可访问地址（反向代理 / 对象存储），否则请改用公网 URL。

## 成片合成

需要本机有 ffmpeg（`brew install ffmpeg`），也可以用 `FFMPEG_PATH` 指定可执行文件路径。检测不到时按钮禁用并给出安装提示。

- 只合并「已生成完成」的镜头，严格按剧本顺序拼接
- 每个片段先 `scale + pad` 到统一尺寸再 `concat`，源视频分辨率/帧率不一致也不会失败
- 输出 H.264（`-preset veryfast -crf 20`）+ `faststart`
- 任一镜头带声音就保留音轨：统一 48kHz 立体声、AAC 192k，按镜头时长裁剪/补静音后再拼；所有镜头都无声时自动退化为纯画面输出（`VIDEO_AUDIO=false` 走这条）
- 输出尺寸跟随 `VIDEO_RESOLUTION` 与 `VIDEO_RATIO`：16:9 → 1280×720，9:16 → 720×1280，1:1 → 720×720
- 产物保存在 `.data/exports/`，自动保留最近 10 个；`GET /api/exports/{file}` 支持 Range 拖动播放

## 分镜串联 agent

一次性让模型吐全部镜头，很容易「每镜各自成立、彼此接不起来」。生成剧本现在是两阶段：

```
创意 ──▶ 串联导演 agent ──▶ 状态链(entry/exit) ──▶ 分镜 agent ──▶ 分镜脚本
```

**第一阶段 `lib/agents/continuity.ts`**：不写分镜文案，只规划一条状态链。每个镜头必须给出：

| 字段 | 含义 |
| --- | --- |
| `entry` | 承接上一镜的哪个状态；第一镜写「开场」 |
| `action` | 这一镜做完什么动作 |
| `exit` | 结束时留下的可拍摄状态（谁、在哪、什么姿势、朝向、手里拿什么） |
| `shotSize` / `cameraMove` | 成组推进的景别与运镜 |
| `transition` | 到下一镜的衔接方式（只作剪辑参考，不进画面） |

硬约束：相邻镜头的 action 首尾相接、不允许凭空换场地、角色外形全片锁定、景别按「建立 → 逼近 → 细节 → 释放」推进。

**第二阶段 `lib/agents/storyboard.ts`**：把状态链和角色表塞进分镜提示词，要求第 N 镜从 `entry` 开始、在 `exit` 结束，`shotSize`/`cameraMove` 照抄大纲，同一角色复用同一段英文外貌描述。

降级：串联环节失败（网络、JSON 不合法等）会退回原来的一次性生成，并往 `.data/logs/agent.log` 记一条 warn，不会让生成直接失败。代价是生成耗时大约翻倍（两次 LLM 调用，实测 4 镜约 24 秒）。

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
| POST | `/api/script` | `{ idea, style, shotCount, duration }` → `{ script }` |
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
    index.ts            统一出口（浏览器端请直接从 agents/media 引入）
    llm.ts              LLM 调用与 JSON 提取（最底层，其余 agent 共用）
    continuity.ts       串联导演 agent（规划 entry/exit 状态链）
    storyboard.ts       分镜 agent（照状态链写画面 + JSON 规范化）
    media.ts            素材关联 agent（镜头文本 / 角色卡 → 该带哪些项目素材）
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
