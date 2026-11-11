import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  LivenessStatus,
  ReadinessStatus,
} from '../../../application/ports/health-checker.port';
import { HealthService } from '../../../infrastructure/health/health.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async checkRoot(): Promise<ReadinessStatus> {
    return this.checkReadiness();
  }

  @Get('live')
  @HttpCode(HttpStatus.OK)
  checkLiveness(): LivenessStatus {
    return this.healthService.getLiveness();
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async checkReadiness(): Promise<ReadinessStatus> {
    const readiness = await this.healthService.getReadiness();
    if (readiness.status !== 'ok') {
      throw new ServiceUnavailableException(readiness);
    }
    return readiness;
  }
}
