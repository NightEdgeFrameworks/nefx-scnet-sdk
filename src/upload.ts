/**
 * 大文件分片上传。
 *
 * 实测结论（2026-09-14，照搬自已验证的 scnet.mjs，逻辑未改）：
 *   - POST {efile}/openapi/v2/file/burst   逐片上传（multipart）
 *   - POST {efile}/openapi/v2/file/merge   合并
 *   - 合并前远端文件名是 `<name>.efilePart`，合并后才变成 `<name>`
 *   - 单次 /file/upload（非分片）也能用，但大文件建议走 burst
 *
 * 设计要点：流式读盘，绝不把整个文件读进内存——算例动辄几百 MB 到 GB。
 */
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Endpoints } from './api.ts';
import { die, redact, show } from './redact.ts';

export interface UploadOptions {
  file: string;
  remoteDir: string;
  /** 每片字节数，默认 8 MiB */
  chunkSize?: number;
  cover?: 'cover' | 'uncover';
  /** 每片最多重试次数，默认 3 */
  retries?: number;
  onProgress?: (p: {
    chunk: number;
    totalChunks: number;
    sentBytes: number;
    totalBytes: number;
    bytesPerSec: number;
  }) => void;
}

export interface UploadResult {
  name: string;
  remotePath: string;
  bytes: number;
  chunks: number;
  elapsedMs: number;
}

const MiB = 1048576;

export async function uploadFile(ep: Endpoints, o: UploadOptions): Promise<UploadResult> {
  const local = o.file;
  const dir = o.remoteDir;
  const name = basename(local);
  const totalSize = statSync(local).size;
  const chunkSize = o.chunkSize ?? 8 * MiB;
  const totalChunks = Math.max(1, Math.ceil(totalSize / chunkSize));
  const cover = o.cover ?? 'cover';
  const retries = o.retries ?? 3;

  const fd = openSync(local, 'r');
  const t0 = Date.now();
  let sent = 0;
  try {
    for (let i = 1; i <= totalChunks; i++) {
      const start = (i - 1) * chunkSize;
      const len = Math.min(chunkSize, totalSize - start);
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, start);

      let ok = false;
      let lastMsg = '';
      for (let attempt = 1; attempt <= retries && !ok; attempt++) {
        const form = new FormData();
        form.append('chunkNumber', String(i));
        form.append('cover', cover);
        form.append('file', new Blob([buf]), name);
        form.append('filename', name);
        form.append('path', dir);
        form.append('relativePath', name);
        form.append('totalChunks', String(totalChunks));
        form.append('totalSize', String(totalSize));
        form.append('chunkSize', String(chunkSize));
        form.append('currentChunkSize', String(len));
        try {
          const res = await fetch(`${ep.EFILE}/openapi/v2/file/burst`, {
            method: 'POST',
            headers: { token: ep.region.token },
            body: form,
          });
          const txt = await res.text();
          let j: Record<string, unknown>;
          try {
            j = JSON.parse(txt) as Record<string, unknown>;
          } catch {
            j = { code: '?', _nonJson: txt.slice(0, 200) };
          }
          if (String(j.code) === '0') ok = true;
          else lastMsg = JSON.stringify(redact(j));
        } catch (e) {
          lastMsg = 'network: ' + (e as Error).message;
        }
        if (!ok && attempt < retries) {
          console.error(`  片 ${i} 第 ${attempt} 次失败（${lastMsg}），重试…`);
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      if (!ok) die(`片 ${i}/${totalChunks} 连续 ${retries} 次失败：${lastMsg}`);

      sent += len;
      const elapsed = Math.max((Date.now() - t0) / 1000, 0.001);
      o.onProgress?.({
        chunk: i,
        totalChunks,
        sentBytes: sent,
        totalBytes: totalSize,
        bytesPerSec: sent / elapsed,
      });
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* 已关 */
    }
  }

  const merge = new FormData();
  merge.append('cover', cover);
  merge.append('filename', name);
  merge.append('id', '1');
  merge.append('path', dir);
  merge.append('identifier', '');
  merge.append('relativePath', name);
  const mr = await fetch(`${ep.EFILE}/openapi/v2/file/merge`, {
    method: 'POST',
    headers: { token: ep.region.token },
    body: merge,
  });
  const mtxt = await mr.text();
  let mj: Record<string, unknown>;
  try {
    mj = JSON.parse(mtxt) as Record<string, unknown>;
  } catch {
    mj = { raw: mtxt.slice(0, 300) };
  }
  if (String(mj.code) !== '0') {
    show(`合并失败 ${name}`, mj);
    die(`合并失败：${name}`);
  }

  return {
    name,
    remotePath: `${dir.replace(/\/$/, '')}/${name}`,
    bytes: totalSize,
    chunks: totalChunks,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * 上传后按字节数校验远端文件。
 * 依据是 /file/list 返回的 size 字段——只做"大小对得上"的粗校验；
 * 真正的逐字节校验用 downloadFile 的 content-length 比对。
 */
export async function verifyRemoteSize(
  ep: Endpoints,
  remoteDir: string,
  name: string,
  expected: number,
): Promise<{ ok: boolean; actual?: number | string }> {
  const { entries } = await (
    await import('./api.ts')
  ).listDirComplete(ep, remoteDir);
  const f = entries.find((x) => x.name === name);
  if (!f) return { ok: false };
  const actual = Number(f.size);
  return { ok: Number.isFinite(actual) && actual === expected, actual: f.size };
}
