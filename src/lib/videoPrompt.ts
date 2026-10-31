export function buildVideoPrompt(
  prompt: string,
  referenceTexts: string[],
  referenceMode: 'first_frame' | 'last_frame' | 'style' = 'first_frame',
  hasImageReferences = false,
  imageReferenceCount = hasImageReferences ? 1 : 0,
): string {
  const modeGuides = new Set([
    '将提供的参考图作为视频尾帧，安排自然过渡，并让动作在该画面收束。',
    '将提供的参考图仅用于风格参考，提取其光线、色彩和质感，不要求复刻原图主体。',
    '将提供的参考图作为视频首帧，保持主体与场景特征一致，并从该画面自然延续动作。',
    '将第一张参考图作为视频首帧，第二张参考图作为尾帧，生成两帧之间自然连贯的过渡。',
    // 清理早期版本写入节点提示词的旧引导，避免它与新文案重复提交。
    '连接的图片作为视频结束画面，安排自然过渡并让动作在该画面收束。',
    '连接的图片仅作为风格参考，提取光线、色彩和质感，不要求复刻原图主体。',
    '以连接的图片作为视频起始画面，保持主体和场景连续，再自然发展动作。',
    '第一张连接图作为视频首帧，第二张连接图作为尾帧，让画面自然过渡并保持主体场景连贯。',
  ]);
  const base = String(prompt || '').trim().split('\n').filter((line) => !modeGuides.has(line.trim())).join('\n').trim();
  const references = [...new Set(referenceTexts.map((text) => String(text || '').trim()).filter(Boolean))]
    .filter((text) => !base.includes(text));
  const referenceGuide = hasImageReferences
    ? referenceMode === 'last_frame'
      ? '将提供的参考图作为视频尾帧，安排自然过渡，并让动作在该画面收束。'
      : referenceMode === 'style'
        ? '将提供的参考图仅用于风格参考，提取其光线、色彩和质感，不要求复刻原图主体。'
        : imageReferenceCount > 1
          ? '将第一张参考图作为视频首帧，第二张参考图作为尾帧，生成两帧之间自然连贯的过渡。'
          : '将提供的参考图作为视频首帧，保持主体与场景特征一致，并从该画面自然延续动作。'
    : '';
  return [base, referenceGuide, ...references.map((text) => `参考文案：${text}`)].filter(Boolean).join('\n');
}

export function extractVideoScript(source: string): string {
  const text = String(source || '').trim();
  if (!text) return '';
  const blocks = [...text.matchAll(/```([^\n`]*)\n?([\s\S]*?)```/g)];
  const labeledBlock = blocks.find((match) => /video|prompt|script|视频|脚本|提示词/i.test(match[1] || ''));
  const block = labeledBlock || (blocks.length === 1 ? blocks[0] : undefined);
  if (block?.[2]?.trim()) return block[2].trim();
  const heading = /(?:视频(?:生成)?(?:提示词|脚本)|生成提示词|提示词)\s*[:：]\s*/i.exec(text);
  return heading ? text.slice(heading.index + heading[0].length).trim() : text;
}
