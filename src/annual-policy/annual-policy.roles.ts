import { POLICY_VIEW_ROLES } from '../policy/policy-scope';

export const ANNUAL_POLICY_CONTRACT_UPLOAD_ROLES = [
    'saleadmin',
    'salesadmin',
    'salesadmin_la',
];

export const ANNUAL_POLICY_VIEW_ROLES = [
    ...POLICY_VIEW_ROLES,
    'salesadmin',
    'accountant',
    'ketoan_congno',
    'thuquy',
    'ketoan_truong',
];
