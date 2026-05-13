import type { ActionEvent, PopupState } from "./types";

export interface ContentToBackgroundMessage {
  type: "RECORD_EVENT";
  event: ActionEvent;
}

export interface ContentToBackgroundResponse {
  type: "EVENT_RECORDED";
  id: string;
  hash: string;
}

export interface BackgroundToContentMessage {
  type: "EXECUTE_STEP";
  step: {
    action_type: string;
    selector_chain: Array<{ type: string; value: string }>;
    value?: string;
    intent?: string;
    methods?: Array<{
      action_type: string;
      selector_chain: Array<{ type: string; value: string }>;
      value?: string;
    }>;
  };
}

export interface BackgroundToContentResponse {
  type: "STEP_RESULT";
  success: boolean;
  error?: string;
}

export interface ContentScriptReadyMessage {
  type: "CONTENT_SCRIPT_READY";
  tabId: number;
}

export interface CaptureDomSnippetMessage {
  type: "CAPTURE_DOM_SNIPPET";
  selectorPattern: string;
}

export interface DomSnippetResponse {
  type: "DOM_SNIPPET_RESULT";
  html: string;
  url: string;
  title: string;
  error?: string;
}

export type ExtensionMessage =
  | ContentToBackgroundMessage
  | BackgroundToContentMessage;

export type ExtensionResponse =
  | ContentToBackgroundResponse
  | BackgroundToContentResponse;
