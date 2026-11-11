import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { DatabaseModule } from './infrastructure/database/database.module';
import { HealthModule } from './infrastructure/health/health.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { WageringModule } from './infrastructure/wagering/wagering.module';
import { DomainExceptionFilter } from './presentation/http/filters/domain-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    MessagingModule,
    ObservabilityModule,
    HealthModule,
    WageringModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: DomainExceptionFilter,
    },
  ],
})
export class AppModule {}
