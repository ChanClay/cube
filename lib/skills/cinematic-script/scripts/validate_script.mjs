#!/usr/bin/env node
/**
 * 分镜脚本确定性校验器（零依赖，Node >= 18）。
 *
 * 用法：
 *   node validate_script.mjs <script.json> [--shots N] [--total SECONDS]
 *   cat script.json | node validate_script.mjs -
 *
 * 接受三种输入：Script、{ "script": Script }、{ "shots": [...] }（审片修复稿）。
 * 规则镜像 lib/skills/spec.ts 与 lib/agents/review.ts，只做本地判断，不调用任何模型。
 * fatal 存在时退出码为 1。
 */

import { readFileSync } from 'node:fs';

const SHOT_SIZES = ['大远景', '远景', '全景', '中景', '近景', '特写'];
const DEFAULT_SHOT_SIZE = '中景';
const SHOT_SIZE_EN = {
  大远景: 'extreme wide shot',
  远景: 'wide shot',
  全景: 'full shot',
  中景: 'medium shot',
  近景: 'medium close-up',
  特写: 'close-up',
};
const CAMERA_MOVE_EN = {
  固定机位: ['static shot', 'static camera', 'locked-off camera', 'fixed camera'],
  缓慢推近: ['slow push-in', 'slow dolly in', 'slowly pushes in', 'push-in'],
  缓慢拉远: ['slow pull-out', 'slow dolly out', 'slowly pulls back', 'pull-out'],
  横向移动: ['lateral tracking shot', 'trucking shot', 'lateral move'],
  环绕: ['orbit shot', 'orbiting camera', 'arc shot'],
  跟随: ['tracking shot', 'follow shot', 'camera follows'],
  手持晃动: ['handheld camera', 'handheld shot'],
  升格慢动作: ['slow motion', 'slow-motion'],
};
const DEFAULT_CAMERA_MOVE = '固定机位';

const PROMPT_MIN_WORDS = 40;
const PROMPT_MAX_WORDS = 125;
const PROMPT_REPAIR_WORDS = 30;
const PROMPT_REPAIR_MAX_WORDS = 170;

/** 与 lib/video-models.ts 保持一致；脚本里没写 videoModel 时按旧剧本的 wan3.0 校验 */
const VIDEO_MODELS = {
  'happyhorse-1.1': { minShotSeconds: 3, maxShotSeconds: 15, maxShotCount: 12 },
  'wan3.0-video': { minShotSeconds: 2, maxShotSeconds: 30, maxShotCount: 12 },
  'seedance-2.5': { minShotSeconds: 4, maxShotSeconds: 30, maxShotCount: 12 },
};
const LEGACY_VIDEO_MODEL = 'wan3.0-video';
const MAX_SHOT_COUNT = 12;

const FORBIDDEN =
  /(\bsubtitles?\b|\bcaptions?\b|\bwatermarks?\b|\blogos?\b|\bon-screen text\b|\btext overlay\b|\bsplit[- ]screen\b|\bstoryboard\b|\bshot\s*\d+\b|\bscene\s*\d+\b)/i;

const TRANSITION_HINT =
  /(片刻后|稍后|随后|过了一会儿|次日|第二天|翌日|当天夜里|与此同时|镜头一转|转场|几年后|多年后|已在|已经站在|切换到|\b(later|meanwhile|afterwards|the next (day|morning|night)|years later|cut to|transition)\b)/i;

/** 画面运动方向：同一段动作里方向翻转，观众看到的就是「倒着跑」 */
const DIRECTION_PATTERNS = [
  { direction: 'left', pattern: /(向左|朝左|左侧|画面左|由右向左|从右往左|左前方|左边)/ },
  { direction: 'right', pattern: /(向右|朝右|右侧|画面右|由左向右|从左往右|右前方|右边)/ },
  { direction: 'toward', pattern: /(迎面|冲向镜头|朝镜头|驶向镜头|扑向镜头|逼近镜头)/ },
  { direction: 'away', pattern: /(背向|远离镜头|驶离镜头|退向远处|朝着远处|向远处)/ },
];
const DIRECTION_LABEL = { left: '向左', right: '向右', toward: '迎面', away: '远离' };

/** 主体已经出画的收尾：没有落点，下一镜接不住 */
const OFFSCREEN_EXIT =
  /(冲出画外|驶出画外|飞出画外|冲出画面|驶出画面|飞出画面|出画|掠过画外|离开画面|跑出画面|消失在(黑暗|夜色|雨幕|雨里|雾中|雾里|拐角|尽头|远处)|没入(黑暗|夜色|雨幕|雾中|雾里))/;

function screenDirection(text) {
  const value = str(text);
  if (!value) return null;
  const hit = DIRECTION_PATTERNS.find((item) => item.pattern.test(value));
  return hit ? hit.direction : null;
}

function directionsConflict(a, b) {
  return (
    (a === 'left' && b === 'right') ||
    (a === 'right' && b === 'left') ||
    (a === 'toward' && b === 'away') ||
    (a === 'away' && b === 'toward')
  );
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'with', 'in', 'on', 'at', 'of', 'to', 'from', 'by', 'for',
  'his', 'her', 'their', 'its', 'he', 'she', 'they', 'it', 'is', 'are', 'was', 'were', 'be',
  'wearing', 'holds', 'holding', 'has', 'have', 'very', 'into', 'over', 'under', 'near',
  'who', 'that', 'this', 'as', 'while', 'warm', 'cold', 'soft', 'dim',
]);

const issues = [];
const add = (level, code, message, shotIndex) =>
  issues.push({ level, code, message, shotIndex });

const str = (value) => (typeof value === 'string' ? value.trim() : '');
const countWords = (text) => (text.match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) ?? []).length;

function isEnglishPrompt(text) {
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (letters < 20) return false;
  return cjk / (letters + cjk) <= 0.12;
}

function narrationLimit(duration) {
  const safe = Number.isFinite(duration) && duration > 0 ? duration : 5;
  return Math.min(60, Math.max(16, Math.round(safe * 4)));
}

/** 说 / 问 / 答这类动词：名字后面跟着它们，说明这个人在这一镜里开口了 */
const SPEECH_VERB = '(?:说|道|问|答|喊|叫|开口|低语|嘟囔|回话|回应|接过话|自语|念道)';
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 一人一镜：这一镜的台词里还混进了谁在说话。
 * 只认硬证据（「小满答：」、换行后的「名字：」、行首两个对白标签），不做语义猜测。
 */
function narrationSpeakerConflicts(shot, castNames) {
  const narration = shot.narration;
  if (!narration) return [];

  const speaker = shot.speaker;
  // 名字是说话人名的子串（「陈」vs「老陈」）时无法判定，跳过，避免误报
  const others = [...new Set([...castNames, ...shot.characterNames])].filter(
    (name) => name && name !== speaker && !speaker.includes(name),
  );

  const evidence = others.filter((name) => {
    const escaped = escapeRegExp(name);
    const label = new RegExp(`(^|[\\n。！？；])\\s*${escaped}\\s*[：:]`);
    const withVerb = new RegExp(`${escaped}\\s*${SPEECH_VERB}`);
    return label.test(narration) || withVerb.test(narration);
  });

  const labels = narration.match(/(^|[\n。！？；])\s*[^\s：:，。！？；「」“”"']{1,10}\s*[：:]/g) ?? [];
  const multiLabel = labels.length >= 2;

  if (!speaker) return evidence.length >= 2 ? evidence : multiLabel ? ['多人对白'] : [];
  if (evidence.length > 0) return evidence;
  return multiLabel ? ['多人对白'] : [];
}

function contentWords(phrase) {
  const words = phrase.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  return [...new Set(words.filter((word) => !STOPWORDS.has(word)))];
}

function matchedRatio(phrase, prompt) {
  const words = contentWords(phrase);
  if (words.length === 0) return { ratio: 1, hit: 0, total: 0 };
  const text = prompt.toLowerCase();
  const hit = words.filter((word) => text.includes(word)).length;
  return { ratio: hit / words.length, hit, total: words.length };
}

/**
 * 方位词有没有参照系。
 *
 * 视频模型读到的 "left" 至少有三种解法：画面左、车辆自己的左侧、左侧车道。
 * 出问题的从来不是写错方向，而是没写「以谁为准」，模型各挑一个理解，
 * 于是「左后方超车」被拍成「右前方对撞」。
 * 这里只做保守判定：完全裸用的 left / right 报 warn，宁可漏报也不要误报。
 */
const ANCHOR_PREV = new Set(['frame', 'screen', 'shot', 'camera']);
const ANCHOR_NEXT = new Set([
  'lane', 'side', 'third', 'half', 'edge', 'shoulder', 'wall', 'door', 'window', 'mirror',
  'seat', 'hand', 'corner', 'panel', 'pillar', 'bumper', 'fender', 'flank', 'rear', 'front',
]);

function bareDirections(prompt) {
  const tokens = prompt.toLowerCase().match(/[a-z][a-z'’-]*/g) ?? [];
  const bare = [];
  tokens.forEach((token, i) => {
    if (token !== 'left' && token !== 'right') return;
    const prev = tokens[i - 1] ?? '';
    const prev2 = tokens[i - 2] ?? '';
    const next = tokens[i + 1] ?? '';
    const anchored =
      ANCHOR_PREV.has(prev) ||
      prev.endsWith("'s") ||
      prev2.endsWith("'s") ||
      next === 'of' ||
      ANCHOR_NEXT.has(next) ||
      (prev === 'from' && next === 'to');
    if (!anchored) bare.push(token);
  });
  return bare;
}

/** 机位锚：镜头装在哪 / 朝哪 / 多高。多载具同框时必须有 */
const CAMERA_ANCHOR =
  /\b(camera|view|angle)\b[^,.;]{0,70}\b(mounted|placed|positioned|looking|facing|pointing|set|above|below|behind|beside|low|high)\b|\bfrom (behind|above|below|beside|inside|the (rear|front|roof|side|back))\b|\b(rear[- ]view|overhead|bumper[- ]?mounted|roof[- ]?mounted|over the (roof|hood|bonnet)|at (bumper|roof|hood) height|between both roofs)\b/i;

/**
 * 镜面镜（后视镜 / 侧镜 / 屏幕）。
 * 只写 "close-up of the rear-view mirror" 而不锁画框时，模型把镜子当成画面里的物体，
 * 为它补一扇侧窗，后车就从侧面横着过——180° 同轴追逐被拍成 90° 十字交叉。
 */
const MIRROR_TRIGGER =
  /\b(rear[- ]?view mirror|rearview mirror|side mirror|wing mirror|door mirror|mirror glass)\b|后视镜|倒车镜/i;
const MIRROR_FRAME_ANCHOR =
  /\b(entire|whole|full) (frame|image|picture)\b[^,.;]{0,90}\b(mirror|glass|reflective)\b|\b(frame|image)\b[^,.;]{0,70}\b(filled|occupied|covered)\b[^,.;]{0,90}\b(mirror|glass|reflective)\b|\bfills? (the )?(entire |whole )?(frame|image)\b|\b(mirror|reflective) (surface|glass|face)\b|\binside the mirror\b|\breflected in the (mirror|glass)\b|\bmirror (glass )?(occupies|covers|takes)\b[^,.;]{0,40}\b(frame|third|half|corner)\b/i;
const MIRROR_SIDE_ELEMENT =
  /\b(side window|door window|driver'?s? window|passenger window|a-pillar|door panel|door frame|window frame)\b/i;
const MIRROR_LATERAL_CAR =
  /\b(beside|alongside|next to|side by side|perpendicular|crossing|at a right angle)\b[^,.;]{0,50}\b(car|vehicle|sedan|coupe|truck|suv|headlights?)\b|\b(car|vehicle|sedan|coupe|truck|suv)\b[^,.;]{0,50}\b(beside|alongside|perpendicular|crossing)\b/i;

function stateOverlap(previous, current) {
  const grams = (text) => {
    const clean = text.replace(/[\s，。、；：！？,.;:!?（）()「」《》"']/g, '');
    const set = new Set();
    for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2));
    return set;
  };
  const a = grams(previous);
  const b = grams(current);
  if (a.size === 0 || b.size === 0) return 1;
  let shared = 0;
  for (const gram of b) if (a.has(gram)) shared += 1;
  // 分母取较小一侧：entryState 要求四段，字数多于上一镜 exitState，
  // 按当前段覆盖率会把「接住了、只是补了机位与光源」误判成断链。
  return shared / Math.min(a.size, b.size);
}

const rank = (size) => {
  const index = SHOT_SIZES.indexOf(size);
  return index >= 0 ? index : 3;
};

function normalizeInput(raw) {
  if (Array.isArray(raw)) return { script: { shots: raw } };
  if (raw && typeof raw === 'object') {
    if (raw.script && typeof raw.script === 'object') return { script: raw.script };
    return { script: raw };
  }
  throw new Error('输入不是 JSON 对象');
}

/** 归一化字段：同时接受 Script 与网络返回的命名 */
function normalizeShot(shot, i) {
  const names = shot.characterNames ?? shot.characters ?? shot.character;
  const sceneNames = shot.sceneNames ?? shot.scenes ?? shot.scene;
  return {
    index: Number(shot.index) || i + 1,
    title: str(shot.title),
    duration: Number(shot.duration),
    shotSize: str(shot.shotSize) || DEFAULT_SHOT_SIZE,
    cameraMove: str(shot.cameraMove) || DEFAULT_CAMERA_MOVE,
    description: str(shot.description),
    videoPrompt: str(shot.videoPrompt),
    narration: str(shot.narration),
    narrationType: str(shot.narrationType) || 'voiceover',
    speaker: str(shot.speaker),
    entryState: str(shot.entryState),
    exitState: str(shot.exitState),
    transition: str(shot.transition),
    transitionReason: str(shot.transitionReason),
    referencePrevFrame: shot.referencePrevFrame,
    hiddenCut: shot.hiddenCut,
    beatSheet: Array.isArray(shot.beatSheet) ? shot.beatSheet : [],
    characterNames: Array.isArray(names) ? names.map(str).filter(Boolean) : [],
    sceneNames: Array.isArray(sceneNames) ? sceneNames.map(str).filter(Boolean) : [],
  };
}

function validate(script, options) {
  const model =
    VIDEO_MODELS[str(script.videoModel)] ?? VIDEO_MODELS[LEGACY_VIDEO_MODEL];
  const MIN_SHOT_SECONDS = model.minShotSeconds;
  const MAX_SHOT_SECONDS = model.maxShotSeconds;

  const characters = Array.isArray(script.characters) ? script.characters : [];
  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  const cast = new Set(characters.map((c) => str(c.name)).filter(Boolean));
  const sceneSet = new Set(scenes.map((s) => str(s.name)).filter(Boolean));
  const castPromptEn = new Map(
    characters.filter((c) => str(c.name) && str(c.promptEn)).map((c) => [str(c.name), str(c.promptEn)]),
  );
  const scenePromptEn = new Map(
    scenes.filter((s) => str(s.name) && str(s.promptEn)).map((s) => [str(s.name), str(s.promptEn)]),
  );
  const subjectTypes = new Map(
    characters.filter((c) => str(c.name)).map((c) => [str(c.name), str(c.subjectType)]),
  );

  const shots = (Array.isArray(script.shots) ? script.shots : []).map(normalizeShot);
  if (shots.length === 0) {
    add('fatal', 'no-shot', '没有镜头，shots 为空');
    return { shots };
  }
  if (shots.length > MAX_SHOT_COUNT) {
    add('fatal', 'shot-count', `镜头数 ${shots.length} 超过上限 ${MAX_SHOT_COUNT}`);
  }
  if (options.expectedShots && shots.length !== options.expectedShots) {
    add('fatal', 'shot-count', `要求 ${options.expectedShots} 镜，实际 ${shots.length} 镜`);
  }

  const seenPrompts = new Set();
  let chain = 0;

  shots.forEach((shot, i) => {
    const at = shot.index;

    // 时长
    if (!Number.isFinite(shot.duration) || shot.duration < MIN_SHOT_SECONDS || shot.duration > MAX_SHOT_SECONDS) {
      add('fatal', 'duration-out-of-range', `第 ${at} 镜 duration=${shot.duration}，必须在 ${MIN_SHOT_SECONDS}~${MAX_SHOT_SECONDS} 秒`, at);
    }

    // 画面描述
    if (shot.description.length < 2) {
      add('fatal', 'empty-description', `第 ${at} 镜没有中文画面描述`, at);
    }

    // 英文提示词
    const prompt = shot.videoPrompt;
    if (prompt.length < 5) {
      add('fatal', 'empty-prompt', `第 ${at} 镜没有 videoPrompt`, at);
    } else {
      const words = countWords(prompt);
      if (!isEnglishPrompt(prompt)) {
        add('fatal', 'prompt-not-english', `第 ${at} 镜 videoPrompt 不是英文（${words} 词）`, at);
      } else if (words < PROMPT_REPAIR_WORDS) {
        add('warn', 'prompt-weak', `第 ${at} 镜 videoPrompt 只有 ${words} 词（建议 ${PROMPT_MIN_WORDS}~${PROMPT_MAX_WORDS}）`, at);
      } else if (words > PROMPT_REPAIR_MAX_WORDS) {
        add('warn', 'prompt-long', `第 ${at} 镜 videoPrompt ${words} 词，过于啰嗦`, at);
      }
      if (FORBIDDEN.test(prompt)) {
        add('fatal', 'prompt-forbidden', `第 ${at} 镜 videoPrompt 含字幕 / 水印 / 分屏等禁用内容`, at);
      }

      const key = prompt.toLowerCase().replace(/\s+/g, ' ');
      if (seenPrompts.has(key)) {
        add('warn', 'duplicate-prompt', `第 ${at} 镜 videoPrompt 与前面某一镜完全相同`, at);
      }
      seenPrompts.add(key);

      const cameraGroup = CAMERA_MOVE_EN[shot.cameraMove];
      if (cameraGroup && !cameraGroup.some((word) => prompt.toLowerCase().includes(word.toLowerCase()))) {
        add('warn', 'prompt-camera-mismatch', `第 ${at} 镜运镜「${shot.cameraMove}」在英文提示词里没有对应写法`, at);
      }
      const sizeEn = SHOT_SIZE_EN[shot.shotSize];
      if (sizeEn) {
        const text = prompt.toLowerCase();
        const ok =
          text.includes(sizeEn) ||
          ((shot.shotSize === '近景' || shot.shotSize === '特写') && text.includes('close-up'));
        if (!ok) {
          add('warn', 'prompt-shot-size-mismatch', `第 ${at} 镜景别「${shot.shotSize}」在英文提示词里没有对应写法`, at);
        }
      }

      for (const name of shot.characterNames) {
        const phrase = castPromptEn.get(name);
        if (!phrase) continue;
        const { ratio, hit, total } = matchedRatio(phrase, prompt);
        if (total >= 3 && ratio < 0.5) {
          add('warn', 'prompt-drift', `第 ${at} 镜没有复用「${name}」的固定外貌短语（命中 ${hit}/${total}）`, at);
        }
      }
      for (const name of shot.sceneNames) {
        const phrase = scenePromptEn.get(name);
        if (!phrase) continue;
        const { ratio, hit, total } = matchedRatio(phrase, prompt);
        if (total >= 3 && ratio < 0.5) {
          add('warn', 'prompt-drift', `第 ${at} 镜没有复用场景「${name}」的固定空间短语（命中 ${hit}/${total}）`, at);
        }
      }

      /**
       * 场景回档：本镜标注的是 B，英文却更像片头（或别的场景）的空间短语。
       * 一个镜头自己的场景短语几乎没命中、另一个场景却高度命中，
       * 就是「后面的镜头莫名其妙回到片头地点」在成片前唯一可观测的信号。
       */
      if (shot.sceneNames.length > 0) {
        const ownBest = shot.sceneNames.reduce((best, name) => {
          const phrase = scenePromptEn.get(name);
          if (!phrase) return best;
          return Math.max(best, matchedRatio(phrase, prompt).ratio);
        }, 0);
        if (ownBest < 0.4) {
          for (const scene of scenes) {
            if (!scene.promptEn || shot.sceneNames.includes(scene.name)) continue;
            const { ratio, total } = matchedRatio(scene.promptEn, prompt);
            if (total >= 3 && ratio >= 0.7) {
              add(
                'warn',
                'scene-drift',
                `第 ${at} 镜标注的场景是「${shot.sceneNames.join('、')}」，但英文提示词更像「${scene.name}」的空间（命中 ${Math.round(ratio * 100)}%）；画面会表现为回档到别的场景`,
                at,
              );
              break;
            }
          }
        }
      }

      // 空间坐标：多载具同框必须先有机位锚，裸方位词必须带参照系
      const vehicleCast = shot.characterNames.filter((name) => subjectTypes.get(name) === 'vehicle');
      if (vehicleCast.length >= 2 && !CAMERA_ANCHOR.test(prompt)) {
        add('warn', 'no-camera-anchor', `第 ${at} 镜有 ${vehicleCast.length} 辆载具同框，但提示词没写机位锚（镜头装在哪 / 朝哪 / 多高）`, at);
      }
      const bare = bareDirections(prompt);
      if (bare.length > 0) {
        add('warn', 'bare-direction', `第 ${at} 镜方位词「${[...new Set(bare)].join(' / ')}」没有参照系（改成 frame left / 实体名 + 部位 / the left-hand lane）`, at);
      }

      // 镜面镜：画框没焊在镜面上，模型就会补侧窗，把同轴追逐拍成十字交叉
      const mirrorShot = MIRROR_TRIGGER.test(prompt) || MIRROR_TRIGGER.test(`${shot.description} ${shot.entryState}`);
      if (mirrorShot) {
        if (!MIRROR_FRAME_ANCHOR.test(prompt)) {
          add(
            'warn',
            'mirror-frame-missing',
            `第 ${at} 镜是后视镜 / 镜面镜，但没把画框锁在镜面上：补 "the entire frame is the reflective glass of the rear-view mirror, the housing edges just inside the frame borders"。只写 close-up of the mirror，模型会补出车内视角与侧窗，后车从侧面横过`,
            at,
          );
        }
        if (MIRROR_SIDE_ELEMENT.test(prompt)) {
          add(
            'warn',
            'mirror-side-window',
            `第 ${at} 镜是镜面镜，却写了侧窗 / A 柱 / 门板：画面基准会转向侧面，后车变成横向掠过，同轴追逐读成十字交叉`,
            at,
          );
        }
        if (MIRROR_LATERAL_CAR.test(prompt)) {
          add(
            'warn',
            'mirror-lateral-car',
            `第 ${at} 镜是镜面镜，却用 beside / alongside / perpendicular / crossing 描述后车：改成 on the same lane centerline directly behind`,
            at,
          );
        }
      }
    }

    // 秒级节拍
    if (shot.duration >= 4 && shot.beatSheet.length < 2) {
      add('warn', 'timeline-missing', `第 ${at} 镜 ${shot.duration} 秒只有 ${shot.beatSheet.length} 段节奏，至少 2 段`, at);
    }
    if (shot.beatSheet.length > 8) {
      add('warn', 'timeline-too-many-beats', `第 ${at} 镜 beatSheet 有 ${shot.beatSheet.length} 段，超过 8 段`, at);
    }
    if (shot.beatSheet.length > 0 && Number.isFinite(shot.duration)) {
      const beats = shot.beatSheet
        .map((beat) => ({ from: Number(beat.from), to: Number(beat.to), action: str(beat.action) }))
        .sort((a, b) => a.from - b.from);
      if (beats[0].from > 0.01) {
        add('warn', 'timeline-gap', `第 ${at} 镜 beatSheet 首段从 ${beats[0].from} 秒开始，必须从 0 开始`, at);
      }
      const last = beats[beats.length - 1];
      if (Math.abs(last.to - shot.duration) > 0.05) {
        add('warn', 'timeline-gap', `第 ${at} 镜 beatSheet 末段结束于 ${last.to} 秒，必须等于 duration ${shot.duration} 秒`, at);
      }
      let cursor = 0;
      for (const beat of beats) {
        if (!beat.action) {
          add('warn', 'timeline-empty-action', `第 ${at} 镜 beatSheet 有段落没有写动作`, at);
        }
        if (!Number.isFinite(beat.from) || !Number.isFinite(beat.to) || beat.to <= beat.from) {
          add('fatal', 'timeline-invalid', `第 ${at} 镜 beatSheet 有非法区间 ${beat.from}~${beat.to}`, at);
          continue;
        }
        if (beat.from > cursor + 0.05) {
          add('warn', 'timeline-gap', `第 ${at} 镜 beatSheet 在 ${cursor}~${beat.from} 秒之间断档`, at);
        } else if (beat.from < cursor - 0.05) {
          add('warn', 'timeline-overlap', `第 ${at} 镜 beatSheet 在 ${beat.from} 秒处与上一段重叠`, at);
        }
        cursor = Math.max(cursor, beat.to);
      }
    }

    // 台词
    const limit = narrationLimit(shot.duration);
    if (shot.narration.length > limit) {
      add('warn', 'narration-long', `第 ${at} 镜台词 ${shot.narration.length} 字，${shot.duration} 秒最多 ${limit} 字`, at);
    }

    // 一人一镜：一镜里两个人的对白，成片里只会念出一句，或者两个人一起动嘴
    const extraSpeakers = narrationSpeakerConflicts(shot, [...cast]);
    if (extraSpeakers.length > 0) {
      add(
        'warn',
        'multi-speaker',
        `第 ${at} 镜的台词里出现了另外的说话人（${extraSpeakers.join('、')}）：一镜只能有一个 speaker，` +
          '把它拆成相邻两镜（A 的镜头 → hard-cut 反打 B 的镜头，守轴线），每镜只留一个人的台词',
        at,
      );
    }

    // 台词复述画面：画面已经拍到的信息又念一遍，观众就在听配图朗诵
    if (shot.narration.length >= 8 && shot.description && stateOverlap(shot.description, shot.narration) >= 0.4) {
      add(
        'warn',
        'dialogue-flat',
        `第 ${at} 镜的台词「${shot.narration}」基本在复述画面描述；台词要说画面说不出来的部分（目的 / 潜台词 / 关系变化），或者这一镜干脆不开口`,
        at,
      );
    }

    if (shot.narrationType === 'dialogue') {
      if (!shot.narration) {
        add('warn', 'dialogue-empty', `第 ${at} 镜标成 dialogue 却没有台词`, at);
      }
      if (!shot.speaker) {
        add('warn', 'dialogue-no-speaker', `第 ${at} 镜是 dialogue 但没指定 speaker`, at);
      } else if (!shot.characterNames.includes(shot.speaker)) {
        add('warn', 'speaker-not-on-screen', `第 ${at} 镜说话人「${shot.speaker}」不在本镜 characters 里`, at);
      }
    } else if (shot.speaker) {
      add('warn', 'speaker-useless', `第 ${at} 镜 narrationType=${shot.narrationType}，speaker 应留空`, at);
    }
    if (shot.narrationType === 'none' && shot.narration) {
      add('warn', 'narration-with-none', `第 ${at} 镜标成 none 但有台词，系统会降级为 voiceover`, at);
    }

    // 引用
    for (const name of shot.characterNames) {
      if (cast.size > 0 && !cast.has(name)) {
        add('warn', 'unknown-character', `第 ${at} 镜引用了角色表里没有的「${name}」`, at);
      }
    }
    for (const name of shot.sceneNames) {
      if (sceneSet.size > 0 && !sceneSet.has(name)) {
        add('warn', 'unknown-scene', `第 ${at} 镜引用了场景表里没有的「${name}」`, at);
      }
    }

    // 跨镜衔接
    if (i === 0) {
      if (shot.transition) {
        add('warn', 'first-shot-transition', '第 1 镜不需要 transition，系统会忽略', at);
      }
      chain = 0;
      return;
    }

    const prev = shots[i - 1];

    if (shot.transition && !['same-take', 'hard-cut', 'time-jump'].includes(shot.transition)) {
      add('warn', 'transition-invalid', `第 ${at} 镜 transition 只能是 same-take / hard-cut / time-jump`, at);
    }

    const sizeGap = Math.abs(rank(shot.shotSize) - rank(prev.shotSize));

    if (shot.transition === 'same-take') {
      if (shot.duration > 8 && shot.characterNames.length > 0) {
        add('warn', 'same-take-too-long', `第 ${at} 镜 ${shot.duration} 秒且有人物，接帧会丢失角色卡参考图`, at);
      }
      // 摄影机没停机就不可能在切点换景别：跨 1 档也不行
      if (sizeGap > 0) {
        add('warn', 'same-take-size-gap', `第 ${at} 镜景别从${prev.shotSize}变成${shot.shotSize}，摄影机没停机就换不了景别，不能算同一次拍摄`, at);
      }
      const prevScene = prev.sceneNames.join('|');
      const scene = shot.sceneNames.join('|');
      if (prevScene && scene && prevScene !== scene) {
        add('warn', 'same-take-scene-change', `第 ${at} 镜换了场景，不能算 same-take`, at);
      }
      chain += 1;
      if (chain > 2) {
        add('warn', 'same-take-chain', `第 ${at} 镜连续接帧超过 2 次，人物会漂`, at);
      }
    } else {
      chain = 0;
    }

    // 跨了 2 档以上还指望接住上一镜末帧：生成时只能看到一次突兀的拉远 / 推近
    if (shot.transition === 'hard-cut' && sizeGap > 1 && shot.referencePrevFrame === true && !shot.hiddenCut) {
      const prevScene = prev.sceneNames.join('|');
      const scene = shot.sceneNames.join('|');
      if (prevScene && scene && prevScene === scene) {
        add(
          'warn',
          'size-gap-carry',
          `第 ${at} 镜景别从${prev.shotSize}跳到${shot.shotSize}，上一镜末帧接不住：改走角色卡 / 场景卡，或用 hiddenCut 声明遮挡转场`,
          at,
        );
      }
    }

    // 首尾状态是每一处剪辑点的依据，硬切同样要有（只是允许不重合）
    if (!shot.entryState) {
      add('warn', 'state-missing', `第 ${at} 镜没有 entryState，无法确认接住了第 ${prev.index} 镜`, at);
    }
    if (i < shots.length - 1 && !shot.exitState) {
      add('warn', 'state-missing', `第 ${at} 镜没有 exitState，第 ${shots[i + 1].index} 镜没有状态可接`, at);
    }

    if (shot.transition !== 'time-jump') {
      // 出口停在主体出画处：观众抓不到落点，下一镜怎么切都接不上
      if (prev.exitState && OFFSCREEN_EXIT.test(prev.exitState) && !shot.hiddenCut) {
        add(
          'warn',
          'exit-offscreen',
          `第 ${prev.index} 镜以「${prev.exitState}」收尾，主体已经出画，第 ${at} 镜没有落点可接：把出口放在可辨认的动作相位上，或用 hiddenCut 遮挡交接`,
          prev.index,
        );
      }

      // 方向翻转 / 越轴
      const prevDirection = screenDirection(prev.exitState);
      const direction = screenDirection(shot.entryState);
      if (!shot.hiddenCut && prevDirection && direction && directionsConflict(prevDirection, direction)) {
        add(
          'warn',
          'direction-flip',
          `第 ${prev.index} 镜结束在${DIRECTION_LABEL[prevDirection]}运动，第 ${at} 镜却${DIRECTION_LABEL[direction]}运动；要换向先垫一个中性机位（迎面 / 背面 / 空镜）`,
          at,
        );
      }

      // 硬切要说明切点承接的是什么
      if (shot.transition === 'hard-cut' && !shot.transitionReason) {
        add('warn', 'cut-undeclared', `第 ${at} 镜是硬切但没写 transitionReason：说明切点承接的动作相位或背景锚点`, at);
      }
    }

    const declaredCut = shot.transition === 'hard-cut' || shot.transition === 'time-jump';
    if (!declaredCut) {
      if (shot.entryState && prev.exitState && !TRANSITION_HINT.test(shot.entryState)) {
        if (stateOverlap(prev.exitState, shot.entryState) < 0.15) {
          add('warn', 'continuity-gap', `第 ${prev.index} 镜结束于「${prev.exitState}」，第 ${at} 镜却从「${shot.entryState}」开始`, at);
        }
      }
    }
  });

  // 开场前情没人交代：全片没有旁白，第一镜又停在空镜 / 无口播上
  const hasDialogue = shots.some((s) => s.narrationType === 'dialogue' && s.narration);
  const hasVoiceover = shots.some((s) => s.narrationType === 'voiceover' && s.narration);
  if (hasDialogue && !hasVoiceover && shots.length >= 4 && shots[0].narrationType !== 'dialogue') {
    add(
      'warn',
      'no-opening-voiceover',
      '全片没有一句旁白，开场的前情只能由人物的第一句台词自己解释；把第 1 镜改成空镜 / 大远景 + 一句 voiceover 交代谁、在哪、为什么打，第 2 镜再进人物台词',
      1,
    );
  }

  return { shots };
}

function main() {
  const args = process.argv.slice(2);
  const options = { expectedShots: 0, total: 0 };
  let target = '';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--shots') options.expectedShots = Number(args[++i]) || 0;
    else if (arg === '--total') options.total = Number(args[++i]) || 0;
    else if (arg === '-h' || arg === '--help') {
      console.log('用法: node validate_script.mjs <script.json | -> [--shots N] [--total SECONDS]');
      process.exit(0);
    } else target = arg;
  }

  let text;
  try {
    text = target && target !== '-' ? readFileSync(target, 'utf8') : readFileSync(0, 'utf8');
  } catch (err) {
    console.error(`读取失败: ${err.message}`);
    process.exit(2);
  }

  let script;
  try {
    script = normalizeInput(JSON.parse(text)).script;
  } catch (err) {
    console.error(`JSON 解析失败: ${err.message}`);
    process.exit(2);
  }

  const { shots } = validate(script, options);

  if (options.total > 0 && shots.length > 0) {
    const sum = shots.reduce((acc, shot) => acc + (Number.isFinite(shot.duration) ? shot.duration : 0), 0);
    if (sum !== options.total) {
      add('fatal', 'total-duration', `各镜时长之和 ${sum} 秒，不等于目标总时长 ${options.total} 秒`);
    }
  }

  const fatal = issues.filter((issue) => issue.level === 'fatal');
  const warn = issues.filter((issue) => issue.level === 'warn');

  for (const issue of issues) {
    const tag = issue.level === 'fatal' ? 'FATAL' : 'warn ';
    console.log(`[${tag}] ${issue.code}: ${issue.message}`);
  }

  const total = shots.reduce((acc, shot) => acc + (Number.isFinite(shot.duration) ? shot.duration : 0), 0);
  console.log(`\n${shots.length} 镜 / ${total} 秒：fatal ${fatal.length}，warn ${warn.length}`);
  if (fatal.length === 0 && warn.length === 0) console.log('通过：结构与影视语言约束全部满足。');
  process.exit(fatal.length > 0 ? 1 : 0);
}

main();
