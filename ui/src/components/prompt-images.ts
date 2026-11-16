import { Schema } from "effect";
import { PromptImage } from "../../../protocol/prompt";

// Resize screenshots and phone photos before they become durable prompt events.
export async function prepareImage(file: File): Promise<PromptImage> {
  if (!file.type.startsWith("image/") || file.size > 20 * 1024 * 1024)
    throw new Error("Choose an image smaller than 20 MB");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This browser cannot prepare images");
    for (let attempt = 0; attempt < 5; attempt++) {
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const lossless = canvas.toDataURL("image/png");
      const url = lossless.length <= 170_022 ? lossless : canvas.toDataURL("image/webp", 0.9);
      const comma = url.indexOf(",");
      const data = url.slice(comma + 1);
      if (data.length <= 170_000)
        return Schema.decodeUnknownSync(PromptImage)({
          mediaType: url.slice(5, url.indexOf(";")),
          data,
        });
      canvas.width = Math.max(1, Math.round(canvas.width * 0.75));
      canvas.height = Math.max(1, Math.round(canvas.height * 0.75));
    }
    throw new Error("This image is too large; crop it and try again");
  } finally {
    bitmap.close();
  }
}
