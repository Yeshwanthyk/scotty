# Comet upstream provenance

Scotty Desktop was bootstrapped from selected presentation assets and the
native composer input core in
[`zeronsh/comet`](https://github.com/zeronsh/comet), pinned at:

```text
b033110d087ae0f1d1ba607b77d97624165c1986
```

Imported files:

| Scotty path                                             | Comet source                                | Upstream blob                              | Treatment                                                                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/scotty-desktop/src/theme.rs`                    | `crates/ui/src/theme.rs`                    | `d6d320b7368dc00608955c6bb39e0445c3732d60` | Copied; package path and formatting only                                                                                                                                                |
| `crates/scotty-desktop/src/app_menus.rs`                | `crates/ui/src/app_menus.rs`                | `794540f1e93dac13518a8c5ce08d6111a120ec1b` | Reduced to Scotty's native app/window actions                                                                                                                                           |
| `crates/scotty-desktop/src/composer_input.rs`           | `crates/ui/src/composer.rs`                 | `8f5b96517a9fc1854326757db830d1e51de3088a` | Adapted text-input entity and painted element only; removed Comet app state, attachments, pickers, undo history, and runtime wiring; connected to Scotty draft and fenced-submit events |
| `crates/scotty-desktop/assets/fonts/Geist.ttf`          | `crates/ui/assets/fonts/Geist.ttf`          | `f63f0afc6390323715972b6645115485f37cc9f4` | Unmodified                                                                                                                                                                              |
| `crates/scotty-desktop/assets/fonts/GeistMono.ttf`      | `crates/ui/assets/fonts/GeistMono.ttf`      | `f1f640b6c2c538ff85094efe3fbc840aadd09466` | Unmodified                                                                                                                                                                              |
| `crates/scotty-desktop/assets/fonts/Geist-Medium.ttf`   | `crates/ui/assets/fonts/Geist-Medium.ttf`   | `96cb22f8bb85577f3d56c497ee82913883da0fbd` | Unmodified                                                                                                                                                                              |
| `crates/scotty-desktop/assets/fonts/Geist-SemiBold.ttf` | `crates/ui/assets/fonts/Geist-SemiBold.ttf` | `b2b0618fa4ef73c5585043410a6ed9ed8a3c8e2a` | Unmodified                                                                                                                                                                              |
| `crates/scotty-desktop/assets/fonts/Geist-Bold.ttf`     | `crates/ui/assets/fonts/Geist-Bold.ttf`     | `863b2868c15bfce525a09174b4d322c12b5d498c` | Unmodified                                                                                                                                                                              |
| `dist/macos/Info.plist`                                 | `dist/macos/Info.plist`                     | `9885e9732ed5acb8f0ca9a98cf9f984eb3dd5de9` | Adapted to Scotty bundle identity                                                                                                                                                       |
| `COMET_LICENSE`                                         | `LICENSE`                                   | `2cb0a384d5057c3af0676e1692b89ab46478f150` | Unmodified MIT license                                                                                                                                                                  |

Scotty does **not** import Comet's outer composer workflow, engine, harness,
CRDT documents, sync, RPC server, Edge Worker, credential accounts, updater,
or persisted state. The adapted editor owns only transient local editing state;
Scotty still owns draft generations, selected-session fences, sidecar commands,
and submission semantics. The runtime boundary remains Scotty's Worker,
Sandbox Durable Object, and existing Pi supervisor.

Upstream refreshes are explicit reviews: clone the pinned successor under
`/tmp`, diff only the paths above, retain notices, and rerun the desktop and
credential-isolation gates. Never overwrite local files blindly.
