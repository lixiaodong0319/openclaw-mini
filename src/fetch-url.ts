import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { StringDecoder } from "node:string_decoder";

// 一个 fetch_url 调用的 DNS、重定向和正文下载共享同一个总时限。
// maxBytes 限制的是原始响应字节，而不是解码后的 JavaScript 字符数。
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
export const DEFAULT_FETCH_BYTES = 64 * 1024;
export const MAX_FETCH_BYTES = 256 * 1024;

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface FetchResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

// 生产环境使用真实 DNS 和固定 IP 请求；依赖接口只用于测试成功响应、重定向等逻辑，
// 让测试不需要真的访问公网。executeTool 不暴露覆盖依赖的入口。
export interface FetchUrlDependencies {
  resolveAddresses: (hostname: string) => Promise<ResolvedAddress[]>;
  request: (
    url: URL,
    address: ResolvedAddress,
    maxBytes: number,
    timeoutMs: number,
  ) => Promise<FetchResponse>;
}

const blockedAddresses = createBlockedAddressList();

// 完整流程：URL 语法检查 -> DNS 解析 -> 全地址公网检查 -> 固定 IP 请求 ->
// 重定向逐跳重复检查 -> 文本响应校验 -> UTF-8 安全解码。
export async function fetchUrlText(
  rawUrl: string,
  maxBytes: number,
  dependencyOverrides: Partial<FetchUrlDependencies> = {},
): Promise<string> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FETCH_BYTES) {
    throw new Error(`fetch_url max_bytes must be an integer between 1 and ${MAX_FETCH_BYTES}`);
  }
  const dependencies: FetchUrlDependencies = {
    resolveAddresses: resolvePublicAddresses,
    request: requestPinnedUrl,
    ...dependencyOverrides,
  };
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let currentUrl = parseAndValidateUrl(rawUrl);
  let redirects = 0;

  while (true) {
    // DNS 解析也计入总超时，避免解析器卡住时绕过请求阶段的 timeout。
    const dnsTime = deadline - Date.now();
    if (dnsTime <= 0) {
      throw new Error(`fetch_url timed out after ${FETCH_TIMEOUT_MS} milliseconds`);
    }
    const addresses = await withTimeout(
      dependencies.resolveAddresses(normalizeHostname(currentUrl.hostname)),
      dnsTime,
    );
    if (addresses.length === 0) {
      throw new Error("fetch_url hostname did not resolve to an address");
    }
    // 必须检查 DNS 返回的全部地址，而不是只检查准备连接的第一个地址。
    // 混合返回“公网 + 内网”的域名同样拒绝，避免地址轮换造成边界不一致。
    for (const address of addresses) {
      if (!isPublicAddress(address.address, address.family)) {
        throw new Error(`fetch_url blocked non-public address: ${address.address}`);
      }
    }

    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0) {
      throw new Error(`fetch_url timed out after ${FETCH_TIMEOUT_MS} milliseconds`);
    }
    // requestPinnedUrl 的 lookup 回调只会返回这里已经验证过的地址，连接阶段不会二次解析域名。
    const response = await dependencies.request(currentUrl, addresses[0]!, maxBytes, remainingTime);
    const location = getSingleHeader(response.headers.location);
    if (isRedirectStatus(response.status) && location) {
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`fetch_url exceeded ${MAX_REDIRECTS} redirects`);
      }
      // Location 可以是相对地址。合成绝对 URL 后重新进入循环，下一跳会再次做 DNS/地址检查。
      currentUrl = parseAndValidateUrl(new URL(location, currentUrl).href);
      redirects += 1;
      continue;
    }

    const contentType = validateTextResponseHeaders(response.headers);

    // 响应可能刚好在一个 UTF-8 多字节字符中间截断。StringDecoder.write 不会把
    // 不完整尾字节变成 �，而是只返回最后一个完整字符之前的文本。
    const decoder = new StringDecoder("utf8");
    return JSON.stringify({
      url: currentUrl.href,
      status: response.status,
      content_type: contentType ?? null,
      body: decoder.write(response.body),
      truncated: response.truncated,
      redirects,
    }, null, 2);
  }
}

function parseAndValidateUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("fetch_url requires a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("fetch_url only supports http and https URLs");
  }
  if (url.username || url.password) {
    // 防止确认界面和错误日志意外暴露 URL 中携带的 Basic Auth 凭据。
    throw new Error("fetch_url URLs must not contain usernames or passwords");
  }
  if (url.hostname.length === 0) {
    throw new Error("fetch_url URL must contain a hostname");
  }

  // 本地域名在 DNS 前直接拒绝；最终是否公网仍以解析后的 IP 检查为准。
  const hostname = normalizeHostname(url.hostname).toLowerCase();
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".lan")
    || hostname.endsWith(".home")
  ) {
    throw new Error("fetch_url blocked a local hostname");
  }
  return url;
}

async function resolvePublicAddresses(hostname: string): Promise<ResolvedAddress[]> {
  // IP 字面量不需要 DNS，但仍会在主流程中经过相同的公网地址检查。
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }
  // all: true 是 SSRF 防护的必要条件：不能只看到解析器碰巧返回的第一个公网地址。
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => {
    if (result.family !== 4 && result.family !== 6) {
      throw new Error(`fetch_url received an unsupported address family: ${result.family}`);
    }
    return { address: result.address, family: result.family };
  });
}

function requestPinnedUrl(
  url: URL,
  address: ResolvedAddress,
  maxBytes: number,
  timeoutMs: number,
): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // HTTPS 仍然使用原始 URL hostname 做 Host/SNI 和证书校验；这里只替换底层 DNS 结果。
    // 这既保持 TLS 语义，又消除校验完成后发生 DNS rebinding 的时间窗口。
    const lookupPinnedAddress: LookupFunction = (_hostname, _options, callback) => {
      callback(null, address.address, address.family);
    };
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: "GET",
      // 不复用跨请求连接。每一跳都必须使用本轮重新验证并固定的地址。
      agent: false,
      lookup: lookupPinnedAddress,
      headers: {
        accept: "text/*, application/json, application/xml, application/*+json, application/*+xml;q=0.9",
        // 不自动解压响应，避免压缩炸弹绕过 maxBytes 原始正文限制。
        "accept-encoding": "identity",
        "user-agent": "OpenClaw/1.0",
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = getSingleHeader(response.headers.location);
      if (isRedirectStatus(status) && location) {
        // 重定向正文没有使用价值，直接排空连接并把 Location 交给外层逐跳验证。
        response.resume();
        finish({ status, headers: response.headers, body: Buffer.alloc(0), truncated: false });
        return;
      }

      try {
        validateTextResponseHeaders(response.headers);
      } catch (error) {
        response.resume();
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      response.on("data", (chunk: Buffer) => {
        const remaining = maxBytes - bytes;
        if (remaining <= 0) {
          // 到达上限后立即关闭响应，不继续消耗大型正文的网络带宽。
          truncated = true;
          response.destroy();
          finish({
            status,
            headers: response.headers,
            body: Buffer.concat(chunks),
            truncated,
          });
          return;
        }
        const selected = chunk.subarray(0, remaining);
        chunks.push(selected);
        bytes += selected.length;
        if (selected.length < chunk.length) {
          // 当前 chunk 已经跨过上限，只保存允许的前半部分并终止连接。
          truncated = true;
          response.destroy();
          finish({
            status,
            headers: response.headers,
            body: Buffer.concat(chunks),
            truncated,
          });
        }
      });
      response.once("end", () => finish({
        status,
        headers: response.headers,
        body: Buffer.concat(chunks),
        truncated,
      }));
      response.once("error", fail);
    });

    // timeoutMs 是扣除 DNS 和之前重定向耗时后的剩余总预算。
    const timeout = setTimeout(() => {
      request.destroy();
      fail(new Error(`fetch_url timed out after ${FETCH_TIMEOUT_MS} milliseconds`));
    }, timeoutMs);
    request.once("error", fail);
    request.end();

    function finish(response: FetchResponse): void {
      // destroy、end 和 error 可能相继到达；settled 保证 Promise 只完成一次。
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(response);
    }

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }
  });
}

function isTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType === "application/xml"
    || mediaType === "application/javascript"
    || mediaType === "application/x-javascript"
    || mediaType === "application/x-www-form-urlencoded"
    || mediaType.endsWith("+json")
    || mediaType.endsWith("+xml");
}

function validateTextResponseHeaders(headers: http.IncomingHttpHeaders): string {
  const contentType = getSingleHeader(headers["content-type"]);
  if (!contentType || !isTextContentType(contentType)) {
    throw new Error(`fetch_url response is not supported text content: ${contentType ?? "unknown"}`);
  }
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]?.toLowerCase();
  // 当前实现只用 UTF-8 解码器。显式拒绝其他字符集，比返回不可预测的乱码更容易让模型处理。
  if (charset && charset !== "utf-8" && charset !== "utf8" && charset !== "us-ascii") {
    throw new Error(`fetch_url response charset is not supported: ${charset}`);
  }
  const contentEncoding = getSingleHeader(headers["content-encoding"]);
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new Error(`fetch_url does not accept encoded responses: ${contentEncoding}`);
  }
  return contentType;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function getSingleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeHostname(hostname: string): string {
  // WHATWG URL 对 IPv6 hostname 保留方括号，而 net.isIP/BlockList 接受不带括号的地址。
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  // dns.lookup 本身没有可用的 AbortSignal；用 Promise 超时把它纳入整轮截止时间。
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`fetch_url timed out after ${FETCH_TIMEOUT_MS} milliseconds`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function isPublicAddress(address: string, family: 4 | 6): boolean {
  const normalized = address.toLowerCase();
  // Node BlockList 会把 IPv4 映射到 IPv6 后再比较，若直接加入 ::ffff:0:0/96
  // 会误伤所有公网 IPv4。因此 mapped IPv6 在这里单独识别并整体拒绝。
  if (family === 6 && (normalized.startsWith("::ffff:") || normalized.startsWith("0:0:0:0:0:ffff:"))) {
    return false;
  }
  const addressType = family === 4 ? "ipv4" : "ipv6";
  return isIP(address) === family && !blockedAddresses.check(address, addressType);
}

function createBlockedAddressList(): BlockList {
  const blockList = new BlockList();
  // 除 RFC1918 私网外，也阻止回环、链路本地、运营商 NAT、文档网段、
  // 基准测试网段、组播和保留地址，防止它们被用作内部服务跳板。
  const ipv4Subnets: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  for (const [network, prefix] of ipv4Subnets) blockList.addSubnet(network, prefix, "ipv4");

  // IPv6 同样阻止未指定/兼容地址、NAT64、Teredo/6to4 等过渡机制、
  // 文档地址、ULA、链路/站点本地和组播地址。
  const ipv6Subnets: Array<[string, number]> = [
    ["::", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ];
  for (const [network, prefix] of ipv6Subnets) blockList.addSubnet(network, prefix, "ipv6");
  return blockList;
}
