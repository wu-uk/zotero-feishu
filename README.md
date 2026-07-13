# Zotero Feishu Sync

[简体中文](doc/README-zhCN.md)

Zotero Feishu Sync is an unofficial Zotero plugin that publishes literature
metadata, notes, images, and PDF attachments to Feishu cloud documents. Zotero
remains the source of truth: synchronizing an existing item replaces the
plugin-managed content in its mapped Feishu document.

## Requirements

- Zotero 8-9. Release validation is performed on Zotero 9.
- A mainland Feishu account that can create a personal application and grant
  the requested permissions. Tenant policy may require administrator approval.
- Local PDF and note-image files must be available to Zotero when synchronizing.

## Installation

1. Download `zotero-feishu-sync.xpi` from the latest GitHub Release.
2. In Zotero, open **Tools → Plugins**.
3. Choose **Install Add-on From File**, select the XPI, and restart Zotero if
   requested.

## Connect Feishu

1. Open **Zotero Settings → Zotero Feishu Sync** and select **Connect Feishu**.
2. Confirm creation of the dedicated personal application in the browser.
3. If the Feishu permission console opens, enable the listed permissions and
   complete any required app publication or administrator approval.
4. Complete account authorization in the browser and return to Zotero.

No App ID, App Secret, or redirect URL needs to be entered manually. Leave the
target folder empty to use the root of My Space, or enter a Feishu Drive folder
URL or token.

## Usage

- Right-click a regular Zotero item, child note, or child attachment and choose
  **Feishu Sync → Sync selected items**.
- Right-click a collection and choose **Sync current collection to Feishu**.
- Use the same item menu to open or explicitly delete its mapped document.
- Check the Feishu status column for syncing, success, or failure details.

Each regular item maps to one Feishu Docx. Unchanged sources are skipped after
the mapped document is verified. Child notes retain Markdown-equivalent
structure, embedded note images are uploaded, and local child PDFs are appended
to the document.

## Limitations

- Only My Library and mainland Feishu are currently supported.
- Standalone notes and standalone attachments are not synchronized. Selecting a
  child note or attachment synchronizes its regular parent item.
- PDF annotations must first be added to a Zotero note.
- Feishu edits are not imported into Zotero and may be replaced by the next
  synchronization.
- Item mappings are local to the Zotero profile. Losing the mapping can create a
  second Feishu document for the same item.

## Privacy And Removal

Literature content is sent directly from Zotero to Feishu; the plugin does not
use a developer-operated relay server. App credentials and OAuth tokens are
stored in Zotero's Firefox Login Manager. Item mappings are stored in
`<Zotero profile>/zotero-feishu/state.json`.

Disconnecting removes the OAuth tokens but retains the generated application
credentials for a later reconnect. Uninstalling the plugin does not delete the
personal application or synchronized documents from Feishu; remove them from
the Feishu Open Platform and Drive when they are no longer needed.

## Development

```bash
npm install
npm start
npm run lint:check
npm run build
npm test
```

Copy `.env.example` to `.env` and use a dedicated Zotero development profile.
Production packages and update manifests are written to `.scaffold/build/`.

## License

AGPL-3.0-or-later. See `THIRD_PARTY_NOTICES.md` for incorporated third-party
software notices. Feishu and its logo are trademarks of their respective owner;
this project is not affiliated with or endorsed by Feishu.
