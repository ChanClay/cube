# videoPrompt 写法

`videoPrompt` 是唯一送进视频模型（HappyHorse 1.1）的画面指令。它**不是创作**，是 `description` 的忠实英译。评审标准只有一句：中文写了什么，英文就得有什么；英文里多出来的东西都是风险。

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
{景别} of {主体 + 角色固定 promptEn}, {机位锚：镜头装在哪 / 朝哪 / 多高}, {空间布局：谁在画面哪一侧、谁挡住谁}, {一个具体动作}, {环境与陈设细节}, {光线方向与色温}, {一个运镜}, {材质/质感/颗粒}, {可选一句环境声}
```

硬性要求：

- 40~125 个单词（低于 30 或高于 170 会被审片判为不合格）。载具同框的镜头请用足上限：机位锚与部位级接触点比修饰词值钱。
- 一段话，用逗号连接，不分点、不重复同一信息。
- 只出现一个运镜、一个动作主体、一条匀速动作链。
- 结尾固定收口：`constant subtle motion, no frozen frame`。

### 画面必须在动

每一镜至少要有一个贯穿全镜的持续运动源，三选一或叠加：主体动（呼吸、眨眼、发丝与衣料被气流带动）、介质动（雨丝、尘粒、烟雾、水花、玻璃上的水痕）、相对动（背景横掠的车流与灯光、地面后退、光斑移动、车身振动）。

特写最容易踩：只写「眼神凝重」而没有任何运动源，成片就是主角静止坐着、镜头给个特写。特写要用局部写更大的动作——手在抖是因为车在颠、瞳孔在缩是因为后视镜里的车灯逼近、窗外景物横成一道线。收口词 `no frozen frame` 只是兜底，不能代替真正的运动源。

### 秒级节拍怎么进英文

`beatSheet` 是这一镜的动作骨架，它的每一段都要在英文里有对应，按时间顺序用并列的现在分词短语串成一条动作链：

| beatSheet | 英文片段 |
| --- | --- |
| 0~2s 抬眼看向塔顶 | `his eyes lifting toward the top of the tower` |
| 2~4s 伸手拧开灯罩 | `his hand rising to twist the lamp shade open` |
| 4~5s 火苗窜起 | `a small flame flaring up inside the glass` |

拼进模板后：

```
Close-up of an old lighthouse keeper ..., his eyes lifting toward the top of the tower, his hand rising to twist the lamp shade open, a small flame flaring up inside the glass, warm oil lamp light from below, slow push-in, shallow depth of field, 35mm film grain, constant subtle motion, no frozen frame
```

三条硬规则：

- **顺序不能改**：英文动作的出现顺序必须与秒级节拍一致，否则观众看到的是另一条动作线。
- **不许丢段**：3 段节拍至少要有 3 个动作短语。丢一段等于把这一镜的叙事砍掉一截，长镜头会退化成一段慢动作。
- **不许用时间副词**：`first` / `then` / `after that` / `finally` / `next` 会让模型把画面切成两段，接缝处就是抽帧般的抖动。用并列分词，让动作自己连起来。
- **每段都要有 `actionEn`**：8~14 个英文单词，与中文 `action` 一一对应。运行时会按 `from` / `to` 把它拼成 `0-2s: ...; 2-5s: ...` 的英文时间轴一并提交给视频模型；缺了它，这一段动作只剩英文提示词里那一句概括（审片报 `beat-en-missing`）。

节拍之间本来就不连贯（前一段在室内、后一段已经在街上）时，说明切点选错了：那是两个镜头，不是一镜的两段。

## 三、空间方位：先定坐标系，再写方向

「前 / 后 / 左 / 右」本身没有参照系。同一个 `left` 到了视频模型那里，至少有三种解法：画面左侧、车辆自己的左侧、左侧车道。模型不会追问「以谁为准」，它各自挑一个理解——这就是「写的是左后方超车、拍出来变成右前方对撞」的全部成因。

所以规则不是把方向词写得更花，而是**先把参照系写死，并且只允许存在三套**：

| 坐标系 | 参照系 | 合法写法 | 用来写什么 |
| --- | --- | --- | --- |
| 画面坐标系 | 画框 | `frame left` / `frame right` / `frame center` / `the left third of frame` / `foreground` / `background` | 主体落在哪里、朝哪一侧运动、占画多少 |
| 机位坐标系 | 镜头 | `toward the camera` / `away from the camera` / `crossing frame from left to right` | 迎面、远离、横穿 |
| 实体局部坐标系 | 物体自己 | `front-left fender corner` / `rear-right quarter panel` / `B-pillar` / `driver door` / `front bumper` / `rear axle` | 两车贴在哪里、撞在哪里、谁咬着谁 |

**裸写 `left` / `right` / `front` / `behind` 一律不合格。** 首次出现必须带限定（`frame left`、`the black car's left flank`、`the left-hand lane`），同一段第二次出现才可以省。

### 三级写法：机位锚 → 画面布局 → 接触点

画面里有两个以上主体（尤其载具）时，按这个顺序写，缺一级模型就只能自己猜位置：

1. **机位锚**（8~14 词，必须是第一句）：镜头装在哪、朝哪、多高、多近。这一句写完后，画面左即左、画面纵深即前进方向，后面所有方向词才有落点。
2. **画面布局**：谁在画面哪一侧、占画多少、谁挡住谁。
3. **接触点 / 相对位移**：用「实体 + 部位 + 相对 + 实体 + 部位」的三角关系，代替单给方向。

反例与改写（同一件事，两种写法）：

| 裸方向写法 | 问题 | 改写 |
| --- | --- | --- |
| `the red car overtakes the black car on the left` | `left` 无参照系，模型分不清画面左 / 黑车左侧 / 左侧车道 | `camera mounted low on the rear bumper of the black car, looking forward between both roofs`（机位锚）`the red car's nose at the black car's rear-left quarter panel`（接触点）`sliding out into the adjacent lane`（位移） |
| `a car chases another car, fast` | 没机位、没布局，两车位置全靠模型猜，`fast` 也拍不出来 | 机位锚 + 谁在画面哪侧 + 最近一次接触点，再写动作 |
| `he looks to the left` | 人物戏也踩同一个坑：看向哪一侧决定下一镜怎么接 | `he turns his head toward frame left, off-screen headlights approaching` |
| 中文写「车尾左后方」，英文写 `front right` | 方位错位，成片会直接撞错位置 | 中英共用一套参照系，逐项核对方向词 |

### 「前后」只许有一个含义

前进方向写 `ahead` / `behind along the road`，画面纵深写 `foreground` / `background`。混用就是「车明明在超车、拍出来像在倒车」的直接原因。

### 顺序不能倒

先空间、后动作。空间没写清就写动作，模型会先出一张两个主体各自摆放的图，再让它们动——接触点永远撞不上。反之，先给机位与布局，模型会先把两个主体摆在正确位置，再执行动作链。

### 镜面镜头：画框即镜面，两车同轴

写「后视镜特写」几乎必然踩到一个稳定的误读：`close-up of the rear-view mirror` 只说了「拍镜子」，没说「画框就是镜面」。模型于是把后视镜当成画面里的一个物体，为了给它一个合理的所在，补出车内视角、A 柱和一扇侧窗——后车就从侧窗外横着掠过去。结果就是本该 180° 同轴的蛇形追逐，被拍成 90° 的十字交叉。

镜面镜（后视镜 / 侧镜 / 监视器屏幕）按下面四句写，缺任何一句都会退回默认误读：

1. **镜面锚（第一句）**：`the entire frame is the reflective glass of the rear-view mirror, the mirror housing edges running just inside the frame borders`。画框与镜面焊死后，模型没有余量再放一扇侧窗。
2. **机位**：`camera positioned at the mirror, looking rearward`。镜面镜是 POV，不是「从车内往后视镜方向拍」。
3. **同轴关系**：`the pursuing car on the same lane centerline directly behind us, its headlights centered in the glass and growing larger, both vehicles on one vanishing line down the center of the glass`；接触点写 `its front bumper closing on our rear bumper`。
4. **镜像方向**：`mirrored left-right, the car approaching from our rear-left grows from frame right toward frame center`。不写这句，镜中左右会翻，动作方向会自相矛盾。

镜面镜里**禁止**出现 `side window` / `door window` / `A-pillar` / `door panel` / `door frame` / `dashboard`，也**禁止** `beside` / `alongside` / `next to` / `perpendicular` / `crossing`——这些词会把同轴追逐读成并排或交叉行驶。

正例：

```
Close-up, the entire frame is the reflective glass of the rear-view mirror, its black housing edges just inside the frame borders, camera positioned at the mirror looking rearward, the pursuing black coupe on the same lane centerline directly behind us, its headlights centered in the glass and growing larger, its front bumper closing on our rear bumper, both vehicles on one vanishing line down the center of the glass, mirrored left-right so the car approaching from our rear-left grows from frame right toward frame center, raindrops sliding across the glass, cold blue storm light, static shot, shallow depth of field, 35mm film grain, constant subtle motion, no frozen frame
```

反例与改法：

| 反例 | 问题 | 改法 |
| --- | --- | --- |
| `close-up of the rear-view mirror, a car chasing behind` | 没锁画框，模型补车内视角 + 侧窗，后车从侧面横过 | 先写镜面锚，再写同轴后车与镜像方向 |
| `through the side window, a car close behind` | 直接把机位写在侧窗上，空间基准变成侧面 | 侧窗镜不是后视镜镜：要么改成镜面镜，要么明确这是「侧窗外的并排车」，不要和追逐混用 |
| `the mirror shows a car beside us` | `beside` 把追逐读成并排 / 交叉 | 改 `on the same lane centerline directly behind` |
| 镜面占满画面，却又写「后视镜里映出他的眼睛」 | 人镜同框必须留出画面占比，否则模型会为了放脸而退出镜面 | 拆两镜，或写 `the mirror glass occupies the upper third of frame`，镜外只留顶棚与挡风玻璃上缘 |

### 追逐戏的相对位置只有一个写法

同向追逐的两辆车，相对位置只有一种合法描述：**同一条车道中心线、一前一后**（`on the same lane centerline, directly behind / ahead along the road`）。写 `beside` / `alongside` / `next to` / `side by side` 会让模型把后车摆到本车侧方，两车夹角从 180° 变成 90°——观众看到的就不再是追，而是两条路交叉。

## 四、正例

中文 description：

> 中景，白发守塔人站在铁旋梯上抬头看向塔顶，油灯暖光扫过他满是皱纹的脸，空气中浮尘可见，缓慢推近。

videoPrompt：

```
Medium shot of an old lighthouse keeper with grey hair and a weathered face standing on a spiral iron staircase, looking up toward the top of the tower, warm oil lamp light flickering across his deep wrinkles, dust particles floating in the air, cold blue ambient light from the storm outside, slow push-in, shallow depth of field, 35mm film grain, photorealistic, constant subtle motion, no frozen frame
```

为什么合格：景别与运镜对得上；主体用了角色固定短语；动作只有一个（抬头）；光有方向（油灯为暖主光、窗外冷光为辅）；没有中文没写的元素。

## 五、反例与改法

| 反例 | 问题 | 改法 |
| --- | --- | --- |
| `A beautiful sad scene of a man` | 形容词代替画面，无景别无动作 | 写清景别 + 主体 + 一个动作 |
| `he looks up, then immediately turns and runs to the door` | `then immediately` 这类时间副词会让模型把画面拆成两段 | 用并列分词串成一条链：`his eyes lifting, his body turning toward the door, breaking into a run` |
| `medium shot ... extreme wide shot` | 两镜的景别写进同一段 | 一镜只留一个景别 |
| `handheld push-in orbit` | 多个运镜 | 只留一个 |
| `... with subtitles and a logo` | 禁用内容 | 全部删掉 |
| `slow motion rain falling` | 非升格镜头出现 slow motion | 删掉，或用 `cameraMove=升格慢动作` |
| `a cyberpunk city, beautiful lighting` | 光线没方向、色温缺失 | 写 `neon signs from the left, magenta and cyan, wet reflective asphalt` |
| 中文只写了「他推门进来」，英文加了「雨衣滴水、身后有警车」 | 英文擅自增戏 | 删掉新增元素，或回中文补上并接受它成为画面事实 |
| `the red car overtakes the black car on the left` | `left` 裸用：画面左 / 黑车左侧 / 左侧车道三种解法 | 补机位锚 + 三角关系，见第三节 |
| `a car chases another car, fast` | 无机位锚、无布局，位置全靠模型猜 | 机位锚 → 画面布局 → 接触点，再写动作 |
| `two cars racing through the rain` | 没写谁在前谁在后、镜头在哪，模型会一次给两辆并排车 | 先写机位与相对部位，再写动作 |

## 六、中译英的逐项核对法

写完一段，按这五栏逐项打勾，任何一栏缺项就回去补：

1. **主体**：谁 / 什么（人、载具、道具），是否逐字复用了对应的 `promptEn`（不是缩写版）；本镜出现的每一辆车是否都写到了。
2. **动作**：只有一个，动词具体（抬眼 / 握住 / 松手 / 后退），不带并列句。
3. **道具与环境**：中文写到的陈设、材质、天气、地面反光是否都在。
4. **光线**：方向 + 色温 +（可选）光比，是否与场景卡一致。
5. **运镜与质感**：景别词、运镜词是否与中文字段一致；质感词（`35mm film grain`、`shallow depth of field`）是否与全片风格一致。
6. **空间**：有没有机位锚？每个 `left` / `right` / `front` / `behind` 是否都带了参照系（`frame ...`、实体名、`lane`）？两个以上主体时，谁在画面哪一侧、谁挡住谁、接触点在哪个部位，是否都不需要读者猜？

反向再查一遍：英文里有没有中文没写的名词、动词、人物？有就删。

## 七、模型行为备忘（HappyHorse 1.1）

- 首帧与参考图互斥（i2v / r2v 是两个模型）：把上一镜末帧当首帧，这一镜就传不了角色卡，长镜头里人脸会漂。所以首帧只用在同景别的接点上；景别一变就让末帧退回参考图，卡片照常传。
- 首帧是硬约束：生成出来的第一帧必须和那张图一致。景别跨了档还塞首帧，模型只会在开场硬拉一段推拉，成片像卡了一下。
- 一次生成越长，后半段动作越慢、肢体越容易糊；**10 秒是质量线，接口上限看剧本选的模型**（HappyHorse 15 秒 / wan3.0 30 秒）。
- HappyHorse 没有提示词扩写开关，景别与运镜全靠这个字段写准；wan3.0 可以开 `prompt_extend`，但默认关（会把景别与运镜改掉）。
- 多主体各做各的动作，模型会自动把画面拆成两段来塞。
- 台词过长不会被放慢，只会被吞掉后半句。
- 画面里出现文字类描述会诱发字幕/水印。

## 八、固定短语的复用纪律

- 角色 `promptEn` 20~35 词，覆盖「主体 + 年龄感/机型 + 头面 + 服装/装甲 + 装备 + 配色 + 道具」；机械体不写年龄与服装词。
- 载具 `promptEn` 20~35 词，覆盖「主体 + 车型体量 + 车漆与涂装 + 玻璃 + 轮毂轮胎 + 灯具 + 改装件 + 标识」；不写年龄与服装词。同一辆车全片只有一段短语。
- 场景 `promptEn` 15~25 词，覆盖「空间类型 + 关键陈设 + 光源与色调」。
- 每镜提示词里**原文粘贴**，不要为了句子通顺改词序、删形容词、换同义词。一致性优先于文笔。
- 一镜里出现两辆车时，两段 `promptEn` 都要写，并分别点明它们在画面里的位置与运动方向；只写一辆，另一辆就会被模型自由发挥。
