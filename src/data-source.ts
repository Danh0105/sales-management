import 'dotenv/config';
import { DataSource } from 'typeorm';
import { resolveDatabaseConnectionSettings } from './database/database-options';

const { synchronize: _runtimeSynchronize, ...connection } =
  resolveDatabaseConnectionSettings();

export default new DataSource({
  ...connection,
  // Migrations must never trigger TypeORM schema synchronization.
  synchronize: false,
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/migrations/*.ts'],
});
