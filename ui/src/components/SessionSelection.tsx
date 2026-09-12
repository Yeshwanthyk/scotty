import { createContext, useContext } from "react";

export const SessionSelection = createContext<string | null>(null);

export function SessionSelectionLabel() {
  const label = useContext(SessionSelection);
  return label === null ? null : (
    <span
      className="session-selection-label"
      aria-label="Configured agent, provider, model, and thinking"
    >
      {label.split(" · ").map((part, index) => (
        <span key={`${index}-${part}`}>{part}</span>
      ))}
    </span>
  );
}
