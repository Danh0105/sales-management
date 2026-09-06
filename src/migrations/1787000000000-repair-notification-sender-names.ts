import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notifications created before fixVietnamese was corrected may contain a
 * replacement character in the sender-name prefix. Rebuild that prefix from
 * the related employee while preserving the rest of the original message.
 */
export class RepairNotificationSenderNames1787000000000
    implements MigrationInterface
{
    name = 'RepairNotificationSenderNames1787000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "notification" AS notification
            SET "message" = employee."name" || substring(
                notification."message"
                FROM position(' đã ' IN notification."message")
            )
            FROM "employee" AS employee
            WHERE notification."senderId" = employee."id"
              AND notification."message" LIKE '%�%'
              AND position(' đã ' IN notification."message") > 0
        `);
    }

    public async down(): Promise<void> {
        // The previous replacement characters contained no recoverable data.
    }
}
