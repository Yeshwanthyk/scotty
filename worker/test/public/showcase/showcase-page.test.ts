import { assert, describe, it } from "vitest";
import {
  formatShowcaseDuration,
  showcaseLoadFailure,
  showcaseVideoState,
} from "../../../public/showcase/view.js";
import showcaseScript from "../../../public/showcase/index.js?raw";
import showcaseHtml from "../../../public/showcase/index.html?raw";

describe("Showcase video review", () => {
  it("formats recording durations for the visible metadata", () => {
    assert.strictEqual(formatShowcaseDuration(0), "0:00");
    assert.strictEqual(formatShowcaseDuration(65.9), "1:05");
    assert.strictEqual(formatShowcaseDuration(3_725), "1:02:05");
  });

  it("keeps playback failures local to the recording and offers recovery", () => {
    assert.deepStrictEqual(showcaseVideoState("error"), {
      label: "Recording unavailable",
      detail: "The browser recording could not be played right now.",
    });
    assert.include(showcaseScript, 'video.addEventListener("error"');
    assert.include(showcaseScript, 'retryVideo.textContent = "Retry recording"');
    assert.include(showcaseScript, 'link.textContent = "Download recording"');
    assert.include(showcaseScript, 'videoSection.className = "showcase-video-section"');
  });

  it("maps supported API signals to distinct, actionable page copy", () => {
    assert.deepStrictEqual(showcaseLoadFailure({ status: 404, code: "not_found" }), {
      title: "Showcase expired or removed",
      detail:
        "This Showcase is no longer available. Its retained evidence may have expired or been removed.",
      retry: false,
    });
    assert.deepStrictEqual(showcaseLoadFailure({ status: 409, code: "wrong_state" }), {
      title: "Showcase does not match",
      detail:
        "These evidence runs no longer form a matched Showcase. Open Evidence and choose a matching pair.",
      retry: false,
    });
    assert.deepStrictEqual(showcaseLoadFailure({ status: 503, code: "upstream" }), {
      title: "Showcase temporarily unavailable",
      detail: "Scotty could not reach the retained browser proof. Try again in a moment.",
      retry: true,
    });
    assert.deepStrictEqual(showcaseLoadFailure({ status: 200, code: "malformed" }), {
      title: "Showcase data is malformed",
      detail: "Scotty received an invalid Showcase payload. Try again or return to Evidence.",
      retry: true,
    });
  });

  it("uses semantic media controls and preserves comparison markup", () => {
    assert.include(showcaseScript, "video.controls = true");
    assert.include(showcaseScript, 'video.preload = "metadata"');
    assert.include(showcaseScript, 'video.addEventListener("loadedmetadata"');
    assert.include(showcaseHtml, 'aria-live="polite"');
    assert.include(showcaseScript, 'slices.className = "showcase-slices"');
  });
});
