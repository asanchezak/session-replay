import type { ActionEvent, PopupState } from "../shared/types";
import { apiClient } from "./api";
import { createLogger } from "../shared/logger";

const log = createLogger("orchestrator");
const STORAGE_KEY = "recording_state";

// Allow content scripts to read recording state directly from storage
// This eliminates the race between SET_RECORDING message and SW restart
try {
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
  log.log("Storage access level set: TRUSTED_AND_UNTRUSTED_CONTEXTS");
} catch (e) {
  log.warn("Failed to set storage access level:", e);
}

let _initPromise: Promise<void> | null = null;
let _eventQueue: ActionEvent[] = [];
let _drainTimeout: ReturnType<typeof setTimeout> | null = null;

function drainQueue(orchestrator: Orchestrator): void {
  const batch = _eventQueue.splice(0);
  if (batch.length === 0) return;
  log.log(`Draining ${batch.length} queued events after SW restart`);

  for (const ev of batch) {
    orchestrator.eventBuffer.push(ev);
  }
  orchestrator.broadcastState();
  orchestrator.persist();

  if (_drainTimeout) {
    clearTimeout(_drainTimeout);
    _drainTimeout = null;
  }
}

export class Orchestrator {
  eventBuffer: ActionEvent[] = [];
  private _isRecording = false;
  private _recordingName = "";
  private _recordingGoal = "";
  private _ready = false;

  get isRecording(): boolean {
    return this._isRecording;
  }

  constructor() {
    this._init();
  }

  private async _init(): Promise<void> {
    if (_initPromise) return;
    _initPromise = this._tryRestore();
    await _initPromise;
    this._ready = true;
    drainQueue(this);
  }

  private async _tryRestore(): Promise<void> {
    try {
      const stored = await chrome.storage.session.get(STORAGE_KEY);
      const data = stored[STORAGE_KEY] as
        | { isRecording: true; events: ActionEvent[]; name: string }
        | undefined;
      if (data?.isRecording && Array.isArray(data.events)) {
        this._isRecording = true;
        this.eventBuffer = [...data.events];
        this._recordingName = data.name || "";
        log.log(`Restored recording session (${this.eventBuffer.length} buffered events)`);
        this.broadcastState();
      }
    } catch {
      // first run or storage unavailable
    }
  }

  async persist(): Promise<void> {
    try {
      await chrome.storage.session.set({
        [STORAGE_KEY]: {
          isRecording: this._isRecording,
          events: this.eventBuffer,
          name: this._recordingName,
        },
      });
    } catch {
      // storage write failed
    }
  }

  private async _clearStorage(): Promise<void> {
    try {
      await chrome.storage.session.remove(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  async startRecording(): Promise<void> {
    this._isRecording = true;
    this.eventBuffer = [];
    this._recordingName = "";
    await this.persist();
    this.broadcastState();
  }

  async stopRecording(): Promise<{ id: string; name: string; step_count: number } | null> {
    this._isRecording = false;
    const events = [...this.eventBuffer];
    this.eventBuffer = [];
    await this._clearStorage();

    if (events.length === 0) {
      this.broadcastState();
      return null;
    }

    const name = this._recordingName || `Recording ${new Date().toLocaleString()}`;
    const targetUrl = events.find(e => e.page_url)?.page_url || null;
    const goal = this._recordingGoal || undefined;

    try {
      const result = await apiClient.recordWorkflow(name, targetUrl, events, goal);
      log.log(`Workflow recorded: ${result.id} (${result.step_count} steps)`);
      this.broadcastState();
      return result;
    } catch (err) {
      log.error("Failed to save workflow recording:", err);
      this.broadcastState();
      return null;
    }
  }

  async pushEvent(event: ActionEvent): Promise<void> {
    if (this._ready && !this._isRecording) {
      return;
    }
    if (!this._ready) {
      _eventQueue.push(event);
      if (_eventQueue.length > 1000) {
        _eventQueue.splice(0, _eventQueue.length - 1000);
      }
      if (!_drainTimeout) {
        _drainTimeout = setTimeout(() => drainQueue(this), 5000);
      }
      return;
    }

    this.eventBuffer.push(event);
    if (this.eventBuffer.length > 1000) {
      this.eventBuffer.splice(0, this.eventBuffer.length - 1000);
    }
    this.broadcastState();
    await this.persist();
  }

  setRecordingName(name: string): void {
    this._recordingName = name;
  }

  setRecordingGoal(goal: string): void {
    this._recordingGoal = goal;
  }

  broadcastState(state?: PopupState): void {
    const s = state || (this._isRecording
      ? { type: "recording", step_count: this.eventBuffer.length }
      : { type: "idle" });
    chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: s }).catch(() => {});
  }

  notifyRunning(workflowName: string, currentStep: number, totalSteps: number, runId: string): void {
    this.broadcastState({
      type: "running",
      workflow_name: workflowName,
      current_step: currentStep,
      total_steps: totalSteps,
      run_id: runId,
    });
  }

  notifyRunningParameterized(
    workflowName: string,
    currentStep: number,
    totalSteps: number,
    runId: string,
    params: Record<string, string>,
  ): void {
    this.broadcastState({
      type: "running_parameterized",
      workflow_name: workflowName,
      current_step: currentStep,
      total_steps: totalSteps,
      run_id: runId,
      params,
    });
  }

  notifyRecovering(workflowName: string, currentStep: number, totalSteps: number, runId: string, error: string): void {
    this.broadcastState({
      type: "recovering",
      workflow_name: workflowName,
      current_step: currentStep,
      total_steps: totalSteps,
      run_id: runId,
      error,
    });
  }

  notifyFailed(workflowName: string, currentStep: number, totalSteps: number, runId: string, error: string): void {
    this.broadcastState({
      type: "failed",
      workflow_name: workflowName,
      current_step: currentStep,
      total_steps: totalSteps,
      run_id: runId,
      error,
    });
  }

  notifyWaiting(runId: string, reason: string): void {
    this.broadcastState({
      type: "waiting_for_user",
      run_id: runId,
      reason,
    });
  }

  notifyIdle(): void {
    this.broadcastState({ type: "idle" });
  }

  getState(): PopupState {
    return this._isRecording
      ? { type: "recording", step_count: this.eventBuffer.length }
      : { type: "idle" };
  }
}

export const orchestrator = new Orchestrator();
