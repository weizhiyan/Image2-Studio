import type { ModelProfileView } from '@/types';

export interface ImageModelOption {
  key: string;
  profileId: string;
  profileName: string;
  model: string;
}

/** 节点工具栏与对话输入区共用同一份可用生图模型清单。 */
export function imageModelOptionsOf(profiles?: ModelProfileView[]): ImageModelOption[] {
  return (profiles || [])
    .filter((profile) => profile.kind === 'image' && profile.enabled !== false)
    .flatMap((profile) => (profile.enabledModels || []).map((model) => ({
      key: `${profile.id}:${model}`,
      profileId: profile.id,
      profileName: profile.name,
      model,
    })));
}
