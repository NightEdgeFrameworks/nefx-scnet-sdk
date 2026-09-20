/**
 * 凭据、签名、认证。
 *
 * 凭据来源优先级：
 *   1. 环境变量 SCNET_USER / SCNET_ACCESS_KEY / SCNET_SECRET_KEY（三者齐全才生效）
 *   2. SCNET_SECRET_PATH 指定的文件
 *   3. ~/.nefx/scnet/secret.json         ← 唯一默认位置
 *
 * 为什么是 ~/.nefx/scnet/：这个仓库原先只在本机跑，凭据放 ~/.dsh-tools/scnet/
 * （那是本机工具链的凭据库）。它成了**公开件**之后，默认值不该指向一个"因为某个
 * 私有工具链才存在"的目录——外面的人 clone 下来根本没有 ~/.dsh-tools/。
 *
 * 为什么不留旧路径兜底（2026-09-20 羽月拍板）：兜底那一版让"凭据到底在哪"有两个
 * 可能答案，判据就散了；本机已经把文件搬到新位置，旧路径再也没有读者。宁可报错时
 * 只报一个地址。旧目录不再被读，也不该再存在（凭据只放一处的老规矩）。
 *
 * 为什么不把凭据放进仓库：见 redact.ts 顶部那段注释。凭据文件路径同时避开了
 * Documents / .dsh-memory / .dsh/sessions 三个会同步上云的通道。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { die } from './redact.ts';

/** 默认目录。公开件里写的就是这个。 */
export const DEFAULT_DIR = join(homedir(), '.nefx', 'scnet');

/**
 * 凭据文件选哪个。**纯函数**（只吃入参，不碰文件系统、不看环境变量），所以离线可测。
 *
 * 只有两条路：显式指定，或者默认位置。**不看文件在不在**——"这次请求读哪个文件"
 * 必须是可预测的，而且报错时只能指向一个地址（旧位置那一版兜底就是在这里散的判据）。
 */
export function resolveSecretPath(o: { explicit: string | undefined }): {
  path: string;
  dir: string;
} {
  if (o.explicit) return { path: o.explicit, dir: dirname(o.explicit) };
  return { path: join(DEFAULT_DIR, 'secret.json'), dir: DEFAULT_DIR };
}

/**
 * 可写状态目录（token 缓存 + watch 采样）选哪个。也是纯函数。
 *
 * 默认**跟着凭据解析到的那个目录走**：凭据在默认位置 ⇒ token 缓存与 watch 采样点也在
 * 那儿；用 SCNET_SECRET_PATH 指到别处 ⇒ 两者一起搬过去。只有一条规则，没有特例。
 *
 * 为什么需要覆盖：容器里凭据目录是**只读挂载**（凭据不该能被容器改写，
 * 也不该被 COPY 进镜像层），而这两样都要写盘。2026-09-14 实测：只读挂载下
 * 第一次调接口就报 `EROFS: read-only file system, open '.../token-cache.json'`——
 * 一个纯粹为了省一次认证的缓存，把整个接口调用打死了。
 */
export function resolveStateDir(o: { explicit: string | undefined; secretDir: string }): string {
  return o.explicit || o.secretDir;
}

/**
 * 两条路径都在**启动时定一次**，之后不再变。长驻进程（serve / mcp）里凭据文件中途
 * 出现或消失都当作没发生——"这次请求读哪个文件"必须是可预测的。
 */
const resolvedSecret = resolveSecretPath({
  explicit: process.env.SCNET_SECRET_PATH,
});
export const SECRET_PATH = resolvedSecret.path;
export const STATE_DIR = resolveStateDir({
  explicit: process.env.SCNET_STATE_DIR,
  secretDir: resolvedSecret.dir,
});
export const TOKEN_CACHE_PATH = join(STATE_DIR, 'token-cache.json');

const AUTH_URL = 'https://api.scnet.cn/api/user/v3/tokens';
const TOKEN_TTL_MS = 15 * 60 * 1000;

export interface Credentials {
  user: string;
  ak: string;
  sk: string;
}

/** 一个计算区域的授权信息。token 是敏感值，只在本模块与请求头之间流转。 */
export interface Region {
  token: string;
  clusterId: string;
  clusterName: string;
  [k: string]: unknown;
}

export function loadCredentials(): Credentials {
  const envUser = process.env.SCNET_USER;
  const envAk = process.env.SCNET_ACCESS_KEY;
  const envSk = process.env.SCNET_SECRET_KEY;
  if (envUser && envAk && envSk) return { user: envUser, ak: envAk, sk: envSk };

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(SECRET_PATH, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    die(
      `读不到或无法解析凭据文件（路径不打印）。` +
        `请把 user / access_key / secret_key 写进 ~/.nefx/scnet/secret.json` +
        `（或用 SCNET_SECRET_PATH 指定别的路径），` +
        `或改用 SCNET_USER / SCNET_ACCESS_KEY / SCNET_SECRET_KEY 三个环境变量。`,
      { code: (e as NodeJS.ErrnoException).code },
    );
  }
  for (const k of ['user', 'access_key', 'secret_key']) {
    const v = raw[k];
    if (typeof v !== 'string' || !v.length || v.startsWith('<')) {
      die(`凭据缺字段或仍是占位符：${k}`);
    }
  }
  return { user: raw.user as string, ak: raw.access_key as string, sk: raw.secret_key as string };
}

/**
 * 签名 = HMAC-SHA256(secretKey, payload) 的小写 hex。
 * payload 的三个键按字典序拼（accessKey < timestamp < user），**顺序不能改**。
 */
export function sign(sk: string, ak: string, timestamp: string, user: string): string {
  return createHmac('sha256', sk)
    .update(`{"accessKey":"${ak}","timestamp":"${timestamp}","user":"${user}"}`, 'utf8')
    .digest('hex');
}

async function getJson(
  url: string,
  headers: Record<string, string> = {},
  opts: RequestInit = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  const text = await res.text();
  try {
    return { httpStatus: res.status, ...(JSON.parse(text) as Record<string, unknown>) };
  } catch {
    return { httpStatus: res.status, _nonJson: text.slice(0, 500) };
  }
}

export { getJson };

/** 进程内缓存。长时间活着的服务（serve / mcp）不必每次请求都读一遍盘。 */
let memCache: { at: number; data: Region[] } | null = null;
let cacheWarned = false;

/**
 * 认证。返回各区域的授权列表（含 token）。
 * 平台按计算区域分别颁发 token，所以目标中心是运行时决定的，不能写死域名。
 */
export async function authenticate(force = false): Promise<Region[]> {
  const fresh = (c: { at: number; data: Region[] } | null): c is { at: number; data: Region[] } =>
    !!c && Date.now() - c.at < TOKEN_TTL_MS && Array.isArray(c.data);

  if (!force && fresh(memCache)) return memCache.data;

  if (!force && existsSync(TOKEN_CACHE_PATH)) {
    try {
      const c = JSON.parse(readFileSync(TOKEN_CACHE_PATH, 'utf8')) as {
        at: number;
        data: Region[];
      };
      if (fresh(c)) {
        memCache = c;
        return c.data;
      }
    } catch {
      /* 缓存坏了就重取 */
    }
  }
  const { user, ak, sk } = loadCredentials();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const r = await getJson(
    AUTH_URL,
    { user, accessKey: ak, signature: sign(sk, ak, timestamp, user), timestamp },
    { method: 'POST' },
  );
  if (String(r.code) !== '0') die('认证未通过', r);
  const data = r.data as Region[];
  const entry = { at: Date.now(), data };
  memCache = entry;
  try {
    // 目录可能还不存在（SCNET_STATE_DIR 指向一个新建路径时）——writeFileSync 不会建父目录。
    // 2026-09-14 实测：漏了这句，容器里报的是 ENOENT 而不是 EROFS，症状一样是"接口挂了"。
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(TOKEN_CACHE_PATH, JSON.stringify(entry), { mode: 0o600 });
  } catch (e) {
    // 缓存写不进去（只读挂载等）不该让调用失败：它只是加速手段，内存里那份已够用。
    // 但要吼一声——否则「每次请求都重新认证」这件事会安静地发生。
    if (!cacheWarned) {
      cacheWarned = true;
      console.error(
        `[scnet] token 缓存写不进去（${(e as NodeJS.ErrnoException).code}），` +
          `改用进程内缓存。可用 SCNET_STATE_DIR 指向一个可写目录。`,
      );
    }
  }
  return data;
}

/** 过滤出真正带 token 的区域；clusterId=0 是平台自身 token（ac），不能拿来跑作业。 */
export function usableRegions(data: Region[]): Region[] {
  return (Array.isArray(data) ? data : []).filter((x) => x && x.token);
}

export function pickRegion(data: Region[], selector?: string | number): Region {
  const list = usableRegions(data);
  if (!list.length) die('没有任何区域返回可用 token（账户是否停用？）');
  if (selector === undefined || selector === null || selector === '') return list[0]!;
  if (typeof selector === 'number' || /^\d+$/.test(String(selector))) {
    const r = list[Number(selector)];
    if (!r) die(`区域序号越界：${selector}（共 ${list.length} 个）`);
    return r;
  }
  const r = list.find((x) => x.clusterName === selector || String(x.clusterId) === String(selector));
  if (!r) {
    die(`找不到区域：${selector}`, { available: list.map((x) => `${x.clusterName}(${x.clusterId})`) });
  }
  return r;
}
