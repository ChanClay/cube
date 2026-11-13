# 生成链路

从「创意 / 小说」到「成片」的完整链路图。分镜生成见 `lib/agents/storyboard.ts:1331 generateScript`，单镜出视频见 `lib/services/video-service.ts`，提示词拼装在 `lib/skills/dialogue.ts:171 buildVideoPrompt`。

## 总链路

```mermaid
flowchart TD
    A["创意 / 小说原文"] --> B["POST /api/script"]
    B --> C["generateScript() · storyboard.ts:1331"]
    C --> C1["① 蓝图<br/>adaptStory 小说 / planStory 创意"]
    C1 --> C2["② 分镜 requestStoryboard<br/>normalizeScript → finalizeScript"]
    C2 --> C3["③ 翻译 localizeScriptPrompts<br/>中文描述 → 英文 videoPrompt"]
    C3 --> C4["④ 审片 reviewAndRepair<br/>再 finalize + auditScript"]
    C4 --> D[("MySQL<br/>scripts.content = 整份 Script JSON")]
    D --> E["剧本页 /projects/[id]<br/>ScriptView + ShotCard"]
    E --> F["buildVideoPrompt() · dialogue.ts:171"]
    F --> G["POST /api/video<br/>startVideoJob"]
    G --> H{"按 shot.videoModel<br/>路由 provider"}
    H --> H1["wan3.0<br/>百炼 video-synthesis"]
    H --> H2["happyhorse-1.1<br/>百炼 t2v / i2v / r2v"]
    H --> H3["seedance-2.5<br/>方舟 generations/tasks"]
    H1 --> I[("video_jobs 表")]
    H2 --> I
    H3 --> I
    I --> J["前端轮询 GET /api/video/[id]<br/>5s 一次"]
    J --> K["成功即转存<br/>.data/videos/{uuid}.mp4"]
    K --> L["POST /api/compose<br/>ffmpeg 拼接 → .data/exports"]
```

## 单镜出视频时序

```mermaid
sequenceDiagram
    autonumber
    participant U as 前端
    participant API as /api/video
    participant SVC as video-service
    participant LOCK as withSubmitLock
    participant P as Provider
    participant DB as video_jobs
    participant FS as .data/videos

    U->>API: POST shotId + prompt + media[]
    API->>DB: findActiveJob 查 2h 内活跃任务
    alt 已有活跃任务
        DB-->>U: 直接返回该 job（幂等）
    else 无
        API->>LOCK: 进程内串行锁
        API->>SVC: startVideoJob
        SVC->>SVC: 时长按模型区间 clamp<br/>素材决策 resolveShotMedia
        SVC->>P: 创建异步任务
        P-->>SVC: provider_job_id
        SVC->>DB: 写 status / prompt / media_json
        API-->>U: job
    end

    loop 每 5s 轮询
        U->>API: GET /api/video/[id]
        API->>P: GET tasks/{id}
        P-->>API: status / progress / video_url
        alt 返回 video_url
            API->>FS: 下载转存 mp4
            API->>DB: 更新本地 url
        end
        API-->>U: job 最新状态
    end
```

## 提示词最终拼装顺序

顺序由 `buildVideoPrompt` 固定，旧剧本缺字段时对应片段整段不出现。

```mermaid
flowchart LR
    A["videoPrompt<br/>英文画面描述"] --> B["Timeline<br/>beatSheet.actionEn<br/>0-2s: …; 2-5s: …"]
    B --> C["Overall motion<br/>全片运动基调<br/>剔掉剧情动作与主体"]
    C --> D["场景锚定<br/>场景卡 promptEn + 陈设补漏"]
    D --> E["blockingEn<br/>走位"]
    E --> F["背景人群<br/>backgroundCast"]
    F --> G{"narrationType"}
    G -->|dialogue| G1["The character named X<br/>speaks with natural lip movement"]
    G -->|voiceover| G2["Off-screen narrator<br/>no lip movement"]
    G -->|none| G3["只出环境音 / BGM"]
    G1 --> H{"media 含接帧?"}
    G2 --> H
    G3 --> H
    H -->|hasCarryFrame| H1["首帧即上一镜末帧<br/>禁改人数/装扮"]
    H -->|hasPrevFrameReference| H2["只借光线/调色<br/>构图重来"]
    H -->|无| H3["不加限定"]
```

## 接帧素材决策

判定见 `lib/skills/shot-media.ts:67 prevFrameUsage`，`VIDEO_REFERENCE_PREV_FRAME` 关掉后 hard-cut 一律不接。

```mermaid
flowchart TD
    S["本镜需要参考上一镜末帧?"] --> T{"transition"}
    T -->|same-take| A{"同景别?"}
    T -->|hard-cut| B{"景别差"}
    T -->|time-jump 或跨场景| X["不接帧"]
    A -->|是| F["first_frame<br/>接缝完全连续，但传不了卡片"]
    A -->|否| R1["reference_image<br/>只借光线/色调/材质"]
    B -->|同景别| F
    B -->|差 1 档 或 hiddenCut| R1
    B -->|差 ≥2 档| X
```

## 分镜四步流水线的数据流

```mermaid
flowchart TD
    REQ["ScriptRequest<br/>idea / source / style<br/>mode / shotCount / videoModel"] --> PLAN
    PLAN["StoryPlan<br/>characters + scenes + beats<br/>entry / exit / shotSize / cameraMove"] --> SB
    SB["Shot[]<br/>description · videoPrompt · beatSheet<br/>entryState · exitState · transition"] --> FIN
    FIN["finalizeScript<br/>时长收口 / 引用校验 / 衔接修正 / 人群继承"] --> LOC
    LOC["localize<br/>逐镜中文 → 英文提示词"] --> REV
    REV{"auditScript 检出硬伤?"}
    REV -->|是| FIX["reviewAndRepair 定向修一次"]
    REV -->|否| OUT
    FIX --> OUT["Script JSON 落 scripts.content"]
```
