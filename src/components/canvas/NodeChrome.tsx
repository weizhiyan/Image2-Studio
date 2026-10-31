import { Children, isValidElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Handle } from '@xyflow/react';

interface NodeChromeProps {
  title: string;
  tone: string;
  /** tone 之下再分一档色相（目前只有生图 Agent 的 "image"）。见 Nodes.css 的 tone 表。 */
  variant?: string;
  selected?: boolean;
  className?: string;
  style?: CSSProperties;
  afterCard?: ReactNode;
  children: ReactNode;
}

export function NodeChrome({ title, tone, variant, selected, className = '', style, afterCard, children }: NodeChromeProps) {
  const childItems = Children.toArray(children);
  const handles = childItems.filter((child) => isValidElement(child) && child.type === Handle);
  const content = childItems.filter((child) => !(isValidElement(child) && child.type === Handle));

  return (
    <div
      className={`canvas-node ${className} ${selected ? 'node-selected' : ''}`}
      data-tone={tone}
      data-variant={variant}
      style={style}
    >
      <div className="node-header" data-tone={tone} data-variant={variant}>
        <span className="node-title">{title}</span>
      </div>
      {handles}
      <div className="node-panel-card">
        {content}
      </div>
      {afterCard}
    </div>
  );
}

export function NodePortRow({ label, tone }: { label: string; tone: string }) {
  return (
    <div className="node-port-row">
      <span className={`node-port-dot ${tone}`} />
      <span>{label}</span>
    </div>
  );
}

export function NodeButton({
  children,
  className = '',
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button className={`node-control node-button nodrag nopan ${className}`} type="button" onClick={onClick}>
      {children}
    </button>
  );
}

export interface NodeSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface NodeSelectProps {
  value: string;
  options: NodeSelectOption[];
  placeholder?: string;
  className?: string;
  menuClassName?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
}

/** Shared application menu for canvas selects. Keeps browser-native menus out of the workflow UI. */
export function NodeSelect({
  value,
  options,
  placeholder = '请选择...',
  className = '',
  menuClassName = '',
  disabled = false,
  autoFocus = false,
  ariaLabel,
  onChange,
}: NodeSelectProps) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<FloatingMenuRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (rootRef.current?.contains(target) || menuRef.current?.contains(target))) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  useEffect(() => {
    if (autoFocus) triggerRef.current?.focus();
  }, [autoFocus]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const updateMenuPosition = () => {
      if (!triggerRef.current) return;
      setMenuRect(getFloatingMenuRect(triggerRef.current));
    };
    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [open, options.length]);

  const menu = open && menuRect ? (
    <div
      ref={menuRef}
      className={`node-custom-select-menu node-floating-select-menu ${className} ${menuClassName}`}
      role="listbox"
      aria-label={ariaLabel}
      style={{
        left: menuRect.left,
        top: menuRect.top,
        width: menuRect.width,
        maxHeight: menuRect.maxHeight,
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      {options.length === 0 ? (
        <div className="node-custom-select-empty">暂无可选内容</div>
      ) : options.map((option) => (
        <button
          className={`node-custom-select-item ${option.value === value ? 'active' : ''}`}
          type="button"
          role="option"
          aria-selected={option.value === value}
          disabled={option.disabled}
          key={option.value}
          onClick={() => {
            if (option.disabled) return;
            onChange(option.value);
            setOpen(false);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className={`node-custom-select-wrap nodrag nopan ${className}`} ref={rootRef}>
      <button
        ref={triggerRef}
        className={`node-custom-select-trigger ${open ? 'open' : ''} ${!selected ? 'is-placeholder' : ''}`}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          if (!disabled) setOpen((current) => !current);
        }}
      >
        <span>{selected?.label || placeholder}</span>
        <ChevronIcon />
      </button>
      {menu ? createPortal(menu, document.body) : null}
    </div>
  );
}

type FloatingMenuRect = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

const FLOATING_MENU_MARGIN = 12;
const FLOATING_MENU_GAP = 6;
const FLOATING_MENU_MAX_HEIGHT = 280;

function getFloatingMenuRect(anchor: HTMLElement): FloatingMenuRect {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(Math.max(rect.width, 180), viewportWidth - FLOATING_MENU_MARGIN * 2);
  const left = clamp(rect.left, FLOATING_MENU_MARGIN, viewportWidth - FLOATING_MENU_MARGIN - width);
  const below = viewportHeight - rect.bottom - FLOATING_MENU_MARGIN - FLOATING_MENU_GAP;
  const above = rect.top - FLOATING_MENU_MARGIN - FLOATING_MENU_GAP;
  const openAbove = below < 150 && above > below;
  const availableHeight = Math.max(96, openAbove ? above : below);
  const maxHeight = Math.min(FLOATING_MENU_MAX_HEIGHT, availableHeight);
  const top = openAbove
    ? Math.max(FLOATING_MENU_MARGIN, rect.top - FLOATING_MENU_GAP - maxHeight)
    : Math.min(viewportHeight - FLOATING_MENU_MARGIN - maxHeight, rect.bottom + FLOATING_MENU_GAP);
  return { left, top, width, maxHeight };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function ChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m7 10 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** 重命名：铅笔（画布下拉菜单行的编辑入口，与 TrashIcon 同规格） */
export function EditIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 20h4l10.5-10.5a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5V20Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.5 6.5 17.5 9.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 7h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="m18 7-.7 11.2A2 2 0 0 1 15.3 20H8.7a2 2 0 0 1-2-1.8L6 7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v5M14 11v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/** 资产库入口：左侧功能竖条与大图预览的收藏入口共用同一图形。 */
export function AssetGlyphIcon() {
  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15.9998 4.90009C16.2482 4.89991 16.4893 4.98382 16.684 5.13816C16.8786 5.29249 17.0153 5.50817 17.0718 5.75009V5.75209L17.0738 5.75809L17.0818 5.79209L17.1178 5.93609C17.3215 6.71826 17.5638 7.48987 17.8438 8.24809C18.3718 9.67209 19.0998 11.1821 19.9578 12.0421C20.8178 12.9021 22.3278 13.6281 23.7518 14.1561C24.51 14.436 25.2816 14.6783 26.0638 14.8821L26.2078 14.9181L26.2418 14.9261H26.2478C26.4899 14.9825 26.7058 15.1192 26.8604 15.3138C27.0151 15.5085 27.0994 15.7497 27.0996 15.9983C27.0998 16.2469 27.016 16.4883 26.8617 16.6832C26.7074 16.8782 26.4918 17.0152 26.2498 17.0721H26.2478L26.2418 17.0741L26.2058 17.0821L26.0658 17.1181C25.2836 17.3218 24.512 17.5641 23.7538 17.8441C22.3278 18.3721 20.8178 19.1001 19.9578 19.9601C19.0978 20.8201 18.3718 22.3281 17.8438 23.7521C17.5638 24.5103 17.3215 25.2819 17.1178 26.0641L17.0818 26.2081L17.0738 26.2421V26.2481C17.0173 26.4902 16.8807 26.7061 16.686 26.8608C16.4914 27.0154 16.2502 27.0997 16.0015 27.0999C15.7529 27.1002 15.5116 27.0163 15.3166 26.8621C15.1217 26.7078 14.9846 26.4921 14.9278 26.2501V26.2481L14.9258 26.2421L14.9178 26.2061L14.8818 26.0661C14.678 25.2839 14.4357 24.5123 14.1558 23.7541C13.6278 22.3281 12.8998 20.8181 12.0418 19.9581C11.1818 19.0981 9.67176 18.3721 8.24776 17.8441C7.48954 17.5641 6.71793 17.3218 5.93576 17.1181L5.79176 17.0801L5.75976 17.0741H5.75176C5.50964 17.0177 5.29372 16.881 5.13907 16.6864C4.98442 16.4917 4.90013 16.2505 4.8999 16.0019C4.89967 15.7533 4.98351 15.5119 5.13779 15.3169C5.29208 15.122 5.50775 14.985 5.74976 14.9281H5.75176L5.75776 14.9261L5.79176 14.9181L5.93576 14.8821C6.71793 14.6784 7.48954 14.4361 8.24776 14.1561C9.67176 13.6281 11.1818 12.9001 12.0418 12.0421C12.9018 11.1821 13.6278 9.67209 14.1558 8.24809C14.4358 7.48987 14.6781 6.71826 14.8818 5.93609L14.9178 5.79209L14.9258 5.75809V5.75209C14.9822 5.50964 15.1191 5.29346 15.3141 5.13875C15.5092 4.98404 15.7508 4.89992 15.9998 4.90009Z" />
    </svg>
  );
}
