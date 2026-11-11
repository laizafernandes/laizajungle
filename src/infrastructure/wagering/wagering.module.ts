import { Module } from '@nestjs/common';
import {
  CLOCK_PORT,
  type ClockPort,
  GetWagerTransactionUseCase,
  GetWalletLedgerUseCase,
  GetWalletUseCase,
  ID_GENERATOR_PORT,
  type IdGeneratorPort,
  OpenWalletUseCase,
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
import { loadEnvConfig } from '../config/env.config';
import { MikroOrmUnitOfWork } from '../database/adapters/mikro-orm-unit-of-work';
import { MikroOrmWagerTransactionRepository } from '../database/adapters/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletLedgerRepository } from '../database/adapters/mikro-orm-wallet-ledger.repository';
import { MikroOrmWalletRepository } from '../database/adapters/mikro-orm-wallet.repository';
import { SystemClock, UuidV7IdGenerator } from '../system/system-adapters';
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
      ],
      useFactory: (
        walletRepo: WalletRepositoryPort,
        wagerTxRepo: WagerTransactionRepositoryPort,
        ledgerRepo: WalletLedgerRepositoryPort,
        idGen: IdGeneratorPort,
        policy: PendingReferencePolicy,
      ) =>
        new WagerTransactionResolutionService(walletRepo, wagerTxRepo, ledgerRepo, idGen, policy),
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
      ],
      useFactory: (
        unitOfWork: UnitOfWorkPort,
        walletRepo: WalletRepositoryPort,
        wagerTxRepo: WagerTransactionRepositoryPort,
        ledgerRepo: WalletLedgerRepositoryPort,
        idGen: IdGeneratorPort,
        clock: ClockPort,
      ) => new OpenWalletUseCase(unitOfWork, walletRepo, wagerTxRepo, ledgerRepo, idGen, clock),
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
      ],
      useFactory: (
        unitOfWork: UnitOfWorkPort,
        walletRepo: WalletRepositoryPort,
        wagerTxRepo: WagerTransactionRepositoryPort,
        resolutionService: WagerTransactionResolutionService,
        idGen: IdGeneratorPort,
        clock: ClockPort,
      ) =>
        new ProcessWagerTransactionUseCase(
          unitOfWork,
          walletRepo,
          wagerTxRepo,
          resolutionService,
          idGen,
          clock,
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
  ],
  exports: [
    OpenWalletUseCase,
    ProcessWagerTransactionUseCase,
    ProcessPendingReferencesUseCase,
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    GetWagerTransactionUseCase,
    ReconcileWalletUseCase,
  ],
})
export class WageringModule {}
