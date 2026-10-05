import { AuthUser } from '../../type/auth-user.type';
import { HrRequestAccess } from '../access/hr-permission.guard';

export type HrRequest = {
  hrAccess: HrRequestAccess;
  user?: AuthUser;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  ip?: string;
};

export const HR_VALIDATION = {
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
};
