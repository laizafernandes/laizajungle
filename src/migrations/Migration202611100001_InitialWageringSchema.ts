import { Migration } from '@mikro-orm/migrations';

export class Migration202611100001_InitialWageringSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid NOT NULL,
        player_id uuid NOT NULL,
        currency varchar(3) NOT NULL,
        balance_amount numeric(18,2) NOT NULL,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pk_wallets PRIMARY KEY (id),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT chk_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT chk_wallets_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid NOT NULL,
        provider_id varchar(100) NOT NULL,
        external_transaction_id varchar(255) NOT NULL,
        idempotency_key varchar(255) NOT NULL,
        payload_hash varchar(64) NOT NULL,
        wallet_id uuid NOT NULL,
        player_id uuid NOT NULL,
        round_id varchar(255) NOT NULL,
        game_id varchar(255) NOT NULL,
        kind varchar(20) NOT NULL,
        amount numeric(18,2) NOT NULL,
        currency varchar(3) NOT NULL,
        reference_external_transaction_id varchar(255) NULL,
        reference_transaction_id uuid NULL,
        status varchar(30) NOT NULL,
        failure_code varchar(64) NULL,
        resulting_balance_amount numeric(18,2) NULL,
        reference_attempts integer NOT NULL DEFAULT 0,
        next_reference_retry_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz NULL,
        CONSTRAINT pk_wager_transactions PRIMARY KEY (id),
        CONSTRAINT fk_wager_tx_wallet FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE RESTRICT,
        CONSTRAINT fk_wager_tx_reference FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT chk_wager_tx_amount_positive CHECK (amount > 0),
        CONSTRAINT chk_wager_tx_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_wager_tx_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT chk_wager_tx_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT chk_wager_tx_reference_required CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT chk_wager_tx_resulting_balance_non_negative CHECK (resulting_balance_amount IS NULL OR resulting_balance_amount >= 0),
        CONSTRAINT chk_wager_tx_reference_attempts_non_negative CHECK (reference_attempts >= 0)
      );
    `);

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_tx_single_reversal_per_kind
      ON wager_transactions (reference_transaction_id, kind)
      WHERE reference_transaction_id IS NOT NULL
        AND kind IN ('REFUND', 'ROLLBACK')
        AND status = 'PROCESSED';
    `);

    this.addSql(`
      CREATE INDEX idx_wager_tx_pending_reference
      ON wager_transactions (next_reference_retry_at, created_at)
      WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE INDEX idx_wager_tx_wallet_created
      ON wager_transactions (wallet_id, created_at DESC);
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid NOT NULL,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        direction varchar(10) NOT NULL,
        amount numeric(18,2) NOT NULL,
        currency varchar(3) NOT NULL,
        balance_before numeric(18,2) NOT NULL,
        balance_after numeric(18,2) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pk_wallet_ledger_entries PRIMARY KEY (id),
        CONSTRAINT fk_ledger_wallet FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE RESTRICT,
        CONSTRAINT fk_ledger_transaction FOREIGN KEY (transaction_id) REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT chk_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT chk_ledger_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_ledger_balance_before_non_negative CHECK (balance_before >= 0),
        CONSTRAINT chk_ledger_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT chk_ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
    `);

    this.addSql(`
      CREATE INDEX idx_ledger_wallet_created_id
      ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);
    `);

    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_wallet_ledger_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only and immutable (% is not allowed)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER trg_wallet_ledger_entries_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION prevent_wallet_ledger_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'DROP TRIGGER IF EXISTS trg_wallet_ledger_entries_immutable ON wallet_ledger_entries;',
    );
    this.addSql('DROP FUNCTION IF EXISTS prevent_wallet_ledger_mutation();');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}
