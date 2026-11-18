import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Bộ đếm số chứng từ theo tiền tố + năm; tăng nguyên tử bằng UPSERT ... RETURNING. */
@Entity('financial_document_sequences')
export class FinancialDocumentSequence {
  @PrimaryColumn({
    type: 'varchar',
    length: 10,
    primaryKeyConstraintName: 'PK_financial_document_sequences',
  })
  prefix!: string;

  @PrimaryColumn({
    type: 'smallint',
    primaryKeyConstraintName: 'PK_financial_document_sequences',
  })
  year!: number;

  @Column({ name: 'last_number', type: 'int', default: 0 })
  lastNumber!: number;
}
