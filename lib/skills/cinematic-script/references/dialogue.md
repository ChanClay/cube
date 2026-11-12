# 对白：台词分析与一人一镜

分镜里最容易糊过去的两件事——台词没设计、两个人的话挤在一个镜头里。前者让成片变成配图朗诵，后者让音频系统只念一句、另一句凭空消失，或者两个人一起动嘴。

这份文档只解决这两件事。写完一场对话，回来过一遍本页的清单即可。

## 一、先诊断：三种最常见的台词病

| 症状 | 表现 | 根因 |
| --- | --- | --- |
| 念设定 | 「你是三十年前那个守塔人的儿子，这座塔归你了。」 | 用台词交代世界观 / 身份 / 前情，而这些本该由画面或场景给出 |
| 复述画面 | 画面里灯刚灭，人物说：「灯灭了。」 | 台词和画面在同一层，观众被喂了两遍 |
| 无阻力对白 | 你一句我一句，谁也没改变主意 | 双方都知道同一件事，没有信息差，台词只剩寒暄 |

三种病都指向同一个处方：**台词必须携带画面给不出的东西——目的、隐瞒、代价。**

## 二、台词分析四问

写每一句之前，四问全部要有答案；任何一个空着，这句就删掉。

| 问题 | 写进 JSON 的哪里 | 例（灯塔戏） |
| --- | --- | --- |
| 这句要达成什么 | 蓝图 `dialogue.intent` | 逼对方在风暴里做选择 |
| 为什么不能直说 | `dialogue.subtext` | 他不肯说「我需要你留下」，只说油不够了 |
| 对方听完怎么变 | `dialogue.effect` | 她把雨衣挂回钉子上（决定留下） |
| 说完画面变什么 | `beatSheet` 的最后一段 | 门被风撞上，两个人之间的距离缩短了一步 |

对应的台词只有一句：**「灯油只够烧到天亮。」**

- 不合格：`「我需要你留下来帮我，因为这盏灯很重要。」`（把 intent 直接念出来）
- 不合格：`「外面风很大，你衣服都湿了。」`（有画面，没有目的）
- 合格：`「灯油只够烧到天亮。」`（说的是油，要的是人）

再加三条硬约束：

1. **一句一个意思**，10~20 字；短句比长句有力，问句比陈述有戏。
2. **口语、可念、带停顿**：写完之后念一遍，念不顺的句子模型也念不顺。
3. **不写心里活动**：「他心想」「他看着远方，思绪万千」既拍不出也念不出，一律不进 `narration`。

## 三、从原文到分镜：先排话轮表

小说里一段对白，先拆成话轮，再一个话轮一个镜头。这一步做对，后面就不会出现「两个人抢一个镜头」。

| 话轮 | 谁 | 潜台词 | 听者反应 | 镜头 |
| --- | --- | --- | --- | --- |
| 1 | 老陈 | 试探她还会不会再走 | 小满手停了一下 | 老陈近景（带小满侧脸） |
| 2 | 小满 | 反问：你到底要不要我 | 老陈移开视线 | 反打小满近景（带老陈肩） |
| 3 | —（沉默） | 双方都在等对方先说 | 风声变大，灯芯抖了一下 | 反应镜头：两人之间的空处 + 灯的火焰 |
| 4 | 老陈 | 让步（用「楼上还有一桶」代替「你留下」） | 小满转身去拿桶 | 老陈中景（他背对镜头走向楼梯） |

规则：

- **一个话轮 = 一个镜头**。第 3 行的「沉默」也是一个镜头，而且往往是全场最贵的那一镜。
- **同一人物连续说几句**可以留在同一镜里，用 `beatSheet` 分出「说第一句 / 停顿 / 说第二句」；一旦换人开口，必须切。
- 话轮超过 4 个时，把中场的一次发言压进反应镜头（听者不说话，但画面在他身上），节奏才不会变成乒乓对切。

## 四、一人一镜：为什么是硬规则

`Shot.speaker` 只有一个值，运行时 `lib/skills/dialogue.ts` 会把它拼成「说话人 + 引号台词」提交给视频模型。一镜里塞两个人的对白，会有三种结局，没有一种是能用的：

1. 模型只念其中一句，另一句在成片里凭空消失；
2. 画面里两个人一起动嘴，口型全错；
3. 台词被拆成两段念，中间出现一个不属于这场戏的停顿。

所以：

- 一镜只有一个 `speaker`，`narration` 里也只能有这一个人说的话；
- 换人开口 = 换镜 = `hard-cut`；
- 校验命中 `multi-speaker` 的写法（以下都是错的）：

```
「老陈：撤。」「小满：不撤。」        ← 两行对白标签
「撤。」他说。「不撤。」她答。        ← 一问一答连写
「你先走，我断后。」「那你呢？」      ← 两组引号、两个人
```

### 正反打怎么写

| 要点 | 写法 |
| --- | --- |
| 视线匹配 | A 看 `frame right`，B 就看 `frame left`；两人不许同时看同一个方向 |
| 轴线 | 机位停在两人连线的同一侧；要越轴先在中间垫一个中性机位（空镜 / 手部特写 / 背影跟拍） |
| 30° 原则 | 换机位至少换 30°，不要同景别同构图对切 |
| 听者在场 | 说话人的镜头里必须有听者的一点存在：肩、后脑、耳、手。没有它就变成独白 |
| 景别与权力 | 占上风的一方给近景 + 低角度，让步的一方给中景 + 平视；不要把双方写成同景别同构图 |
| 切点说明 | 硬切写 `transitionReason`：「反打承接上一句的话尾」 |

单人的反打（clean single）与带肩的反打（over-the-shoulder）交替使用：连续三次 clean single 会让观众忘了两个人在同一个空间里。

### 反应镜头

关键台词之后，给听者一个独立的镜头：

- `narrationType: 'none'`，或只留一句 2~6 字的短句；
- 画面里必须有运动源（呼吸、手上的动作、风把头发吹开、灯焰抖动），否则就是一张静止的肖像；
- 这一镜承担情绪转折，常常是全片的情绪顶点——不要把它塞进说话人的镜头里当背景。

## 五、长度与节奏预算

| 单镜时长 | 一句台词的字数上限 | 说明 |
| --- | --- | --- |
| 3 秒 | 16 字 | 几乎没有停顿，只够一句短问 |
| 5 秒 | 20 字 | 标准对白镜 |
| 10 秒 | 40 字 | 已经需要 `beatSheet` 分段（说半句 / 停顿 / 说完） |
| 20 秒+ | 60 字（封顶） | 长镜口播的极限，再长只会被吞掉后半句 |

硬上限由 `narrationLimit(duration) = min(60, max(16, duration × 4))` 决定，超出会被截断到最近的句读处。

节奏：

- 对白戏的镜头长度要变化：逼问用 2~4 秒短镜，摊牌用 6~10 秒长镜；
- 连续 3 镜同景别 + 同机位 = 观众开始走神，第 4 镜必须换个机位或插一个反应 / 空镜；
- 一场戏里至少留一次「谁都不说话」的间隙。

## 六、旁白：该用就用，别拿它当补丁

把旁白当成「解释画面」的工具是病，但把它当成禁区同样是病。一场戏如果一开口就要人物自己交代「我是谁、我们在哪、为什么要打」，那是剧本没写完，不是台词的问题。

### 三个正当用途

| 用途 | 写法 | 例 |
| --- | --- | --- |
| 开场交代前情 | 空镜铺景 + 一句旁白，讲清谁 / 在哪 / 为什么打；背景说完，下一镜直接进人物台词 | 帐外空镜：「董卓乱政，十八路诸侯会于酸枣。」下一镜袁术开口 |
| 跨时空转场 | 「三日后」「另一路诸侯到了」，然后直接接新场景 | 「汜水关前，华雄已连斩三将。」 |
| 收尾点题 | 一句克制的旁白收住情绪，不要总结全片 | 「那杯酒，始终是温的。」 |

开场那一条最容易被忽略：**先给背景，再给戏**。背景用旁白一句交代完，人物的第一句台词才不必自我解释，可以直接进入目的与潜台词——这正是「第一个空镜用旁白，第二个镜头直接袁术说话」比「让袁术在台词里说明会盟缘由」好的原因。

### 旁白写事，不写景

- **给画面给不出的信息**：身份、时间跨度、因果、数量、结局（「十八路」「三日后」「只剩半桶油」）；
- **不许重述画面**：画面里已经抬头、流泪、刀落，旁白就不要再念一遍；
- **不许替人物表达内心**：「他心里很难过」既拍不出也念不出；
- **一镜最多一句**，全片旁白句数不超过镜头数的一半——旁白一密，戏就变成配图朗诵。

写旁白时可以直接对着这一镜的 `description` 反查：旁白里有没有和描述重复的词？有就改。

### 与对白的分工

- 信息型内容（前情、时间、数量）→ 旁白，放在没有人物开口的镜头上；
- 关系型内容（目的、潜台词、让步与反击）→ 对白，放在人物开口的镜头上；
- 同一件事不要两边都说：旁白交代过的背景，台词里不许再解释一遍。

旁白不需要 `speaker`，`narrationType` 写 `voiceover`，画面里的人物闭嘴；把人物台词写成 `voiceover` 会丢掉口型，把旁白写成 `dialogue` 会让模型给一个不该开口的人配上表情与口型。

## 七、声音

- 台词必须写进提示词才会被念出来：`buildVideoPrompt` 会把 `speaker` 与台词拼成一个「说话人开口 + 引号台词」的句子；
- HappyHorse 没有 `audio` 开关，也不接受参考音频，音色只能靠文字描述维持：同一人物的称呼、语气词、句长习惯要在全片保持一致；
- 环境声写在 `videoPrompt` 末尾一句（`heavy rain and distant thunder`），不要单独写一大段。

## 八、示例：一段对白 → 三个镜头

原文：

> 「灯油还够吗？」她问。他没抬头：「够烧到天亮。」她看着他手里的灯，没再说话。

分镜（节选，只保留对白相关字段）：

```json
[
  {
    "title": "她问灯油",
    "duration": 5,
    "shotSize": "近景",
    "cameraMove": "缓慢推近",
    "transition": "hard-cut",
    "transitionReason": "反打承接问句的话尾，B 抬眼之前的那次呼吸",
    "entryState": "小满站在旋梯下方，湿发贴着脸，画面右侧是老陈的肩与后脑；油灯在画面左侧偏下；主光来自灯焰，暖调偏低",
    "exitState": "小满问完，嘴唇还留着开口的形状，视线移向画面左下那盏灯；画面右侧老陈的肩没有动；灯焰被穿堂风吹得偏向一边",
    "beatSheet": [
      { "from": 0, "to": 2, "action": "小满抬眼看向老陈", "actionEn": "Xiaoman lifting her eyes toward the old man" },
      { "from": 2, "to": 5, "action": "她开口问灯油，声音压得低", "actionEn": "she asking about the lamp oil in a low voice" }
    ],
    "description": "近景，小满站在旋梯下方问灯油够不够，画面右侧是老陈的肩，油灯的光从下往上打在她湿漉漉的脸上",
    "videoPrompt": "medium close-up of Xiaoman, a young fisherwoman with wet black hair sticking to her cheeks, standing below a spiral iron staircase, the shoulder and back of the old keeper's head in the right of frame, an oil lamp at the lower left, she lifts her eyes and asks about the lamp oil in a low voice, warm flickering lamplight from below, dust drifting in the air, slow push-in, 50mm lens, 35mm film grain, constant subtle motion, no frozen frame",
    "narration": "灯油还够烧到天亮吗？",
    "narrationType": "dialogue",
    "speaker": "小满",
    "characters": ["小满", "老陈"],
    "scenes": ["灯塔内部"]
  },
  {
    "title": "他没抬头",
    "duration": 5,
    "shotSize": "近景",
    "cameraMove": "固定机位",
    "transition": "hard-cut",
    "transitionReason": "反打回老陈，承接同一个问句的应答",
    "entryState": "老陈侧对镜头坐在灯下，手上正把灯芯剪短，画面左下是小满的手背；油灯在两人之间；主光是灯焰的暖调，背景是冷蓝的窗",
    "exitState": "他剪完灯芯，手指停在半空，视线仍落在灯上，没有看小满；画面左下她的手背收紧了一下；灯焰恢复稳定",
    "beatSheet": [
      { "from": 0, "to": 2.5, "action": "剪刀剪断烧黑的灯芯", "actionEn": "the scissors trimming the blackened wick" },
      { "from": 2.5, "to": 5, "action": "他答了一句，眼睛始终没离开灯", "actionEn": "he answering without lifting his eyes from the flame" }
    ],
    "description": "近景，老陈侧对镜头剪灯芯，答话时眼睛没离开火焰，画面左下露出小满的手背",
    "videoPrompt": "medium close-up of the old lighthouse keeper in profile, grey hair and weathered face lit from below by the oil lamp, his hands trimming the blackened wick with small scissors, the back of Xiaoman's hand at the lower left of frame, he answers without lifting his eyes from the flame, warm lamp glow against a cold blue window in the background, static shot, 50mm lens, 35mm film grain, constant subtle motion, no frozen frame",
    "narration": "够烧到天亮。",
    "narrationType": "dialogue",
    "speaker": "老陈",
    "characters": ["老陈", "小满"],
    "scenes": ["灯塔内部"]
  },
  {
    "title": "她没再问",
    "duration": 4,
    "shotSize": "中景",
    "cameraMove": "缓慢拉远",
    "transition": "hard-cut",
    "transitionReason": "切到两人之间的空处，把沉默交给画面",
    "entryState": "两人一坐一站分居画面两侧，油灯在他们中间偏下；灯焰稳定；背景窗上是斜落的雨痕",
    "exitState": "小满把湿雨衣挂回门钉，转身走向楼梯；老陈仍在画面右侧低头看灯；两人距离拉开，灯焰在画面中央",
    "beatSheet": [
      { "from": 0, "to": 2, "action": "她看了他一眼，什么也没说", "actionEn": "she glancing at him without a word" },
      { "from": 2, "to": 4, "action": "她把雨衣挂回门钉，转身走向楼梯", "actionEn": "she hanging her wet coat back on the nail and turning toward the stairs" }
    ],
    "description": "中景，小满站在灯旁看了老陈一眼没再问，随后把湿雨衣挂回门钉转身走向楼梯，镜头缓慢拉远，两人之间只剩一盏灯",
    "videoPrompt": "medium shot of a cramped stone lighthouse interior at night, Xiaoman standing beside the oil lamp glancing at the old keeper without a word, then hanging her wet coat back on the iron nail and turning toward the spiral stairs, the old man still bent over the lamp in the right of frame, rain streaking the small window, warm lamp glow against cold blue night, slow pull-out, 35mm lens, film grain, constant subtle motion, no frozen frame",
    "narration": "",
    "narrationType": "none",
    "characters": ["小满", "老陈"],
    "scenes": ["灯塔内部"]
  }
]
```

三个镜头里：一处问、一处答、一处沉默。每一镜只有一个 `speaker`，反打守在同一轴线（小满看画右、老陈朝画左），第三次不开口，答案交给画面。

## 九、病历表

| 症状 | 真正原因 | 处方 |
| --- | --- | --- |
| 台词像说明书，人物在念旁白 | 没做四问，直接写「想说的话」 | 每句先答目的 / 潜台词 / 变化 / 画面，答不上就删 |
| 两个人抢一个镜头 | 把整段对白压进 `narration` | 一话轮一镜，反打 `hard-cut`，每镜只留一个 `speaker` |
| 只有一个人在动嘴，另一个人在说话 | 一镜写了两人对白，模型只念一句 | 同上；校验报 `multi-speaker` |
| 对白戏像乒乓对切 | 每句都切、同景别同机位 | 缩短话轮数，插反应 / 空镜，景别跟权力关系走 |
| 台词被吞掉后半句 | 字数超过 `duration × 4` | 删到一句一意，或加长这一镜 |
| 情绪最高点是人物在说话 | 把高潮写成台词镜 | 高潮给反应镜头：不开口，只有手上的动作和环境 |
| 全程旁白解说 | 用 `voiceover` 代替画面与对白 | 旁白只留时间跨度与画面拍不到的信息 |
