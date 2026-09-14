import { getSingularPatch } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";

export default function PierreDiff({
  patch,
  split,
  words,
}: {
  readonly patch: string;
  readonly split: boolean;
  readonly words: boolean;
}) {
  const fileDiff = useMemo(() => {
    try {
      return getSingularPatch(patch);
    } catch {
      return undefined;
    }
  }, [patch]);
  if (fileDiff === undefined)
    return (
      <>
        <p>Unable to render this patch. Showing source.</p>
        <pre>{patch}</pre>
      </>
    );
  return (
    <FileDiff
      fileDiff={fileDiff}
      options={{
        theme: "pierre-dark",
        themeType: "dark",
        diffStyle: split ? "split" : "unified",
        lineDiffType: words ? "word" : "none",
        overflow: "scroll",
      }}
    />
  );
}
