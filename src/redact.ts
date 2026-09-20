/**
 * 输出脱敏。
 *
 * 硬规矩：token / AK / SK / signature 的值永远不许落到 stdout。
 * 原因（已实测，不要删这段注释）：
 *   stdout → DSH 会话日志 session.v3.jsonl.zstd（未加密）→ .dsh-memory/journal/
 *   → 每天 03:40 备份到 Documents\MiCloud\DSH-Memory-Backup → 小米云盘。
 *   而备份脚本的密钥拦截正则只认 sk- / AIza / ghp_ 三种前缀，
 *   SCNet 的 AK 是 32 位纯十六进制，一个都匹配不上。
 *   所以"不进 stdout"是唯一可靠的保险。
 */

const SECRET_KEY_RE =
  /(token|secret|passwd|password|signature|accesskey|access_key|secretkey|secret_key)$/i;

/** 长而无空格、不像 URL 的字符串，按疑似 token 处理 */
const TOKENISH_RE = /^[A-Za-z0-9_\-.]{40,}$/;

export function mask(v: unknown): string {
  if (typeof v !== 'string') return '<redacted>';
  if (v.length <= 12) return '***';
  return `${v.slice(0, 3)}…${v.slice(-2)}[${v.length}]`;
}

export function redact(node: unknown, depth = 0): unknown {
  if (depth > 12) return '[deep]';
  if (Array.isArray(node)) {
    const head = node.slice(0, 10).map((x) => redact(x, depth + 1));
    if (node.length > 10) head.push(`…(+${node.length - 10})`);
    return head;
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      // aclHosts 是几千个主机名拼成的长串，只留计数
      if (k === 'aclHosts' && typeof v === 'string') {
        out[k] = `<${v.split(',').length} hosts>`;
        continue;
      }
      if (SECRET_KEY_RE.test(k)) out[k] = mask(v);
      else if (typeof v === 'string' && TOKENISH_RE.test(v) && !/^https?:/.test(v)) out[k] = mask(v);
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return node;
}

/** 打印一段脱敏后的 JSON，带标题 */
export function show(label: string, obj: unknown): void {
  console.log(`\n=== ${label} ===\n${JSON.stringify(redact(obj), null, 2)}`);
}

export class ScnetError extends Error {
  readonly detail: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = 'ScnetError';
    this.detail = detail;
  }
}

export function die(msg: string, detail?: unknown): never {
  if (detail !== undefined) show('上下文（脱敏）', detail);
  throw new ScnetError(msg, detail);
}
