import { LedgerDirection, Money, type MoneyProps } from '../../domain/index';
import { ValidationApplicationError, WalletNotFoundError } from '../errors/application.error';
import type { MetricsPort, StructuredLoggerPort } from '../ports/observability.ports';
import type {
  UnitOfWorkPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../ports/wagering.ports';
import { isValidUuid } from '../services/validation.helpers';

export interface WalletReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export class ReconcileWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly walletRepository: WalletRepositoryPort,
    private readonly walletLedgerRepository: WalletLedgerRepositoryPort,
    private readonly logger?: StructuredLoggerPort,
    private readonly metrics?: MetricsPort,
  ) {}

  async execute(walletId: string, correlationId?: string): Promise<WalletReconciliationResult> {
    if (!isValidUuid(walletId)) {
      throw new ValidationApplicationError('walletId must be a valid UUID');
    }

    const result = await this.unitOfWork.runInTransaction(async (tx) => {
      // Lock wallet row to observe a point-in-time consistent snapshot with its ledger entries.
      const wallet = await this.walletRepository.findByIdForUpdate(tx, walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }

      const entries = await this.walletLedgerRepository.findAllByWallet(tx, walletId);

      let calculated = Money.zero(wallet.currency);
      for (const entry of entries) {
        calculated =
          entry.direction === LedgerDirection.Credit
            ? calculated.add(entry.money)
            : calculated.subtract(entry.money);
      }

      const difference = wallet.balance.subtract(calculated);
      const consistent = difference.isZero();

      return {
        walletId: wallet.id,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries: entries.length,
      };
    });

    this.metrics?.recordReconciliationResult({ consistent: result.consistent });

    if (!result.consistent) {
      const fields = {
        correlationId: correlationId ?? result.walletId,
        walletId: result.walletId,
        consistent: false,
        checkedEntries: result.checkedEntries,
      };
      if (this.logger) {
        this.logger.warn('wallet_reconciliation_mismatch', fields);
      } else {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'wallet_reconciliation_mismatch',
            ...fields,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }

    return result;
  }
}
