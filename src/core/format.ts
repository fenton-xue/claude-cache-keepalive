import type { ReceiptStatus } from './types';

/** 一次发送的结果，供界面和通知显示 */
export interface SendResult {
  ok: boolean;
  /** 判定完成的时间 */
  at: number;
  /** 回执的 status；超时为 'timeout'，本地发送异常为 'error' */
  status?: ReceiptStatus | 'timeout' | 'error';
  reason?: string;
  dropReason?: string;
}

const STATUS_LABEL: Record<string, string> = {
  held: '已挂起',
  denied: '已拒绝',
  expired: '已过期',
  dropped: '已丢弃',
  timeout: '超时未送达',
  error: '发送出错',
};

/** 失败原因：状态（英文原值）、回执 reason，dropped 另带 drop_reason */
export function describeFailure(r: SendResult): { title: string; detail: string } {
  const status = r.status ?? 'error';
  const label = STATUS_LABEL[status] ?? status;
  const title = status === 'timeout' || status === 'error' ? label : `${label}（${status}）`;
  const parts: string[] = [];
  if (r.reason) parts.push(r.reason);
  if (r.dropReason) parts.push(`drop_reason: ${r.dropReason}`);
  return { title, detail: parts.join('；') };
}

/** 毫秒 → "X 分 Y 秒" */
export function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
}
