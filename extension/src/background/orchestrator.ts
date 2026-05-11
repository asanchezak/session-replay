import type { ActionEvent, PopupState } from "../shared/types";
import { apiClient } from "./api";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export class Orchestrator {
  private eventBuffer: ActionEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private popupState: PopupState = { type: "idle" };
  private isRecording = false;
  private retryQueue: ActionEvent[] = [];

  startRecording(): void {
    this.isRecording = true;
    this.eventBuffer = [];
    this.retryQueue = [];
    this.popupState = { type: "recording", step_count: 0 };
    this.broadcastState();
    this.flushTimer = setInterval(() => this.flush(), 2000);
  }

  async stopRecording(): Promise<ActionEvent[]> {
    this.isRecording = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    await this.flushRetryQueue();
    const events = [...this.eventBuffer];
    this.eventBuffer = [];
    this.popupState = { type: "idle" };
    this.broadcastState();
    return events;
  }

  async pushEvent(event: ActionEvent): Promise<void> {
    if (!this.isRecording) return;

    this.eventBuffer.push(event);
    this.popupState = {
      type: "recording",
      step_count: this.eventBuffer.length,
    };
    this.broadcastState();

    if (this.eventBuffer.length >= 5) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.eventBuffer.length === 0) return;

    const batch = [...this.eventBuffer];
    this.eventBuffer = [];

    const results = await Promise.allSettled(
      batch.map((event) => apiClient.recordEvent(event)),
    );

    const failures: ActionEvent[] = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        failures.push(batch[i]);
      }
    });

    if (failures.length > 0) {
      console.warn(`Failed to send ${failures.length}/${batch.length} events, queuing for retry`);
      this.retryQueue.push(...failures);
    }
  }

  private async flushRetryQueue(): Promise<void> {
    if (this.retryQueue.length === 0) return;

    const batch = [...this.retryQueue];
    this.retryQueue = [];

    for (const event of batch) {
      let success = false;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await apiClient.recordEvent(event);
          success = true;
          break;
        } catch (err) {
          console.warn(`Retry ${attempt}/${MAX_RETRIES} failed for event:`, err);
          if (attempt < MAX_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
          }
        }
      }
      if (!success) {
        console.error(`Failed to send event after ${MAX_RETRIES} retries, discarding`);
      }
    }
  }

  private broadcastState(): void {
    chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: this.popupState }).catch(() => {
      // Popup may not be open
    });
  }

  getState(): PopupState {
    return this.popupState;
  }
}

export const orchestrator = new Orchestrator();
