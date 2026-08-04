function canonicalValue(value, seen) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return '"number:nan"';
    if (value === Infinity) return '"number:infinity"';
    if (value === -Infinity) return '"number:-infinity"';
    if (Object.is(value, -0)) return '"number:-0"';
    return String(value);
  }
  if (typeof value === "undefined") return '"undefined"';
  if (typeof value === "bigint") return JSON.stringify(`bigint:${value}`);
  if (typeof value !== "object") return JSON.stringify(`${typeof value}:${String(value)}`);
  if (seen.has(value)) return '"circular"';

  seen.add(value);
  let signature;
  if (Array.isArray(value)) {
    signature = `[${value.map((item) => canonicalValue(item, seen)).join(",")}]`;
  } else if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([key, item]) => [canonicalValue(key, seen), canonicalValue(item, seen)])
      .sort(([left], [right]) => left.localeCompare(right));
    signature = `[${entries.map(([key, item]) => `[${key},${item}]`).join(",")}]`;
  } else if (value instanceof Set) {
    signature = `[${[...value]
      .map((item) => canonicalValue(item, seen))
      .sort()
      .join(",")}]`;
  } else {
    signature = `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`)
      .join(",")}}`;
  }
  seen.delete(value);
  return signature;
}

export function semanticSignature(value) {
  return canonicalValue(value, new Set());
}

export function resolveKeyedItems(previous, entries) {
  const next = new Map();
  const nodes = [];
  let added = 0;
  let replaced = 0;
  let reused = 0;

  for (const entry of entries) {
    if (next.has(entry.key)) throw new Error(`Duplicate worklog key: ${entry.key}`);
    const prior = previous.get(entry.key);
    let node;
    if (prior?.signature === entry.signature) {
      node = prior.node;
      reused += 1;
    } else {
      node = entry.render();
      if (prior) replaced += 1;
      else added += 1;
    }
    next.set(entry.key, { node, signature: entry.signature });
    nodes.push(node);
  }

  return {
    next,
    nodes,
    added,
    removed: [...previous.keys()].filter((key) => !next.has(key)).length,
    replaced,
    reused,
  };
}

function patchChildren(container, nodes) {
  const desired = new Set(nodes);
  for (let index = container.children.length - 1; index >= 0; index -= 1) {
    const child = container.children[index];
    if (!desired.has(child)) container.removeChild(child);
  }
  for (const [index, node] of nodes.entries()) {
    const current = container.children[index] ?? null;
    if (current !== node) container.insertBefore(node, current);
  }
}

export function createWorklogView(container) {
  let rendered = new Map();
  return {
    update(entries) {
      const result = resolveKeyedItems(rendered, entries);
      patchChildren(container, result.nodes);
      rendered = result.next;
      return {
        added: result.added,
        removed: result.removed,
        replaced: result.replaced,
        reused: result.reused,
      };
    },
  };
}

export function meaningfulWorklogAnnouncement({ type, method, wasActive, isActive }) {
  if (
    type === "extension_ui_request" &&
    ["select", "confirm", "input", "editor"].includes(method)
  ) {
    return "Pi needs your input.";
  }
  if (!wasActive && isActive) return "Pi started working.";
  if (wasActive && !isActive) return "Pi finished working.";
  return undefined;
}
