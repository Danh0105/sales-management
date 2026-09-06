// src/data-source.ts
import { DataSource } from 'typeorm';

export default new DataSource({
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    username: 'postgres',
    password: 'postgres',
    database: 'sales_db',
    entities: ['src/**/*.entity.ts'],
    migrations: ['src/migrations/*.ts'],
});