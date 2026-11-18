# Images sent to an agent

1. Record preexisting sessions; leave them unowned. Run `npm run --silent e2e -- images`,
   then `npm run --silent e2e -- images --agent claude`, sequentially against the deployed image.
   Both prove initial/steering structured input by hashing the adapter's actual content,
   exact retries, image-aware conflicts, malformed/oversize rejection and the 700 KB boundary.
   Evidence and owned session IDs are printed; the test saves logs and stops its sessions.
2. In an owned browser tab, attach through the chooser, paste and drop images. Remove one;
   invalid files show an error without losing the draft. At desktop and phone widths check
   previews and send controls. Send an image-only prompt and inspect its conversation image.
3. Send a known colored shape to real Codex and ask what it depicts. Its visual answer must
   identify the shape/color. Steer with another image. Reload the page: both images persist.
4. Redeploy, reconnect and compare live log image payloads with the conversation snapshot.
   The fold test separately pins exact images in pending resend commands; report this distinction
   rather than claiming a live pending resend was exercised.
5. Stop only owned sessions, save logs/screenshots, close the owned tab; restore changed settings.
