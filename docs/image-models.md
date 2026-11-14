# 文生图模型

角色卡 / 场景卡配图由 `IMAGE_PROVIDER` 决定走哪家，默认百炼万相（`wan2.6-t2i`）。上层统一调用 `lib/providers/image/index.ts` 的 `generateImage`，协议差异被封装在两个 provider 里。

| provider | 平台 | 默认模型 | 说明 |
| --- | --- | --- | --- |
| `wan`（默认） | 阿里云百炼 | `wan2.6-t2i` | 原行为，复用视频的百炼 Key / 地址 |
| `seedream` | 火山方舟 | `doubao-seedream-5-5-261028` | 与 Seedance 同平台，Key 默认复用 `VIDEO_SEEDANCE_API_KEY` / `ARK_API_KEY` |

视频用 Seedance 时，换成 Seedream 出卡片图通常更贴：同厂模型的训练分布与参考图编码更接近，图生视频时画风、肤质、光比更稳。这属于经验判断，建议先拿同一份提示词 A/B 对比再长期切换。

请求里除了中文的「名称：外形描述」，还会带上蓝图锁定的 `promptEn`（固定英文外貌 / 空间短语），保证卡片和逐镜视频里长得一样。

描述命中机甲 / 义体 / 装甲 / 全息等科技词时，`lib/skills/image-prompt.ts` 会自动追加一层「科技细节」（分件、接缝、发光线条、金属反射、磨损），否则文生图对「科技角色」的默认输出是光滑的塑料块。

接口返回的图片地址只保留 24 小时，服务端会立刻下载并转存到 `.data/uploads/`，前端拿到的是站内永久地址。

## 协议差异

### 万相（`lib/providers/image/wan-image.ts`）

| 模型 | 协议 |
| --- | --- |
| `wan2.6` 及以上（含 `wan2.7-image`） | 多模态同步协议 |
| `wan2.5` 及以下 | 自动切换成异步轮询 |

尺寸是百炼写法：角色竖图 `1104*1472`，场景 / 载具横图 `1696*960`。

### Seedream（`lib/providers/image/seedream.ts`）

同步接口 `POST {base}/images/generations`（方舟协议），尺寸写 `1024x1536` 这类小写 `x` 格式，由 `toSeedreamSize` 按卡片长宽比映射：

| 卡片比例 | Seedream 4.x / 5.x | Seedream 3.x（只支持固定档位） |
| --- | --- | --- |
| 竖图（角色） | `1024x1536` | `864x1152` |
| 横图（场景 / 载具） | `1536x1024` | `1280x720` |
| 方图 | `1024x1024` | `1024x1024` |

模型名含 `seedream-3` 时按 3.x 的固定尺寸档位走，其余（含方舟 Endpoint ID `ep-…`）按 4.x / 5.x 处理。5.5 支持到 2K / 4K，卡片图按 1.5 ~ 1.6 MP 出图已经够做视频参考图；想要更高分辨率时改 `seedream.ts` 的 `SIZES_NEW` 即可。

**不支持 `negative_prompt`**：负向约束只能写进正向提示词，`buildCardPrompt` 的结尾已经带了「不要画面文字 / 水印 / 畸形肢体」，所以这里不再重复拼接。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `IMAGE_PROVIDER` | `wan` | `wan` / `seedream`；填错按 `wan` 处理 |
| `IMAGE_API_KEY` | 复用 `VIDEO_API_KEY` | 万相 API Key（百炼） |
| `IMAGE_BASE_URL` | 复用 `VIDEO_BASE_URL` | 万相接口地址 |
| `IMAGE_MODEL` | `wan2.6-t2i` | `wan2.6` 及以上走多模态同步协议；`wan2.5` 及以下自动切换成异步轮询 |
| `IMAGE_SEEDREAM_API_KEY` | 复用 `VIDEO_SEEDANCE_API_KEY` → `ARK_API_KEY` | Seedream API Key（方舟） |
| `IMAGE_SEEDREAM_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | 方舟接口地址 |
| `IMAGE_SEEDREAM_MODEL` | `doubao-seedream-5-5-261028` | 3.x 只支持固定尺寸档位；4.x / 5.x 支持任意像素 |

切换 provider 后不需要改前端与 `/api/image` 的任何代码，重启服务即可生效。
