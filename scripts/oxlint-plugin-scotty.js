import noConditionalTests from "./oxlint-plugin-scotty/rules/no-conditional-tests.js";
import noDoubleCast from "./oxlint-plugin-scotty/rules/no-double-cast.js";
import noEffectEscapeHatch from "./oxlint-plugin-scotty/rules/no-effect-escape-hatch.js";
import noEffectInternalTags from "./oxlint-plugin-scotty/rules/no-effect-internal-tags.js";
import noEffectRunSyncInTests from "./oxlint-plugin-scotty/rules/no-effect-run-sync-in-tests.js";
import noEffectRuntimeEscape from "./oxlint-plugin-scotty/rules/no-effect-runtime-escape.js";
import noErrorConstructor from "./oxlint-plugin-scotty/rules/no-error-constructor.js";
import noInlineObjectTypeAssertion from "./oxlint-plugin-scotty/rules/no-inline-object-type-assertion.js";
import noInlineSchemaCompile from "./oxlint-plugin-scotty/rules/no-inline-schema-compile.js";
import noInstanceofError from "./oxlint-plugin-scotty/rules/no-instanceof-error.js";
import noInstanceofTaggedError from "./oxlint-plugin-scotty/rules/no-instanceof-tagged-error.js";
import noJsonParse from "./oxlint-plugin-scotty/rules/no-json-parse.js";
import noPromiseCatch from "./oxlint-plugin-scotty/rules/no-promise-catch.js";
import noPromiseReject from "./oxlint-plugin-scotty/rules/no-promise-reject.js";
import noRawWallClock from "./oxlint-plugin-scotty/rules/no-raw-wall-clock.js";
import noTryCatchOrThrow from "./oxlint-plugin-scotty/rules/no-try-catch-or-throw.js";
import noTsNocheck from "./oxlint-plugin-scotty/rules/no-ts-nocheck.js";
import noUnknownErrorMessage from "./oxlint-plugin-scotty/rules/no-unknown-error-message.js";
import noUnknownShapeProbing from "./oxlint-plugin-scotty/rules/no-unknown-shape-probing.js";
import preferSchemaInferredTypes from "./oxlint-plugin-scotty/rules/prefer-schema-inferred-types.js";
import preferYieldTaggedError from "./oxlint-plugin-scotty/rules/prefer-yield-tagged-error.js";

export default {
  meta: { name: "scotty" },
  rules: {
    "no-conditional-tests": noConditionalTests,
    "no-double-cast": noDoubleCast,
    "no-effect-escape-hatch": noEffectEscapeHatch,
    "no-effect-internal-tags": noEffectInternalTags,
    "no-effect-run-sync-in-tests": noEffectRunSyncInTests,
    "no-effect-runtime-escape": noEffectRuntimeEscape,
    "no-error-constructor": noErrorConstructor,
    "no-inline-object-type-assertion": noInlineObjectTypeAssertion,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-instanceof-error": noInstanceofError,
    "no-instanceof-tagged-error": noInstanceofTaggedError,
    "no-json-parse": noJsonParse,
    "no-promise-catch": noPromiseCatch,
    "no-promise-reject": noPromiseReject,
    "no-raw-wall-clock": noRawWallClock,
    "no-try-catch-or-throw": noTryCatchOrThrow,
    "no-ts-nocheck": noTsNocheck,
    "no-unknown-error-message": noUnknownErrorMessage,
    "no-unknown-shape-probing": noUnknownShapeProbing,
    "prefer-schema-inferred-types": preferSchemaInferredTypes,
    "prefer-yield-tagged-error": preferYieldTaggedError,
  },
};
