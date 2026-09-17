# scotty-browser-test

First-party Pi extension for one-shot browser evidence jobs inside a warm Scotty session.

It registers only `scotty_browser_test`. The tool accepts the bounded BrowserEvidenceJob graph
and submits it to Scotty's reserved internal container route. Every job captures a PNG after each
step. A job with `capture.video: true` also returns one real browser-recorded WebM after the context
closes. Browser, preview, storage, and session authority remain outside the container.

Tool calls should include `displayText`, a plain, single-line phrase of at most 180 characters
describing the intended task, such as `Checking the invoice checkout flow`. Pi and Codex show it
as the conversation tool label. It is optional for compatibility and removed before the job is
submitted to the evidence API; older calls retain their default labels.

App preview and capture are independent workflows. Browser evidence needs only an already-running
target app's sandbox-local address and real render readiness. For a Showcase, capture the same
viewport, steps, and assertions before a change with video disabled, then after the change with
video enabled. Capture cleans up only resources it created. It leaves the target app running. If
the result reports `port_conflict`, report the blocker without restarting or reconfiguring the
target app. Publish each exact
`scotty-evidence:<jobId>` marker returned by the first-party tool result at most once; the
authenticated `summaryUrl` remains internal and is not rendered.
