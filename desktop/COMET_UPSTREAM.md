# Comet upstream provenance

Scotty Desktop was bootstrapped from selected presentation assets and the
native composer input core in
[`zeronsh/comet`](https://github.com/zeronsh/comet), pinned at:

```text
b033110d087ae0f1d1ba607b77d97624165c1986
```

Imported files:

| Scotty path                                             | Comet source                                                    | Upstream blob                                                                          | Treatment                                                                                                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/scotty-desktop/src/theme.rs`                    | `crates/ui/src/theme.rs`                                        | `d6d320b7368dc00608955c6bb39e0445c3732d60`                                             | Copied; package path and formatting only                                                                                                                                         |
| `crates/scotty-desktop/src/app_menus.rs`                | `crates/ui/src/app_menus.rs`                                    | `794540f1e93dac13518a8c5ce08d6111a120ec1b`                                             | Adapted to Scotty app/window actions; retained Comet's native Edit menu routing for undo, redo, cut, copy, paste, and select-all                                                 |
| `crates/scotty-desktop/src/composer_input.rs`           | `crates/ui/src/composer.rs`                                     | `8f5b96517a9fc1854326757db830d1e51de3088a`                                             | Adapted text-input entity and painted element; retained bounded undo/redo and transcript-copy fallback; removed Comet app state and domain runtime wiring                        |
| `crates/scotty-desktop/src/transcript_selection.rs`     | `crates/ui/src/markdown/selection.rs`                           | `478cd0fb0055ef89ca1d32c27d103d3c0d53b217`                                             | Copied selection state model and tests; renamed keys and terminology for Scotty's transcript                                                                                     |
| `crates/scotty-desktop/src/selectable_text.rs`          | `crates/ui/src/markdown/render.rs`                              | `1b02cc2f9fea5944be330cfc7658ce86ac6c07b3`                                             | Extracted Comet's frame registry, cross-element drag selection, selection wash, and clickable-link text wrapper                                                                  |
| `crates/scotty-desktop/src/markdown.rs`                 | `crates/ui/src/markdown/parser.rs`                              | `180cc02bd908a20edffdbd345a725ec3e141b92e`                                             | Retains Scotty's bounded pulldown-cmark projection; adapted Comet's requirement that rendered link ranges retain their destinations                                              |
| `crates/scotty-desktop/src/markdown_mend.rs`            | `crates/ui/src/markdown/mend.rs`                                | `65b62e34cb526fa3a4dfd3eac3aa5c391164454e`                                             | Adapted display-only repair for incomplete streaming emphasis, code, links, and setext headings; canonical transcript text remains unchanged                                     |
| `crates/scotty-desktop/src/syntax_highlight.rs`         | `crates/ui/src/markdown/highlight.rs`                           | `b951462cb53aee8ea2e65691dc8a12b3a2345837`                                             | Adapted Comet's dependency-free, color-only tokenizer for Scotty code blocks                                                                                                     |
| `crates/scotty-desktop/src/attachments.rs`              | `crates/ui/src/attachments.rs`                                  | `a5aaf3af2559b3fd3e49bc0d861e1c4f512af931`                                             | Adapted image staging, format checks, bounds, and thumbnails; Scotty sends Pi-native image data and never sends Comet host paths                                                 |
| `crates/scotty-desktop/src/main.rs`                     | `crates/ui/src/markdown/render.rs`, `crates/ui/src/composer.rs` | `1b02cc2f9fea5944be330cfc7658ce86ac6c07b3`, `8f5b96517a9fc1854326757db830d1e51de3088a` | Integrated selection, links, code copy, syntax color, stable streaming display, and attachment picker/staging into Scotty's existing virtualized timeline and fenced submit path |
| `crates/scotty-desktop/assets/fonts/Geist.ttf`          | `crates/ui/assets/fonts/Geist.ttf`                              | `f63f0afc6390323715972b6645115485f37cc9f4`                                             | Unmodified                                                                                                                                                                       |
| `crates/scotty-desktop/assets/fonts/GeistMono.ttf`      | `crates/ui/assets/fonts/GeistMono.ttf`                          | `f1f640b6c2c538ff85094efe3fbc840aadd09466`                                             | Unmodified                                                                                                                                                                       |
| `crates/scotty-desktop/assets/fonts/Geist-Medium.ttf`   | `crates/ui/assets/fonts/Geist-Medium.ttf`                       | `96cb22f8bb85577f3d56c497ee82913883da0fbd`                                             | Unmodified                                                                                                                                                                       |
| `crates/scotty-desktop/assets/fonts/Geist-SemiBold.ttf` | `crates/ui/assets/fonts/Geist-SemiBold.ttf`                     | `b2b0618fa4ef73c5585043410a6ed9ed8a3c8e2a`                                             | Unmodified                                                                                                                                                                       |
| `crates/scotty-desktop/assets/fonts/Geist-Bold.ttf`     | `crates/ui/assets/fonts/Geist-Bold.ttf`                         | `863b2868c15bfce525a09174b4d322c12b5d498c`                                             | Unmodified                                                                                                                                                                       |
| `dist/macos/Info.plist`                                 | `dist/macos/Info.plist`                                         | `9885e9732ed5acb8f0ca9a98cf9f984eb3dd5de9`                                             | Adapted to Scotty bundle identity                                                                                                                                                |
| `COMET_LICENSE`                                         | `LICENSE`                                                       | `2cb0a384d5057c3af0676e1692b89ab46478f150`                                             | Unmodified MIT license                                                                                                                                                           |

## Reviewed surface

The reusable native-desktop baseline is now explicit rather than implied by the
initial thin port: composer editing includes bounded undo/redo; the native Edit
menu routes standard clipboard selectors; transcript text has Comet's rendered
selection model; and markdown preserves clickable links and code-copy
affordances.

Scotty now includes three further reviewed slices. Code blocks use Comet's
color-only tokenizer. Incomplete streaming Markdown gets display-only repair.
The native image picker uses Comet's staging and thumbnail pattern, then sends
bounded Pi-native image content through Scotty's fenced command path. Scotty
never sends a local path or file name to the sidecar, Worker, or container.

The following Comet surfaces remain reviewed but deferred: its full incremental
parser cache and veil, rich table renderer and render caches, transcript
spring/rail, motion and sound systems, attachment upload/read-back by host path,
full-size attachment lightbox, drag-and-drop intake, and terminal panel. These
need separate Scotty-owned slices. An upstream refresh must evaluate them
explicitly instead of assuming they were imported.

Scotty does **not** import Comet's outer composer workflow, engine, harness,
CRDT documents, sync, RPC server, Edge Worker, credential accounts, updater,
or persisted state. The adapted editor owns only transient local editing state;
Scotty still owns draft generations, selected-session fences, sidecar commands,
and submission semantics. The runtime boundary remains Scotty's Worker,
Sandbox Durable Object, and existing Pi supervisor.

Upstream refreshes are explicit reviews: clone the pinned successor under
`/tmp`, diff only the paths above, retain notices, and rerun the desktop and
credential-isolation gates. Never overwrite local files blindly.
