# Common Ink Clipper

A Chrome extension that clips the page you are reading into a note. Sign in and allow it. The notes are yours.

## Build

From the repo root:

```sh
npm install
npm run extension:build
```

That writes an unpacked extension to `extension/dist`. `npm run build` and `npm test` build and test it too.

## Load a build without npm

Each pull request, and each push to main, uploads an `extension-dist` artifact. You can load that without cloning the repo or running npm.

1. Open the [latest CI run](https://github.com/paudrow/common-ink-v3/actions/workflows/ci.yml) and download the `extension-dist` artifact.
2. Unzip it to a folder you will keep. `manifest.json` is in that folder.
3. The first time, open `chrome://extensions`, turn on Developer mode, and choose Load unpacked. Select that folder.
4. After each update, unzip the new artifact into the same folder, then click Reload on `chrome://extensions`.

## Load a local build

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose Load unpacked and select `extension/dist`.

The toolbar icon clips the current page. The context menu clips the page, the selection, a link, an image, or the element under the pointer. Alt+Shift+C clips the page.

## Sign in

1. Open the extension. Leave the host as `https://commonink.app`, or set it to a preview or a local app such as `http://localhost:5173`.
2. Choose Sign in. Common Ink asks you to allow the clipper. Allow sends a token back to this browser. It is not listed with your agents.
3. Allowing again replaces that token, so an older sign-in on another browser stops working.

A pasted token still works, under Paste a token. A read-only token can sign in, and Save stays off. Sign out in the extension drops the token from this browser. The token stays in this browser's extension storage until then.

Clip a page, edit the title, pick a folder, and save. The folder list is the folders you can edit, loaded again each time you open the clipper, and it opens on the folder you saved to last. Images are uploaded into that folder and embedded in the note. An image the extension cannot fetch is kept as a link, and the note is still created. A PDF or another document is uploaded and embedded on the note. A tweet keeps the post's text and its address, so the note can embed it. A YouTube page keeps the description and the watch address.
