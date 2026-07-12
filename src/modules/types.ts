export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scope: string;
}

export interface SyncRecord {
  libraryID: number;
  itemKey: string;
  documentId: string;
  documentUrl: string;
  sourceHash: string;
  lastSyncedAt: string;
}

export interface SyncState {
  version: 1;
  records: Record<string, SyncRecord>;
}

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  inlineCode?: boolean;
  link?: string;
}

export interface TextRun {
  text: string;
  style?: TextStyle;
}

export type RichBlock =
  | {
      type:
        | "paragraph"
        | "heading1"
        | "heading2"
        | "heading3"
        | "bullet"
        | "ordered"
        | "quote"
        | "code";
      runs: TextRun[];
    }
  | { type: "divider" }
  | {
      type: "image";
      attachmentKey: string;
      alt: string;
      width?: number;
      height?: number;
    };

export interface DocumentModel {
  title: string;
  blocks: RichBlock[];
  sourceHash: string;
}

export type SyncOutcome =
  | "created"
  | "updated"
  | "unchanged"
  | "partial"
  | "failed";

export interface SyncResult {
  itemKey: string;
  title: string;
  outcome: SyncOutcome;
  documentUrl?: string;
  errors: string[];
}
