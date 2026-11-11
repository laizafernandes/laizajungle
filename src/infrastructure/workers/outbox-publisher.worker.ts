import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { OutboxPublisherUseCase } from '../../application/index';
import { loadEnvConfig } from '../config/env.config';

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private readonly pollIntervalMs: number;
  private readonly enabled: boolean;

  constructor(
    @Inject(OutboxPublisherUseCase)
    private readonly useCase: OutboxPublisherUseCase,
  ) {
    const cfg = loadEnvConfig();
    this.pollIntervalMs = cfg.outbox.pollIntervalMs;
    this.enabled = cfg.outbox.publisherEnabled;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }
    this.scheduleNextTick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
  }

  private scheduleNextTick(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.inFlight = this.runTick().finally(() => {
        this.inFlight = null;
        this.scheduleNextTick();
      });
    }, this.pollIntervalMs);
  }

  private async runTick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.useCase.publishDueBatch();
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'outbox_publisher_worker_tick_failed',
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
}
