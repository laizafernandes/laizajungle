import { Injectable } from '@nestjs/common';
import type { ClockPort, IdGeneratorPort } from '../../application/index';

@Injectable()
export class UuidV7IdGenerator implements IdGeneratorPort {
  nextId(): string {
    return Bun.randomUUIDv7();
  }
}

@Injectable()
export class SystemClock implements ClockPort {
  now(): Date {
    return new Date();
  }
}
