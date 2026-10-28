/** 对话面板专用字形图标：与 NodeToolbarIcons 同规范（currentColor 着色，尺寸随按钮）。
 *  定位 = 准星；发送 = 上箭头；关闭 / 清空 / 自动定位开关各一枚。 */

/** 定位到画布：准星（外圈 + 中心点 + 四向短线）。 */
export function LocateGlyphIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 发送：上箭头（圆底按钮里用）。 */
export function SendGlyphIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 13V3M8 3 3.5 7.5M8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 关闭：×。 */
export function CloseGlyphIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m3.5 3.5 9 9m0-9-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 清空对话：垃圾桶。 */
export function TrashGlyphIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4h11M6.5 4V2.75A.75.75 0 0 1 7.25 2h1.5a.75.75 0 0 1 .75.75V4M4 4l.6 8.6a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 引用到对话：气泡（消息图片「引用」按钮用，18px 与同排图标对齐）。 */
export function ChatRefGlyphIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M4 3.5h10A1.5 1.5 0 0 1 15.5 5v5a1.5 1.5 0 0 1-1.5 1.5H7.5L4 14.5V12A1.5 1.5 0 0 1 2.5 10.5V5A1.5 1.5 0 0 1 4 3.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** 添加图片：相框 + 加号（输入区「添加图片」入口）。 */
export function PlusImageGlyphIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.5 3.5v11M2.5 9h13" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** @ 引用：圈 A（输入区「@ 图片/节点」入口）。 */
export function AtGlyphIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.4" />
      <path d="M12 9v1.5a2.5 2.5 0 0 0 5 0V9a8 8 0 1 0-3.2 6.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 角色：头像轮廓（输入框左上角角色选择入口）。 */
export function RoleGlyphIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.25 13c.45-2.45 2.1-3.75 4.75-3.75S12.3 10.55 12.75 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 历史对话：时钟（标题栏下拉入口）。 */
export function HistoryGlyphIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 4.25V7l2 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 下拉箭头（标题 / 展开折叠方向）。 */
export function ChevronGlyphIcon({ up = false }: { up?: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" style={up ? { transform: 'rotate(180deg)' } : undefined}>
      <path d="m3.5 5.25 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 新建对话：加号（历史菜单顶部）。 */
export function NewThreadGlyphIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 更多：竖三点（线程操作菜单）。 */
export function MoreGlyphIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="3.5" r="1.1" fill="currentColor" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
      <circle cx="8" cy="12.5" r="1.1" fill="currentColor" />
    </svg>
  );
}

/** 重命名对话：铅笔。 */
export function PencilGlyphIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 15 15" fill="none" aria-hidden="true">
      <path d="m3 10.9-.55 2.1 2.1-.55L12.2 4.8a1.1 1.1 0 0 0 0-1.55l-.45-.45a1.1 1.1 0 0 0-1.55 0L3 10.9Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="m8.95 3.75 2.3 2.3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

/** 停止：方块（Agent 运行中替换发送按钮）。 */
export function StopGlyphIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" fill="currentColor" />
    </svg>
  );
}

/** 复制：双页（Agent 回复旁）。 */
export function CopyGlyphIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="7.5" height="7.5" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9.5 2.5h-6a1 1 0 0 0-1 1v6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function CopySuccessGlyphIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="m2.5 7.25 2.6 2.6 6.4-6.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 重试：回转箭头（工具失败卡）。 */
export function RetryGlyphIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M11.5 1.75V4.5H8.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 展开/收起：右箭头（工具过程卡折叠态）。 */
export function FoldGlyphIcon({ open = false }: { open?: boolean }) {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true" style={open ? { transform: 'rotate(90deg)' } : undefined}>
      <path d="m4.25 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IdGlyphIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M1.5 3.5h3m-1.5 0v7m-1.5 0h3M7 3.5h2a3.5 3.5 0 0 1 0 7H7v-7Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
