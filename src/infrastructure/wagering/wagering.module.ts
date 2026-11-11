import { Module } from '@nestjs/common';
import {
  CLOCK_PORT,
  type ClockPort,
  ID_GENERATOR_PORT,
  type IdGeneratorPort,
  OpenWalletUseCase,
  ProcessWagerTransactionUseCase,
  UNIT_OF_WORK_PORT,
  type UnitOfWorkPort,
  WAGER_TRANSACTION_REPOSITORY_PORT,
  WALLET_LEDGER_REPOSITORY_PORT,
  WALLET_REPOSITORY_PORT,
  type WagerTransactionRepositoryPort,
  type WalletLedgerRepositoryPort,
  type WalletRepositoryPort,
} from '../../application/index';
import { WageringController } from '../../presentation/http/controllers/wagering.controller';
import { WalletsController } from '../../presentation/http/controllers/wallets.controller';
import { MikroOrmUnitOfWork } from '../database/adapters/mikro-orm-unit-of-work';
import { MikroOrmWagerTransactionRepository } from '../database/adapters/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletLedgerRepository } from '../database/adapters/mikro-orm-wallet-ledger.repository';
import { MikroOrmWalletRepository } from '../database/adapters/mikro-orm-wallet.repository';
import { SystemClock, UuidV7IdGenerator } from '../system/system-adapters';

@Module({
  controllers: [WalletsController, WageringController],
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
      ) =>
        new ProcessWagerTransactionUseCase(
          unitOfWork,
          walletRepo,
          wagerTxRepo,
          ledgerRepo,
          idGen,
          clock,
        ),
    },
  ],
  exports: [OpenWalletUseCase, ProcessWagerTransactionUseCase],
})
export class WageringModule {}
