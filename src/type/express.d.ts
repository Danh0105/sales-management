import { AuthUser } from './auth-user.type';

declare module 'express' {
    interface Request {
        user?: AuthUser;
    }
}