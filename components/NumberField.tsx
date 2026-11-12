'use client';

import { useEffect, useState } from 'react';

interface Props {
  value: number;
  min: number;
  max: number;
  /** 每次点 +/- 的步长，默认 1 */
  step?: number;
  /** 输入框右侧的单位，如「秒」 */
  unit?: string;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * 数字输入器：可手动输入，也可点 +/- 逐档调整。
 *
 * 输入过程中只改本地文本，失焦 / 回车时才夹进 [min, max] 并回调，
 * 这样清空重填时不会被中途夹值打断；外部夹值（如切模型）在未聚焦时同步。
 */
export default function NumberField({
  value,
  min,
  max,
  step = 1,
  unit,
  ariaLabel,
  disabled = false,
  onChange,
}: Props) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  const parse = (raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clamp(parsed, min, max) : null;
  };

  /** 输入框里的值优先（可能还没提交），无效时退回已提交的值 */
  const current = parse(text) ?? clamp(value, min, max);

  const commit = (raw: string) => {
    const next = parse(raw);
    if (next === null) {
      setText(String(value));
      return;
    }
    setText(String(next));
    if (next !== value) onChange(next);
  };

  const nudge = (delta: number) => {
    const next = clamp(current + delta, min, max);
    setText(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div className="stepper">
      <button
        type="button"
        className="stepper-btn"
        onClick={() => nudge(-step)}
        disabled={disabled || current <= min}
        aria-label={`减少${ariaLabel}`}
      >
        −
      </button>
      <input
        className="stepper-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={text}
        aria-label={`${ariaLabel}，可手动输入，范围 ${min}~${max}`}
        disabled={disabled}
        onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          setFocused(false);
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(e.currentTarget.value);
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setText(String(value));
            e.currentTarget.blur();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            nudge(step);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            nudge(-step);
          }
        }}
      />
      {unit && <span className="stepper-unit">{unit}</span>}
      <button
        type="button"
        className="stepper-btn"
        onClick={() => nudge(step)}
        disabled={disabled || current >= max}
        aria-label={`增加${ariaLabel}`}
      >
        +
      </button>
    </div>
  );
}
