import { Migration } from '@mikro-orm/migrations';

export class Migration202611110002_InboxAndOutboxSchema extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name varchar(120) NOT NULL,
        message_id varchar(255) NOT NULL,
        payload_hash varchar(64) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz NULL,
        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid NOT NULL,
        aggregate_id varchar(255) NOT NULL,
        event_type varchar(100) NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NULL,
        published_at timestamptz NULL,
        CONSTRAINT pk_outbox_messages PRIMARY KEY (id),
        CONSTRAINT chk_outbox_attempts_non_negative CHECK (attempts >= 0)
      );
    `);

    this.addSql(`
      CREATE INDEX idx_outbox_pending_due
      ON outbox_messages (next_attempt_at, occurred_at, id)
      WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
  }
}
