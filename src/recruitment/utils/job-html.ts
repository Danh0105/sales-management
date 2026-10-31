const BLOCKED_BLOCKS =
  /<(script|style|iframe|object|embed|svg|math)[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const TAGS = /<\/?([a-z0-9]+)(?:\s[^>]*)?>/gi;
const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'blockquote',
  'h2',
  'h3',
  'div',
]);
const ALIGN =
  /(?:^|[;\s])text-align\s*:\s*(left|center|right|justify)(?:\s*;|$)/i;

/**
 * Rich text của tin tuyển dụng chỉ giữ bộ tag định dạng nhỏ, bỏ toàn bộ event,
 * URL và markup có thể thực thi. Text thuần được giữ nguyên để tương thích dữ
 * liệu cũ. Thuộc tính duy nhất được giữ là text-align với giá trị allowlist.
 */
export function sanitizeRecruitmentHtml(value?: string | null): string | null {
  if (value == null) return null;
  const input = value
    .replace(/\0/g, '')
    .replace(COMMENTS, '')
    .replace(BLOCKED_BLOCKS, '');

  const sanitized = input.replace(TAGS, (tag: string, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    const closing = /^<\//.test(tag);
    if (closing) return `</${name}>`;
    if (name === 'br') return '<br>';
    if (name === 'p' || name === 'div') {
      const style = tag.match(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const align = (style?.[1] ?? style?.[2] ?? '').match(ALIGN)?.[1];
      if (align) return `<${name} style="text-align:${align.toLowerCase()}">`;
    }
    return `<${name}>`;
  });
  return sanitized.trim() || null;
}

export function hasMeaningfulRecruitmentHtml(value?: string | null): boolean {
  if (!value) return false;
  return (
    value
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&[a-z0-9#]+;/gi, 'x')
      .trim().length > 0
  );
}
