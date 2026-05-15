import type { ActionEvent, AgentCommand } from "./types";

export interface ContentToBackgroundMessage {
  type: "RECORD_EVENT";
  event: ActionEvent;
  protocol_version?: number;
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
  protocol_version?: number;
}

export interface BackgroundToContentResponse {
  type: "STEP_RESULT";
  success: boolean;
  error?: string;
}

export interface ContentScriptReadyMessage {
  type: "CONTENT_SCRIPT_READY";
  tabId: number;
  protocol_version?: number;
}

export interface CaptureDomSnippetMessage {
  type: "CAPTURE_DOM_SNIPPET";
  selectorPattern: string;
  protocol_version?: number;
}

export interface DomSnippetResponse {
  type: "DOM_SNIPPET_RESULT";
  html: string;
  url: string;
  title: string;
  error?: string;
}

export interface DetectChallengesMessage {
  type: "DETECT_CHALLENGES";
  protocol_version?: number;
}

export interface ChallengesDetectedResponse {
  type: "CHALLENGES_DETECTED";
  challenges: Array<{
    detected: boolean;
    type: string | null;
    confidence: number;
    description: string | null;
  }>;
}

export interface ExtractDataMessage {
  type: "EXTRACT_DATA";
  outputSchema: Record<string, unknown> | null;
  protocol_version?: number;
}

export interface ExtractDataResponse {
  type: "EXTRACT_DATA_RESULT";
  data: Record<string, unknown>[];
  url: string;
  error?: string;
}

export interface CapturePageContextMessage {
  type: "CAPTURE_PAGE_CONTEXT";
  protocol_version?: number;
}

export interface PageContextResponse {
  type: "PAGE_CONTEXT_RESULT";
  url: string;
  title: string;
  dom_snippet: string;
  accessibility_tree: string;
  visible_text: string;
  visible_elements: Array<Record<string, unknown>>;
  is_blocking: boolean;
  blocking_type: string | null;
}

export interface ExecuteAgentCommandMessage {
  type: "EXECUTE_AGENT_COMMAND";
  command: AgentCommand;
  protocol_version?: number;
}

export interface AgentCommandResultResponse {
  type: "AGENT_COMMAND_RESULT";
  success: boolean;
  error?: string;
}

export type ExtensionMessage =
  | ContentToBackgroundMessage
  | BackgroundToContentMessage
  | ContentScriptReadyMessage
  | CaptureDomSnippetMessage
  | DetectChallengesMessage
  | ExtractDataMessage
  | CapturePageContextMessage
  | ExecuteAgentCommandMessage;

export type ExtensionResponse =
  | ContentToBackgroundResponse
  | BackgroundToContentResponse
  | DomSnippetResponse
  | ChallengesDetectedResponse
  | ExtractDataResponse
  | PageContextResponse
  | AgentCommandResultResponse;
