import { useLayoutEffect, useRef, useState } from "react";

/**
 * A segmented track: one raised thumb glides under the picked option. The thumb takes the picked
 * option's measured place, so options keep their own widths. Each label reserves its bold width
 * with an invisible copy, so picking one never shifts its neighbours.
 */
export function Segmented<Id extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: ReadonlyArray<{ id: Id; label: string; locked?: boolean }>;
  value: Id;
  onChange: (id: Id) => void;
  className?: string;
}) {
  const buttons = useRef(new Map<Id, HTMLButtonElement>());
  const [thumb, setThumb] = useState<{ x: number; width: number }>();
  useLayoutEffect(() => {
    const button = buttons.current.get(value);
    if (button === undefined) return;
    const measure = () => setThumb({ x: button.offsetLeft, width: button.offsetWidth });
    measure();
    // Fonts arriving late, or a label changing, resize the option under the thumb.
    const observer = new ResizeObserver(measure);
    observer.observe(button);
    return () => observer.disconnect();
  }, [value]);
  return (
    <div
      className={className === undefined ? "segmented" : `segmented ${className}`}
      role="group"
      aria-label={label}
    >
      {thumb ? (
        <span
          className="segmented-thumb"
          aria-hidden="true"
          style={{ width: thumb.width, transform: `translateX(${thumb.x}px)` }}
        />
      ) : null}
      {options.map((option) => (
        <button
          type="button"
          key={option.id}
          ref={(button) => {
            if (button === null) buttons.current.delete(option.id);
            else buttons.current.set(option.id, button);
          }}
          className="segmented-option pressable"
          aria-pressed={value === option.id}
          data-locked={option.locked === true ? "" : undefined}
          onClick={() => onChange(option.id)}
        >
          <span className="segmented-label">{option.label}</span>
          <span className="segmented-ghost" aria-hidden="true">
            {option.label}
          </span>
        </button>
      ))}
    </div>
  );
}
