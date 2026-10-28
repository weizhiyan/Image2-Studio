import type { CSSProperties, KeyboardEvent } from 'react';
import './QuantitySegments.css';

export default function QuantitySegments({ ariaLabel, value, min, max, options, disabled = false, onChange }: {
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  options?: number[];
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const values = options?.length
    ? [...new Set(options.filter((option) => Number.isInteger(option)))]
    : Array.from({ length: Math.max(1, max - min + 1) }, (_, index) => min + index);
  const selected = values.includes(value) ? value : min;
  const selectedIndex = Math.max(0, values.indexOf(selected));
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1
      : event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % values.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index - 1 + values.length) % values.length : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(values[next]);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };
  return (
    <div className="quantity-segments" role="radiogroup" aria-label={ariaLabel}>
      <span
        aria-hidden="true"
        className="quantity-segments-thumb"
        style={{ '--segment-count': values.length, '--segment-index': selectedIndex } as CSSProperties}
      />
      {values.map((quantity, index) => (
        <button key={quantity} type="button" role="radio" aria-checked={selected === quantity}
          tabIndex={selected === quantity ? 0 : -1} disabled={disabled}
          onClick={() => onChange(quantity)} onKeyDown={(event) => navigate(event, index)}>
          {quantity}
        </button>
      ))}
    </div>
  );
}
