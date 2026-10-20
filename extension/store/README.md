# Chrome Web Store listing

Everything the Chrome Web Store asks for when the clipper is submitted or updated. The text is in `listing.json`, and the images are made from the real extension and the real app, so both can be made again when the clipper changes.

## Submit an update

1. Raise `version` in `extension/manifest.json`. The store refuses a version it has seen.
2. Make the images again if the clipper or the app looks different. Start a dev server, then run:

   ```sh
   npm run store:assets -- --url http://localhost:5173
   ```

3. Check the listing and print it in the dashboard's order:

   ```sh
   npm run store:listing
   ```

   This fails when a field is over the store's limit, when the summary isn't the manifest's description, or when the manifest asks for a permission the listing gives no reason for.

4. Write the zip to upload. It is the built extension without the manifest's `key`, which the store refuses:

   ```sh
   npm run store:zip
   ```

5. In the [developer dashboard](https://chrome.google.com/webstore/devconsole), upload the zip under Package, then paste each field under Store listing and Privacy practices, and upload the images from this folder.

## The fields

| Dashboard | Where it comes from |
| --- | --- |
| Item name, Summary | `name` and `description` in `extension/manifest.json`, which `listing.json` must match |
| Description, Category, Language, URLs | `storeListing` in `listing.json` |
| Store icon | `extension/dist/icon-128.png`, written by `npm run extension:build` |
| Screenshots, promo tiles | the PNGs in this folder, from `npm run store:assets` |
| Single purpose, permission justifications, data usage, certifications | `privacyPractices` in `listing.json` |
| Privacy policy | https://commonink.app/privacy |
