import { EditorView } from "@codemirror/view";

/** The colours of code, each a token a theme may set (`--tok-keyword`, and so on: night shift does), and the light and dark colours where none does, by the classes `classHighlighter` gives its words: a code block's, and a code file's read in the app. */
export const tokenColors = EditorView.baseTheme({
  ".tok-keyword, .tok-operatorKeyword, .tok-modifier": { color: "var(--tok-keyword, light-dark(#8b3fc7, #c792ea))" },
  ".tok-string, .tok-string2, .tok-inserted": { color: "var(--tok-string, light-dark(#3d7a3d, #a5d6a7))" },
  ".tok-comment, .tok-meta": { color: "var(--tok-comment, light-dark(#8a8580, #7d7870))", fontStyle: "italic" },
  ".tok-number, .tok-bool, .tok-atom, .tok-literal": { color: "var(--tok-number, light-dark(#b25d0f, #f0a868))" },
  ".tok-typeName, .tok-className, .tok-namespace": { color: "var(--tok-type, light-dark(#0f7a8a, #7fd0dd))" },
  ".tok-propertyName, .tok-macroName, .tok-labelName": { color: "var(--tok-property, light-dark(#2f5fc4, #8fb4ff))" },
  ".tok-variableName.tok-definition, .tok-heading": { color: "var(--tok-property, light-dark(#2f5fc4, #8fb4ff))" },
  ".tok-deleted, .tok-invalid": { color: "var(--tok-invalid, light-dark(#b3261e, #f28b82))" },
});
