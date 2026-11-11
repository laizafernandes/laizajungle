export interface ComponentHealthResult {
  status: 'up' | 'down';
  latencyMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface ReadinessStatus {
  status: 'ok' | 'degraded';
  timestamp: string;
  checks: {
    postgres: ComponentHealthResult;
    sqs: ComponentHealthResult;
  };
}

export interface LivenessStatus {
  status: 'ok';
  timestamp: string;
  uptimeSeconds: number;
}
