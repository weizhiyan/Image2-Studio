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
