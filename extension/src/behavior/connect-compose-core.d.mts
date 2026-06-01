// Type declarations for connect-compose-core.mjs (plain JS so both the Playwright
// daemon and the TypeScript extension can consume the shared in-page connect-note
// logic without a build step).

export const NOTE_TEXTAREA_SELECTOR: string;

export function prepareConnectNoteDialog(): Promise<{
  ok: boolean;
  reason?: string;
  ready?: boolean;
}>;
