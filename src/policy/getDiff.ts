import { PolicyStatus } from "./policy.enum";

export function getDiff(oldObj: any, newObj: any) {
    const diff: any = {};

    const keys = new Set([
        ...Object.keys(oldObj || {}),
        ...Object.keys(newObj || {}),
    ]);

    for (const key of keys) {
        const oldVal = oldObj?.[key];
        const newVal = newObj?.[key];

        if (
            typeof oldVal === "object" &&
            typeof newVal === "object" &&
            oldVal &&
            newVal &&
            !Array.isArray(oldVal) &&
            !Array.isArray(newVal)
        ) {
            const childDiff = getDiff(oldVal, newVal);
            if (Object.keys(childDiff).length > 0) {
                diff[key] = childDiff;
            }
        }

        else if (Array.isArray(oldVal) || Array.isArray(newVal)) {
            if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
                diff[key] = {
                    old: oldVal,
                    new: newVal,
                };
            }
        }

        else if (oldVal !== newVal) {
            diff[key] = {
                old: oldVal,
                new: newVal,
            };
        }
    }

    return diff;
}