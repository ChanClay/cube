import type { Script } from '@/lib/types';
import { DEFAULT_VIDEO_MODEL_ID } from '@/lib/video-models';

/** 未配置 LLM 时用于预览界面与联调视频链路（不调用任何模型接口） */
export const demoScript: Script = {
  videoModel: DEFAULT_VIDEO_MODEL_ID,
  title: '最后的灯塔',
  logline: '风暴之夜，守塔人点亮最后一束光，为失踪的渔船指引归途。',
  style: '电影感写实',
  motionProfile:
    '风暴之夜，雨、浪与光束始终在动：雨丝斜落、巨浪翻涌、塔顶光束扫过海面，任何近景 / 特写都要保留风压与湿气。',
  motionEn:
    'constant storm motion, driving rain and surging waves, wind pressure visible even in close-ups',
  characters: [
    {
      id: 'demo-char-1',
      name: '老陈',
      subjectType: 'human',
      desc: '六十岁的守塔人，白发，深色雨衣，布满皱纹的脸',
    },
    { id: 'demo-char-2', name: '渔船', subjectType: 'vehicle', desc: '一艘老旧的木制渔船，船身斑驳' },
  ],
  scenes: [
    {
      id: 'demo-scene-1',
      name: '灯塔内部',
      desc: '石砌旋梯，墙壁斑驳，油灯昏黄，空间狭小潮湿',
      promptEn:
        'narrow stone spiral staircase inside an old lighthouse, damp patched walls, warm oil lamp glow, cramped wet air',
      inventory: [
        {
          name: '旋梯',
          en: 'stone spiral staircase',
          where: '沿塔壁盘旋而上，铁扶手在靠塔心那一侧',
          whereEn: 'a stone spiral staircase winding up along the tower wall, its iron handrail on the inner side',
          fixed: true,
        },
        {
          name: '铁窗',
          en: 'narrow iron window',
          where: '北墙，正对旋梯转角',
          whereEn: 'a narrow iron window on the north wall, facing the landing of the staircase',
          fixed: true,
        },
        {
          name: '油灯',
          en: 'oil lamp',
          where: '挂在旋梯转角的铁钩上',
          whereEn: 'an oil lamp hung on an iron hook at the staircase landing',
          fixed: false,
        },
      ],
    },
    {
      id: 'demo-scene-2',
      name: '风暴中的海面',
      desc: '暴雨夜，巨浪翻涌，远处灯塔光束扫过，光线冷蓝',
      promptEn:
        'violent rainstorm over a black sea at night, towering waves, a lighthouse beam sweeping across the water, cold blue light',
    },
  ],
  shots: [
    {
      id: 'demo-1',
      index: 1,
      title: '风暴中的灯塔',
      duration: 5,
      shotSize: '远景',
      cameraMove: '缓慢推近',
      description: '暴雨夜，白色灯塔孤零零立在黑色礁石上，巨浪拍岸，塔顶光束扫过海面。',
      beatSheet: [
        {
          from: 0,
          to: 2,
          action: '巨浪撞碎在礁石上，水花喷到画面中部',
          actionEn: 'huge waves shattering on the rocks, spray bursting into the middle of the frame',
        },
        {
          from: 2,
          to: 4,
          action: '塔顶光束从右向左扫过海面',
          actionEn: 'the tower beam sweeping from right to left across the sea',
        },
        {
          from: 4,
          to: 5,
          action: '雨幕加重，灯塔被压成剪影',
          actionEn: 'the rain thickening, the lighthouse flattening into a silhouette',
        },
      ],
      videoPrompt:
        'A lone white lighthouse standing on black volcanic rocks during a violent rainstorm at night, huge waves crashing against the cliff, the rotating beam of light sweeping across the dark sea, cold blue and teal color grading, volumetric rain, cinematic wide shot, slow dolly in, photorealistic, 35mm film grain, constant subtle motion, no frozen frame',
      narration: '那晚，海面上没有一艘船回来。',
      narrationType: 'voiceover',
      characterNames: [],
      sceneNames: ['风暴中的海面'],
      sceneIds: ['demo-scene-2'],
    },
    {
      id: 'demo-2',
      index: 2,
      title: '守塔人',
      duration: 5,
      shotSize: '中景',
      cameraMove: '缓慢推近',
      description: '白发老人站在塔内旋梯上抬头望向塔顶，油灯的暖光映着他满是皱纹的脸。',
      beatSheet: [
        {
          from: 0,
          to: 2,
          action: '老人扶着铁扶手抬头，视线越过旋梯',
          actionEn: 'the old man gripping the iron rail and raising his head, his gaze climbing past the staircase',
        },
        {
          from: 2,
          to: 3.5,
          action: '油灯火苗被穿堂风吹得一晃',
          actionEn: 'the oil lamp flame swaying in the draft from the stairwell',
        },
        {
          from: 3.5,
          to: 5,
          action: '他把灯举到脸侧，皱纹被暖光填满',
          actionEn: 'lifting the lamp beside his face, warm light settling into his wrinkles',
        },
      ],
      videoPrompt:
        'Medium shot of an old lighthouse keeper with grey hair and a weathered face standing on a spiral iron staircase, looking up, warm oil lamp light flickering across his deep wrinkles, dust particles floating in the air, shallow depth of field, slow push in, cinematic portrait lighting, photorealistic, moody atmosphere, 50mm lens, constant subtle motion, no frozen frame',
      narration: '他决定再点一次。',
      narrationType: 'voiceover',
      characterNames: ['老陈'],
      sceneNames: ['灯塔内部'],
      sceneIds: ['demo-scene-1'],
    },
    {
      id: 'demo-3',
      index: 3,
      title: '光刺破风暴',
      duration: 5,
      shotSize: '大远景',
      cameraMove: '升格慢动作',
      description: '从塔顶俯视，光束穿透暴雨，照亮海面上一艘正在下沉的旧渔船。',
      beatSheet: [
        {
          from: 0,
          to: 1.5,
          action: '光束从画面上方斜切进暴雨',
          actionEn: 'the beam slicing diagonally down through the rain from above',
        },
        {
          from: 1.5,
          to: 3.5,
          action: '光柱扫过海面，照出一艘倾斜的船影',
          actionEn: 'the light column sweeping across the sea, revealing a tilted hull',
        },
        {
          from: 3.5,
          to: 5,
          action: '船头沉入浪里，只剩桅杆',
          actionEn: 'the bow sinking under the waves, only the mast still standing',
        },
      ],
      videoPrompt:
        'Aerial high angle view from the top of a lighthouse, a bright beam of light cutting through heavy rain and fog, revealing a small sinking wooden fishing boat in the churning dark sea below, slow motion, cold blue palette with warm beam glow, cinematic epic scale, volumetric fog, photorealistic, ultra detailed, constant subtle motion, no frozen frame',
      narration: '光找到了它。',
      narrationType: 'voiceover',
      characterNames: [],
      sceneNames: ['风暴中的海面'],
      sceneIds: ['demo-scene-2'],
    },
  ],
};
