import { useRef, useState, type MouseEvent } from "react";
import { Viewer } from "./Viewer";

export type LightboxImage = { href: string; label: string };

// Images open in the app instead of a new tab, which would leave the installed app. The thumbnail
// stays a link, so long-press, a modified click or a middle click still reach the file.
export function useLightbox(images: ReadonlyArray<LightboxImage>) {
  const [index, setIndex] = useState<number>();
  const opener = useRef<HTMLElement>(undefined);
  const open = (at: number) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    opener.current = event.currentTarget;
    setIndex(at);
  };
  const image = index === undefined ? undefined : images[index];
  const view =
    index === undefined || image === undefined ? null : (
      <Viewer
        label="Image viewer"
        className="lightbox"
        index={index}
        count={images.length}
        onIndex={setIndex}
        onClose={() => {
          setIndex(undefined);
          opener.current?.focus();
        }}
        swipeDown
        title={image.label}
        actions={
          <a
            className="viewer-link desktop-only"
            href={image.href}
            target="_blank"
            rel="noreferrer"
          >
            Open original
          </a>
        }
      >
        <div className="lightbox-stage" data-scrim>
          <img
            key={image.href}
            src={image.href}
            alt={image.label}
            onClick={(event) => {
              // Keep a tap on the picture; one on the letterbox around it closes.
              if (onPicture(event.currentTarget, event.clientX, event.clientY))
                event.preventDefault();
            }}
          />
        </div>
      </Viewer>
    );
  return { open, view };
}

// The image is drawn with object-fit: contain, so its element is bigger than the picture.
function onPicture(img: HTMLImageElement, x: number, y: number) {
  const box = img.getBoundingClientRect();
  if (img.naturalWidth === 0 || img.naturalHeight === 0) return true;
  const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
  const width = img.naturalWidth * scale;
  const height = img.naturalHeight * scale;
  const left = box.left + (box.width - width) / 2;
  const top = box.top + (box.height - height) / 2;
  return x >= left && x <= left + width && y >= top && y <= top + height;
}
