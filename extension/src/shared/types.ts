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

export interface MethodDef {
  action_type: ActionType;
  selector_chain: SelectorSet[];
  value?: string;
}

export interface RecordedStep {
  step_index: number;
  action_type: ActionType;
  intent?: string;
  selector_chain: SelectorSet[];
  value?: string;
  methods?: MethodDef[];
  accessibility_metadata?: Record<string, unknown>;
  text_anchors?: string[];
  dom_context?: Record<string, unknown>;
  checkpoint?: boolean;
}

export interface SelectorSet {
  type: "accessibility" | "css" | "text" | "xpath" | "anchor";
  value: string;
  score?: number;
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
  extracted_data?: Record<string, unknown>[];
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
  | { type: "setting_goal" }
  | { type: "recording"; step_count: number }
  | { type: "running"; workflow_name: string; current_step: number; total_steps: number; run_id: string }
  | { type: "running_parameterized"; workflow_name: string; current_step: number; total_steps: number; run_id: string; params: Record<string, string> }
  | { type: "recovering"; workflow_name: string; current_step: number; total_steps: number; run_id: string; error: string }
  | { type: "failed"; workflow_name: string; current_step: number; total_steps: number; run_id: string; error: string }
  | { type: "waiting_for_user"; reason: string; run_id: string }
  | { type: "error"; message: string };

export interface RecordEventResponse {
  id: string;
  hash: string;
  previous_hash: string;
}

export interface SemanticWorkflowInfo {
  goal: string | null;
  summary: string | null;
  confidence: number;
  parameters: WorkflowParameter[];
  phases: SemanticPhase[];
  outputSpec: OutputSpecification | null;
  replayStrategy: string | null;
}

export interface WorkflowParameter {
  key: string;
  type: "string" | "number" | "boolean" | "list";
  default: string | null;
  description: string | null;
  confidence: number;
  required: boolean;
}

export interface SemanticPhase {
  phase_index: number;
  phase_name: string;
  phase_goal: string | null;
  start_step_index: number;
  end_step_index: number;
}

export interface OutputSpecification {
  type: string;
  schema: Record<string, unknown> | null;
  confidence: number;
}

export interface RuntimeParams {
  [key: string]: string | number | boolean | string[];
}

export interface ExecutionPlan {
  strategy: string;
  mode: string;
  steps?: RecordedStep[];
  parameters?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  reason?: string;
}

export interface ExtractedData {
  step_index: number;
  data: Record<string, unknown>[];
  schema: Record<string, unknown> | null;
  url: string;
  timestamp: string;
}

export interface AgentCommandSelector {
  type: string;
  value: string;
}

export interface AgentCommand {
  action: "navigate" | "click" | "type" | "select" | "scroll" | "extract";
  target: string | null;
  value: string | null;
  selector_chain: AgentCommandSelector[];
  intent: string | null;
  methods: Array<{
    action_type: string;
    selector_chain: AgentCommandSelector[];
    value?: string;
  }>;
  timeout_ms: number;
  success_condition: Record<string, unknown> | null;
}

export interface AgentDecision {
  decision:
    | "EXECUTE"
    | "SKIP"
    | "ADAPT"
    | "WAIT"
    | "RESTART"
    | "ROLLBACK"
    | "PAUSE"
    | "COMPLETED";
  confidence: number;
  reasoning: string;
  command: AgentCommand | null;
  next_step_index: number | null;
  pause_reason: string | null;
  requires_human: boolean;
}

export interface PageContext {
  url: string;
  title: string;
  dom_snippet: string;
  accessibility_tree: string;
  visible_text: string;
  visible_elements: Array<{
    tag: string;
    id?: string;
    classes: string[];
    text: string;
    role?: string;
    aria_label?: string;
    selector: string;
    rect: { x: number; y: number; width: number; height: number };
  }>;
  is_blocking: boolean;
  blocking_type: string | null;
  page_unchanged: boolean;
  // Phase 2: delta against the previous PageContext for this tab/run, computed
  // by the service worker so the LLM sees what changed since the last poll.
  page_diff?: PageDiff | null;
}

export interface PageDiff {
  url_changed: boolean;
  previous_url?: string;
  added: Array<{ tag: string; role?: string; text: string }>;
  removed: Array<{ tag: string; role?: string; text: string }>;
  title_changed: boolean;
  previous_title?: string;
}

export interface AgentPollRequest {
  page_context: PageContext;
  current_step_index: number | null;
}

export interface AgentPollResponse {
  decision: string;
  confidence: number;
  reasoning: string;
  command: AgentCommand | null;
  next_step_index: number | null;
  pause_reason: string | null;
  wait_ms?: number | null;
  rollback_to?: number | null;
  requires_human: boolean;
  plan_updates?: Array<{ operation: string; step_index: number; new_step?: Record<string, unknown>; reason?: string }>;
}

export interface AgentResultRequest {
  step_index: number;
  success: boolean;
  error: string | null;
  page_context_after: PageContext | null;
  error_context?: string;
}

export interface AgentResultResponse {
  accepted: boolean;
  decision: string | null;
  next_step_index: number | null;
  should_poll?: boolean;
  ai_analysis?: {
    likely_cause: string;
    analysis: string;
    suggested_selectors: Array<{ type: string; value: string }>;
    confidence: number;
    should_retry: boolean;
  } | null;
}
