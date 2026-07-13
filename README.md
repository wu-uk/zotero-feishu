# Zotero Feishu Sync

Zotero Feishu Sync is a Zotero 7-9 plugin that publishes literature metadata,
abstracts, child notes, and embedded note images to Feishu cloud documents.
Zotero remains the source of truth; syncing an existing item replaces the
managed Feishu document content.

## Current Scope

- Sync selected items, their selected child notes or attachments, or the direct
  items in the current Zotero collection.
- Create one Feishu Docx per regular item in a configured folder.
- Preserve Markdown-equivalent note structure, including headings, lists,
  quotes, code blocks, task lists, and tables, and upload embedded note images.
- Append local PDF attachments to the end of each synchronized document.
- Present literature metadata in a native Feishu callout for faster scanning.
- Show per-item syncing, success, and failure indicators in the Zotero item tree.
- Skip unchanged items using a local source hash.
- Open or explicitly delete a linked Feishu document.

The initial release supports My Library and mainland Feishu only. It does not
sync PDF annotations that have not been added to a Zotero note, standalone
notes, group libraries, attachments, or edits made in Feishu.

## Feishu Setup

1. Open the plugin preferences and click **Connect Feishu**.
2. Confirm creation of a dedicated local app in the browser.
3. If Feishu opens the app permission page, enable the listed permissions and
   complete any publishing or administrator approval required by your tenant.
4. Complete account authorization in the browser and return to Zotero.

Leave the destination folder empty to use My Space, or enter a Drive folder
URL. No App ID, App Secret, or OAuth redirect URL needs to be configured.

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

AGPL-3.0-or-later. See `THIRD_PARTY_NOTICES.md` for incorporated third-party
software notices.
