export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  scope: string;
}

export interface FeishuUser {
  name: string;
  openId: string;
}

export interface PendingSync {
  targetSourceHash: string;
  startedAt: string;
}

export interface SyncRecord {
  libraryID: number;
  itemKey: string;
  documentId: string;
  documentUrl: string;
  documentTitle?: string;
  sourceHash: string;
  lastSyncedAt: string;
  sections?: SyncedSection[];
  pendingSync?: PendingSync;
}

export interface SyncState {
  version: 3;
  records: Record<string, SyncRecord>;
}

export interface SyncedSection {
  key: string;
  sourceHash: string;
  remoteHash?: string;
  blockIds: string[];
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

export interface EquationSource {
  content: string;
  display: boolean;
}

export interface TextBlock {
  type:
    | "paragraph"
    | "heading1"
    | "heading2"
    | "heading3"
    | "heading4"
    | "heading5"
    | "heading6"
    | "bullet"
    | "ordered"
    | "quote"
    | "code";
  runs: TextRun[];
}

export interface CalloutBlock {
  type: "callout";
  backgroundColor?: number;
  borderColor?: number;
  textColor?: number;
  emojiId?: string;
  children: TextBlock[];
}

export type RichBlock =
  | TextBlock
  | CalloutBlock
  | { type: "divider" }
  | {
      type: "html";
      content: string;
      normalizeOrderedListItems?: boolean;
      equations?: EquationSource[];
    }
  | {
      type: "file";
      attachmentKey: string;
      name: string;
    }
  | {
      type: "image";
      attachmentKey: string;
      alt: string;
      width?: number;
      height?: number;
    };

export interface DocumentModel {
  title: string;
  sections: DocumentSection[];
  sourceHash: string;
}

export interface DocumentSection {
  key: string;
  sourceHash: string;
  blocks: RichBlock[];
}

export interface DocumentWriteResult {
  sections: SyncedSection[];
  errors: string[];
  rebuilt: boolean;
}

export type SyncOutcome =
  "created" | "updated" | "unchanged" | "partial" | "failed";

export interface SyncResult {
  libraryID: number;
  itemKey: string;
  title: string;
  outcome: SyncOutcome;
  documentUrl?: string;
  errors: string[];
}
