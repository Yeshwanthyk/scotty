# Repository choices

Baseline and cleanup: [../SKILL.md](../SKILL.md). Use a stored GitHub account.

1. Run `npm run --silent e2e -- repositories`. It must decode real account repositories,
   fetch distinct one-item pages, follow all 100-item pages and reject invalid pagination.
2. Open New session in an owned browser tab. Focus Repository: recent/configured and GitHub
   choices appear. Type a case-insensitive substring and select a matching option.
3. Choose standard-2, then change repository by typing and by ArrowDown + Enter.
   The size stays standard-2. Escape closes without selecting; Tab leaves the picker.
4. Enter owner/repo manually, then paste a GitHub repository URL. Both produce owner/repo.
   Search for an impossible name: an empty message still permits manual entry.
5. At 375 px wide, open choices and inspect a screenshot: popup fits the viewport and rows
   remain readable. Loading/error messages must not imply a complete empty catalog.
6. Create a session through the form, read it with `scotty read <id>` and confirm standard-2. Read
   `GET /api/sessions/<id>` to confirm `session.display.repository` and `size`. Save its log and stop only that owned session. Close the owned tab.

A GitHub outage or absent token shows a failure and keeps manual input usable. Do not change
or remove the owner's stored token to simulate it. Report upstream failure coverage as untested
unless a real failed response occurs.
