/**
 * The whole document of a frame that runs a plugin's code: the app's styles, the app's script, which
 * is the plugin's side of the port, and the plugin's code. The code is held as a JSON string with
 * every `<` written as an escape, so nothing in it can end the element that holds it or start
 * another, and it reads back as exactly the text that was installed. The app's script runs it once
 * the frame has been told what it is for.
 */
export function frameDocument({ code, sdk, styles, scheme }: { code: string; sdk: string; styles: string; scheme: "light" | "dark" }): string {
  const held = JSON.stringify(code).replace(/</g, "\\u003c");
  return `<!doctype html>
<meta charset="utf-8">
<style>:root { color-scheme: ${scheme}; }
${styles}</style>
<body><div id="ink-root"></div>
<script>${sdk}</script>
<script type="application/json" id="ink-code">${held}</script>
</body>
`;
}
