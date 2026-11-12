import type { Script, Shot } from '@/lib/types';

/** 新建项目 / 新建剧本时的占位名，生成剧本时不会被模型标题覆盖 */
export const NEW_SCRIPT_TITLE = '未命名剧本';

/**
 * 手动添加的空镜头：只给出一份可编辑的骨架，
 * 画面描述 / 视频提示词留给用户自己写，或点「重新生成分镜信息」让模型补。
 */
export function blankShot(index: number): Shot {
  return {
    id: crypto.randomUUID(),
    index,
    title: `镜头 ${index}`,
    duration: 5,
    shotSize: '中景',
    cameraMove: '固定机位',
    description: '',
    videoPrompt: '',
    narration: '',
    narrationType: 'voiceover',
    characterNames: [],
    sceneNames: [],
    media: [],
  };
}

/**
 * 空白剧本模板。
 * 新建项目和「＋ 新建剧本」共用同一份结构，避免两处写法漂移。
 */
export function blankScript(title: string = NEW_SCRIPT_TITLE): Script {
  return {
    title,
    logline: '',
    style: '电影感写实',
    characters: [],
    scenes: [],
    shots: [],
  };
}
