import type { CSSProperties } from 'react';
import './ParameterSlider.css';

export interface ParameterSliderProps {
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  valueLabel: string;
  minLabel?: string;
  maxLabel?: string;
  scaleInside?: boolean;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export default function ParameterSlider({
  ariaLabel,
  value,
  min,
  max,
  valueLabel,
  minLabel,
  maxLabel,
  scaleInside = false,
  disabled = false,
  onChange,
}: ParameterSliderProps) {
  const ratio = max > min ? (value - min) / (max - min) : 0;
  const style = { '--parameter-slider-ratio': String(ratio) } as CSSProperties;

  const input = (
    <input
      type="range"
      min={min}
      max={max}
      step={1}
      value={value}
      aria-label={ariaLabel}
      aria-valuetext={valueLabel}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
    />
  );

  return (
    <div className={`parameter-slider${scaleInside ? ' is-scale-inside' : ''}`} style={style}>
      <div className="parameter-slider-main">
        {scaleInside ? (
          <div className="parameter-slider-track">
            <span className="parameter-slider-ticks" aria-hidden="true"><i /><i /><i /></span>
            {input}
            <span className="parameter-slider-edge-label is-min" aria-hidden="true">{minLabel || ''}</span>
            <span className="parameter-slider-edge-label is-max" aria-hidden="true">{maxLabel || ''}</span>
          </div>
        ) : input}
        <output className="parameter-slider-output">{valueLabel}</output>
      </div>
      {!scaleInside && (minLabel !== undefined || maxLabel !== undefined) ? (
        <div className="parameter-slider-scale" aria-hidden="true">
          <span>{minLabel || ''}</span>
          <span>{maxLabel || ''}</span>
        </div>
      ) : null}
    </div>
  );
}
