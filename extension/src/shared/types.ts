export interface ActionEvent {
  event_type: ActionType;
  payload: Record<string, unknown>;
  page_url: string;
  page_title: string;
  timestamp: string;
  run_id?: string;
}

export type ActionType =
  | "click"
  | "type"
  | "select"
  | "submit"
  | "scroll"
  | "navigate"
  | "hover"
  | "copy"
  | "paste"
  | "tab_change";

export interface RecordedStep {
  step_index: number;
  action_type: ActionType;
  intent?: string;
  selector_chain: SelectorSet[];
  accessibility_metadata?: Record<string, unknown>;
  text_anchors?: string[];
  dom_context?: Record<string, unknown>;
  checkpoint?: boolean;
}

export interface SelectorSet {
  type: "accessibility" | "css" | "text" | "xpath";
  value: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  prompt?: string;
  target_url?: string;
  status: "draft" | "active" | "archived";
  steps: RecordedStep[];
  created_at: string;
}

export interface ExecutionRun {
  id: string;
  workflow_id: string;
  status: RunStatus;
  current_step_index: number;
  pause_reason?: string;
  error_summary?: string;
  started_at?: string;
  ended_at?: string;
}

export type RunStatus =
  | "idle"
  | "recording"
  | "validated"
  | "queued"
  | "running"
  | "waiting_for_user"
  | "recovering"
  | "failed"
  | "completed"
  | "canceled";

export type PopupState =
  | { type: "idle" }
  | { type: "recording"; step_count: number }
  | { type: "running"; workflow_name: string; current_step: number; total_steps: number; run_id: string }
  | { type: "waiting_for_user"; reason: string; run_id: string }
  | { type: "error"; message: string };

export interface RecordEventResponse {
  id: string;
  hash: string;
  previous_hash: string;
}
