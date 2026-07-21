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
import noManualTagCheck from "./oxlint-plugin-scotty/rules/no-manual-tag-check.js";
import noMatchOrelse from "./oxlint-plugin-scotty/rules/no-match-orelse.js";
import noPromiseCatch from "./oxlint-plugin-scotty/rules/no-promise-catch.js";
import noPromiseClientSurface from "./oxlint-plugin-scotty/rules/no-promise-client-surface.js";
import noPromiseReject from "./oxlint-plugin-scotty/rules/no-promise-reject.js";
import noRawErrorThrow from "./oxlint-plugin-scotty/rules/no-raw-error-throw.js";
import noRawFetch from "./oxlint-plugin-scotty/rules/no-raw-fetch.js";
import noRawWallClock from "./oxlint-plugin-scotty/rules/no-raw-wall-clock.js";
import noRedundantErrorFactory from "./oxlint-plugin-scotty/rules/no-redundant-error-factory.js";
import noRedundantPrimitiveCast from "./oxlint-plugin-scotty/rules/no-redundant-primitive-cast.js";
import noSchemaClass from "./oxlint-plugin-scotty/rules/no-schema-class.js";
import noSwitchStatement from "./oxlint-plugin-scotty/rules/no-switch-statement.js";
import noTryCatchOrThrow from "./oxlint-plugin-scotty/rules/no-try-catch-or-throw.js";
import noTsNocheck from "./oxlint-plugin-scotty/rules/no-ts-nocheck.js";
import noUnknownErrorMessage from "./oxlint-plugin-scotty/rules/no-unknown-error-message.js";
import noUnknownShapeProbing from "./oxlint-plugin-scotty/rules/no-unknown-shape-probing.js";
import noUnsupportedEffectApi from "./oxlint-plugin-scotty/rules/no-unsupported-effect-api.js";
import preferEffectPredicate from "./oxlint-plugin-scotty/rules/prefer-effect-predicate.js";
import preferSchemaInferredTypes from "./oxlint-plugin-scotty/rules/prefer-schema-inferred-types.js";
import preferValueInferredExtensionTypes from "./oxlint-plugin-scotty/rules/prefer-value-inferred-extension-types.js";
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
    "no-manual-tag-check": noManualTagCheck,
    "no-match-orelse": noMatchOrelse,
    "no-promise-catch": noPromiseCatch,
    "no-promise-client-surface": noPromiseClientSurface,
    "no-promise-reject": noPromiseReject,
    "no-raw-error-throw": noRawErrorThrow,
    "no-raw-fetch": noRawFetch,
    "no-raw-wall-clock": noRawWallClock,
    "no-redundant-error-factory": noRedundantErrorFactory,
    "no-redundant-primitive-cast": noRedundantPrimitiveCast,
    "no-schema-class": noSchemaClass,
    "no-switch-statement": noSwitchStatement,
    "no-try-catch-or-throw": noTryCatchOrThrow,
    "no-ts-nocheck": noTsNocheck,
    "no-unknown-error-message": noUnknownErrorMessage,
    "no-unknown-shape-probing": noUnknownShapeProbing,
    "no-unsupported-effect-api": noUnsupportedEffectApi,
    "prefer-effect-predicate": preferEffectPredicate,
    "prefer-schema-inferred-types": preferSchemaInferredTypes,
    "prefer-value-inferred-extension-types": preferValueInferredExtensionTypes,
    "prefer-yield-tagged-error": preferYieldTaggedError,
  },
};
