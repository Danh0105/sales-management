import { DataSource } from 'typeorm';

import { assertSafeDatabaseTarget } from '../../src/database/database-options';

/**
 * Lớp bảo vệ thứ hai, nạp qua `setupFiles` của cả hai cấu hình Jest: mọi
 * TypeORM `DataSource` khởi tạo trong test (AppModule, `TypeOrmModule.forRoot`
 * tự dựng trong test, `src/data-source.ts`, script seed...) đều bị kiểm database
 * đích trước khi mở kết nối — không phụ thuộc từng file test có nhớ hay không.
 */
// Gọi lại bằng `.call(this)` bên dưới nên việc tách method khỏi prototype là cố ý.
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalInitialize = DataSource.prototype.initialize;

DataSource.prototype.initialize = function guardedInitialize(
  this: DataSource,
): Promise<DataSource> {
  try {
    assertSafeDatabaseTarget(this.options.database);
  } catch (error) {
    return Promise.reject(error as Error);
  }
  return originalInitialize.call(this) as Promise<DataSource>;
};
