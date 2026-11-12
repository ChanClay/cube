# videoPrompt 写法

`videoPrompt` 是唯一送进文生视频模型（wan3.0）的画面指令。它**不是创作**，是 `description` 的忠实英译。评审标准只有一句：中文写了什么，英文就得有什么；英文里多出来的东西都是风险。

## 一、词库：只用项目里的标准写法

景别（`shotSize` → 英文）：

| 中文 | 英文 |
| --- | --- |
| 大远景 | extreme wide shot |
| 远景 | wide shot |
| 全景 | full shot |
| 中景 | medium shot |
| 近景 | medium close-up |
| 特写 | close-up |

运镜（`cameraMove` → 英文首选取法）：

| 中文 | 英文 |
| --- | --- |
| 固定机位 | static shot |
| 缓慢推近 | slow push-in |
| 缓慢拉远 | slow pull-out |
| 横向移动 | lateral tracking shot |
| 环绕 | orbit shot |
| 跟随 | tracking shot |
| 手持晃动 | handheld camera |
| 升格慢动作 | slow motion |

校验器对运镜接受同义写法（`static camera`、`slow dolly in`、`orbiting camera` 等），但生成时只写首选，避免自己给自己制造不一致。

## 二、模板

```
{景别} of {主体 + 角色固定 promptEn}, {一个具体动作}, {环境与陈设细节}, {光线方向与色温}, {一个运镜}, {材质/质感/颗粒}, {可选一句环境声}
```

硬性要求：

- 40~110 个单词（低于 30 或高于 150 会被审片判为不合格）。
- 一段话，用逗号连接，不分点、不重复同一信息。
- 只出现一个运镜、一个动作主体、一条匀速动作链。
- 结尾固定收口：`smooth continuous motion, steady pacing, stable framing`。

## 三、正例

中文 description：

> 中景，白发守塔人站在铁旋梯上抬头看向塔顶，油灯暖光扫过他满是皱纹的脸，空气中浮尘可见，缓慢推近。

videoPrompt：

```
Medium shot of an old lighthouse keeper with grey hair and a weathered face standing on a spiral iron staircase, looking up toward the top of the tower, warm oil lamp light flickering across his deep wrinkles, dust particles floating in the air, cold blue ambient light from the storm outside, slow push-in, shallow depth of field, 35mm film grain, photorealistic, smooth continuous motion, steady pacing, stable framing
```

为什么合格：景别与运镜对得上；主体用了角色固定短语；动作只有一个（抬头）；光有方向（油灯为暖主光、窗外冷光为辅）；没有中文没写的元素。

## 四、反例与改法

| 反例 | 问题 | 改法 |
| --- | --- | --- |
| `A beautiful sad scene of a man` | 形容词代替画面，无景别无动作 | 写清景别 + 主体 + 一个动作 |
| `he looks up, then immediately turns and runs to the door` | 一镜两个动作，模型会把画面拆成两段 | 只留「抬头」，下一个动作开新镜 |
| `medium shot ... extreme wide shot` | 两镜的景别写进同一段 | 一镜只留一个景别 |
| `handheld push-in orbit` | 多个运镜 | 只留一个 |
| `... with subtitles and a logo` | 禁用内容 | 全部删掉 |
| `slow motion rain falling` | 非升格镜头出现 slow motion | 删掉，或用 `cameraMove=升格慢动作` |
| `a cyberpunk city, beautiful lighting` | 光线没方向、色温缺失 | 写 `neon signs from the left, magenta and cyan, wet reflective asphalt` |
| 中文只写了「他推门进来」，英文加了「雨衣滴水、身后有警车」 | 英文擅自增戏 | 删掉新增元素，或回中文补上并接受它成为画面事实 |

## 五、中译英的逐项核对法

写完一段，按这五栏逐项打勾，任何一栏缺项就回去补：

1. **主体**：谁 / 什么，是否逐字复用了角色 `promptEn`（不是缩写版）。
2. **动作**：只有一个，动词具体（抬眼 / 握住 / 松手 / 后退），不带并列句。
3. **道具与环境**：中文写到的陈设、材质、天气、地面反光是否都在。
4. **光线**：方向 + 色温 +（可选）光比，是否与场景卡一致。
5. **运镜与质感**：景别词、运镜词是否与中文字段一致；质感词（`35mm film grain`、`shallow depth of field`）是否与全片风格一致。

反向再查一遍：英文里有没有中文没写的名词、动词、人物？有就删。

## 六、模型行为备忘（wan3.0）

- 首帧 / 尾帧与 `reference_*` 互斥：把上一镜末帧当首帧，这一镜就传不了角色卡，长镜头里人脸会漂。所以首帧只用在同景别的接点上；景别一变就让末帧退回参考图，卡片照常传。
- 首帧是硬约束：生成出来的第一帧必须和那张图一致。景别跨了档还塞首帧，模型只会在开场硬拉一段推拉，成片像卡了一下。
- 一次生成越长，后半段动作越慢、肢体越容易糊；**10 秒是质量线，30 秒只是接口上限**。
- 提示词扩写（服务端二次改写）会换掉景别与运镜，人物和镜头语言都会漂，默认关闭；只有提示词极短时才考虑开启。
- 多主体各做各的动作，模型会自动把画面拆成两段来塞。
- 台词过长不会被放慢，只会被吞掉后半句。
- 画面里出现文字类描述会诱发字幕/水印。

## 七、固定短语的复用纪律

- 角色 `promptEn` 20~35 词，覆盖「主体 + 年龄感/机型 + 头面 + 服装/装甲 + 装备 + 配色 + 道具」；机械体不写年龄与服装词。
- 场景 `promptEn` 15~25 词，覆盖「空间类型 + 关键陈设 + 光源与色调」。
- 每镜提示词里**原文粘贴**，不要为了句子通顺改词序、删形容词、换同义词。一致性优先于文笔。
