# Web clipper

The Common Ink Clipper for Chrome saves a web page, a selection, a link, an image, or one part of a page as a note in the folder you pick.

## Install the clipper

The clipper is coming to the Chrome Web Store. Until then, you load it into Chrome yourself as an unpacked extension:

1. Get a build of the clipper and unzip it to a folder you will keep. The [clipper's README](https://github.com/paudrow/common-ink-v3/blob/main/extension/README.md) says where to get one.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the folder.

To update it, unzip the new build into the same folder and choose the clipper's reload button on `chrome://extensions`.

## Sign in

1. Open the clipper from Chrome's toolbar.
2. Leave **Host** as `https://commonink.app`.
3. Choose **Sign in**. Common Ink opens a page titled "Allow Common Ink Clipper". If you aren't signed in to Common Ink, it asks you to sign in with Google first.
4. Choose **Allow**.

The clipper's token can list your workspaces and folders, create notes, and upload the pictures and files it clips. It can't read, change, or delete anything. It isn't one of your agents, so the Agents page doesn't list it.

The clipper stays signed in for 90 days. **Sign out** in the clipper ends it sooner. If you allow the clipper again, from this browser or another, the new sign-in replaces the old one, and the old one stops working.

To sign a clipper out from Common Ink, open Settings and go to Account. Under **Clipper**, choose **Revoke**. **Sign out everywhere** signs the clipper out too.

## Clip a page

There are three ways to clip:

- Open the clipper from the toolbar and choose **Clip page** or **Clip selection**.
- Right-click the page and choose **Clip page to Common Ink**, **Clip selection to Common Ink**, **Clip link to Common Ink**, or **Clip image to Common Ink**. **Clip element to Common Ink** clips the part of the page under the pointer.
- Press `Alt+Shift+C` to clip the page.

The clipper then shows what it will save. To save it:

1. Edit the **Title** if you want another.
2. If you are in more than one workspace, pick the **Workspace**.
3. Pick the **Folder**. The list has the folders you can edit, and it opens on the folder you saved to last.
4. Choose **Save**.

**Dismiss** throws the clip away.

## Images, files, posts, and videos

- **Images.** The clipper uploads each image in the clip into the same folder and embeds it in the note. The clipper says how many it will save. An image it can't fetch stays in the note as a link, and the note is still made. An image on your computer or your local network, or behind a redirect, stays a link too.
- **PDFs and other documents.** A PDF, or a file such as a `.csv`, `.json`, `.txt`, or `.md`, is uploaded to the folder and embedded in the note. A file over 80 MB is not clipped.
- **Posts on X.** A post keeps its text and its address, so the note can embed the post.
- **YouTube.** A video page keeps its description and its watch address.

To learn what a note can embed and how uploads work, see [Writing notes](/docs/notes).
