# Common Ink Clipper

A Chrome extension that clips the page you are reading into a note. Sign in and allow it. The notes are yours.

## Build

From the repo root:

```sh
npm install
npm run extension:build
```

That writes an unpacked extension to `extension/dist`. `npm run build` and `npm test` build and test it too.

## Download it from the dev server

A dev server (`npm run dev`) offers the clipper it was started from: Settings, under Account, has Download next to the clipper. That zip is built from `extension/` when you click, so it is always this checkout's clipper, with the same ID as a local build. Unzip it, then load it as below. A deploy has no Download. On a deploy, Get the Chrome Extension opens the Chrome Web Store page.

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

The clipper's token reaches only what the clipper does: it lists workspaces and folders, creates notes, and uploads files. It can't read, change or delete anything. It lasts 90 days. Sign out in the extension ends it on the server and drops it from this browser. Settings, under Account, lists it with a Revoke button. Signing out everywhere ends it too, whether you do it or an admin of a workspace you are in does, with or without agents.

A pasted token still works, under Paste a token. A read-only token can sign in, and Save stays off. Sign out in the extension drops a pasted token from this browser and leaves it connected in Common Ink.

## Extension ID

Common Ink lets only the extension IDs in its `CLIPPER_EXTENSION_IDS` setting sign in, so another extension can't ask for a token. The sign-in page shows the ID it is for.

The `key` in `manifest.json` is the Chrome Web Store item's public key. It fixes the ID of an unpacked build at `fcppkekegajpfdoilfhhohoilkbleiih`, the store item's ID, wherever it is loaded from. `scripts/extension-id.ts` works the ID out from the key. The dev server and the tests allow that ID. Production allows it in `CLIPPER_EXTENSION_IDS`, and a Preview copies that setting.

The key is a public key. Anyone can copy it into an unpacked extension. That copy has the store item's ID only on a machine that loads it unpacked.

Clip a page, edit the title, pick a folder, and save. The folder list is the folders you can edit, loaded again each time you open the clipper, and it opens on the folder you saved to last. Images are uploaded into that folder and embedded in the note. An image the extension cannot fetch is kept as a link, and the note is still created. So is an image on this computer or its network, and one behind a redirect: Chrome doesn't show an extension where a redirect points, so it is not followed. A public name that resolves to a private address is not caught, since an extension can't see what a name resolves to. A PDF or another document is uploaded and embedded on the note. A tweet keeps the post's text and its address, so the note can embed it. A YouTube page keeps the description and the watch address.
