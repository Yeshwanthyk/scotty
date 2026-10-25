// Scotty's oxlint rules: the parts of AGENTS.md and .agents/skills/ a machine
// can check. Which files are host boundaries is decided in .oxlintrc.json.
import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];
type Create = NonNullable<Rule["create"]>;
type Visitor = ReturnType<Create>;
type NodeOf<K extends string> = Parameters<NonNullable<Visitor[K]>>[0];

// `object.property`, where both sides are plain names (no computed access).
const memberPath = (node: NodeOf<"MemberExpression">): readonly [string, string] | undefined =>
  !node.computed && node.object.type === "Identifier" && node.property.type === "Identifier"
    ? [node.object.name, node.property.name]
    : undefined;

const rule = (description: string, create: Create): Rule => ({
  meta: { type: "problem", docs: { description } },
  create,
});

// modeling-effect-errors: Effect.run* lives only at a host boundary.
const noEffectRun = rule("Run Effects only at a host boundary", (context) => ({
  MemberExpression(node) {
    const path = memberPath(node);
    if (path?.[0] === "Effect" && path[1].startsWith("run")) {
      context.report({
        node,
        message: `Effect.${path[1]} runs an Effect outside a host boundary. Return the Effect, or add this file to the boundary list in .oxlintrc.json if it is the host's entrypoint.`,
      });
    }
  },
}));

// decoding-effect-boundaries: JSON text is decoded with Schema.fromJsonString.
const noJsonParse = rule("Decode JSON text with Schema", (context) => ({
  MemberExpression(node) {
    const path = memberPath(node);
    if (path?.[0] === "JSON" && path[1] === "parse") {
      context.report({
        node,
        message:
          "JSON.parse returns an unchecked value. Decode with Schema.decodeUnknown*(Schema.fromJsonString(X)).",
      });
    }
  },
}));

// AGENTS.md: no casts that hide a type. `as const` is not a cast.
const noTypeAssertion = rule("No type assertions", (context) => {
  const report = (node: NodeOf<"TSAsExpression"> | NodeOf<"TSTypeAssertion">) =>
    context.report({
      node,
      message:
        "A type assertion hides the real type. Decode with Schema, narrow with a guard, or fix the type.",
    });
  return {
    TSAsExpression(node) {
      const annotation = node.typeAnnotation;
      const isConst =
        annotation.type === "TSTypeReference" &&
        annotation.typeName.type === "Identifier" &&
        annotation.typeName.name === "const";
      if (!isConst) report(node);
    },
    TSTypeAssertion: report,
  };
});

// modeling-effect-errors: a failure inside Effect.gen is `yield* new Tagged(...)`.
const noThrowInGenerator = rule("No throw inside a generator", (context) => {
  const generators: Array<boolean> = [];
  const enter = (node: { readonly generator?: boolean }) =>
    generators.push(node.generator === true);
  const exit = () => generators.pop();
  return {
    FunctionDeclaration: enter,
    "FunctionDeclaration:exit": exit,
    FunctionExpression: enter,
    "FunctionExpression:exit": exit,
    ArrowFunctionExpression: enter,
    "ArrowFunctionExpression:exit": exit,
    ThrowStatement(node) {
      if (generators.at(-1) === true) {
        context.report({
          node,
          message:
            "A throw inside Effect.gen becomes a defect. Fail in the typed channel: `return yield* new SomeError(...)`.",
        });
      }
    },
  };
});

// AGENTS.md: fold.ts reads no clock and no random numbers, and does no I/O. A global is matched
// bare or through `globalThis`, `self` or `window`, including when it is destructured.
const impure = new Map([
  ["Date", new Set(["now"])],
  ["Math", new Set(["random"])],
  ["performance", new Set(["now"])],
  ["crypto", undefined],
  ["console", undefined],
]);
const impureCalls = new Set(["fetch", "setTimeout", "setInterval", "queueMicrotask"]);
const globalObjects = new Set(["globalThis", "self", "window"]);
type Expression = NodeOf<"MemberExpression">["object"];
// `Date`, or `globalThis.Date`: the global an expression names.
const globalName = (node: Expression): string | undefined => {
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return undefined;
  const path = memberPath(node);
  return path !== undefined && globalObjects.has(path[0]) ? path[1] : undefined;
};
const pureFold = rule("The fold is pure", (context) => {
  const report = (
    node: NodeOf<"MemberExpression" | "NewExpression" | "CallExpression" | "VariableDeclarator">,
    what: string,
  ) =>
    context.report({
      node,
      message: `${what} is impure. The fold takes time from each event's \`at\` and does no I/O.`,
    });
  return {
    MemberExpression(node) {
      if (node.computed || node.property.type !== "Identifier") return;
      const name = globalName(node.object);
      if (name === undefined || !impure.has(name)) return;
      const members = impure.get(name);
      if (members === undefined || members.has(node.property.name)) {
        report(node, `${name}.${node.property.name}`);
      }
    },
    VariableDeclarator(node) {
      if (node.id.type !== "ObjectPattern" || node.init === null) return;
      const name = globalName(node.init);
      if (name === undefined || !impure.has(name)) return;
      const members = impure.get(name);
      for (const property of node.id.properties) {
        const key =
          property.type === "Property" && !property.computed && property.key.type === "Identifier"
            ? property.key.name
            : undefined;
        // A rest element or computed key could take any member.
        if (members === undefined || key === undefined || members.has(key)) {
          report(node, `${name}.${key ?? "*"}`);
          return;
        }
      }
    },
    NewExpression(node) {
      if (globalName(node.callee) === "Date" && node.arguments.length === 0) {
        report(node, "new Date()");
      }
    },
    CallExpression(node) {
      const name = globalName(node.callee);
      if (name !== undefined && impureCalls.has(name)) report(node, name);
    },
  };
});

export default {
  meta: { name: "scotty" },
  rules: {
    "no-effect-run": noEffectRun,
    "no-json-parse": noJsonParse,
    "no-type-assertion": noTypeAssertion,
    "no-throw-in-generator": noThrowInGenerator,
    "pure-fold": pureFold,
  },
};
