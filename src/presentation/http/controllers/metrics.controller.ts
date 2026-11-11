import { Controller, Get, Header, Inject, Query, Res } from '@nestjs/common';
import { METRICS_PORT } from '../../../application/index';
import type { PrometheusMetricsRegistry } from '../../../infrastructure/observability/prometheus-metrics-registry';

interface HttpResponse {
  setHeader(name: string, value: string): void;
}

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(METRICS_PORT)
    private readonly registry: PrometheusMetricsRegistry,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async getMetrics(
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<unknown> {
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return this.registry.collectSnapshot();
    }

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return this.registry.renderPrometheus();
  }
}
