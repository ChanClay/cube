import type { Script } from '@/lib/types';

/** 未配置 LLM 时用于预览界面与联调视频链路（不调用任何模型接口） */
export const demoScript: Script = {
  title: '最后的灯塔',
  logline: '风暴之夜，守塔人点亮最后一束光，为失踪的渔船指引归途。',
  style: '电影感写实',
  characters: [
    { id: 'demo-char-1', name: '老陈', desc: '六十岁的守塔人，白发，深色雨衣，布满皱纹的脸' },
    { id: 'demo-char-2', name: '渔船', desc: '一艘老旧的木制渔船，船身斑驳' },
  ],
  scenes: [
    { id: 'demo-scene-1', name: '灯塔内部', desc: '石砌旋梯，墙壁斑驳，油灯昏黄，空间狭小潮湿' },
    { id: 'demo-scene-2', name: '风暴中的海面', desc: '暴雨夜，巨浪翻涌，远处灯塔光束扫过，光线冷蓝' },
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
        { from: 0, to: 2, action: '巨浪撞碎在礁石上，水花喷到画面中部' },
        { from: 2, to: 4, action: '塔顶光束从右向左扫过海面' },
        { from: 4, to: 5, action: '雨幕加重，灯塔被压成剪影' },
      ],
      videoPrompt:
        'A lone white lighthouse standing on black volcanic rocks during a violent rainstorm at night, huge waves crashing against the cliff, the rotating beam of light sweeping across the dark sea, cold blue and teal color grading, volumetric rain, cinematic wide shot, slow dolly in, photorealistic, 35mm film grain, dramatic lighting',
      narration: '那晚，海面上没有一艘船回来。',
      narrationType: 'voiceover',
      characterNames: [],
      sceneNames: ['风暴中的海面'],
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
        { from: 0, to: 2, action: '老人扶着铁扶手抬头，视线越过旋梯' },
        { from: 2, to: 3.5, action: '油灯火苗被穿堂风吹得一晃' },
        { from: 3.5, to: 5, action: '他把灯举到脸侧，皱纹被暖光填满' },
      ],
      videoPrompt:
        'Medium shot of an old lighthouse keeper with grey hair and a weathered face standing on a spiral iron staircase, looking up, warm oil lamp light flickering across his deep wrinkles, dust particles floating in the air, shallow depth of field, slow push in, cinematic portrait lighting, photorealistic, moody atmosphere, 50mm lens',
      narration: '他决定再点一次。',
      narrationType: 'voiceover',
      characterNames: ['老陈'],
      sceneNames: ['灯塔内部'],
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
        { from: 0, to: 1.5, action: '光束从画面上方斜切进暴雨' },
        { from: 1.5, to: 3.5, action: '光柱扫过海面，照出一艘倾斜的船影' },
        { from: 3.5, to: 5, action: '船头沉入浪里，只剩桅杆' },
      ],
      videoPrompt:
        'Aerial high angle view from the top of a lighthouse, a bright beam of light cutting through heavy rain and fog, revealing a small sinking wooden fishing boat in the churning dark sea below, slow motion, cold blue palette with warm beam glow, cinematic epic scale, volumetric fog, photorealistic, ultra detailed',
      narration: '光找到了它。',
      narrationType: 'voiceover',
      characterNames: [],
      sceneNames: ['风暴中的海面'],
    },
  ],
};
