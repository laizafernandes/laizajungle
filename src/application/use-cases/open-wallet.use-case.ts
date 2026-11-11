import {
  LedgerDirection,
  Money,
  type MoneyProps,
  WagerTransaction,
  Wallet,
  WalletLedgerEntry,
} from '../../domain/index';
import { DuplicateWalletError, ValidationApplicationError } from '../errors/application.error';
import type {
  ClockPort,
  IdGeneratorPort,
  UnitOfWorkPort,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../ports/wagering.ports';
import { extractPgUniqueConstraint, isValidUuid } from '../services/validation.helpers';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class OpenWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly walletRepository: WalletRepositoryPort,
    private readonly wagerTransactionRepository: WagerTransactionRepositoryPort,
    private readonly walletLedgerRepository: WalletLedgerRepositoryPort,
    private readonly idGenerator: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    if (!isValidUuid(command.playerId)) {
      throw new ValidationApplicationError('playerId must be a valid UUID');
    }

    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();
    const wallet = Wallet.open({
      id: this.idGenerator.nextId(),
      playerId: command.playerId,
      initialBalance,
      now,
    });

    try {
      await this.unitOfWork.runInTransaction(async (tx) => {
        await this.walletRepository.insert(tx, wallet);

        if (initialBalance.isPositive()) {
          const openingTx = WagerTransaction.createOpening({
            id: this.idGenerator.nextId(),
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initialBalance,
            createdAt: now,
          });
          openingTx.markProcessed(undefined, now, initialBalance);

          const ledgerEntry = WalletLedgerEntry.create({
            id: this.idGenerator.nextId(),
            walletId: wallet.id,
            transactionId: openingTx.id,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(initialBalance.currency),
            balanceAfter: initialBalance,
            createdAt: now,
          });

          await this.wagerTransactionRepository.insert(tx, openingTx);
          await this.walletLedgerRepository.insert(tx, ledgerEntry);
        }
      });
    } catch (error) {
      const uniqueConstraint = extractPgUniqueConstraint(error);
      if (uniqueConstraint?.includes('uq_wallets_player_currency')) {
        throw new DuplicateWalletError(command.playerId, initialBalance.currency);
      }
      throw error;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
