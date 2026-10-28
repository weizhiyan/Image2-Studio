/**
 * 视频节点必须「长得跟图片节点一样」——同一个组件、同一套类名，
 * 差别只在 kind 与成品介质。这里用静态渲染断言 DOM 结构，锁住这个约定：
 * 一旦有人又把视频节点拆成独立组件 / 独立样式，这些断言会红。
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import FlowImageNode from '@/components/canvas/FlowImageNode';
import NodeVideoToolbar, { SchemaSettingsPopover, VideoSettingsPopover } from '@/components/canvas/NodeVideoToolbar';
import NodeSelectionToolbar from '@/components/canvas/NodeSelectionToolbar';
import type { CanvasNodeData } from '@/types';

function videoNode(extra: Partial<CanvasNodeData> = {}): CanvasNodeData {
  return {
    kind: 'video',
    label: '视频生成',
    prompt: '一只蓝色纸船漂浮在水面',
    videoStatus: 'idle',
    videoSeconds: 5,
    videoResolution: '480p',
    videoRatio: '16:9',
    videoAudio: false,
    videoProgress: 0,
    cardWidth: 320,
    ...extra,
  } as CanvasNodeData;
}

function imageComposer(extra: Partial<CanvasNodeData> = {}): CanvasNodeData {
  return {
    kind: 'composer',
    label: '输入提示词',
    prompt: '',
    status: 'idle',
    ratio: 'auto',
    cardWidth: 320,
    ...extra,
  } as CanvasNodeData;
}

function renderNode(data: CanvasNodeData, selected = false) {
  // Handle 组件要读 ReactFlow store，必须包一层 Provider（与 settingsProfileRow.test.tsx 同款）
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <FlowImageNode
        id="n1"
        data={data as never}
        selected={selected}
        type="flow-image"
        draggable
        dragging={false}
        zIndex={0}
        selectable
        deletable
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider> as never,
  );
}

describe('视频节点复用图片节点的外壳', () => {
  it('外层类名与图片 composer 同族（image-flow-node / image-node-composer-shell）', () => {
    const html = renderNode(videoNode());
    expect(html).toContain('image-flow-node');
    expect(html).toContain('image-node-video');
    // 输入态走的是图片那套 composer 外壳，不是另起一套
    expect(html).toContain('image-node-composer-shell');
    expect(html).toContain('image-node-composer-card');
    // 不出现独立组件留下的平行类名
    expect(html).not.toContain('video-flow-node');
    expect(html).not.toContain('video-node-shell');
  });

  it('图片生成输入区不显示 Enter 快捷键提示', () => {
    const html = renderNode(imageComposer({ composerEditing: true }));
    expect(html).not.toContain('hb-hint');
    expect(html).not.toContain('Shift+Enter');
  });

  it('输入区结构与图片 composer 一致：textarea + 上传钮 + 发送钮', () => {
    const html = renderNode(videoNode());
    expect(html).toContain('image-node-composer-content');
    expect(html).toContain('image-node-composer-foot');
    expect(html).toContain('image-node-composer-send');
    expect(html).toContain('aria-label="上传参考图"');
    expect(html).toContain('aria-label="优化视频脚本"');
    expect(html).not.toContain('hb-hint');
    expect(html).not.toContain('Shift+Enter');
    expect(html).not.toContain('image-node-placeholder');
    // 参数不住在卡片里：工具栏负责，卡片上不该出现 select
    expect(html).not.toContain('<select');
  });

  it('视频节点进入编辑态后提示词输入框可编辑', () => {
    const html = renderNode(videoNode({ composerEditing: true }));
    expect(html).toContain('class="nodrag nowheel"');
    expect(html).not.toContain('readonly=""');
  });

  it('脚本优化后显示可撤销按钮', () => {
    const html = renderNode(videoNode({ videoPromptOptimized: true, videoPromptOriginal: '原始脚本' }));
    expect(html).toContain('aria-label="撤销视频脚本优化"');
    expect(html).toContain('撤销优化');
  });

  it('比例写进 --image-aspect-ratio（与图片节点同一个变量）', () => {
    // 竖图 9:16 必须是矮比（<1），横图 16:9 必须是宽比（>1）——曾因高/宽翻错方向被拉成竖条
    expect(renderNode(videoNode({ videoRatio: '9:16' }))).toContain('--image-aspect-ratio:0.56');
    expect(renderNode(videoNode({ videoRatio: '16:9' }))).toMatch(/--image-aspect-ratio:1\.7\d/);
  });
});

describe('视频节点的三态', () => {
  it('运行中：进度条在，输入框仍占位但发送不可点', () => {
    const html = renderNode(videoNode({ videoStatus: 'running', videoProgress: 42 }));
    expect(html).toContain('image-node-video-progress');
    expect(html).toContain('42%');
    expect(html).toContain('is-video-running');
    expect(html).toContain('image-node-running-border');
    expect(html).not.toContain('image-node-placeholder');
  });

  it('排队中（progress 0）：不显示 0%，显示「已提交」', () => {
    const html = renderNode(videoNode({ videoStatus: 'running', videoProgress: 0 }));
    expect(html).toContain('已提交');
    expect(html).not.toContain('0%');
  });

  it('完成：出 video 播放器，容器还是 .image-node-media', () => {
    const html = renderNode(videoNode({
      videoStatus: 'done',
      videoUrl: '/api/files/vid_x.mp4',
      videoFileName: 'vid_x.mp4',
    }));
    expect(html).toContain('<video');
    expect(html).toContain('src="/api/files/vid_x.mp4"');
    expect(html).toContain('image-node-media');
    expect(html).toContain('image-node-video-player');
    expect(html).toContain('class="image-node-kind-label"');
    expect(html).toContain('>视频</span>');
    expect(html).toContain('class="image-node-video-seek nodrag nowheel nopan"');
    expect(html).toContain('preload="none"');
    expect(html).toContain('aria-label="视频时间进度条"');
    expect(html).toContain('aria-label="播放视频"');
    expect(html).toContain('aria-label="关闭视频声音"');
    expect(html).toContain('class="image-node-video-audio nodrag nowheel nopan"');
    expect(html).toContain('class="image-node-video-scrim"');
    expect(html).toContain('class="image-node-copy-button nowheel"');
    expect(html).not.toContain('controls=""');
    // 完成后不再显示输入区
    expect(html).not.toContain('image-node-composer-shell');
    // 下载入口
    expect(html).toContain('下载视频');
  });

  it('仅选中或进入视口附近的视频节点才预取媒体元数据', () => {
    const data = videoNode({ videoStatus: 'done', videoUrl: '/api/files/vid_x.mp4' });
    expect(renderNode(data)).toContain('preload="none"');
    expect(renderNode(data, true)).toContain('preload="metadata"');
  });

  it('失败：错误文案摊在卡片上，不靠 toast', () => {
    const html = renderNode(videoNode({ videoStatus: 'error', videoError: '内容审核未通过' }));
    expect(html).toContain('内容审核未通过');
    expect(html).toContain('is-error');
  });

  it('提交结果未知时明确要求核查，提供确认后重试入口', () => {
    const html = renderNode(videoNode({
      videoStatus: 'error',
      videoSubmissionUnknown: true,
      videoError: '提交结果未知，请先核查服务商任务记录',
    }));
    expect(html).toContain('提交结果未知，请先核查服务商任务记录');
    expect(html).toContain('我已核查，仍要重试');
    expect(html).toContain('提交状态待核查');
  });
});

describe('视频成品操作工具栏', () => {
  it('不显示绘画入口，重新生成按钮按重新编辑命名', () => {
    const html = renderToStaticMarkup(
      <NodeSelectionToolbar
        showPreview={false}
        showRedit={false}
        onPreview={() => undefined}
        onRedit={() => undefined}
        onRegenerate={() => undefined}
        regenerateLabel="重新编辑视频"
        regenerateTitle="重新编辑：返回视频参数与提示词编辑"
        ariaLabel="视频操作"
      />,
    );
    expect(html).toContain('aria-label="视频操作"');
    expect(html).toContain('aria-label="重新编辑视频"');
    expect(html).not.toContain('进入绘画标注');
  });
});

describe('视频参数工具栏', () => {
  it('单一参数入口汇总当前值，弹层用时长滑块和三档画质', () => {
    const toolbarHtml = renderToStaticMarkup(
      <NodeVideoToolbar
        model="seedance-video"
        profileId="video-profile"
        modelOptions={[{ key: 'video-profile:seedance-video', model: 'seedance-video', profileId: 'video-profile', profileName: '视频模型' }]}
        seconds={5}
        resolution="480p"
        ratio="16:9"
        generateAudio={false}
        onSelectModel={() => undefined}
        onSelectSeconds={() => undefined}
        onSelectResolution={() => undefined}
        onSelectRatio={() => undefined}
        onToggleAudio={() => undefined}
      />,
    );
    expect(toolbarHtml).toContain('16:9 · 480p · 5s · 无声音');
    const popoverHtml = renderToStaticMarkup(
      <VideoSettingsPopover
        seconds={5}
        resolution="480p"
        ratio="16:9"
        generateAudio={false}
        onSelectSeconds={() => undefined}
        onSelectResolution={() => undefined}
        onSelectRatio={() => undefined}
        onToggleAudio={() => undefined}
      />,
    );
    expect(popoverHtml).toContain('type="range"');
    expect(popoverHtml).toContain('aria-label="视频时长"');
    expect(popoverHtml).toContain('1080p');
    expect(popoverHtml).toContain('role="switch"');
    expect(popoverHtml).toContain('aria-checked="false"');
    expect(popoverHtml).toContain('连接图片用途');
    expect(popoverHtml).toContain('首帧');
    expect(popoverHtml).toContain('尾帧');
    expect(popoverHtml).toContain('风格');
  });

  it('schema 时长选项也用滑块，而不是拥挤的选项列表', () => {
    const html = renderToStaticMarkup(
      <SchemaSettingsPopover
        schema={{
          name: 'seedance-video',
          params: [{
            name: 'duration',
            label: '视频时长',
            type: 'select',
            options: Array.from({ length: 12 }, (_, index) => ({ label: `${index + 4}秒`, value: String(index + 4) })),
          }],
        }}
        values={{ duration: '8' }}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="视频时长"');
    expect(html).toContain('type="range"');
    expect(html).toContain('8秒');
    expect(html).not.toContain('<select');
  });

  it('schema 数量选项显示离散分段，不改写服务商定义的取值', () => {
    const html = renderToStaticMarkup(
      <SchemaSettingsPopover
        schema={{
          name: 'seedance-video',
          params: [{
            name: 'count',
            label: '生成数量',
            type: 'select',
            options: [1, 3, 5].map((value) => ({ label: `${value} 张`, value: String(value) })),
          }],
        }}
        values={{ count: '3' }}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="生成数量"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).not.toContain('<select');
  });
});

describe('图生视频：连上来的图以引用 chip 呈现', () => {
  it('有图片引用时渲染 chips（与图片 composer 同一套结构）', () => {
    const html = renderNode(videoNode({
      references: [{ id: 'r1', url: '/api/files/img_a.png', title: '图A', kind: 'image' }],
    }));
    expect(html).toContain('image-node-composer-ref');
    expect(html).toContain('image-node-composer-ref-index');
    expect(html).toContain('/api/files/img_a.png');
  });

  it('纯文本引用不参与首帧（视频不需要文案引用）', () => {
    const html = renderNode(videoNode({
      references: [{ id: 'r2', url: '', title: '文案', kind: 'text', text: '一段描述' }],
    }));
    // 文本引用照常显示（点击可拼进提示词），但没有图片 chip 的编号徽标
    expect(html).toContain('image-node-composer-ref-text');
    expect(html).not.toContain('image-node-composer-ref-index');
  });
});

describe('图片 composer 未被视频改动破坏', () => {
  it('普通 composer 仍然渲染原样', () => {
    const html = renderNode(imageComposer());
    expect(html).toContain('image-node-composer');
    expect(html).not.toContain('image-node-video');
    expect(html).toContain('aria-label="上传参考图"');
  });
});

describe('图片结果角标', () => {
  it('尺寸与复制入口带悬停入场类名，动效由媒体容器 hover 触发', () => {
    const html = renderNode(imageComposer({
      kind: 'image',
      imageUrl: '/api/files/img_done.png',
      size: '1024x1024',
    }));
    expect(html).toContain('image-node-meta-badges image-node-result-meta');
    expect(html).toContain('aria-label="复制图片"');
  });
});
