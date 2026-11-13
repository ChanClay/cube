---
name: shot-handoff
description: This skill should be used when writing or fixing the handoff between two adjacent shots in this project's storyboard (Script.shots) — deciding Shot.referencePrevFrame, writing an entryState that actually inherits the previous shot's last frame, and staging a close-up so the space stays readable. Trigger it when the user complains that a wide/航拍 shot cuts straight into a 车内 or 人物特写 and the interior/background is reinvented every shot, that 特写角度 is 无语, that 镜头接不上 or 画面漂移, or when asked about 末帧参考 / 接帧 / 跨镜连续 / 特写怎么拍 / 入口状态. Not for whole-script structuring (use cinematic-script), single-shot prompt polish, video file editing, or UI code.
---

# 镜头交接：让每一镜知道自己从哪来

相邻两镜之间的接缝，是成片「像不像电影」的唯一分水岭。核心事实只有一条：

> **上一镜的末帧不是「风格参考」，是本镜唯一免费的空间情报。特写之所以崩，不是因为特写难拍，而是因为特写被丢在一张没有环境的画布里，被迫凭空发明环境。**

内饰每镜一个样、特写角度离谱、车内细节不忍直视——全部是同一个病因：本镜没有继承上一镜的空间事实，只能靠模型的先验重新设计一台「看起来像车」的车。

## 一、先判档：末帧到底会不会被用上

`referencePrevFrame` 只表达「要不要用」，真正用法由 `lib/skills/shot-media.ts` 的 `prevFrameUsage` 决定，写作时必须先按这张表判档，再决定分镜序列：

| 情形 | 运行时结果 | 分镜怎么写 |
| --- | --- | --- |
| 第 1 镜 | 不适用 | 不写该字段 |
| `same-take` | 不看字段：同景别且上一镜未出画 → 末帧当首帧；景别不同或已出画 → 什么都不用 | 景别 / 机位必须与上一镜完全一致 |
| `hard-cut` + 同场景 + 景别跨度 0 | `first_frame`（本镜第一帧 = 上一镜最后一帧） | 留空即自动；写 `false` 会关掉，只在本镜必须重新打光时用 |
| `hard-cut` + 同场景 + 跨度 1，或 `hiddenCut: true` | `reference_image`（只借光线 / 材质 / 空间，构图按本镜重来） | 留空即自动；写 `true` 明确表达意图 |
| `hard-cut` + 同场景 + 跨度 ≥2 | `null` | **写 `true` 无效且校验报 fatal**，先改序列（见第二节） |
| 跨场景（手动开） | `reference_image` | 仅当确实要借同一光线基调时写 `true` |
| `time-jump` | `null` | 写 `false`，走角色卡 / 场景卡 |
| 上一镜 `exitState` 命中出画词（冲出画外 / 消失在雨幕…） | 跨度 0 也降级成 `reference_image` | 别用出画收尾，见第四节 |

**由此得到一个必须背下来的推论：大远景（档 0）→ 特写（档 5）跨度 5，末帧一定用不上。** 从航拍飙车直切车内人物特写，在本仓库是「零情报裸奔」：上一镜只给了一张俯视车顶的图，本镜却要重建整个座舱。看到这种序列，先改镜头，不要改字段。

## 二、跨大景别交接的三个合法解法（按优先级）

1. **垫一档（最稳，优先用）**
   航拍大远景 → 全景 / 中景（车与座舱同时可辨）→ 车内特写。
   跨度变成 0 → 2 → 1，第二跳落在 `reference_image` 上，特写能借到真实座舱的几何、光照与窗外世界，同时保住角色卡。
2. **`hiddenCut`（一镜到底换机位，观感最连贯）**
   无人机俯冲贴到车窗、穿过挡风玻璃、雨刷 / 甩镜 / 暗部盖住画面后进车内，写 `hiddenCut: true`。同场景下跨度随意（5 档也行）都降级成 `reference_image`，观众感知仍是同一次拍摄。这是「航拍直接进车内」唯一不失真的写法。
3. **硬直切（最后手段，靠场景内固定件自救）**
   必须跨 ≥2 档硬切时，末帧拿不到，本镜必须自己带满情报：座舱内饰固定短语 + 五要素 `entryState`（见第三、四节），并在提示词里点明容器与两个以上固定件。此时的一致性来源不是末帧，是卡片。

> 不要为了拿末帧而把 `same-take` 写给不同景别的两镜：`prevFrameUsage` 会直接判定不使用，`same-take` 的物理前提是摄影机没停机。

## 三、`entryState`：先复述事实，再写新动作

每个非首镜的 `entryState` 按固定四段写，缺一项就是一个连续性的洞：

1. **承接**：从上一镜末帧继承的可见事实——主体位置、姿态、朝向、手持物（不看上一镜的 `characterNames`，看它最后一帧真有什么）。
2. **空间**：本镜所在的容器几何，并点名 **两个以上固定件**（车厢：方向盘 / 仪表台 / 后视镜 / A 柱 / 车窗框 / 雨刷；走廊：门框 / 消防栓 / 地砖线）。
3. **机位**：镜头相对主体的方位 + 高度 + 距离感，**必须点名参照系**——在谁的哪一侧、朝哪个方向看、多高、多近（副驾侧 45°、与方向盘同高、半臂距离；追车镜写「两车车尾视角、低于车顶、两车都朝画面纵深开」）。这一项写糊，英文里的左右就必然是模型猜的。
4. **环境**：光源方向与色温 + 窗外 / 背景锚点 + 运动感（护栏与雨丝自左向右掠过）。

反例（等于让模型自由发挥）：

```
他握紧方向盘，神情紧绷。
```

正例（四段齐全，可直接英译）：

```
承接上一镜车头向右切入的瞬间：老陈仍在驾驶座，双手十点两点握方向盘，副驾空着；
黑色轿车座舱内，仪表台红灯亮着，前挡雨刷在画面下缘；机位在副驾侧、与方向盘同高、距他半臂；
车外是压低的铅灰天光，护栏与雨丝自左向右掠过后窗。
```

注意两点：

- **入口不是复述上一镜的景别**，而是把上一镜的事实搬到新机位上。
- **上一镜末帧里没有的人不许出现在本镜入口。** 运行时用 `lastFrameCast`（画面事实）而非 `characterNames`（分镜意图）去重末帧人物，本镜入口凭空多一个人，成片就会「多出一个乘客」。
- **反方向同样成立：末帧里有的一群人不许消失。** 群演没有主体卡，末帧参考只保证像素从哪来，保证不了人数被保留——所以人群必须写进 `backgroundCast`（`desc` + 逐字复用的 `promptEn`），同场景相邻镜头由定稿层继承上一镜，人群退场要显式写 `crowdCleared: true`。不写就等着「上一镜结尾一群人、下一镜只剩角色卡上那一个主角」。接帧（`first_frame`）镜也会点名末帧里的人物并锁人数，别把它当成「只接像素」。

### 3.1 机位段要相对上一镜写：取景与机位的串联

第三段（机位）不是「这一镜机位在哪」，而是「机位从上一镜怎么变过来」。只写「机位在侧面」等于让模型每镜重新摆一次摄影机，两镜各自成立、接起来就是一组摆拍图。

机位三要素，缺一不可：

1. **轴线侧**：人物 / 车头连线的哪一侧（副驾侧、轴线左侧、车的右后四分之一）。
2. **高度**：腰平 / 胸平 / 眼平 / 顶视 / 贴地。
3. **距离或焦段感**：半臂 / 一臂 / 三米，广角还是中长焦观感。

再补一句「相对上一镜怎么变」：沿轴线转了多少度、抬高还是压低、推进还是拉远。四条硬约束：

- **换机位至少 30°**。同景别 + 同运镜 + 同机位侧 = 跳帧，不是剪辑；切之前先问「这一刀观众能看出机位变了吗」。
- **同一段落停在同一轴线侧**。只有正反打换侧，且必须先过桥：垫一个中性机位（迎面 / 背面 / 空镜 / 手部特写），或让主体在画面内完成转向。机位换侧，画面方向一定跟着翻。
- **景别是阶梯**。一次最多跨 1 档；跨度 ≥2 必须先垫一档（大远景 → 全景 / 中景 → 特写），或用 `hiddenCut`。跨度 ≥2 时末帧一定用不上，只能靠卡片自救。
- **共用锚点、复用机位短语**。每个非首镜至少复用上一镜的一个空间参照（同一条路、同一盏灯、门框、挡风玻璃），并让它落在画框同一侧；同一段落的「镜头装在哪 / 朝哪 / 多高 / 多近」写成一句固定英文，跨镜逐字复用，只换主体与动作。

校验器对应四个码：`camera-position-missing`（entryState 没写机位段）、`same-take-camera-change`（没停机却换了运镜或轴线侧）、`framing-repeat`（同景别同运镜同侧，像跳帧）、`framing-jump`（景别跨 ≥2 档且没 hiddenCut）。

## 四、特写：五个必答问题，缺一个就是无场景空镜

特写不是「把环境删掉只拍脸」，是「用局部承载环境」。每写一个特写，先答完这五问：

1. **容器**：在哪里面（轿车座舱 / 驾驶舱 / 走廊 / 门框内）。
2. **机位**：方位角 + 高度 + 焦段。特写用中长焦（85~135mm 观感），不用广角；机位只在轴线一侧。
3. **固定件**：至少两个容器固定件入画。这是「细节不忍直视」的直接解药——固定件写死，内饰就不会每镜重造。
4. **光源**：主光从哪来（挡风玻璃外的天光 / 仪表灯 / 掠过的路灯），色温是冷是暖。
5. **介质与运动**：窗外的世界（速度感）+ 一个贯穿全镜的运动源（车震、雨刷、掠过的灯光）。特写不许静止。

**车内特写的三种合法角度**（其余角度默认不写）：

- 越肩 / 侧四分之三：副驾侧 45°，与主角同高，方向盘上缘与挡风玻璃入画。
- 纯镜面视角（POV）：画框就是后视镜玻璃，`the entire frame is the reflective glass of the rear-view mirror`，机位在镜面处朝车尾看，镜中后车同车道、正后方、车灯居中变大；不写侧窗、A 柱、门板。**不要**写成「机位在后视镜后方，同时拍到眼睛与镜中车灯」——那必然连带侧窗，后车会被拍成从侧面横过，追逐读成十字交叉。
- 人镜同框（确需）：镜面只占画面上三分之一（`the mirror glass occupies the upper third of frame`），镜外区域只允许顶棚与挡风玻璃上缘；做不到就拆成「纯镜面特写 + 车内人物特写」两镜。
- 正面略低平视：隔着仪表台，必须能看见方向盘上缘与挡风玻璃。

**禁止的角度**：穿过挡风玻璃正面平视（会造出没有内饰的假车）、90° 正侧广角切（脸变形、车厢消失）、大角度俯拍（人物变成玩具模型）、镜头贴脸且没有任何固定件。

**出画收尾的替代**：`exitState` 写「冲出画外 / 消失在雨幕 / 完全虚化」会让末帧变空，下一镜跨度 0 也被降级。改用「主体出画前一拍」收：车头咬住前车、轮胎压过水洼、手在方向盘上收紧，主体仍在画面内。

## 五、把交接写进 `videoPrompt`

固定词序不变（景别 + 主体 + 动作 + 环境 + 光线 + 运镜 + 质感），只把交接情报塞进「环境细节」位，并且：

- **容器短语全片逐字复用**：座舱内饰必须落成一段固定英文短语（写进场景卡 `promptEn` 或载具卡），每镜原样复用。内饰形容词越自由，内饰漂得越狠。
- **先给空间，再给动作**，模型才会先在正确的位置上搭景，再让人动。
- **两个以上主体的接缝先写机位锚**：镜头装在哪、朝哪、多高，再写谁在画面哪一侧、谁挡住谁。方位一律带参照系（`frame left` / `B-pillar` / `the black car's rear-left quarter panel`），裸写 `left` / `right` 时模型会各挑一个理解，接缝两侧的方向就翻车了。完整规则见 `cinematic-script` 的 `references/video-prompt.md` 第三节。

车内特写模板（45~70 词，按需删减）：

```
close-up, {character promptEn} seated in the driver's seat of {vehicle promptEn},
camera placed in the passenger seat at steering-wheel height,
his hands at ten and two on the wheel,
low dashboard with twin red instrument dials and wipers at the lower edge of frame,
rain streaks crossing the windshield, guardrail and grey daylight sliding past behind him,
{一个具体动作}, slow push-in, shallow depth of field,
constant subtle motion, no frozen frame
```

## 六、交付前的交接自检

1. 相邻两镜是否出现「**同场景 + `hard-cut` + 跨度 ≥2**」？有就改成垫一档或 `hiddenCut`，再写字段。
2. 每个非首镜的 `entryState` 是否四段齐全（承接 / 空间 + 固定件 / 机位 / 环境）？
3. 每个特写是否答完五问、至少两个固定件、明确光源、窗外或背景锚点？
4. 特写机位是否与上一镜在同一轴线侧？运动方向有没有翻转？
5. 上一镜 `exitState` 是否以出画收尾（会让末帧空掉）？
6. 本镜入口里的人，上一镜末帧里真的有吗？
7. 跑 `node lib/skills/cinematic-script/scripts/validate_script.mjs <script.json>`，把 `state-missing` / `exit-offscreen` / `direction-flip` / `cut-undeclared` 清到零。
8. 上一镜结尾的一群人有没有被缩成本镜主角一个人？同场景人群是否由 `backgroundCast` 继承，人群退场有没有显式写 `crowdCleared: true`？
9. 取景与机位是否成对设计：每镜的机位段有没有写轴线侧 / 高度 / 距离，并说清相对上一镜转了 30° 还是抬高了？相邻两镜是不是同景别 + 同运镜 + 同轴线侧（`framing-repeat`）？景别有没有一步跨 ≥2 档（`framing-jump`）？标了 `same-take` 的两镜运镜与轴线侧是否完全一致（`same-take-camera-change`）？

## 七、分工与唯一事实来源

- 整片结构（蓝图、主体卡、镜数、台词、风格）→ `cinematic-script` skill。
- 接缝（末帧档位、`entryState` 继承、特写空间、切点）→ 本 skill。
- 硬约束以代码为准，文档与代码冲突时改文档：`lib/skills/shot-media.ts`（`prevFrameUsage` / `prevFrameCast`）、`lib/skills/spec.ts`（`shotSizeGap` / `endsOffscreen` / `CUT_POINT_RULES` / `CONTINUITY_RULES` / `FRAMING_HANDOFF_RULES` / `mentionsCameraSetup` / `cameraAxisSide`）、`lib/agents/storyboard.ts`（`resolveReferenceFrames`）。

完整决策矩阵、车内 / 机舱 / 走廊三套交接配方与逐字段 JSON 示例见 `references/handoff-recipes.md`。
