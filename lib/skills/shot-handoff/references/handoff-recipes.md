# 镜头交接配方

配套 `SKILL.md`。这里只放「具体怎么写」：末帧能读出什么、三套场景的完整配方、可直接改的 JSON 片段、症状对照表。

## 一、末帧情报清单（写 `entryState` 时逐项过一遍）

看上一镜 `exitState` 与画面描述，提取这八类事实，能提取到的都要在下一镜入口里体现：

| 类别 | 具体内容 | 漏掉的后果 |
| --- | --- | --- |
| 主体 | 位置（画面左 / 中 / 右、占比）、姿态、朝向 | 下一镜凭空换位 |
| 手部 | 手在哪、拿着什么 | 方向盘 / 道具凭空出现或消失 |
| 载具 | 车型、车漆、损坏、灯光状态 | 换了一辆车 |
| 容器 | 车厢 / 机舱 / 走廊的可见几何、固定件 | 内饰每镜重造 |
| 光源 | 主光方向、色温、有无仪表灯 / 路灯掠过 | 一镜日戏一镜夜戏 |
| 窗外 | 背景锚点（护栏、隧道口、同一盏路灯） | 从一条路跳到另一条路 |
| 速度 | 运动方向、速度档、画面里怎么体现 | 特写变静止摆拍 |
| 人物 | 真正在场的人（`lastFrameCast` 优先） | 多出乘客、少掉同伴 |

这八类里「容器」和「光源」是特写最容易丢、也最致命的两个：丢了就等于换了一台车、换了一个时间。

## 二、配方 A：航拍追车 → 车内特写

### 解法 1（推荐）：垫一档

三镜序列，跨度 0 → 2 → 1：

```json
[
  {
    "title": "航拍追车",
    "shotSize": "大远景",
    "cameraMove": "跟随",
    "transition": "hard-cut",
    "referencePrevFrame": false,
    "exitState": "黑色轿车在双车道公路中段偏右，车头咬住前方货车的尾灯，护栏与雨丝自左向右掠过，镜头仍在车顶上方二十米跟随。"
  },
  {
    "title": "贴着车顶压下来",
    "shotSize": "中景",
    "cameraMove": "跟随",
    "transition": "hard-cut",
    "hiddenCut": true,
    "referencePrevFrame": true,
    "entryState": "承接俯冲：黑色轿车仍在画面中央偏右，车顶与后窗占据画面下半；机位降到车后三米、与车顶齐平；铅灰天光从画面左上压下，护栏在右侧拉成流线。",
    "description": "中景，镜头贴着黑色轿车车顶跟随下降，后窗里能看见驾驶座头枕与仪表台微光，护栏与雨丝向右拉成流线。",
    "videoPrompt": "medium shot, following a matte-black sedan from just above its roof, the rear window showing the headrest and a faint dashboard glow inside, guardrails and rain streaks smearing to the right, low grey daylight pressing from the upper left, the camera descending with the car, constant subtle motion, no frozen frame"
  },
  {
    "title": "驾驶座特写",
    "shotSize": "特写",
    "cameraMove": "缓慢推近",
    "transition": "hard-cut",
    "referencePrevFrame": true,
    "entryState": "承接上一镜后窗内可见的头枕与仪表微光：老陈在驾驶座，双手十点两点握方向盘，指节发白；副驾座空着；仪表台红灯亮，雨刷在画面下缘；机位在副驾侧 45°、与方向盘同高、半臂距离；车外铅灰天光，护栏与雨丝自左向右掠过后窗。",
    "description": "特写，老陈在驾驶座双手握方向盘，仪表台红灯与雨刷在画面下缘，窗外护栏与雨丝自左向右掠过，镜头缓慢推近。",
    "videoPrompt": "close-up, a weathered man in his forties in a dark jacket seated in the driver's seat of a matte-black sedan, his hands at ten and two on the wheel with white knuckles, low dashboard with twin red instrument dials and wipers at the lower edge of frame, guardrails and rain streaks sliding left to right behind the rear window, slow push-in, shallow depth of field, constant subtle motion, no frozen frame"
  }
]
```

第二镜写 `hiddenCut: true`：镜头贴着车顶压下来、后窗逐渐占满画面，观众感知是同一次拍摄，所以第三镜哪怕跨度 1 也稳稳拿到 `reference_image`；第三镜的入口把「后窗里的头枕与仪表微光」明确继承下来，座舱几何就不再是模型编的。

### 解法 2：一镜到底穿过车窗

只在同一个镜头里完成，`hiddenCut` 用不上（同一镜没有接缝），靠 `beatSheet` 三段推进：

```
0~3s 航拍贴近车顶，后窗占满画面
3~6s 镜头穿过玻璃虚焦，雨刷扫过
6~9s 车内：驾驶座双手握方向盘，仪表灯亮
```

这样特写的座舱是「刚才那辆车」的一部分，不是新造的。

### 解法 3：必须直切时

`大远景 → 特写` 跨度 5，末帧一定不生效（写 `true` 还会被校验判 fatal）。此时：

- 把座舱内饰写成固定英文短语，与载具卡一起写死，每镜逐字复用；
- 本镜 `entryState` 四段齐全；
- 提示词里点明「副驾侧机位 + 方向盘 + 仪表台 + 后视镜」四个固定件。

## 三、配方 B：机舱 / 驾驶舱特写

与车内同构，只换固定件与介质：

- 固定件：HUD 反光、操纵杆、头顶开关阵列、舷窗框、安全带压肩。
- 光源：仪表冷蓝 + 舱外云层白光，二者色温必须写清方向。
- 介质：云层 / 地面灯光在舷窗上缓慢横移，代替车窗雨丝。
- 合法角度：越肩、舷窗侧逆光、正面略低（能看见操纵杆与 HUD）。
- 禁止：正面平视把座舱拍成一张纯背景图（没有固定件，模型会造一个通用驾驶舱）。

## 四、配方 C：走廊 / 门框交接

- 遮挡物就是天然的 `hiddenCut`：人物走过柱子、门框刮过画面、灯管频闪到暗。
- 固定件：门框线、踢脚线、消防栓、地砖缝隙、顶灯间距。
- 机位：贴一侧墙、与胸同高、长焦压缩走廊纵深。
- 跨度可以大（全景 → 特写），因为遮挡点本身就在变，观众接受「换机位」。

## 五、出画收尾的替代写法

| 不要写 | 改成 |
| --- | --- |
| 冲出画外 | 车头咬住前车尾灯，主体仍在画面右三分之一 |
| 消失在雨幕 | 雨幕压到车身中段，尾灯仍是一团红光 |
| 完全虚化 | 焦点从后视镜滑回眼睛，脸颊占满画面 |
| 跑出画面 | 一只脚刚踏上门槛，脚踝仍在画面下缘 |

判据只有一个：**最后一帧里还有可辨认的主体或锚点**。空画面会让末帧失去情报价值，也让下一镜失去入口。

## 六、症状对照表

| 症状 | 病因 | 修法 |
| --- | --- | --- |
| 车内内饰每镜一个样 | 没有座舱固定短语；末帧没生效 | 写死内饰短语 + 垫一档拿 `reference_image` |
| 特写角度乱、脸变形 | 未限机位与焦段，广角近贴 | 三合法角度 + 中长焦 + 保持轴线一侧 |
| 大景别切特写后像换了世界 | 跨度 ≥2，末帧被忽略 | 垫一档或 `hiddenCut` |
| 特写里看不出车在动 | 只写神情，无运动源 | 车震 / 雨刷 / 窗外横掠 + 一个贯穿动作 |
| 下一镜多出一个乘客 | 入口照抄 `characterNames`，未看末帧实况 | 按 `lastFrameCast` 与末帧事实写入口 |
| 同一场景一镜日光一镜霓虹 | 入口未继承光源方向与色温 | `entryState` 第四段必须写光源 |
| 剪辑点像推拉镜头 | 跨景别还指望末帧当首帧 | 改成 `reference_image` 用法（留空即可），或垫一档 |
