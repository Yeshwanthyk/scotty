import { hourlyRate, Size, sizeSpec } from "../../../src/places/place";

const sizeLabel = (size: typeof Size.Type) => {
  const { vcpu, memory } = sizeSpec[size];
  return `${size} · ${vcpu === 0.5 ? "½" : vcpu} vCPU · ${memory} GiB · up to $${hourlyRate(size).toFixed(2)}/h`;
};

// The closed picker shows only the name, or `label` when the size isn't known yet; the open
// list shows what each size has and costs.
export function SizePicker({
  value,
  label,
  onChange,
}: {
  value: typeof Size.Type;
  label?: string;
  onChange: (size: typeof Size.Type) => void;
}) {
  return (
    <label className="repo-picker size-picker">
      <span>{label ?? value}</span>
      <select
        aria-label="Size"
        value={value}
        onChange={(event) => {
          const picked = Size.literals.find((size) => size === event.target.value);
          if (picked !== undefined) onChange(picked);
        }}
      >
        {Size.literals.map((size) => (
          <option key={size} value={size}>
            {sizeLabel(size)}
          </option>
        ))}
      </select>
    </label>
  );
}
