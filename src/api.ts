/**
 * 端点解析与文件接口。
 *
 * 平台返回的 URL 有两种形态（已实测）：
 *   - 已含服务段，如 https://x.x.x.x:port/efile
 *   - 裸 host:port，如 https://x.x.x.x:port
 * 所以 svc() 要判断一下再补段。
 */
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { getJson, type Region } from './auth.ts';
import { die, redact, show } from './redact.ts';

const CENTER_HOSTS = ['https://www.scnet.cn', 'https://api.scnet.cn'];

export interface Endpoints {
  region: Region;
  /** HPC 接口基址，已带 /hpc */
  HPC: string;
  /** 文件接口基址，已带 /efile */
  EFILE: string;
  /** 网页终端基址（未实测，仅记录） */
  ESH: string;
  /** 远端家目录，GAP_WORK_DIR 默认值 */
  home: string;
  /** 远端用户名，作业属主查询要用 */
  userName: string;
  /** 集群调度器 ID，提交作业的 strJobManagerID 用它（**不是** clusterId） */
  jobManagerId: string;
}

export function urlOf(list: unknown, fallback = ''): string {
  if (!Array.isArray(list)) return fallback;
  const ok =
    (list as Array<{ enable?: unknown; url?: string }>).find((x) => String(x?.enable) === 'true') ??
    (list as Array<{ url?: string }>)[0];
  return ok?.url ?? fallback;
}

export function svc(base: string, seg: string): string {
  if (!base) return '';
  const b = base.replace(/\/$/, '');
  return b.endsWith(`/${seg}`) ? b : `${b}/${seg}`;
}

/**
 * 解析区域可用端点。
 * GET /ac/openapi/v2/center 返回该区域的 hpc / efile / eshell 地址与 clusterUserInfo。
 */
export async function resolveEndpoints(region: Region): Promise<Endpoints> {
  let last: Record<string, unknown> | undefined;
  let data: Record<string, unknown> | undefined;
  for (const h of CENTER_HOSTS) {
    const r = await getJson(`${h}/ac/openapi/v2/center`, { token: region.token });
    if (String(r.code) === '0' && r.data) {
      data = r.data as Record<string, unknown>;
      break;
    }
    last = r;
  }
  if (!data) {
    show('获取授权区域失败（脱敏）', last);
    die('center 接口没返回可用数据');
  }
  const cu = (data.clusterUserInfo ?? {}) as Record<string, string>;
  const home = cu.homePath ?? '/public/home';

  let jobManagerId = '';
  const HPC = svc(urlOf(data.hpcUrls), 'hpc');
  if (HPC) {
    const cl = await getJson(`${HPC}/openapi/v2/cluster`, { token: region.token });
    const d = cl.data as unknown;
    jobManagerId = String(
      Array.isArray(d)
        ? ((d[0] as { id?: unknown })?.id ?? '')
        : ((d as { id?: unknown })?.id ?? ''),
    );
  }
  return {
    region,
    HPC,
    EFILE: svc(urlOf(data.efileUrls), 'efile'),
    ESH: urlOf(data.eshellUrls),
    home,
    userName: cu.userName ?? '',
    jobManagerId,
  };
}

// ── 文件接口 ────────────────────────────────────────────────────────────────

/**
 * 远端目录里的一条记录。
 *
 * ★2026-09-15 实测更正：平台每条记录返回 **17 个字段**，我们先前只声明了 3 个
 * （`name`/`size`/`lastModifiedTime`），于是不得不靠 `children` 求差来推"这是目录还是文件"。
 * 那是自残——类型、符号链接标志、权限、属主、属组本来就在返回里：
 *   owner group permission permissionAction{read,write,execute,allowed}
 *   isDirectory isRegularFile isSymbolicLink isShare isOther
 *   creationTime lastAccessTime lastModifiedTime fileKey path type size name
 * 这里只声明调用方真正会读的那些；其余仍在对象上，只是我们不承诺。
 */
export interface RemoteEntry {
  name: string;
  /**
   * 文件字节数。
   * ⚠ **目录也在 fileList 里，且目录的 `size` 恒为 4096**（inode 大小），不是目录占用——
   * 想算目录大小只能递归加文件；平台没有 quota/size 接口。
   */
  size?: number | string;
  lastModifiedTime?: string;
  lastAccessTime?: string;
  creationTime?: string;
  /** 类型真值来源。别再靠 `children` 求差判类型。 */
  isDirectory?: boolean;
  isRegularFile?: boolean;
  isSymbolicLink?: boolean;
  /** 形如 `rwxr-xr-x`。 */
  permission?: string;
  owner?: string;
  group?: string;
  /** 平台侧绝对路径。与调用方自己拼出来的不一致，说明平台换了口径。 */
  path?: string;
}

export interface DirListing {
  /**
   * 子目录名。
   * ★2026-09-15 实测：这个列表**不受 `limit` 截断影响**，是该目录里全部子目录
   * （用 children[].label 得到，与 fileList 里 isDirectory 的条数一一对上）。
   * 所以"有哪些子目录"永远问得全；被截断的只有 `entries`。
   */
  dirs: string[];
  /**
   * 平台的 `fileList` 原样，**每一条可能是文件、也可能是目录**（看 `isDirectory`）。
   *
   * ⚠ 2026-09-15 从 `files` 改名成 `entries`，因为旧名字在骗人：
   *   实测 home 一页拿全时 `fileList=99` 而其中 `isDirectory=true` 的有 **14 条**——
   *   目录就在这个数组里。旧名字让 `cli ls` 把每个目录打印了两遍（一遍 `[DIR]`、
   *   一遍列成文件），而且让 `truncated` 的判据写松了（见 `truncated`）。
   * 想要"只有文件"，自己按 `isDirectory !== true` 过滤。
   */
  entries: RemoteEntry[];
  /** 平台 code：'0' = 目录存在；'911020' = 目录不存在 */
  code: string;
  msg: string;
  exists: boolean;
  /**
   * 平台自报的条目总数。
   * ★就是 `fileList` 的条数，**目录也算一条**（2026-09-15 实测：home 一页拿全时
   * total=99 / fileList=99 / 其中 isDirectory=14）。所以判截断只能拿它跟
   * `entries.length` 比，见 `truncated`。
   */
  total: number;
  /**
   * 这一页有没有漏东西 —— 判据是 `total > entries.length`。
   *
   * ⚠ 2026-09-15 修正：原来是 `total > files.length + dirs.length`，**偏松**。
   * 因为 `total` 已经把目录算进去了，而 `dirs` 又不受截断影响（见上），等于把目录
   * 数了两遍。实测反例就在家目录上：`limit=90` 时 fileList=90 / total=99 / children=14，
   * 老判据算 `99 > 104` = false，**漏报 9 条**；真判据 `99 > 90` = true。
   * 症状是本项目最贵的那一类：文件明明在，客户端说"不存在"。
   */
  truncated: boolean;
}

/**
 * 列目录，并把"目录不存在"这件事显式暴露出来。
 *
 * 实测（2026-09-14）：`file/list` 对不存在的路径返回 code=911020 / "File does not exist"，
 * 而不是空列表。如果不看 code，就分不清"空目录"和"目录根本不存在"——
 * 对调用方来说这两种情况要做的事完全不同（一个是正常，一个得先建目录）。
 *
 * 【2026-09-14 实测踩到的大坑：这个端点默认只回 10 条】
 * 不带分页参数时 fileList 恒为 10 条，而 data.total 才是真数——实测某个目录
 * fileList=10 / total=17。后果非常隐蔽：上传校验去列目录找不到刚传上去的文件，
 * 于是报"上传校验失败：远端 xxx 大小 不存在"，而文件其实好好地躺在那里。
 * 试过的参数里只有一组有效：
 *     &limit=100&offset=0   → 17 条，全了
 *   pageNum / pageSize / pageIndex / currentPage / size / searchResultLimit /
 *   maxListResultSize / listOrderLimit / keyWord / searchLevel / searchUnitType
 *   全部**被忽略**（一如既往回 10 条）。POST 形态直接 1001 未知异常。
 * 所以这里固定带 limit/offset，并且把 total 暴露出来，让调用方能自己发现截断。
 *
 * ★2026-09-15 实测更正：**`offset` 是空参数，翻页会静默给你重复数据。**
 *   在家目录下一个 `total=5214` 的目录上实测：
 *     limit=1000&offset=0     → 1000 条，首条 A
 *     limit=1000&offset=1000  → 1000 条，首条**还是 A**    ← offset 被忽略
 *     limit=6000&offset=0     → 5214 条，truncated=false  ← 一次要够大才对
 *   按 offset 翻 6 页会累出 6000 条（多 786 条重名），而这个过程看起来完全正常。
 *   所以：**不要翻页，把 limit 加到够大** —— 见 `nextListLimit()` / `listDirComplete()`。
 *   `offset` 参数保留，是因为签名与离线测试都在用它；但任何地方都别据此判"下一页"。
 *   `limit` 的上限没测到（对 5214 条的目录试过 6000 与 100000，都一次拿全）。
 */
export const LIST_PAGE_LIMIT = 1000;

/** 一次拿全时的起步 limit。多数目录一次就够，省掉"先探一次拿 total"的那一轮。 */
export const LIST_LIMIT_FIRST = 2000;

/** 单个目录最多问几次，防呆（每轮 limit 至少翻倍，5 轮足够覆盖百万级目录）。 */
export const LIST_MAX_ROUNDS = 5;

/** limit 的安全上限。平台真实上限**未测**，这个数只是别让我们把 URL 拼到荒唐的长度。 */
export const LIST_LIMIT_CEILING = 2_000_000;

/**
 * 下一次该把 limit 要到多少 —— 不需要再问时返回 null。
 *
 * 抽成纯函数是为了能离线测：这段判断是"目录列全了吗"的唯一判据，
 * 而它错的时候症状是"文件明明在，却报不存在"，最难查。
 * 判据只有一条：`total > 已拿到条数` 就还没列全，**跟 offset 无关**。
 * 注意 `got` 要传 `entries.length`（total 也是按 fileList 数的，两边口径必须一致）。
 */
export function nextListLimit(total: number, got: number): number | null {
  if (!Number.isFinite(total) || total <= got) return null;
  const want = total * 2 + 100;
  return want > LIST_LIMIT_CEILING ? null : want;
}

/**
 * 这一页有没有漏东西 —— **"目录列全了吗"的判据只有这一条**。
 *
 * `total` 就是 `fileList` 的条数（目录也算一条），所以判据是 `total > got`，
 * 其中 `got` 传 `entries.length`。**不要**把 `dirs.length` 加进去：`dirs` 来自
 * `children`，它不受 `limit` 截断影响、恒为该目录全部子目录，加进去等于把目录数两遍。
 *
 * 抽成纯函数是为了能离线测。2026-09-15 的实测反例（就发生在家目录上）：
 * `limit=90` 时 fileList=90 / total=99 / children=14，
 * 老判据 `total > files.length + dirs.length` 算 `99 > 104` = false，**漏报 9 条**；
 * 这个函数算 `99 > 90` = true。症状是"文件明明在，客户端说它不存在"。
 */
export function isTruncated(total: number, got: number): boolean {
  return Number.isFinite(total) && total > got;
}

/** 列目录的 query string。抽出来是为了能被离线单测断言（不带 limit 就只回 10 条）。 */
export function listQuery(path: string, limit = LIST_PAGE_LIMIT, offset = 0): string {
  return `?path=${encodeURIComponent(path)}&limit=${limit}&offset=${offset}`;
}

export async function listDir(
  ep: Endpoints,
  path: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<DirListing> {
  const r = await getJson(
    `${ep.EFILE}/openapi/v2/file/list${listQuery(path, opts.limit, opts.offset)}`,
    { token: ep.region.token },
  );
  const code = String(r.code ?? '?');
  const d = (r.data ?? {}) as {
    children?: Array<{ label: string }>;
    fileList?: RemoteEntry[];
    total?: number | string;
  };
  const entries = d.fileList ?? [];
  const dirs = (d.children ?? []).map((k) => k.label);
  const total = Number(d.total ?? entries.length);
  return {
    dirs,
    entries,
    code,
    msg: String(r.msg ?? ''),
    exists: code === '0',
    total,
    truncated: isTruncated(total, entries.length),
  };
}

/**
 * 完整列一个目录 —— **不翻页，而是把 limit 加到够大**（`offset` 是空参数，见上面的注释）。
 *
 * 返回最后一次的结果，另加 `calls`（实际问了几次：>1 说明这个目录超过了一页）。
 * 拿全的判据是 `total <= files.length`；问到 `LIST_MAX_ROUNDS` 次还没拿全就如实
 * 返回 `truncated: true`，绝不假装成功了——这条跟本项目其它地方的纪律一样：
 * 宁可让人看见"没列全"，也不让人把"没列出来"读成"不存在"。
 *
 * 为什么所有调用方都该用它：`remoteFileInfo()`（存在性判据）和上传后的尺寸校验都建在
 * "这一页就是全部"的假设上。用旧的两页 limit=1000 去列一个有 3000 项的目录，
 * 第 3000 项之后的文件**看不见**，于是报"上传失败：远端文件不存在"——而文件就在那儿。
 */
export async function listDirComplete(
  ep: Endpoints,
  path: string,
): Promise<DirListing & { calls: number; limitUsed: number }> {
  let limit = LIST_LIMIT_FIRST;
  for (let round = 1; ; round++) {
    const r = await listDir(ep, path, { limit });
    const next = !r.exists || round >= LIST_MAX_ROUNDS ? null : nextListLimit(r.total, r.entries.length);
    if (next === null) return { ...r, calls: round, limitUsed: limit };
    limit = Math.max(next, limit * 2);
  }
}

/**
 * 远端目录是否存在。
 *
 * ⚠️ **不要改用 `/file/exist`**。实测（2026-09-14）这个端点根本不可用：
 *   GET  /efile/openapi/v2/file/exist?path=<存在的家目录>  → code=1001 "未知异常"
 *   POST /efile/openapi/v2/file/exist (form path=/dirPath=) → code=10003 "param_incomplete"
 * 对**每一个**路径都是这个结果，也就是说它永远返回"不存在"。
 * 早先的实现据此从 `/` 开始逐级建目录，于是去创建平台的 `/work` 并被拒。
 * 判据只能是 list：列得出来就是存在。
 */
export async function dirExists(ep: Endpoints, path: string): Promise<boolean> {
  return (await listDir(ep, path)).exists;
}

/**
 * 建远端目录。**返回结果，不抛异常**——因为这个端点在本账号上恒失败（见 1.3c），
 * 调用方必须能自己决定"失败要不要紧"。早期版本在这里 `die()`，于是一次正常的 run 会往
 * stdout 打一整块 `code=1001 未知异常`，看起来像出事了，其实后面照常跑完。
 */
export async function makeDir(
  ep: Endpoints,
  path: string,
): Promise<{ ok: boolean; code: string; msg: string; raw: Record<string, unknown> }> {
  const r = await getJson(`${ep.EFILE}/openapi/v2/file/folder-create`, { token: ep.region.token }, {
    method: 'POST',
    body: JSON.stringify({ path }),
  });
  return {
    ok: String(r.code) === '0',
    code: String(r.code ?? '?'),
    msg: String(r.msg ?? ''),
    raw: r,
  };
}

/**
 * 流式下载并校验字节数。
 * 校验依据是服务端 content-length —— 本轮实测它与磁盘上的字节数逐字节一致。
 *
 * ⚠️ **光看字节数是拦不住"文件不存在"的**（2026-09-14 实测踩过）：
 *   请求一个不存在的远端文件，平台返回的是 **HTTP 200**，正文是一小段 JSON
 *   `{"code":"911020","data":null,"msg":"File does not exist"}`，而且 content-length
 *   与这段 JSON 的长度一致。于是字节校验**通过**，本地多出一个 57 B 的"结果文件"，
 *   模板里的 `outputs[].required: true` 也不会报错——因为它确实"下载成功"了。
 *   两道闸：① 下载前用父目录列举确认文件真的在（list 是实测唯一可靠的存在性判据）；
 *   ② 落盘前嗅一下正文是不是平台错误信封；③ 先写 .part，成了再改名，
 *   所以失败绝不会在目标位置留下半成品或伪文件。
 */
export async function downloadFile(
  ep: Endpoints,
  remotePath: string,
  localPath: string,
  onProgress?: (got: number, total: number) => void,
  opts: { checkExists?: boolean } = {},
): Promise<{ bytes: number; total: number }> {
  if (opts.checkExists !== false) {
    const info = await remoteFileInfo(ep, remotePath);
    // known=false 表示连列举都没成功（网络/权限），这时不要凭猜测拦下载
    if (info.known && !info.exists) {
      die(`远端没有这个文件：${remotePath}`, {
        dir: info.dir,
        note: `父目录 ${info.dir} 列不到 ${info.name}——平台对不存在的文件会返回 HTTP 200 + 一小段 JSON，`
          + '光看字节数是发现不了的',
      });
    }
  }

  const url = `${ep.EFILE}/openapi/v2/file/download?path=${encodeURIComponent(remotePath)}`;
  const res = await fetch(url, { headers: { token: ep.region.token } });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    die(`下载失败 HTTP ${res.status}`, { path: remotePath, body: t.slice(0, 300) });
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const part = `${localPath}.part`;
  const ws = createWriteStream(part);
  let got = 0;
  let mark = 0;
  let head = Buffer.alloc(0);
  const cleanup = () => {
    try {
      ws.destroy();
      rmSync(part, { force: true });
    } catch {
      /* 清不掉就算了，别把真正的错误盖掉 */
    }
  };
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      got += buf.length;
      if (head.length <= SNIFF_MAX) head = Buffer.concat([head, buf]);
      if (!ws.write(buf)) await new Promise((r) => ws.once('drain', r));
      if (got - mark >= 16 * 1048576) {
        mark = got;
        onProgress?.(got, total);
      }
    }
  } catch (e) {
    cleanup();
    throw e;
  }
  await new Promise((r) => ws.end(r));
  onProgress?.(got, total);

  if (got <= SNIFF_MAX) {
    const platformErr = platformErrorIn(head);
    if (platformErr) {
      cleanup();
      die(`下载下来的不是文件，是平台的报错：${platformErr}`, {
        path: remotePath,
        bytes: got,
        note: '平台对不存在/无权限的文件返回 HTTP 200 + JSON 错误体，字节数与 content-length 一致，'
          + '所以不会触发字节校验',
      });
    }
  }
  if (total && got !== total) {
    cleanup();
    die(`下载字节数与 content-length 不一致：${got} != ${total}`, { file: basename(remotePath) });
  }
  // 只有全部校验通过才落到目标路径——失败时目标位置保持原样（要么没这个文件，要么还是旧的）
  renameSync(part, localPath);
  return { bytes: got, total };
}

/** 小于这个字节数才当作"可能是平台错误信封"来嗅。 */
const SNIFF_MAX = 4096;

/**
 * 正文是不是平台的 JSON 错误信封。
 * 判据：能解析成对象、`code` 存在且非 '0'、`data` 为 null/缺省。
 * 正常的用户文件即使是 JSON，也几乎不会同时满足这三条；而且下载前还有父目录列举那道闸。
 * 返回 null 表示"不像错误信封"，否则返回给人看的 msg。
 */
export function platformErrorIn(body: Buffer | string): string | null {
  const s = typeof body === 'string' ? body : body.toString('utf8');
  const t = s.trim();
  if (!t.startsWith('{') || s.length > SNIFF_MAX) return null;
  let j: unknown;
  try {
    j = JSON.parse(t);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (o.code === undefined) return null;
  const code = String(o.code);
  if (code === '0') return null;
  if (o.data !== null && o.data !== undefined) return null;
  return typeof o.msg === 'string' && o.msg ? o.msg : `平台返回 code=${code}`;
}

/**
 * 一个"只读探测"端点的响应，到底是"拿到了内容"还是"这个接口对我们不可用"。
 *
 * 起因（2026-09-14 实测）：`userlimits` / `userusedtime` / `userquota` 在本账号上整片 404，
 * 而 `getJson()` 会把 404 的正文原样返回。直接把正文 `show()` 出来，读的人（尤其是不看
 * HTTP 状态码的 agent）会以为那三个接口是有内容的——这正是本项目最贵的一类坑：
 * 失败长得像成功。
 *
 * 返回 null 表示"拿到了内容"；否则返回一句给人看的不可用原因。
 */
export function unavailableReason(body: Record<string, unknown>): string | null {
  const http = typeof body.httpStatus === 'number' ? body.httpStatus : 0;
  if (http >= 400) {
    const msg = typeof body.msg === 'string' && body.msg ? `（${body.msg}）` : '';
    return `HTTP ${http}${msg}`;
  }
  // 只有"平台信封"（带 code 字段）才继续按 code/data 判。
  // 没有 code 的响应不是信封，别把它的内容判成不可用——那样会把正常的
  // 非信封返回（例如直接回一个数组或自定义字段）误伤成"接口坏了"。
  const hasCode = body.code !== undefined && body.code !== null;
  if (!hasCode) return null;
  const code = String(body.code);
  if (code !== '0') {
    const msg = typeof body.msg === 'string' && body.msg ? `（${body.msg}）` : '';
    return `平台 code=${code}${msg}`;
  }
  if (body.data === undefined || body.data === null) return 'data 为空';
  return null;
}

/**
 * 远端文件的存在性（靠列父目录，不靠 `file/exist`——那个端点不可用）。
 * `known: false` 表示列举本身失败了，调用方不应据此判定"不存在"。
 */
export async function remoteFileInfo(
  ep: Endpoints,
  remotePath: string,
): Promise<{ dir: string; name: string; exists: boolean; known: boolean }> {
  const p = remotePath.replace(/\/+$/, '');
  const slash = p.lastIndexOf('/');
  const dir = slash > 0 ? p.slice(0, slash) : '/';
  const name = p.slice(slash + 1);
  try {
    // 必须用 listDirComplete：用单页 limit=1000 去判存在性，目录里第 1001 项之后的文件
    // 会被判成"不存在"。
    const { entries, exists } = await listDirComplete(ep, dir);
    if (!exists) return { dir, name, exists: false, known: true };
    return { dir, name, exists: entries.some((f) => f.name === name), known: true };
  } catch {
    return { dir, name, exists: false, known: false };
  }
}

// ── 共享存储配额 ───────────────────────────────────────────────────────────
/**
 * 共享存储配额/使用量的路径。
 *
 * ★2026-09-15 实测：官方文档「查询共享存储配额及使用量」写的是
 *   GET {hpcUrls}/hpc/openapi/v2/parastor/quota/usernames/{username}
 * （ParaStor 是曙光的并行文件系统，所以资源段是 `parastor/quota/usernames`）。
 *
 * ⚠ 我们先前在 `D260914-scnet-automation` 里试过 `/hpc/openapi/v2/userquota/users/{u}` 与
 *   `/efile/openapi/v2/file/quota`，全 404 / 1001，于是记成"平台没有配额接口"——
 *   **那是猜错了路径，不是没有接口**。这条坑值得记：把"我没找到"写成"不存在"之前，
 *   先去找官方文档的资源段命名。
 */
export function quotaPath(username: string): string {
  return `/openapi/v2/parastor/quota/usernames/${encodeURIComponent(username)}`;
}

/** 一条共享存储配额记录。**单位由官方文档确认为 GB**（不是字节、不是 MB）。 */
export interface QuotaEntry {
  path: string;
  username: string | null;
  /** 配额量（GB）。平台没给或给得不合法时为 null——不拿 0 冒充"没有配额"。 */
  thresholdGB: number | null;
  /** 已用量（GB）。同上。 */
  usageGB: number | null;
  /** 剩余量（GB）。只有两边都是合法数字时才算，否则 null。 */
  freeGB: number | null;
  /** 已用百分比。`thresholdGB` 为 0 或缺失时是 null——**不能算成 Infinity，也不能硬夹到 100**。 */
  percentUsed: number | null;
}

const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * 把平台返回的 data 数组规格化成 QuotaEntry[]。纯函数，有离线单测。
 *
 * 三条纪律（都是这个仓库被坑过的地方）：
 *   1. **不补 0**：字段缺失就是 null，让调用方能区分"没有配额"和"平台没告诉我"。
 *   2. **百分比不夹取**：已用超过配额是真实状态（平台允许超配额写），要如实报 >100%，
 *      夹成 100 会把"超额"这件事藏起来。
 *   3. **分母为 0 不算百分比**：返回 null，不返回 Infinity。
 */
export function normalizeQuota(data: unknown): QuotaEntry[] {
  if (!Array.isArray(data)) return [];
  const out: QuotaEntry[] = [];
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const thresholdGB = numOrNull(r.threshold);
    const usageGB = numOrNull(r.usage);
    const freeGB = thresholdGB !== null && usageGB !== null ? thresholdGB - usageGB : null;
    const percentUsed = thresholdGB !== null && thresholdGB > 0 && usageGB !== null
      ? (usageGB / thresholdGB) * 100
      : null;
    out.push({
      path: typeof r.path === 'string' ? r.path : '',
      username: typeof r.username === 'string' ? r.username : null,
      thresholdGB,
      usageGB,
      freeGB,
      percentUsed,
    });
  }
  return out;
}

/**
 * 查共享存储配额与已用量。
 *
 * 返回结构而不抛异常：这个端点在某些集群/账号上可能没开（文档错误码里有 `10009 没有权限访问接口`），
 * 那时调用方要能自己决定"是报错还是当没这东西"。`ok=false` 时 `reason` 给一句给人看的原因。
 */
export async function fetchQuota(
  ep: Endpoints,
  username?: string,
): Promise<{ ok: boolean; code: string; msg: string; entries: QuotaEntry[]; reason?: string }> {
  const user = username || ep.userName;
  if (!user) return { ok: false, code: 'NO_USER', msg: '', entries: [], reason: '端点里没解析到 userName，也没有显式给 username' };
  const r = await getJson(`${ep.HPC}${quotaPath(user)}`, { token: ep.region.token });
  const code = String(r.code ?? '?');
  const reason = unavailableReason(r as Record<string, unknown>);
  if (code !== '0' || reason) {
    return { ok: false, code, msg: String(r.msg ?? ''), entries: [], reason: reason ?? `平台 code=${code}` };
  }
  return { ok: true, code, msg: String(r.msg ?? ''), entries: normalizeQuota((r as { data?: unknown }).data) };
}

/**
 * 读远端文本文件的一段（用于看 .trn / 日志）。
 * 走 POST /hpc/openapi/v2/file/content，form 编码。
 */
export async function readRemoteText(
  ep: Endpoints,
  remotePath: string,
  page = 1,
  dir: 'UP' | 'DOWN' = 'UP',
): Promise<{ text: string; totalLines?: number; totalPages?: number }> {
  const form = new URLSearchParams({
    hostName: '',
    dirPath: remotePath,
    triggerNum: String(page),
    rollDirection: dir,
  });
  const res = await fetch(`${ep.HPC}/openapi/v2/file/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', token: ep.region.token },
    body: form.toString(),
  });
  const j = (await res.json().catch(() => ({ code: '?', msg: 'non-json' }))) as {
    data?: { data?: string; allLineTotal?: number; totalTriggerTimes?: number };
    [k: string]: unknown;
  };
  if (!j.data?.data && j.code !== undefined && String(j.code) !== '0') {
    show('读取文件失败（脱敏）', j);
    die('readRemoteText 失败');
  }
  return {
    text: j.data?.data ?? JSON.stringify(redact(j), null, 2),
    totalLines: j.data?.allLineTotal,
    totalPages: j.data?.totalTriggerTimes,
  };
}
