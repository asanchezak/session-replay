type StepLike = {
  step_index: number;
  action_type: string;
  intent?: string;
  value?: string;
  success_condition?: { value?: string } | null;
};

type WorkflowLike = {
  steps: StepLike[];
  connector_bindings?: Array<{
    parameter_key: string;
    connector_id: string;
    source_kind: string;
    template: string;
    enabled: boolean;
  }>;
};

type AnalysisParamLike = { default: string | null };

export type ConnectorBindingDraft = {
  parameter_key: string;
  connector_id: string;
  source_kind: string;
  template: string;
  enabled: boolean;
};

export type WebhookTrigger = {
  id: string;
  connector_id: string;
  workflow_id: string;
  event_kind: string;
  enabled: boolean;
  created_at: string | null;
  last_fired_at: string | null;
  last_job: { job_title: string; job_url: string; job_id: string } | null;
};

export function normalizeWebhookTriggerResponse(payload: unknown): WebhookTrigger[] {
  const isTrigger = (value: unknown): value is WebhookTrigger => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<WebhookTrigger>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.connector_id === "string" &&
      typeof candidate.workflow_id === "string" &&
      typeof candidate.event_kind === "string"
    );
  };

  if (Array.isArray(payload)) {
    return payload.filter(isTrigger);
  }
  if (payload && typeof payload === "object" && "triggers" in payload && Array.isArray((payload as { triggers?: unknown }).triggers)) {
    return (payload as { triggers: unknown[] }).triggers.filter(isTrigger);
  }
  return [];
}

function normalizeText(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function describeStep(step: StepLike): string {
  const number = step.step_index + 1;
  const intent = (step.intent || "").replace(/\s+/g, " ").trim();
  if (intent) return `Step ${number} - ${step.action_type}: ${intent}`;
  return `Step ${number} - ${step.action_type}`;
}

export function formatStepLabel(step: StepLike): string {
  return describeStep(step);
}

export function parameterConsumerSteps(workflow: WorkflowLike | null, parameter: AnalysisParamLike): StepLike[] {
  if (!workflow || !parameter.default) return [];
  const needle = normalizeText(parameter.default);
  if (!needle) return [];
  return workflow.steps.filter((step) => {
    const valueMatch = normalizeText(step.value).includes(needle);
    const intentMatch = normalizeText(step.intent).includes(needle);
    const successMatch = normalizeText(step.success_condition?.value).includes(needle);
    return valueMatch || intentMatch || successMatch;
  });
}

export function getBindingDraftForParameter(
  workflow: WorkflowLike | null,
  parameterKey: string,
): ConnectorBindingDraft {
  const existingBinding = workflow?.connector_bindings?.find((binding) => binding.parameter_key === parameterKey);
  return {
    parameter_key: parameterKey,
    connector_id: existingBinding?.connector_id || "",
    source_kind: existingBinding?.source_kind || "odoo_latest_job",
    template: existingBinding?.template || "Hi, we are hiring for {job_title}.\n\n{job_description}",
    enabled: existingBinding?.enabled ?? true,
  };
}

