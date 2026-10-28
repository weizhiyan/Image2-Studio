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
  disabled = false,
  onChange,
}: ParameterSliderProps) {
  const progress = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const style = { '--parameter-slider-progress': `${progress}%` } as CSSProperties;

  return (
    <div className="parameter-slider">
      <div className="parameter-slider-main">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-label={ariaLabel}
          aria-valuetext={valueLabel}
          disabled={disabled}
          style={style}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        />
        <output className="parameter-slider-output">{valueLabel}</output>
      </div>
      {minLabel !== undefined || maxLabel !== undefined ? (
        <div className="parameter-slider-scale" aria-hidden="true">
          <span>{minLabel || ''}</span>
          <span>{maxLabel || ''}</span>
        </div>
      ) : null}
    </div>
  );
}
