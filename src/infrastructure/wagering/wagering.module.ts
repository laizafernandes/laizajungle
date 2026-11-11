import { Module } from '@nestjs/common';
import {
  CLOCK_PORT,
  type ClockPort,
  EVENT_PUBLISHER_PORT,
  type EventPublisherPort,
  GetWagerTransactionUseCase,
  GetWalletLedgerUseCase,
  GetWalletUseCase,
  ID_GENERATOR_PORT,
  INBOX_REPOSITORY_PORT,
  type IdGeneratorPort,
  type InboxRepositoryPort,
  OUTBOX_REPOSITORY_PORT,
  OpenWalletUseCase,
  OutboxPublisherUseCase,
  type OutboxRepositoryPort,
  PENDING_REFERENCE_POLICY_PORT,
  PendingReferencePolicy,
  ProcessPendingReferencesUseCase,
  ProcessWagerTransactionUseCase,
  ReconcileWalletUseCase,
  UNIT_OF_WORK_PORT,
  type UnitOfWorkPort,
  WAGER_TRANSACTION_REPOSITORY_PORT,
  WALLET_LEDGER_REPOSITORY_PORT,
  WALLET_REPOSITORY_PORT,
  type WagerTransactionRepositoryPort,
  WagerTransactionResolutionService,
  type WalletLedgerRepositoryPort,
  type WalletRepositoryPort,
} from '../../application/index';
import { ProvidersWageringController } from '../../presentation/http/controllers/providers-wagering.controller';
import { WageringController } from '../../presentation/http/controllers/wagering.controller';
import { WalletsController } from '../../presentation/http/controllers/wallets.controller';
import { SqsWagerConsumerService } from '../../presentation/sqs/sqs-wager-consumer.service';
import { loadEnvConfig } from '../config/env.config';
import { MikroOrmInboxRepository } from '../database/adapters/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '../database/adapters/mikro-orm-outbox.repository';
import { MikroOrmUnitOfWork } from '../database/adapters/mikro-orm-unit-of-work';
import { MikroOrmWagerTransactionRepository } from '../database/adapters/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletLedgerRepository } from '../database/adapters/mikro-orm-wallet-ledger.repository';
import { MikroOrmWalletRepository } from '../database/adapters/mikro-orm-wallet.repository';
import { SqsOutboxEventPublisher } from '../messaging/sqs-outbox-event.publisher';
import { SystemClock, UuidV7IdGenerator } from '../system/system-adapters';
import { OutboxPublisherWorker } from '../workers/outbox-publisher.worker';
import { PendingReferenceWorker } from '../workers/pending-reference.worker';

@Module({
  controllers: [WalletsController, WageringController, ProvidersWageringController],
  providers: [
    {
      provide: UNIT_OF_WORK_PORT,
      useClass: MikroOrmUnitOfWork,
    },
    {
      provide: WALLET_REPOSITORY_PORT,
      useClass: MikroOrmWalletRepository,
    },
    {
      provide: WAGER_TRANSACTION_REPOSITORY_PORT,
      useClass: MikroOrmWagerTransactionRepository,
    },
    {
      provide: WALLET_LEDGER_REPOSITORY_PORT,
      useClass: MikroOrmWalletLedgerRepository,
    },
    {
      provide: INBOX_REPOSITORY_PORT,
      useClass: MikroOrmInboxRepository,
    },
    {
      provide: OUTBOX_REPOSITORY_PORT,
      useClass: MikroOrmOutboxRepository,
    },
    {
      provide: EVENT_PUBLISHER_PORT,
      useClass: SqsOutboxEventPublisher,
    },
    {
      provide: ID_GENERATOR_PORT,
      useClass: UuidV7IdGenerator,
    },
    {
      provide: CLOCK_PORT,
      useClass: SystemClock,
    },
    {
      provide: PENDING_REFERENCE_POLICY_PORT,
      useFactory: () => {
        const cfg = loadEnvConfig().pendingReference;
        return new PendingReferencePolicy({
          baseDelayMs: cfg.baseDelayMs,
          maxDelayMs: cfg.maxDelayMs,
          maxAttempts: cfg.maxAttempts,
          ttlMs: cfg.ttlMs,
        });
      },
    },
    {
      provide: WagerTransactionResolutionService,
      inject: [
        WALLET_REPOSITORY_PORT,
        WAGER_TRANSACTION_REPOSITORY_PORT,
        WALLET_LEDGER_REPOSITORY_PORT,
        ID_GENERATOR_PORT,
        PENDING_REFERENCE_POLICY_PORT,
        OUTBOX_REPOSITORY_PORT,
      ],
      useFactory: (
        walletRepo: WalletRepositoryPort,
        wagerTxRepo: WagerTransactionRepositoryPort,
        ledgerRepo: WalletLedgerRepositoryPort,
        idGen: IdGeneratorPort,
        policy: PendingReferencePolicy,
        outboxRepo: OutboxRepositoryPort,
      ) =>
        new WagerTransactionResolutionService(
          walletRepo,
          wagerTxRepo,
          ledgerRepo,
          idGen,
          policy,
          outboxRepo,
        ),
    },
    {
      provide: OpenWalletUseCase,
      inject: [
        UNIT_OF_WORK_PORT,
        WALLET_REPOSITORY_PORT,
        WAGER_TRANSACTION_REPOSITORY_PORT,
        WALLET_LEDGER_REPOSITORY_PORT,
        ID_GENERATOR_PORT,
        CLOCK_PORT,
        OUTBOX_REPOSITORY_PORT,
      ],
      useFactory: (
        unitOfWork: UnitOfWorkPort,
        walletRepo: WalletRepositoryPort,
        wagerTxRepo: WagerTransactionRepositoryPort,
        ledgerRepo: WalletLedgerRepositoryPort,
        idGen: IdGeneratorPort,
        clock: ClockPort,
        outboxRepo: OutboxRepositoryPort,
      ) =>
        new OpenWalletUseCase(
          unitOfWork,
          walletRepo,
          wagerTxRepo,
          ledgerRepo,
          idGen,
          clock,
          outboxRepo,
        ),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [
        UNIT_OF_WORK_PORT,
        WALLET_REPOSITORY_PORT,
        WAGER_TRANSACTION_REPOSITORY_PORT,
        WagerTransactionResolutionService,
        ID_GENERATOR_PORT,
        CLOCK_PORT,
        INBOX_REPOSITORY_PORT,
      ],
      useFactory: (
        unitOfWork: UnitOfWorkPort,
        walletRepo: WalletRepositoryPort,
        wagerTxRepo: WagerTransactionRepositoryPort,
        resolutionService: WagerTransactionResolutionService,
        idGen: IdGeneratorPort,
        clock: ClockPort,
        inboxRepo: InboxRepositoryPort,
      ) =>
        new ProcessWagerTransactionUseCase(
          unitOfWork,
          walletRepo,
          wagerTxRepo,
          resolutionService,
          idGen,
          clock,
          inboxRepo,
        ),
    },
    {
      provide: ProcessPendingReferencesUseCase,
      inject: [
        UNIT_OF_WORK_PORT,
        WALLET_REPOSITORY_PORT,
        WAGER_TRANSACTION_REPOSITORY_PORT,
        WagerTransactionResolutionService,
        CLOCK_PORT,
      ],
      useFactory: (
        unitOfWork: UnitOfWorkPort,
        walletRepo: WalletRepositoryPort,
        wagerTxRepo: WagerTransactionRepositoryPort,
        resolutionService: WagerTransactionResolutionService,
        clock: ClockPort,
      ) =>
        new ProcessPendingReferencesUseCase(
          unitOfWork,
          walletRepo,
          wagerTxRepo,
          resolutionService,
          clock,
          loadEnvConfig().pendingReference.batchSize,
        ),
    },
    {
      provide: OutboxPublisherUseCase,
      inject: [UNIT_OF_WORK_PORT, OUTBOX_REPOSITORY_PORT, EVENT_PUBLISHER_PORT, CLOCK_PORT],
      useFactory: (
        unitOfWork: UnitOfWorkPort,
        outboxRepo: OutboxRepositoryPort,
        eventPublisher: EventPublisherPort,
        clock: ClockPort,
      ) => {
        const outboxCfg = loadEnvConfig().outbox;
        return new OutboxPublisherUseCase(unitOfWork, outboxRepo, eventPublisher, clock, {
          defaultBatchSize: outboxCfg.batchSize,
          baseRetryDelayMs: outboxCfg.baseDelayMs,
          maxRetryDelayMs: outboxCfg.maxDelayMs,
        });
      },
    },
    {
      provide: GetWalletUseCase,
      inject: [UNIT_OF_WORK_PORT, WALLET_REPOSITORY_PORT],
      useFactory: (unitOfWork: UnitOfWorkPort, walletRepo: WalletRepositoryPort) =>
        new GetWalletUseCase(unitOfWork, walletRepo),
    },
    {
      provide: GetWalletLedgerUseCase,
      inject: [UNIT_OF_WORK_PORT, WALLET_REPOSITORY_PORT, WALLET_LEDGER_REPOSITORY_PORT],
      useFactory: (
        unitOfWork: UnitOfWorkPort,
        walletRepo: WalletRepositoryPort,
        ledgerRepo: WalletLedgerRepositoryPort,
      ) => new GetWalletLedgerUseCase(unitOfWork, walletRepo, ledgerRepo),
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [UNIT_OF_WORK_PORT, WAGER_TRANSACTION_REPOSITORY_PORT],
      useFactory: (unitOfWork: UnitOfWorkPort, wagerTxRepo: WagerTransactionRepositoryPort) =>
        new GetWagerTransactionUseCase(unitOfWork, wagerTxRepo),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [UNIT_OF_WORK_PORT, WALLET_REPOSITORY_PORT, WALLET_LEDGER_REPOSITORY_PORT],
      useFactory: (
        unitOfWork: UnitOfWorkPort,
        walletRepo: WalletRepositoryPort,
        ledgerRepo: WalletLedgerRepositoryPort,
      ) => new ReconcileWalletUseCase(unitOfWork, walletRepo, ledgerRepo),
    },
    PendingReferenceWorker,
    OutboxPublisherWorker,
    SqsWagerConsumerService,
  ],
  exports: [
    OpenWalletUseCase,
    ProcessWagerTransactionUseCase,
    ProcessPendingReferencesUseCase,
    OutboxPublisherUseCase,
    SqsWagerConsumerService,
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    GetWagerTransactionUseCase,
    ReconcileWalletUseCase,
  ],
})
export class WageringModule {}
