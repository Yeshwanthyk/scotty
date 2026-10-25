import { hourlyRate, Size, sizeSpec } from "../../../src/places/place";
import { Icon } from "./Icon";
import { Menu } from "./Menu";

const sizeDetail = (size: typeof Size.Type) => {
  const { vcpu, memory } = sizeSpec[size];
  return `${vcpu === 0.5 ? "½" : vcpu} vCPU · ${memory} GiB · up to $${hourlyRate(size).toFixed(2)}/h`;
};

// The closed picker shows only the name, or `label` when the size isn't known yet; the open
// list shows what each size has and costs.
export function SizePicker({
  value,
  label,
  side,
  align,
  onChange,
}: {
  value: typeof Size.Type;
  label?: string;
  side?: "top" | "bottom";
  align?: "start" | "end";
  onChange: (size: typeof Size.Type) => void;
}) {
  return (
    <Menu
      label="Size"
      className="repo-picker size-picker"
      side={side}
      align={align}
      items={Size.literals.map((size) => ({
        label: size,
        detail: sizeDetail(size),
        icon: "check",
        checked: size === value,
        onSelect: () => onChange(size),
      }))}
    >
      <span>{label ?? value}</span>
      <Icon name="chevronDown" size={12} />
    </Menu>
  );
}
