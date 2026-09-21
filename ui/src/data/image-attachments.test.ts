import { describe, expect, it } from "vitest";
import { validateImageFiles } from "./image-attachments";
import { PI_CONSOLE_MAX_IMAGE_BYTES } from "../../../protocol/agents/pi/pi-console";

const file = (name = "photo.png", type = "image/png", size = 8) =>
  new File([new Uint8Array(size)], name, { type });

describe("image attachment selection", () => {
  it("accepts supported desktop and phone images", () => {
    expect(
      validateImageFiles(
        [
          file(),
          file("photo.jpg", "image/jpeg"),
          file("photo.webp", "image/webp"),
          file("photo.gif", "image/gif"),
        ],
        [],
      ),
    ).toBeUndefined();
  });
  it("counts existing images when checking the four-image limit", () => {
    expect(validateImageFiles([file(), file()], [{ size: 1 }, { size: 1 }, { size: 1 }])).toContain(
      "up to 4",
    );
  });
  it("enforces the total size across new and existing images", () => {
    expect(
      validateImageFiles([file()], [{ size: PI_CONSOLE_MAX_IMAGE_BYTES - 8 }]),
    ).toBeUndefined();
    expect(validateImageFiles([file()], [{ size: PI_CONSOLE_MAX_IMAGE_BYTES - 7 }])).toContain(
      "5 MB",
    );
  });
  it("explains unsupported phone photos and empty files", () => {
    expect(validateImageFiles([file("photo.heic", "image/heic")], [])).toContain("HEIC");
    expect(validateImageFiles([file("empty.png", "image/png", 0)], [])).toContain("empty");
  });
});
