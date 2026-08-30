# Container Pi package notices

The container includes the exact first-party packages recorded in [`manifest.json`](manifest.json).

- `scotty-browser-test` is first-party Scotty code under the repository MIT license. See
  `sources/scotty-browser-test/LICENSE`.
- `playwright-core` is Apache-2.0 licensed. Its package license is installed with the pinned npm
  package used by `scotty-browser-test` in the container image.
- `scotty-hatch` is first-party Scotty code under the repository MIT license. See
  `sources/scotty-hatch/LICENSE`.
- `smol-toml` is BSD-3-Clause licensed. Its package license is installed with the pinned npm
  package used by `scotty-hatch` in the container image.
