# Zotero Feishu Sync

Zotero Feishu Sync is a Zotero 7/8 plugin that publishes literature metadata,
abstracts, child notes, and embedded note images to Feishu cloud documents.
Zotero remains the source of truth; syncing an existing item replaces the
managed Feishu document content.

## Current Scope

- Sync selected items, their selected child notes or attachments, or the direct
  items in the current Zotero collection.
- Create one Feishu Docx per regular item in a configured folder.
- Preserve common note formatting and upload embedded note images.
- Skip unchanged items using a local source hash.
- Open or explicitly delete a linked Feishu document.

The initial release supports My Library and mainland Feishu only. It does not
sync PDF annotations that have not been added to a Zotero note, standalone
notes, group libraries, attachments, or edits made in Feishu.

## Feishu Setup

1. Create a dedicated Feishu custom app.
2. Add this redirect URL under the app's security settings:
   `http://127.0.0.1:23119/zotero-feishu/oauth/callback`.
3. Enable `docx:document`, `docs:document.media:upload`,
   `drive:file:upload`, `drive:drive.metadata:readonly`,
   `space:document:delete`, and `offline_access`.
4. Publish the app and ensure your account is in its availability range.
5. Open the plugin preferences and enter the App ID and App Secret. Leave the
   destination folder empty to use My Space, or enter a Drive folder URL. Then
   authorize and test the connection.

Secrets and OAuth tokens are stored in Zotero's Firefox Login Manager. The
local item-to-document mapping is stored under the Zotero profile and is not
synced between computers.

## Development

```bash
npm install
npm start
npm run lint:check
npm run build
npm test
```

Copy `.env.example` to `.env` and configure a dedicated Zotero development
profile before running `npm start` or the Zotero-hosted tests. Production
packages are written to `.scaffold/build/`.

## License

AGPL-3.0-or-later
