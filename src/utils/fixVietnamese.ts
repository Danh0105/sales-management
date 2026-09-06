/**
 * Repair text that was decoded as latin1 although its bytes were UTF-8.
 *
 * Most values coming from PostgreSQL/JWT are already valid Unicode. Running
 * those values through latin1 unconditionally truncates Vietnamese characters
 * and produces the replacement character (�), which then gets persisted in
 * notification messages. Only use the converted value when it is lossless.
 */
export default function fixVietnamese(str: string) {
    if (!str) return str;

    const decoded = Buffer.from(str, 'latin1').toString('utf8');

    return decoded.includes('\uFFFD') ? str : decoded;
}
