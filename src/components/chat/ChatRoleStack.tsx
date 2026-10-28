import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { PromptSkill } from '@/lib/bridge';

export function RoleAvatar({ role }: { role: Pick<PromptSkill, 'name' | 'avatarUrl'> }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [role.avatarUrl]);
  return (
    <span className="hb-chat-role-avatar" aria-hidden="true">
      {role.avatarUrl && !failed
        ? <img src={role.avatarUrl} alt="" onError={() => setFailed(true)} />
        : <span>{Array.from(role.name.trim())[0] || '角'}</span>}
    </span>
  );
}

export function ChatRoleStack({
  roles,
  activeRoleId,
  onToggle,
}: {
  roles: PromptSkill[];
  activeRoleId: string;
  onToggle: (roleId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [hoveredRoleId, setHoveredRoleId] = useState('');
  const [focusedRoleId, setFocusedRoleId] = useState('');
  const [lastTooltipRole, setLastTooltipRole] = useState<PromptSkill>();
  const rootRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipLeft, setTooltipLeft] = useState<number>();
  const tooltipId = useId();
  const menuId = useId();
  const visibleRoles = roles.slice(0, roles.length > 5 ? 4 : 5);
  const hiddenRoles = roles.slice(visibleRoles.length);
  const hiddenActiveRole = hiddenRoles.find((role) => role.id === activeRoleId);
  const tooltipRole = roles.find((role) => role.id === (hoveredRoleId || focusedRoleId));
  const tooltipContent = tooltipRole || lastTooltipRole;
  const tooltipIndex = visibleRoles.findIndex((role) => role.id === tooltipRole?.id);
  const roleCount = visibleRoles.length + (hiddenRoles.length ? 1 : 0);

  useEffect(() => {
    const root = rootRef.current;
    const tooltip = tooltipRef.current;
    if (!root || !tooltip || !tooltipRole) return;
    const positionTooltip = () => {
      const picker = root.querySelector<HTMLElement>('.hb-chat-role-picker');
      const button = picker?.querySelector<HTMLElement>('.hb-chat-role-stack-button');
      if (!picker || !button) return;
      const step = roleCount > 1 ? (picker.offsetWidth - button.offsetWidth) / (roleCount - 1) : 0;
      const center = root.clientWidth - picker.offsetWidth + button.offsetWidth / 2 + Math.max(0, tooltipIndex) * step;
      setTooltipLeft(Math.max(0, Math.min(root.clientWidth - tooltip.offsetWidth, center - tooltip.offsetWidth / 2)));
    };
    positionTooltip();
    const observer = new ResizeObserver(positionTooltip);
    observer.observe(root);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [tooltipRole, tooltipIndex, roleCount]);

  useEffect(() => {
    if (!menuOpen && !tooltipRole) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      setHoveredRoleId('');
      setFocusedRoleId('');
      if (menuOpen) moreRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [menuOpen, tooltipRole]);

  if (roles.length === 0) return null;

  return (
    <div
      ref={rootRef}
      className={`hb-chat-role-lane${menuOpen ? ' is-open' : ''}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
      }}
    >
      <div
        className="hb-chat-role-picker"
        style={{ '--hb-role-count': roleCount } as CSSProperties}
        role="group"
        aria-label="对话角色"
        onPointerLeave={() => setHoveredRoleId('')}
      >
        {visibleRoles.map((role, index) => {
          const active = role.id === activeRoleId;
          const label = role.name;
          return (
            <button
              type="button"
              className={`hb-chat-role-stack-button${active ? ' is-active' : ''}`}
              style={{ '--hb-role-index': index } as CSSProperties}
              aria-label={active ? `${label}，已选，点击取消` : `选择角色 ${label}`}
              aria-pressed={active}
              aria-describedby={!menuOpen && tooltipRole?.id === role.id ? tooltipId : undefined}
              key={role.id}
              onClick={() => onToggle(role.id)}
              onPointerEnter={() => {
                setTooltipLeft(undefined);
                setLastTooltipRole(role);
                setHoveredRoleId(role.id);
              }}
              onFocus={(event) => {
                if (!event.currentTarget.matches(':focus-visible')) return;
                setLastTooltipRole(role);
                setFocusedRoleId(role.id);
              }}
              onBlur={() => setFocusedRoleId('')}
            >
              <RoleAvatar role={role} />
              <span className="hb-chat-role-check" aria-hidden="true">
                <svg viewBox="0 0 12 12" fill="none"><path d="m2.5 6 2.2 2.2 4.8-4.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </span>
            </button>
          );
        })}
        {hiddenRoles.length ? (
          <button
            ref={moreRef}
            type="button"
            className={`hb-chat-role-stack-button hb-chat-role-more${hiddenActiveRole ? ' is-active' : ''}`}
            style={{ '--hb-role-index': visibleRoles.length } as CSSProperties}
            aria-label={`更多角色，另有 ${hiddenRoles.length} 个${hiddenActiveRole ? `，当前角色 ${hiddenActiveRole.name}` : ''}`}
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onPointerEnter={() => setHoveredRoleId('')}
            onClick={() => {
              setHoveredRoleId('');
              setFocusedRoleId('');
              setMenuOpen((open) => !open);
            }}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" /></svg>
          </button>
        ) : null}
      </div>
      <div
        ref={tooltipRef}
        className={`hb-chat-role-tooltip${tooltipRole && !menuOpen ? ' is-visible' : ''}`}
        style={{ left: tooltipLeft }}
        id={tooltipId}
        role="tooltip"
        aria-hidden={!tooltipRole || menuOpen}
      >
        <strong>{tooltipContent?.name}</strong>
      </div>
      {menuOpen ? (
        <div className="hb-chat-role-menu" id={menuId} role="group" aria-label="更多对话角色">
          {hiddenRoles.map((role) => (
            <button
              key={role.id}
              type="button"
              className={`hb-chat-role-menu-item${role.id === activeRoleId ? ' is-active' : ''}`}
              aria-pressed={role.id === activeRoleId}
              onClick={() => {
                onToggle(role.id);
                setMenuOpen(false);
                moreRef.current?.focus();
              }}
            >
              <RoleAvatar role={role} />
              <span><strong>{role.name}</strong></span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
