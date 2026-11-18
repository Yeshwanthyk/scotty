export type Appearance = "system" | "light" | "dark";
export const readAppearance = (): Appearance => {
  try {
    const saved = localStorage.getItem("scotty.appearance");
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
};
const apply = (choice: Appearance) => {
  const dark =
    choice === "dark" ||
    (choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.media = "";
    meta.content = dark ? "#121211" : "#fbfbfa";
  });
};
export const applyAppearance = () => apply(readAppearance());
export const saveAppearance = (choice: Appearance) => {
  try {
    localStorage.setItem("scotty.appearance", choice);
  } catch {
    // Apply the choice for this page even when browser storage is unavailable.
  }
  apply(choice);
};
// Runs in the head before the page paints; no user-provided text is interpolated.
export const appearanceScript = `try{let p=localStorage.getItem('scotty.appearance');document.documentElement.dataset.theme=(p==='dark'||(p!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))?'dark':'light'}catch{document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}`;
