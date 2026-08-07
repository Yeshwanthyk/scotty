# scotty-browser-test

First-party Pi extension for one-shot browser evidence jobs inside a warm Scotty session.

It registers only `scotty_browser_test`. The tool accepts the bounded BrowserEvidenceJob v1
graph and submits it to Scotty's reserved internal container route. Browser, preview, storage,
and session authority remain outside the container.
