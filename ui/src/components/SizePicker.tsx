import { Size } from "../../../src/places/place";

// Each size's vCPU, memory (GiB) and disk (GB), from
// https://developers.cloudflare.com/containers/platform-details/limits/ (read 2026-10-19).
const sizeSpec = {
  "standard-1": { vcpu: 0.5, memory: 4, disk: 8 },
  "standard-2": { vcpu: 1, memory: 6, disk: 12 },
  "standard-3": { vcpu: 2, memory: 8, disk: 16 },
  "standard-4": { vcpu: 4, memory: 12, disk: 20 },
} as const;
// The most an hour costs: memory and disk are billed as provisioned, vCPU by active use (here
// all of it). Per-second rates from https://developers.cloudflare.com/containers/pricing/
// (read 2026-10-19), ignoring the monthly included usage.
const sizeLabel = (size: typeof Size.Type) => {
  const { vcpu, memory, disk } = sizeSpec[size];
  const price = 3600 * (vcpu * 0.00002 + memory * 0.0000025 + disk * 0.00000007);
  return `${size} · ${vcpu === 0.5 ? "½" : vcpu} vCPU · ${memory} GiB · up to $${price.toFixed(2)}/h`;
};

// The closed picker shows only the name; the open list shows what each size has and costs.
export function SizePicker({
  value,
  onChange,
}: {
  value: typeof Size.Type;
  onChange: (size: typeof Size.Type) => void;
}) {
  return (
    <label className="repo-picker size-picker">
      <span>{value}</span>
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
