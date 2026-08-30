# scotty-browser-test

First-party Pi extension for one-shot browser evidence jobs inside a warm Scotty session.

It registers only `scotty_browser_test`. The tool accepts the bounded BrowserEvidenceJob graph
and submits it to Scotty's reserved internal container route. Every job captures a PNG after each
step. A job with `capture.video: true` also returns one real browser-recorded WebM after the context
closes. Browser, preview, storage, and session authority remain outside the container.

For a Showcase, run the same viewport, steps, and assertions before a change with video disabled,
then after the change with video enabled. Publish both exact `scotty-evidence:<jobId>` references in
the same final update.
