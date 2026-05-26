import type { ActionEvent, PopupState } from "../shared/types";
import { apiClient } from "./api";
import { createLogger } from "../shared/logger";

const log = createLogger("orchestrator");
const STORAGE_KEY = "recording_state";
const RUN_TAB_KEY = "active_run_tabs";

// In-memory map of runId → tabId for active runs.
// Written through to chrome.storage.session so it survives SW sleep/reload.
export const runTabMap = new Map<string, number>();

export async function setRunTab(runId: string, tabId: number): Promise<void> {
  runTabMap.set(runId, tabId);
  try {
    const stored = await chrome.storage.session.get(RUN_TAB_KEY);
    const entries = (stored[RUN_TAB_KEY] as Record<string, number>) || {};
    await chrome.storage.session.set({ [RUN_TAB_KEY]: { ...entries, [runId]: tabId } });
  } catch { /* non-fatal; in-memory map is authoritative for this SW lifetime */ }
}

export async function clearRunTab(runId: string): Promise<void> {
  runTabMap.delete(runId);
  try {
    const stored = await chrome.storage.session.get(RUN_TAB_KEY);
    const entries = { ...((stored[RUN_TAB_KEY] as Record<string, number>) || {}) };
    delete entries[runId];
    await chrome.storage.session.set({ [RUN_TAB_KEY]: entries });
  } catch {
    // Non-fatal; run lifecycle can continue using in-memory state.
  }
}

async function restoreRunTabMap(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(RUN_TAB_KEY);
    const entries = (stored[RUN_TAB_KEY] as Record<string, number>) || {};
    for (const [runId, tabId] of Object.entries(entries)) {
      runTabMap.set(runId, tabId);
    }
    if (Object.keys(entries).length > 0) {
      log.log(`[TabLifecycle] Restored ${Object.keys(entries).length} active run-tab entries from storage`);
    }
  } catch {
    // Best-effort restore only.
  }
}

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

interface RecordingStorageState {
  isRecording: boolean;
  events: ActionEvent[];
  name: string;
  goal?: string;
  pendingSave?: boolean;
}

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
  private _pendingSave: RecordingStorageState | null = null;
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
    await this._flushPendingSave();
  }

  private async _tryRestore(): Promise<void> {
    try {
      const stored = await chrome.storage.session.get(STORAGE_KEY);
      const data = stored[STORAGE_KEY] as RecordingStorageState | undefined;
      if (data?.pendingSave && Array.isArray(data.events) && data.events.length > 0) {
        this._pendingSave = {
          isRecording: false,
          events: [...data.events],
          name: data.name || "",
          goal: data.goal,
          pendingSave: true,
        };
        log.log(`Restored pending recording save (${data.events.length} events)`);
      } else if (data?.isRecording && Array.isArray(data.events)) {
        this._isRecording = true;
        this.eventBuffer = [...data.events];
        this._recordingName = data.name || "";
        this._recordingGoal = data.goal || "";
        log.log(`Restored recording session (${this.eventBuffer.length} buffered events)`);
        this.broadcastState();
      }
    } catch {
      // first run or storage unavailable
    }
    await restoreRunTabMap();
  }

  async persist(): Promise<void> {
    try {
      await chrome.storage.session.set({
        [STORAGE_KEY]: {
          isRecording: this._isRecording,
          events: this.eventBuffer,
          name: this._recordingName,
          goal: this._recordingGoal,
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

  private async _persistPendingSave(events: ActionEvent[], name: string, goal: string): Promise<void> {
    this._pendingSave = {
      isRecording: false,
      events: [...events],
      name,
      goal: goal || undefined,
      pendingSave: true,
    };
    try {
      await chrome.storage.session.set({
        [STORAGE_KEY]: this._pendingSave,
      });
    } catch {
      // storage write failed; keep the in-memory snapshot for this session
    }
  }

  private async _flushPendingSave(): Promise<void> {
    if (!this._pendingSave || this._pendingSave.events.length === 0) return;
    const pending = this._pendingSave;
    try {
      const targetUrl = pending.events.find((e) => e.page_url)?.page_url || null;
      const result = await apiClient.recordWorkflow(
        pending.name || `Recording ${new Date().toLocaleString()}`,
        targetUrl,
        pending.events,
        pending.goal,
      );
      log.log(`Recovered pending workflow recording: ${result.id} (${result.step_count} steps)`);
      this._pendingSave = null;
      await this._clearStorage();
    } catch (err) {
      log.error("Failed to save pending workflow recording:", err);
      await this._persistPendingSave(pending.events, pending.name, pending.goal || "");
    }
  }

  async startRecording(): Promise<void> {
    this._isRecording = true;
    this.eventBuffer = [];
    this._recordingName = "";
    this._pendingSave = null;
    await this.persist();
    this.broadcastState();
  }

  async stopRecording(): Promise<{ id: string; name: string; step_count: number } | null> {
    this._isRecording = false;
    const events = [...this.eventBuffer];
    this.eventBuffer = [];
    this.broadcastState();

    if (events.length === 0) {
      this._pendingSave = null;
      await this._clearStorage();
      return null;
    }

    const name = this._recordingName || `Recording ${new Date().toLocaleString()}`;
    const targetUrl = events.find(e => e.page_url)?.page_url || null;
    const goal = this._recordingGoal || undefined;

    // Persist a pending-save snapshot BEFORE the network upload so storage
    // immediately reflects isRecording=false. Without this, the content
    // script's 500ms storage-polling fallback keeps seeing isRecording=true
    // for the duration of the upload and re-enables recording, making the
    // stop button feel unresponsive.
    await this._persistPendingSave(events, name, goal || "");

    try {
      const result = await apiClient.recordWorkflow(name, targetUrl, events, goal);
      log.log(`Workflow recorded: ${result.id} (${result.step_count} steps)`);
      this._pendingSave = null;
      await this._clearStorage();
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

  async retryPendingSaveIfAny(): Promise<void> {
    await this._flushPendingSave();
    if (!this._isRecording) {
      this.broadcastState();
    }
  }
}

export const orchestrator = new Orchestrator();
