import {
  PI_CONSOLE_ALLOWED_IMAGE_MIME_TYPES,
  PI_CONSOLE_MAX_IMAGES,
  PI_CONSOLE_MAX_IMAGE_BYTES,
  type PiConsoleImage,
} from "../../../protocol/agents/pi/pi-console";

export interface ImageAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly image: PiConsoleImage;
}

export const IMAGE_ONLY_PROMPT = "Please review the attached images.";

export function validateImageFiles(
  files: readonly File[],
  existing: readonly Pick<ImageAttachment, "size">[],
): string | undefined {
  if (files.length + existing.length > PI_CONSOLE_MAX_IMAGES)
    return `Attach up to ${PI_CONSOLE_MAX_IMAGES} images. Remove an image to add another.`;
  if (files.some((file) => !PI_CONSOLE_ALLOWED_IMAGE_MIME_TYPES.some((mime) => mime === file.type)))
    return "Choose PNG, JPG, WebP, or GIF images. Export HEIC photos as JPG first.";
  if (files.some((file) => file.size === 0)) return "An image is empty. Choose another file.";
  if (
    [...files, ...existing].reduce((total, file) => total + file.size, 0) >
    PI_CONSOLE_MAX_IMAGE_BYTES
  )
    return "Images must total 5 MB or less. Choose smaller images or remove one.";
  return undefined;
}

export function readImageFile(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const mimeType = PI_CONSOLE_ALLOWED_IMAGE_MIME_TYPES.find((mime) => mime === file.type);
    if (!mimeType) {
      reject(new Error("Unsupported image format"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Image read failed"));
    reader.onabort = () => reject(new Error("Image read cancelled"));
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.includes(",")) {
        reject(new Error("Image read failed"));
        return;
      }
      resolve({
        id: crypto.randomUUID(),
        name: file.name || "Pasted image",
        size: file.size,
        image: {
          type: "image",
          mimeType,
          data: reader.result.slice(reader.result.indexOf(",") + 1),
        },
      });
    };
    reader.readAsDataURL(file);
  });
}
