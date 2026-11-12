# Script JSON 结构与硬约束

事实来源：`lib/types.ts`、`lib/skills/spec.ts`、`lib/skills/shot-plan.ts`、`lib/agents/review.ts`。代码改了这里要同步，冲突时以代码为准。

## 一、整体结构

```json
{
  "title": "片名",
  "logline": "一句话故事梗概（谁 + 想要什么 + 阻碍 + 代价）",
  "style": "整体视觉风格（预设短标签或完整风格描述）",
  "characters": [
    { "name": "角色名", "desc": "可拍摄的中文外形", "promptEn": "fixed English appearance phrase" }
  ],
  "scenes": [
    { "name": "场景名", "desc": "地点/时间/光源方向与色温/主要陈设", "promptEn": "fixed English location phrase" }
  ],
  "shots": [
    {
      "index": 1,
      "title": "镜头小标题",
      "duration": 5,
      "shotSize": "中景",
      "cameraMove": "缓慢推近",
      "transition": "hard-cut",
      "transitionReason": "换机位，仍在同一次拍摄",
      "referencePrevFrame": true,
      "entryState": "本镜第一帧的画面事实",
      "exitState": "本镜最后一帧的画面事实",
      "beatSheet": [{ "from": 0, "to": 2, "action": "抬眼看向塔顶" }],
      "description": "中文画面描述",
      "videoPrompt": "faithful English translation of description",
      "narration": "台词或旁白，可为空字符串",
      "narrationType": "dialogue",
      "speaker": "说话的角色名（仅 dialogue）",
      "characters": ["出镜角色名"],
      "scenes": ["所在场景名"]
    }
  ]
}
```

- `id`、`media`、`lastFrameCast` 由系统写入，手写脚本可以省略。
- 首镜没有 `transition` / `referencePrevFrame` / `transitionReason`。
- 镜头的角色 / 场景字段在 JSON 里叫 `characters` / `scenes`（系统读作 `characterNames` / `sceneNames`）；名字必须逐字来自顶层清单。

## 二、数值约束

| 项 | 约束 | 代码位置 |
| --- | --- | --- |
| 镜头数 | 1~12 | `MAX_SHOT_COUNT` |
| 单镜时长 | 2~30 秒整数，优先 ≤10 | `MIN/MAX_SHOT_SECONDS`、`PREFERRED_SHOT_SECONDS` |
| 总时长 | 2~360 秒；镜头 duration 之和必须等于目标总时长 | `MAX_TOTAL_SECONDS` |
| `duration` 模式镜数 | 保证完整性 = `ceil(总时长 / 10)`；不保证时只给区间由 AI 决定 | `splitByDuration` |
| 角色卡 | 2~4 个，`promptEn` 20~35 词 | `continuity.ts` |
| 场景卡 | 1~4 个，`promptEn` 15~25 词 | `continuity.ts` |
| `videoPrompt` | 英文，40~110 词（<30 或 >150 判不合格） | `PROMPT_*_WORDS` |
| `videoPrompt` 中文占比 | 汉字 / (字母 + 汉字) ≤ 12% | `isEnglishPrompt` |
| 台词长度 | `min(60, max(16, duration × 4))` 字 | `narrationLimit` |
| `beatSheet` | 首段 from=0、末段 to=duration、不断档不重叠、最多 8 段 | `normalizeBeatSheet` |
| `beatSheet` 段数 | duration ≥4 时至少 2 段；2~4 秒 2 段，5~10 秒 2~3 段，10~20 秒 3~5 段 | `TIMELINE_RULES` |
| same-take | 单镜 ≤8 秒、全片连续 ≤2 次、景别跨度 ≤1 档、同场景 | `storyboard.ts` |
| 状态链断开阈值 | bigram 重合度 <0.15 视为断开（显式跳转词除外） | `stateOverlap` |

## 三、枚举值

- `shotSize`：`大远景 / 远景 / 全景 / 中景 / 近景 / 特写`，缺省 `中景`。
- `cameraMove`：`固定机位 / 缓慢推近 / 缓慢拉远 / 横向移动 / 环绕 / 跟随 / 手持晃动 / 升格慢动作`，缺省 `固定机位`。
- `transition`：`same-take / hard-cut / time-jump`。没写时系统按状态链重合度推断，拿不准一律写 `hard-cut`。
- `narrationType`：`dialogue / voiceover / none`，缺省 `voiceover`。写了台词却标 `none` 会被降级成 `voiceover`。

## 四、禁用词（`videoPrompt` 内）

`subtitles` / `captions` / `watermarks` / `logos` / `on-screen text` / `text overlay` / `split-screen` / `storyboard` / `shot 1` / `scene 2` 等一律不写。系统会按逗号切段剥离，但会破坏句子结构，最好一开始就不写。

## 五、审片问题码与修法

校验器与 `auditScript` 返回的码，`fatal` 必须清零：

| code | 级别 | 含义 | 修法 |
| --- | --- | --- | --- |
| `no-shot` | fatal | 没有镜头 | 重写 shots |
| `shot-count` | fatal | 镜数与要求不符 | 合并相邻镜或拆信息量最大的一镜，不新增剧情 |
| `empty-description` | fatal | 缺中文描述 | 补「景别 + 谁 + 动作 + 环境 + 光线」 |
| `empty-prompt` | fatal | 缺英文提示词 | 按中文逐项英译 |
| `prompt-not-english` | fatal | 提示词不是英文 | 重写为英文，角色名可保留汉字 |
| `prompt-forbidden` | fatal | 含字幕/水印/分屏等 | 删除该段 |
| `prompt-weak` | warn | <30 词，信息量不足 | 补环境、光线、质感 |
| `prompt-long` | warn | >150 词，啰嗦 | 删重复与形容词堆砌 |
| `duplicate-prompt` | warn | 与前面某镜完全相同 | 改动作与环境，不要复制 |
| `prompt-camera-mismatch` | warn | 英文无对应运镜 | 补标准运镜词 |
| `prompt-shot-size-mismatch` | warn | 英文无对应景别 | 补标准景别词 |
| `prompt-drift` | warn | 未复用固定 `promptEn`（命中 <50%） | 原文粘贴角色/场景短语 |
| `timeline-missing` | warn | 长镜没有秒级节拍 | 补 `beatSheet` |
| `narration-long` | warn | 台词超出时长容量 | 删到一句一意 |
| `dialogue-empty` | warn | 标了台词却没内容 | 补台词或改 `voiceover`/`none` |
| `dialogue-no-speaker` | warn | 没指定说话人 | 补 `speaker` |
| `speaker-not-on-screen` | warn | 说话人不在本镜 | 把 `speaker` 加进本镜 `characters`，或换人 |
| `unknown-character` / `unknown-scene` | warn | 引用了清单外的名字 | 逐字对齐顶层清单 |
| `state-missing` | warn | 缺 `entryState` / `exitState` | 补上可拍摄的画面事实 |
| `continuity-gap` | warn | 上镜出口与本镜入口对不上 | 对齐状态，或在上一镜写 `hard-cut`/`time-jump` |

## 六、app 侧入口（想把脚本跑成片时）

`POST /api/script`：

```json
{
  "idea": "一个守塔人在风暴夜重新点亮灯塔",
  "source": "idea",
  "style": "电影感写实",
  "mode": "shots",
  "shotCount": 6,
  "duration": 30,
  "ensureCompleteness": true
}
```

- `source: "novel"` 时 `idea` 是原文（200~30000 字），镜头数 / 时长 / 总时长由改编蓝图决定，上述参数被忽略。
- `mode: "duration"` 时 `shotCount` 不生效，`duration` 是视频总时长。
- 返回 `{ script, meta: { model, adaptedIdea } }`；`adaptedIdea` 是小说压出来的梗概，用它回填「故事创意」。
