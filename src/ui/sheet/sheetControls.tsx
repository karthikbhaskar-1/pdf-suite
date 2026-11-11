import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { LengthUnit } from '../../core/stores/sheetStore';
import { UNIT_LABELS } from '../../features/organizer/units';

/** Controls the side sheets share: a segmented choice, a unit select and a number field. */

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // A standard radio group (1.5.5 C1): one tab stop (the chosen option), arrows choose the next or previous option and
  // wrap, Home and End choose the first and the last. Choosing moves the focus with it.
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    refs.current[index]?.focus();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const last = options.length - 1;
    let target: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        target = index === last ? 0 : index + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        target = index === 0 ? last : index - 1;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    choose(target);
  };
  const chosen = options.findIndex((option) => option.value === value);
  return (
    <div className="side-segmented" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={index === (chosen < 0 ? 0 : chosen) ? 0 : -1}
          className={value === option.value ? 'side-seg side-seg-on' : 'side-seg'}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function UnitSelect({ value, onChange }: { value: LengthUnit; onChange: (unit: LengthUnit) => void }) {
  return (
    <select aria-label="Units" className="side-input side-unit" value={value} onChange={(e) => onChange(e.target.value as LengthUnit)}>
      {(['in', 'mm', 'pt'] as LengthUnit[]).map((unit) => (
        <option key={unit} value={unit}>
          {UNIT_LABELS[unit]}
        </option>
      ))}
    </select>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      aria-label={label}
      className="side-input"
      value={Number.isFinite(value) ? value : ''}
      min={min}
      max={max}
      step={step ?? 'any'}
      onChange={(e) => {
        const next = e.target.valueAsNumber;
        if (Number.isFinite(next)) onChange(next);
      }}
    />
  );
}

