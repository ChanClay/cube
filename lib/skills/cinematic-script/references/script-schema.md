# Script JSON 结构与硬约束

事实来源：`lib/types.ts`、`lib/skills/spec.ts`、`lib/skills/shot-plan.ts`、`lib/agents/review.ts`。代码改了这里要同步，冲突时以代码为准。

## 一、整体结构

```json
{
  "title": "片名",
  "logline": "一句话故事梗概（谁 + 想要什么 + 阻碍 + 代价）",
  "style": "整体视觉风格（预设短标签或完整风格描述）",
  "motionProfile": "全片运动基调（蓝图中文产出）：整片在动还是静止、动来自哪里",
  "motionEn": "≤18 words English motion baseline，运行时逐镜追加到视频提示词",
  "characters": [
    {
      "name": "角色名",
      "subjectType": "human | vehicle | mech",
      "desc": "可拍摄的中文外形（只写恒定外观，不写这一镜的姿势 / 场景）",
      "promptEn": "fixed English appearance phrase"
    }
  ],
  "scenes": [
    {
      "name": "场景名",
      "state": "状态变体（可选）：白天 / 夜里断电 / 火灾后；只是机位不同不要拆卡",
      "desc": "地点/时间/光源方向与色温/主要陈设",
      "promptEn": "fixed English location phrase",
      "inventory": [
        {
          "name": "长餐桌",
          "en": "long oak table",
          "where": "房间正中，桌头正对门",
          "whereEn": "in the middle of the room, the table head facing the door",
          "fixed": true
        },
        {
          "name": "酒杯",
          "en": "wine glass",
          "where": "桌面靠近门口那一端",
          "whereEn": "on the table end nearest the door",
          "fixed": false
        }
      ]
    }
  ],
  "shots": [
    {
      "index": 1,
      "title": "镜头小标题",
      "duration": 5,
      "shotSize": "中景",
      "cameraMove": "缓慢推近",
      "transition": "hard-cut",
      "transitionReason": "停机换了机位，同一场戏、同一景别",
      "referencePrevFrame": true,
      "hiddenCut": false,
      "entryState": "本镜第一帧的画面事实",
      "exitState": "本镜最后一帧的画面事实",
      "blocking": "本镜人物走位：谁在空间的哪一侧、面朝哪里（参考门窗 / 桌子哪一端）",
      "blockingEn": "8~18 words English blocking phrase，运行时逐字追加到视频提示词",
      "beatSheet": [
        {
          "from": 0,
          "to": 2,
          "action": "抬眼看向塔顶",
          "actionEn": "his eyes lifting toward the top of the tower"
        }
      ],
      "description": "中文画面描述",
      "videoPrompt": "faithful English translation of description",
      "narration": "台词或旁白，可为空字符串",
      "narrationType": "dialogue",
      "speaker": "说话的角色名（仅 dialogue）",
      "characters": ["出镜角色名"],
      "backgroundCast": [
        {
          "desc": "八名披甲的西凉兵",
          "promptEn": "eight armored Xiliang soldiers in dark lamellar armor"
        }
      ],
      "crowdCleared": false,
      "scenes": ["所在场景名"]
    }
  ]
}
```

- `id`、`media`、`lastFrameCast` 由系统写入，手写脚本可以省略。
- `backgroundCast` 是没有主体卡的背景人群（群演 / 士兵 / 路人）：`desc` 写构成与数量，`promptEn` 是全片逐字复用的英文短语。同场景相邻镜头由定稿层继承上一镜（`inheritBackgroundCast`），省略或写 `[]` 都会继承（模型会把「这一镜没写人群」顺手输出成空数组）；人群真的退场要显式写 `crowdCleared: true`。运行时把 `promptEn` 拼进提示词，带末帧参考时还会锁人数——不写就会出现「上一镜结尾一群人、下一镜只剩主角一个人」。
- `narration` / `narrationType` / `speaker` 是设计层事实，不是 `description` 的派生物：单镜重算（`/api/shot/refine`）会原样保留它们，不会因为「画面描述里没写台词」而清空；整稿修复漏写时也按原稿兜住（`mergeRepairedShots`）。
- 首镜没有 `transition` / `referencePrevFrame` / `transitionReason` / `hiddenCut`。
- `referencePrevFrame` 只表达「要不要用上一镜末帧」，怎么用由景别跨度决定：同景别 → 当首帧；跨 1 档或 `hiddenCut` → 只当 `reference_image`；跨 2 档以上 → 不用。代码见 `lib/skills/shot-media.ts` 的 `prevFrameUsage`。同场景跨度 ≥2 的 `hard-cut` 写 `true` 无效且校验报错，必须先改序列（中间垫一档，或改成 `hiddenCut` 的隐蔽换机位）。
- 镜头的主体 / 场景字段在 JSON 里叫 `characters` / `scenes`（系统读作 `characterNames` / `sceneNames`，并另存一份 `sceneIds` 供改名后仍能定位卡片）；名字必须逐字来自顶层清单。载具卡同样要写进本镜 `characters`，否则那一镜不会带它的参考图。
- `inventory` 是场景卡的固定陈设清单，也是陈设覆盖检查的依据：分镜描述里出现的家具 / 桌上物件如果在这张清单和道具卡里都找不到，审片报 `prop-undeclared`。`where` 只能用相对门窗 / 固定家具的绝对关系（「房间正中，桌头正对门」），不能写「画面左侧」——换机位就翻面。
- `where` 是中文给人看的，**运行时只注入 `whereEn`**：中文位置拼进英文提示词会触发 `prompt-not-english`，模型也读不懂。缺 `whereEn` 时只注入英文名、不给位置；`whereEn` 含裸方位（`on the left`）时不注入位置，审片报 `scene-item-direction`。
- 位置注入时会附一句坐标系声明（`All positions are given from inside the space, relative to its fixed landmarks … never relative to the camera or the frame`）：只给「桌头正对门」而不说以谁为准，模型会读成「桌头正对镜头」。实现在 `lib/skills/spatial.ts` 的 `SPATIAL_FRAME_SENTENCE`。
- `blockingEn` 同理：裸方位不会被注入（错的坐标比没有坐标更糟），审片报 `bare-blocking`。`bare-direction` 这条以前只有离线校验脚本实现，现在 `auditScript` 里也有了。
- `angleRefs` 是同一场景的多机位图集，运行时按本镜景别自动挑一张（`wide` / `mid` / `close` / `reverse`）。标签为 `top` 的俯视图是「布局卡」：只给人对照走位，永远不会作为参考图提交给视频模型。
- 场景按「状态」拆卡（`state`），不按机位拆卡：按视角拆卡会让每个变体各自漂移，问题只是从「跨镜漂移」变成「跨变体漂移」。机位差异用 `angleRefs` 表达。

## 二、数值约束

| 项 | 约束 | 代码位置 |
| --- | --- | --- |
| 镜头数 | 1~12 | `MAX_SHOT_COUNT` |
| 单镜时长 | 随剧本视频模型：HappyHorse 3~15 秒 / wan3.0 2~30 秒，整数，优先 ≤10 | `lib/video-models.ts` + `shotLimits(videoModel)` |
| 总时长 | 单镜下限 ~ 单镜上限 × 12；镜头 duration 之和必须等于目标总时长 | `shotLimits(videoModel).minTotal/maxTotal` |
| `duration` 模式镜数 | 只给区间 `ceil(总时长/单镜上限)` ~ `min(12, 总时长/单镜下限)`，由 AI 按剧情决定 | `splitByDuration(total, limits)` |
| 主体卡 | 2~5 张（最多 8）：人物 + 每一辆载具 + 关键道具，`promptEn` 20~35 词，必须带 `subjectType` | `continuity.ts` |
| 主体卡 `desc` | 只写恒定外观；出现姿势 / 场景 / 动作（坐在车里、握着方向盘）报 `scene-in-character-desc`，配图层会再剥一次 | `APPEARANCE_ONLY_RULES` / `SITUATION_HINT` |
| 运动基调 | 蓝图给 `motion` / `motionEn`；运行时逐镜追加 `motionEn`，所以它只能写「任何一镜都成立的运动介质」，写剧情动作会污染每一镜（`stripScopedMotion` 会剔掉战马 / 刀剑 / 斟酒这类分句） | `StoryPlan.motion` / `MOTION_SCOPE_RULES` / `buildVideoPrompt` |
| 载具卡缺口 | 追逐 / 竞速且有驾驶主体时至少 2 张载具卡（被追的与追的各一张） | `requiredVehicleCards` |
| 场景卡 | 1~4 个，`promptEn` 15~25 词 | `continuity.ts` |
| 场景陈设 | `inventory` 5~12 件，每件带 `en` 与位置 `where`；陈设按「状态」拆卡，不按机位拆卡 | `normalizeInventory` / `set-dressing.ts` |
| 走位 `blocking` | 两人以上同框或人物会位移时必填，另配 8~18 词 `blockingEn`，参考系用固定件不用「画面左侧」 | `lib/skills/scene-anchor.ts` |
| 背景人群 `backgroundCast` | 两个以上无主体卡的人必须登记（`desc` + 逐字复用 `promptEn`）；同场景省略即继承上一镜，退场写 `crowdCleared: true` | `BACKGROUND_CAST_RULES` / `inheritBackgroundCast` |
| `videoPrompt` | 英文，40~125 词（<30 或 >170 判不合格） | `PROMPT_*_WORDS` |
| `videoPrompt` 中文占比 | 汉字 / (字母 + 汉字) ≤ 12% | `isEnglishPrompt` |
| 台词长度 | `min(60, max(16, duration × 4))` 字 | `narrationLimit` |
| 一人一镜 | 一镜只有一个 `speaker`，`narration` 里也只能有这一个人的台词；合规写法见 `dialogue.md` | `SPEAKER_SHOT_RULES` / `narrationSpeakerConflicts` |
| `beatSheet` | 首段 from=0、末段 to=duration、不断档不重叠、最多 8 段 | `normalizeBeatSheet` |
| `beatSheet[].actionEn` | 每段 8~14 词英文动作短语；运行时拼成英文时间轴与 videoPrompt 一起提交 | `TIMELINE_RULES` / `timelineClause` |
| `beatSheet` 段数 | duration ≥4 时至少 2 段；2~4 秒 2 段，5~10 秒 2~3 段，10~20 秒 3~5 段 | `TIMELINE_RULES` |
| same-take | 单镜 ≤8 秒、全片连续 ≤2 次、景别跨度必须为 0（摄影机没停机）、同场景 | `storyboard.ts` |
| 首帧接帧 | 同景别（跨度 0）才当首帧；跨 1 档或 `hiddenCut` 降级为参考图；跨 ≥2 档不接 | `prevFrameUsage` |
| 状态链断开阈值 | bigram 重合度 <0.15 视为断开（显式跳转词除外） | `stateOverlap` |

## 三、枚举值

- `shotSize`：`大远景 / 远景 / 全景 / 中景 / 近景 / 特写`，缺省 `中景`。
- `cameraMove`：`固定机位 / 缓慢推近 / 缓慢拉远 / 横向移动 / 环绕 / 跟随 / 手持晃动 / 升格慢动作`，缺省 `固定机位`。
- `transition`：`same-take / hard-cut / time-jump`。没写时系统按状态链重合度推断，拿不准一律写 `hard-cut`。
- `hiddenCut`：布尔。这次换机位靠遮挡 / 甩镜 / 暗部完成时写 `true`——长镜头里换景别的唯一做法，此时景别可随便跨。
- `narrationType`：`dialogue / voiceover / none`，缺省 `voiceover`。写了台词却标 `none` 会被降级成 `voiceover`。
- `speaker`：只在一镜里唯一的那个人口时出现，必须逐字来自本镜 `characters`。两个人的对白必须拆成两镜——A 的镜头 → `hard-cut` 反打 B 的镜头，`transitionReason` 写「反打承接上一句的话尾」。

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
| `prompt-long` | warn | >170 词，啰嗦 | 删重复与形容词堆砌 |
| `duplicate-prompt` | warn | 与前面某镜完全相同 | 改动作与环境，不要复制 |
| `prompt-camera-mismatch` | warn | 英文无对应运镜 | 补标准运镜词 |
| `prompt-shot-size-mismatch` | warn | 英文无对应景别 | 补标准景别词 |
| `prompt-drift` | warn | 未复用固定 `promptEn`（命中 <50%） | 原文粘贴主体 / 场景短语 |
| `prompt-temporal-adverb` | warn | 英文提示词用了 then / after that / finally | 改成并列的现在分词，把 `beatSheet` 各段串成一条链 |
| `size-gap-carry` | warn | 景别跨 2 档以上还想接上一镜末帧 | 改走卡片，或用 `hiddenCut` 声明遮挡转场 |
| `timeline-missing` | warn | 长镜没有秒级节拍 | 补 `beatSheet` |
| `beat-en-missing` | warn | 过半节拍缺英文 `actionEn`，时间轴提交不到视频模型 | 每段补 8~14 词英文动作短语 |
| `narration-long` | warn | 台词超出时长容量 | 删到一句一意 |
| `dialogue-empty` | warn | 标了台词却没内容 | 补台词或改 `voiceover`/`none` |
| `dialogue-no-speaker` | warn | 没指定说话人 | 补 `speaker` |
| `speaker-not-on-screen` | warn | 说话人不在本镜 | 把 `speaker` 加进本镜 `characters`，或换人 |
| `multi-speaker` | warn | 一镜里出现两个人的台词（两人对白连写 / 一问一答 / 两行「名字：」） | 拆成相邻两镜：A 的镜头 → `hard-cut` 反打 B 的镜头，每镜只留一个 `speaker`；拆镜后镜数会覆盖原目标镜数 |
| `dialogue-flat` | warn | 台词在复述画面（与 `description` 词面高度重合） | 改成说画面说不出的事（目的 / 潜台词 / 关系变化），或让这一镜 `narrationType: "none"` |
| `no-opening-voiceover` | warn | 全片没有旁白，开场前情只能由人物的第一句台词解释 | 第 1 镜改成空镜 / 大远景 + 一句 `voiceover` 交代谁、在哪、为什么打；从动作中段切入的创意可忽略 |
| `unknown-character` / `unknown-scene` | warn | 引用了清单外的名字 | 逐字对齐顶层清单 |
| `state-missing` | warn | 缺 `entryState` / `exitState` | 补上可拍摄的画面事实；hard-cut 的首尾状态同样是下一处剪辑点的依据 |
| `continuity-gap` | warn | 上镜出口与本镜入口对不上 | 对齐状态，或在上一镜写 `hard-cut`/`time-jump` |
| `exit-offscreen` | warn | 上一镜以「冲出画外 / 消失在雨幕 / 完全虚化」收尾 | 出口改到主体仍在画面内、动作可辨认的相位；或本镜写 `hiddenCut` 遮挡交接 |
| `direction-flip` | warn | 相邻两镜运动方向相反（左→右 接 右→左） | 方向保持一致；要越轴先垫中性机位（迎面 / 背面 / 空镜），或让主体在画面内转向 |
| `cut-undeclared` | warn | hard-cut 没写 `transitionReason` | 写清切点承接的是同一瞬间的动作相位，还是同一个背景锚点（同一条路 / 同一盏灯 / 同一个弯） |
| `camera-position-missing` | warn | `entryState` 没写机位段（轴线侧 / 高度 / 距离） | 补成相对上一镜的写法：沿轴线转 30°、抬到胸口高度、退到一臂；缺了机位，模型每镜重新摆一次摄影机 |
| `same-take-camera-change` | warn | `same-take` 的两镜运镜或轴线侧变了 | 摄影机没停机就不可能换机位：改成 `hard-cut`，或把景别、运镜、轴线侧写回与上一镜一致 |
| `framing-repeat` | warn | 同场景硬切，两镜同景别 + 同运镜 + 同轴线侧 | 换机位至少 30°，或换一档景别 / 换一个高度；否则切过去像跳帧 |
| `framing-jump` | warn | 同场景硬切，景别一步跨 ≥2 档且没 `hiddenCut` | 中间垫一档（全景 / 中景），或标 `hiddenCut` 用遮挡换机位；跨度 ≥2 时末帧也一定接不住 |
| `no-camera-anchor` | warn | 两辆以上载具同框，提示词却没写机位锚 | 第一句补「镜头装在哪 / 朝哪 / 多高」，如 `camera mounted low on the rear bumper of the black sedan, looking forward over both roofs` |
| `bare-direction` | warn | 方位词没有参照系（`on the left` / `to the right`），模型分不清画面左 / 车身左 / 车道左 | 改成 `frame left`、`the black car's rear-left quarter panel`、`the left-hand lane`，见 `references/video-prompt.md` 第三节 |
| `prop-undeclared` | warn | 分镜提到的家具 / 桌上物件在场景卡陈设清单与道具卡里都没有出处 | 补进场景卡 `inventory`（中文名 + 英文名 + 相对门窗的位置），或升级成道具卡；否则同一张桌子每镜都会被重新摆一次 |
| `scene-missing` | warn | 镜头标注的场景在场景卡里找不到（卡被删 / 改名后旧数据没对齐） | 在分镜卡的「所在场景」里重新选一次；生成时才拿得到场景参考图 |
| `blocking-missing` | warn | 两个以上角色同框却没有 `blockingEn` | 补 8~18 词英文走位，参考系用门窗 / 桌子哪一端；否则换机位后人物左右关系会翻 |
| `bare-blocking` | warn | `blockingEn` 含裸方位（`on the left`）或写了「画面左侧」 | 改成固定件参照：`at the table end facing the door` / `against the west wall`。运行时不会注入这句话，改好前走位等于没写 |
| `scene-item-direction` | warn | 陈设位置写成画面方位（`whereEn` 裸方位，或 `where` 写了「画面左侧」） | 位置要落在空间里，相对门窗 / 固定家具；画面方位随镜头翻转，换机位必然反 |

## 六、app 侧入口（想把脚本跑成片时）

`POST /api/script`：

```json
{
  "idea": "一个守塔人在风暴夜重新点亮灯塔",
  "source": "idea",
  "style": "电影感写实",
  "mode": "shots",
  "shotCount": 6,
  "duration": 30
}
```

- `source: "novel"` 时 `idea` 是原文（200~30000 字），镜头数 / 时长 / 总时长由改编蓝图决定，上述参数被忽略。
- `mode: "duration"` 时 `shotCount` 不生效，`duration` 是视频总时长；镜数由 AI 按剧情决定，只受 `minShotCount` ~ `maxShotCount` 区间约束。
- 返回 `{ script, meta: { model, adaptedIdea } }`；`adaptedIdea` 是小说压出来的梗概，用它回填「故事创意」。
