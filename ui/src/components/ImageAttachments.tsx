import * as stylex from "@stylexjs/stylex";
import { ImagePlus, X } from "lucide-react";
import { useId, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import {
  PI_CONSOLE_ALLOWED_IMAGE_MIME_TYPES,
  PI_CONSOLE_MAX_IMAGES,
  PI_CONSOLE_MAX_IMAGE_BYTES,
  type PiConsoleImage,
} from "../../../protocol/agents/pi/pi-console";
import { Button } from "./Button";
import { colors } from "../theme/tokens.stylex";
import { validateImageFiles, readImageFile, type ImageAttachment } from "../data/image-attachments";

export function useImageAttachments(disabled: boolean, onChange: () => void) {
  const [items, setItems] = useState<readonly ImageAttachment[]>([]);
  const [error, setError] = useState<string>();
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const readingRef = useRef(false);
  const locked = disabled || reading;
  const add = async (files: readonly File[]) => {
    if (disabled || readingRef.current || files.length === 0) return;
    const problem = validateImageFiles(files, items);
    setError(problem);
    if (problem) return;
    readingRef.current = true;
    setReading(true);
    try {
      const additions = await Promise.all(files.map(readImageFile));
      setItems((current) => [...current, ...additions]);
      onChange();
    } catch {
      setError("These images could not be read. Try choosing them again.");
    } finally {
      readingRef.current = false;
      setReading(false);
    }
  };
  return {
    items,
    error,
    reading,
    locked,
    dragging,
    add,
    images: items.map((item): PiConsoleImage => item.image),
    clear: () => {
      setItems([]);
      setError(undefined);
    },
    remove: (id: string) => {
      if (locked) return;
      setItems((current) => current.filter((item) => item.id !== id));
      setError(undefined);
      onChange();
    },
    handlers: {
      onPaste: (event: ClipboardEvent) => {
        const files = Array.from(event.clipboardData.files).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (!files.length) return;
        event.preventDefault();
        void add(files);
      },
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = locked ? "none" : "copy";
        setDragging(!locked);
      },
      onDragLeave: (event: DragEvent) => {
        if (
          !event.currentTarget.contains(
            event.relatedTarget instanceof Node ? event.relatedTarget : null,
          )
        )
          setDragging(false);
      },
      onDrop: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        void add(Array.from(event.dataTransfer.files));
      },
    },
  };
}

const styles = stylex.create({
  root: { width: "100%", minWidth: 0, display: "grid", gap: "8px" },
  bar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 12px" },
  icon: { width: "16px", height: "16px" },
  hint: { margin: 0, color: colors.muted, fontSize: "11px", lineHeight: 1.5 },
  list: { display: "flex", flexWrap: "wrap", gap: "8px", margin: 0, padding: 0, listStyle: "none" },
  item: { position: "relative", width: "100px", minWidth: 0 },
  image: {
    display: "block",
    width: "100px",
    height: "76px",
    objectFit: "contain",
    borderRadius: "8px",
    backgroundColor: colors.control,
  },
  remove: {
    position: "absolute",
    top: 0,
    right: 0,
    width: "44px",
    height: "44px",
    display: "grid",
    placeItems: "center",
    border: 0,
    borderRadius: "0 8px 0 8px",
    color: "white",
    backgroundColor: "rgb(0 0 0 / 0.8)",
    cursor: "pointer",
    ":focus-visible": { outline: `2px solid ${colors.focus}` },
    ":disabled": { opacity: 0.5, cursor: "not-allowed" },
  },
  name: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.muted,
    fontSize: "11px",
    paddingTop: "4px",
  },
  error: { margin: 0, color: colors.danger, fontSize: "12px", lineHeight: 1.5 },
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

const hideIdleAttachmentNotice = (quiet: boolean, dragging: boolean, reading: boolean): boolean =>
  quiet && !dragging && !reading;

export function ImageAttachments({
  attachments,
  compact = false,
  quiet = false,
}: {
  readonly attachments: ReturnType<typeof useImageAttachments>;
  readonly compact?: boolean;
  readonly quiet?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  return (
    <div data-design={compact ? "compact-attachments" : undefined} {...stylex.props(styles.root)}>
      {attachments.items.length > 0 ? (
        <ul aria-label="Attached images" {...stylex.props(styles.list)}>
          {attachments.items.map((item) => (
            <li key={item.id} {...stylex.props(styles.item)}>
              <img
                src={`data:${item.image.mimeType};base64,${item.image.data}`}
                alt={item.name}
                {...stylex.props(styles.image)}
              />
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                disabled={attachments.locked}
                onClick={() => attachments.remove(item.id)}
                {...stylex.props(styles.remove)}
              >
                <X aria-hidden {...stylex.props(styles.icon)} />
              </button>
              <span title={item.name} {...stylex.props(styles.name)}>
                {item.name}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div data-design="attachment-controls" {...stylex.props(styles.bar)}>
        <input
          ref={input}
          type="file"
          accept={PI_CONSOLE_ALLOWED_IMAGE_MIME_TYPES.join(",")}
          multiple
          hidden
          disabled={attachments.locked}
          onChange={(event) => {
            void attachments.add(Array.from(event.currentTarget.files ?? []));
            event.currentTarget.value = "";
          }}
        />
        <Button
          type="button"
          disabled={attachments.locked || attachments.items.length >= PI_CONSOLE_MAX_IMAGES}
          aria-label={attachments.reading ? "Reading images" : "Add images"}
          title="Add images"
          variant={compact || quiet ? "quiet" : "default"}
          iconOnly={compact}
          aria-describedby={hintId}
          onClick={() => input.current?.click()}
          style={compact ? undefined : { minHeight: 44 }}
        >
          <ImagePlus aria-hidden {...stylex.props(styles.icon)} />
          {compact ? null : attachments.reading ? "Reading images…" : "Add images"}
        </Button>
        <p
          id={hintId}
          data-attachment-notice={attachments.dragging || attachments.reading ? "active" : "idle"}
          aria-live="polite"
          {...stylex.props(
            styles.hint,
            hideIdleAttachmentNotice(quiet, attachments.dragging, attachments.reading) &&
              styles.visuallyHidden,
          )}
        >
          {attachments.reading
            ? "Reading images…"
            : attachments.dragging
              ? "Drop images here"
              : `${attachments.items.length ? `${attachments.items.length}/${PI_CONSOLE_MAX_IMAGES} attached · ` : "Paste or drop · "}PNG, JPG, WebP, GIF · ${PI_CONSOLE_MAX_IMAGE_BYTES / 1024 / 1024} MB total`}
        </p>
      </div>
      {attachments.error ? (
        <p role="alert" {...stylex.props(styles.error)}>
          {attachments.error}
        </p>
      ) : null}
    </div>
  );
}
