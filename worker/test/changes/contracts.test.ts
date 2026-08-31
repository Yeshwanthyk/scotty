import { assert, describe, it } from "vitest";
import {
  CHANGED_FILE_LIMIT,
  changedFilesFromGit,
  parseChangedPath,
  parseGitStatus,
} from "../../src/changes/contracts";

const hash = "a".repeat(40);
const ordinary = (code: string, path: string): string =>
  `1 ${code} N... 100644 100644 100644 ${hash} ${hash} ${path}\0`;
const renamed = (code: string, path: string, oldPath: string): string =>
  `2 ${code} N... 100644 100644 100644 ${hash} ${hash} R100 ${path}\0${oldPath}\0`;

describe("changed-files boundary", () => {
  it("parses hostile paths and rename records without shell or line splitting", () => {
    const hostile = "--output;$(touch nope)\nname.txt";
    const parsed = parseGitStatus(
      `${renamed("R.", "src/new name.ts", "src/old name.ts")}? ${hostile}\0`,
    );

    assert.deepStrictEqual(parsed, [
      {
        path: "src/new name.ts",
        oldPath: "src/old name.ts",
        status: "renamed",
        staged: true,
        unstaged: false,
      },
      {
        path: hostile,
        status: "untracked",
        staged: false,
        unstaged: true,
      },
    ]);
  });

  it("merges rename stats and exposes binary and unmerged files as non-patchable", () => {
    const changes = changedFilesFromGit(
      [
        renamed("R.", "src/new.ts", "src/old.ts"),
        ordinary(".M", "image.png"),
        `u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} conflict.txt\0`,
      ].join(""),
      ["3\t0\tsrc/new.ts", "2\t4\tsrc/old.ts", "-\t-\timage.png", ""].join("\0"),
      "",
    );

    assert.deepStrictEqual(changes, {
      files: [
        {
          path: "src/new.ts",
          oldPath: "src/old.ts",
          status: "renamed",
          staged: true,
          unstaged: false,
          additions: 5,
          deletions: 4,
          binary: false,
          patchable: true,
        },
        {
          path: "image.png",
          status: "modified",
          staged: false,
          unstaged: true,
          binary: true,
          patchable: false,
        },
        {
          path: "conflict.txt",
          status: "unmerged",
          staged: true,
          unstaged: true,
          binary: false,
          patchable: false,
        },
      ],
      truncated: false,
    });
  });

  it("caps the visible list and validates only bounded NUL-free paths", () => {
    const status = Array.from({ length: CHANGED_FILE_LIMIT + 1 }, (_, index) =>
      ordinary(".M", `src/file-${index}.ts`),
    ).join("");
    const changes = changedFilesFromGit(status, "", "");

    assert.lengthOf(changes.files, CHANGED_FILE_LIMIT);
    assert.isTrue(changes.truncated);
    assert.strictEqual(parseChangedPath("src/file.ts"), "src/file.ts");
    assert.isUndefined(parseChangedPath(""));
    assert.isUndefined(parseChangedPath("bad\0path"));
    assert.isUndefined(parseChangedPath("a".repeat(4_097)));
  });
});
