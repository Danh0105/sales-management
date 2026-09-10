import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TeachingSession } from './teaching-session.entity';

export const LESSON_REPORT_IMAGE_TYPE = 'LESSON_REPORT';

/**
 * Read model for the lesson-image library. The legacy JSONB column remains the
 * source used by old clients; this table gives every media item a stable id and
 * makes database pagination/counting possible without loading sessions in RAM.
 */
@Entity('lesson_images')
@Index('IDX_lesson_images_session_id', ['sessionId'])
@Index('IDX_lesson_images_created_at_id', ['createdAt', 'id'])
@Index('UQ_lesson_images_session_sort_order', ['sessionId', 'sortOrder'], {
  unique: true,
})
export class LessonImageEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'session_id', type: 'int' })
  sessionId!: number;

  @ManyToOne(() => TeachingSession, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'session_id' })
  session!: TeachingSession;

  @Column({ type: 'varchar', length: 500 })
  url!: string;

  @Column({ name: 'thumbnail_url', type: 'varchar', length: 500, nullable: true })
  thumbnailUrl!: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 100, nullable: true })
  mimeType?: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder!: number;

  @Column({ type: 'varchar', length: 50, default: LESSON_REPORT_IMAGE_TYPE })
  type!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
