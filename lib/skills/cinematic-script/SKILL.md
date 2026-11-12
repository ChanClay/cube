---
name: cinematic-script
description: This skill should be used when writing, rewriting, auditing, or fixing shot scripts for this project's text → storyboard → AI video pipeline, with the goal of a film-grade result. Trigger it when the user asks for 剧本 / 分镜 / 脚本 / 镜头语言 / 电影感 / 影视级 / 提示词, wants an idea or novel excerpt turned into Script JSON (characters, scenes, shots with entryState/exitState/beatSheet/videoPrompt), or complains that generated video looks 不电影 (画面漂移、镜头接不上、动作发糊、节奏拖沓、像 PPT). Not for editing video files, composing clips, or changing UI code.
---

# 影视级分镜脚本

把创意 / 小说片段 / 已有分镜，写成这个项目能直接消费的 `Script` JSON（`lib/types.ts`），并且让每一镜单独看是电影画面、连着看是一条不跳的镜头链。

## 三条不可让步的原则

1. **先蓝图，再分镜。** 没有 `StoryPlan`（人物、场景、entry/exit 状态链、情绪曲线）就直接写 shots，必然出现「每镜都成立、接起来就断」。先定故事层，再逐镜落地。
2. **一镜一个动作。** 文生视频模型一镜塞两个动作就会把画面拆成两段再接起来，接缝就是抽帧般的抖动。多出来的动作放到下一镜，用 `hard-cut` 交棒。
3. **一致性写在纸上，不靠记忆。** 角色外貌、场景光线必须落成全片一字不改的英文短语（`promptEn`），每镜提示词逐字复用。写漂的根源永远是「这一镜重新描述了一遍长相」。

## 执行流程

### 1. 收敛硬约束（先算，再写）

从用户话里取齐这些参数；缺的按括号里的默认值补齐，不要跳过：

| 参数 | 取值 |
| --- | --- |
| 输入 | 短创意（默认）或小说/章节原文（≥200 字，≤30000 字） |
| 分镜方式 | 按镜头数 `shots`（默认）/ 按总时长 `duration` |
| 镜头数 | 1~12；`duration` 且保证完整性时 = `ceil(总时长/10)` |
| 单镜时长 | 2~30 秒，优先 ≤10 秒（一次生成越长越糊） |
| 总时长 | 2~360 秒 |
| 视觉风格 | 预设短标签（见 `lib/skills/style-presets.ts`）或用户自定义描述 |

风格只给「电影感」四个字等于没给：必须展开成媒介 + 质感 + 光线 + 色调 + 颗粒，否则成片质感每次都在漂。预设标签到明细的映射在 `lib/skills/style-presets.ts` 的 `STYLE_PRESETS`，直接引用，不要另编一套。

### 2. 写故事蓝图（StoryPlan）

按 `lib/agents/continuity.ts` 的结构产出：`title / logline / theme / tone / characters / scenes / beats`。

- `logline` 必须包含「谁 + 想要什么 + 被什么阻碍 + 可能付出什么代价」，40 字内。
- 结构用经典节拍（开场钩子 / 铺垫 / 激励事件 / 升级 / 中点转折 / 低谷 / 高潮 / 余韵），镜数少可省略中间节拍，但开场钩子、高潮、余韵不能缺。
- 每个 beat 必写 `entry`（这一镜第一帧的画面事实）与 `exit`（最后一帧的画面事实），它们是全片唯一可靠的锚点。禁止写「他很紧张」「气氛凝重」这类拍不出来的内容。
- 角色 2~4 个、场景 1~4 个。写前先判断主体类型：人类按「廓形 / 头部 / 上装 / 下装与鞋 / 装备义体 / 配色 / 道具 / 气质」写；机甲、机器人、巨兽、载具按「机型体量 / 头部传感器 / 装甲材质与涂装 / 关节液压 / 武器 / 配色 / 编号 / 动作特征」写，**绝不能给机械体写年龄、发型、上衣和鞋**。
- 情绪曲线给每镜 `emotion` 1~5：不要开场 5、不要全程 3，最高点落在后 1/3 的高潮镜。

### 3. 展开分镜（shots）

逐镜写 `title / duration / shotSize / cameraMove / transition / referencePrevFrame / hiddenCut / entryState / exitState / beatSheet / description / videoPrompt / narration*`。

- 景别按「建立 → 逼近 → 细节 → 释放」推进：开场用大远景/全景交代空间关系，情绪高点用近景/特写，结尾释放回环境或留白。
- 相邻两镜不要同景别 + 同运镜。景别一次最多跨 1 档（特写直接接大远景等于换了个世界）。
- `transition` 只按「摄影机有没有停机」判断：同一次拍摄里切两刀 = `same-take`（单镜 ≤8 秒、全片连续不超过 2 次；景别与机位都不许变）；停机换机位 = `hard-cut`（绝大多数镜头）；时间或地点跳转 = `time-jump`。
- `referencePrevFrame`：只有「同场景 + 同景别的 `hard-cut`」写 `true`（下一镜第一帧就是本镜最后一帧，接缝不跳）；景别变了还写 `true` 只会换来一次突兀的推拉，改走卡片；`time-jump`、换场景一律 `false`。拿不准写 `false`。
- 一镜到底优先在单个镜头内用运镜 + `beatSheet` 完成景别变化，不要拆成多镜再靠 `same-take` 粘。必须在长镜头里换景别时，用遮挡 / 甩镜 / 暗部换机位并写 `hiddenCut: true`——此时景别可随便跨，末帧只当风格参考图。
- `beatSheet` 把 duration 切成 2~4 段（10~20 秒切 3~5 段）：首段 `from=0`、末段 `to=duration`，不断档不重叠，每段只写一个可见动作。没有这一层，20 秒的镜头只会得到一段半死不活的慢动作。
- `description` 用中文写清「景别 + 谁 + 在做什么 + 环境 + 光线」，`videoPrompt` 只做忠实英译（见下）。

### 4. 写 videoPrompt（最影响成片观感的一步）

`videoPrompt` 是 `description` 的**忠实英译**，不是重新创作：中文写到的每个主体、动作、道具、环境、光线都要在英文里有对应，中文没写的一律不许加。

固定词序（40~110 词，一段话，不分点）：

```
景别 + 主体（复用角色 promptEn）+ 具体动作 + 环境细节 + 光线/时间/色调 + 一个运镜 + 画面质感 +（可选）一句声音
```

- 景别、运镜只用 `lib/skills/spec.ts` 的标准表内写法，且必须与本镜的 `shotSize` / `cameraMove` 一致。
- 只写一个运镜、一条连续匀速的动作链，结尾用 `smooth continuous motion, steady pacing, stable framing` 收口。
- 禁止字幕/文字/水印/logo/分屏/转场词/镜头编号；除「升格慢动作」外不写 `slow motion`，也不写 `time-lapse` / `speed ramp` / `jump cut` / `flicker` / `morphing`。
- 不要用 `beautiful` / `sad` 单独代替画面；写可拍摄的名词与动词。

细节与正反例见 `references/video-prompt.md`。

### 5. 台词与声音

- `narration` 一镜只有一句，10~20 字；上限 `min(60, max(16, duration×4))` 字，超了视频模型不会放慢语速，只会吞掉后半句。
- `narrationType`：`dialogue`（画面里的人物开口，驱动口型）/ `voiceover`（画外旁白，人物闭嘴）/ `none`（无口播，`narration` 必须为空字符串）。
- `dialogue` 必须给 `speaker`，且 `speaker` 逐字来自本镜 `characterNames`。不要把人物台词写成旁白。全片至少 1 句 `dialogue`（用户明确要求无对白除外）。
- 台词只表达一个意思、要口语、要留潜台词，不要念设定。画面已经说清的信息不要再用旁白解释。

### 6. 成稿自检（必做，不要凭感觉交付）

先跑确定性校验，再人工过一遍清单：

```bash
node lib/skills/cinematic-script/scripts/validate_script.mjs <script.json>
```

校验覆盖：镜数与时长、英文提示词词数与禁用词、景别/运镜与英文是否对得上、固定短语是否复用、秒级节拍是否覆盖 0~duration、台词长度与说话人、角色/场景引用、跨镜状态链是否断开。`fatal` 必须清零，`warn` 逐条判断。

自检清单：

1. 第 1 镜 3 秒内是否让人看懂「谁、在哪、发生了什么异常」？
2. 第 1 镜到最后一镜连读，每处跳跃是否都在上一镜的 `transition` 里声明过？
3. 相邻两镜是否同景别 + 同运镜？same-take 的景别是否完全没变、是否连续超过 2 次？跨了景别的长镜头是否都标了 `hiddenCut`？
4. 每镜是否只有一个可见动作，且这个动作在 duration 内做得完？
5. 全片光比、色温、颗粒是否同一套语言（同一场景内不许一会儿日光一会儿霓虹）？
6. 是否每镜都在解释剧情，而没有一镜只靠画面推进？
7. 提示词里是否还有中文里没写过的元素、或中文写了却漏掉的道具？
8. 结尾是否留下余韵，而不是用一句总结性旁白收尾？

## 资源索引

- `references/film-language.md` — 景别语义、运镜、构图、光线与调色、镜头组接、节奏曲线，以及「AI 视频为什么不像电影」的病历表。
- `references/video-prompt.md` — 提示词模板、词表、正反例、常见失效模式。
- `references/script-schema.md` — `Script` JSON 全字段、硬约束数值、审片问题码与修法、`/api/script` 入参。
- `scripts/validate_script.mjs` — 确定性校验器，接受 `Script` 或 `{ script: Script }`，零依赖。

## 与本仓库代码的关系

- 本 skill 是「怎么写」的规范；运行时真正下发给模型的提示词在 `lib/agents/*.ts`。
- 改代码里的提示词时，景别/运镜/词数/禁用词等规则的**唯一来源**是 `lib/skills/spec.ts`，不要在 `storyboard.ts`、`review.ts`、`/api/shot/refine` 各写一份，否则模型会收到互相矛盾的指令。
- 想把脚本直接跑成视频，走 app 的 `POST /api/script` 生成，再逐镜生成；`lib/agents/storyboard.ts` 已实现「蓝图 → 分镜 → 英译 → 审片 → 定稿」全链路，手写脚本只在用户要求离线输出或改稿时使用。
