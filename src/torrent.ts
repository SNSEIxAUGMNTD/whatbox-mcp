import type { Duplex } from "node:stream";
import type { Client } from "ssh2";
import type { TorrentRpcConfig, WhatboxConfig } from "./config.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TORRENTS_RETURNED = 200;
const MAX_NAME_LENGTH = 200;
const MAX_URI_LENGTH = 4096;
// A local SCGI round-trip is near-instant; a wedged rTorrent must not hang
// the tool. The enclosing SSH client is torn down per call, which reaps any
// stream a rejection leaves behind.
const RTORRENT_TIMEOUT_MS = 20_000;

export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// SSH loopback tunnel ------------------------------------------------------

function openLoopbackTunnel(client: Client, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (error, stream) => {
      if (error) {
        reject(new Error("Unable to open the loopback RPC tunnel"));
        return;
      }
      resolve(stream);
    });
  });
}

// Minimal HTTP/1.1 over a Duplex stream ------------------------------------

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function decodeChunkedBody(raw: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const lineEnd = raw.indexOf("\r\n", offset);
    if (lineEnd === -1) {
      break;
    }
    const size = Number.parseInt(raw.subarray(offset, lineEnd).toString("ascii"), 16);
    if (!Number.isFinite(size) || size < 0) {
      break;
    }
    if (size === 0) {
      break;
    }
    const start = lineEnd + 2;
    chunks.push(raw.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(chunks);
}

function httpRequestOverTunnel(
  stream: Duplex,
  request: {
    method: "GET" | "POST";
    path: string;
    headers?: Record<string, string>;
    body?: Buffer;
  }
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: "127.0.0.1",
      Connection: "close",
      ...(request.body
        ? { "Content-Length": String(request.body.length) }
        : {}),
      ...request.headers
    };
    const head =
      `${request.method} ${request.path} HTTP/1.1\r\n`
      + Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n")
      + "\r\n\r\n";

    const received: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;

    const fail = (message: string) => {
      if (!settled) {
        settled = true;
        stream.destroy();
        reject(new Error(message));
      }
    };

    stream.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        fail("The RPC response exceeded its bounded size");
        return;
      }
      received.push(chunk);
    });
    stream.on("error", () => fail("The RPC connection failed"));
    stream.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      const raw = Buffer.concat(received);
      const headerEnd = raw.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        reject(new Error("The RPC response was malformed"));
        return;
      }
      const headText = raw.subarray(0, headerEnd).toString("utf8");
      const [statusLine, ...headerLines] = headText.split("\r\n");
      const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
      if (!statusMatch) {
        reject(new Error("The RPC response was malformed"));
        return;
      }
      const parsedHeaders: Record<string, string> = {};
      for (const line of headerLines) {
        const separator = line.indexOf(":");
        if (separator > 0) {
          parsedHeaders[line.slice(0, separator).trim().toLowerCase()] = line
            .slice(separator + 1)
            .trim();
        }
      }
      let body: Buffer = raw.subarray(headerEnd + 4);
      if (parsedHeaders["transfer-encoding"]?.toLowerCase() === "chunked") {
        body = decodeChunkedBody(body);
      }
      resolve({
        status: Number.parseInt(statusMatch[1], 10),
        headers: parsedHeaders,
        body
      });
    });

    stream.write(head);
    if (request.body) {
      stream.write(request.body);
    }
    stream.end();
  });
}

async function rpcRequest(
  client: Client,
  port: number,
  request: Parameters<typeof httpRequestOverTunnel>[1]
) {
  const stream = await openLoopbackTunnel(client, port);
  return httpRequestOverTunnel(stream, request);
}

// Normalized surface -------------------------------------------------------

export interface TorrentSummary {
  id: string;
  name: string;
  state: string;
  percentDone: number;
  ratio: number;
  sizeBytes: number;
  uploadedBytes: number;
  label: string | null;
}

export interface TorrentsStatus {
  client: TorrentRpcConfig["client"];
  torrentCount: number;
  truncated: boolean;
  totals: { downloadRateBps: number; uploadRateBps: number } | null;
  torrents: TorrentSummary[];
}

export type TorrentControlOperation =
  | "pause"
  | "resume"
  | "set_label"
  | "set_ratio_limit";

function requireTorrentRpc(config: WhatboxConfig): TorrentRpcConfig {
  if (!config.torrentRpc) {
    throw new Error(
      "No torrent RPC is configured; set WHATBOX_TORRENT_CLIENT (rtorrent auto-discovers its endpoint; transmission/qbittorrent also need WHATBOX_TORRENT_RPC_PORT)"
    );
  }
  return config.torrentRpc;
}

export function validateTorrentSource(magnetOrUrl: string) {
  if (
    magnetOrUrl.length > MAX_URI_LENGTH
    || !(
      magnetOrUrl.startsWith("magnet:?")
      || magnetOrUrl.startsWith("http://")
      || magnetOrUrl.startsWith("https://")
    )
  ) {
    throw new Error("The torrent source must be a bounded magnet or HTTP(S) URL");
  }
  return magnetOrUrl;
}

function trimName(name: unknown) {
  return String(name ?? "").slice(0, MAX_NAME_LENGTH);
}

// Transmission -------------------------------------------------------------

const TRANSMISSION_STATUS_NAMES: Record<number, string> = {
  0: "stopped",
  1: "queued_verify",
  2: "verifying",
  3: "queued_download",
  4: "downloading",
  5: "queued_seed",
  6: "seeding"
};

class TransmissionClient {
  private sessionId = "";

  constructor(
    private readonly ssh: Client,
    private readonly rpc: TorrentRpcConfig
  ) {}

  private authHeader(): Record<string, string> {
    if (!this.rpc.username && !this.rpc.password) {
      return {};
    }
    const token = Buffer.from(
      `${this.rpc.username ?? ""}:${this.rpc.password ?? ""}`
    ).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  async call(method: string, args: Record<string, unknown>) {
    const body = Buffer.from(
      JSON.stringify({ method, arguments: args }),
      "utf8"
    );
    const doRequest = () =>
      rpcRequest(this.ssh, this.rpc.port ?? 0, {
        method: "POST",
        path: "/transmission/rpc",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeader(),
          ...(this.sessionId
            ? { "X-Transmission-Session-Id": this.sessionId }
            : {})
        },
        body
      });

    let response = await doRequest();
    if (response.status === 409) {
      this.sessionId = response.headers["x-transmission-session-id"] ?? "";
      if (!this.sessionId) {
        throw new Error("The Transmission RPC handshake failed");
      }
      response = await doRequest();
    }
    if (response.status === 401) {
      throw new Error("The Transmission RPC rejected the configured credentials");
    }
    if (response.status !== 200) {
      throw new Error("The Transmission RPC request failed");
    }
    const parsed = JSON.parse(response.body.toString("utf8")) as {
      result?: string;
      arguments?: Record<string, unknown>;
    };
    if (parsed.result !== "success") {
      throw new Error("The Transmission RPC reported a failure");
    }
    return parsed.arguments ?? {};
  }
}

async function transmissionStatus(
  ssh: Client,
  rpc: TorrentRpcConfig
): Promise<TorrentsStatus> {
  const client = new TransmissionClient(ssh, rpc);
  const [torrentArgs, statsArgs] = [
    await client.call("torrent-get", {
      fields: [
        "id",
        "name",
        "status",
        "percentDone",
        "uploadRatio",
        "uploadedEver",
        "sizeWhenDone",
        "labels"
      ]
    }),
    await client.call("session-stats", {})
  ];
  const rawTorrents = (torrentArgs.torrents as Array<Record<string, unknown>>) ?? [];
  const torrents = rawTorrents.slice(0, MAX_TORRENTS_RETURNED).map((torrent) => ({
    id: String(torrent.id),
    name: trimName(torrent.name),
    state:
      TRANSMISSION_STATUS_NAMES[Number(torrent.status)] ?? "unknown",
    percentDone: Math.round(Number(torrent.percentDone ?? 0) * 1000) / 10,
    ratio: Math.max(0, Math.round(Number(torrent.uploadRatio ?? 0) * 100) / 100),
    sizeBytes: Number(torrent.sizeWhenDone ?? 0),
    uploadedBytes: Number(torrent.uploadedEver ?? 0),
    label: Array.isArray(torrent.labels) && torrent.labels.length > 0
      ? trimName(torrent.labels[0])
      : null
  }));
  return {
    client: "transmission",
    torrentCount: rawTorrents.length,
    truncated: rawTorrents.length > MAX_TORRENTS_RETURNED,
    totals: {
      downloadRateBps: Number(statsArgs.downloadSpeed ?? 0),
      uploadRateBps: Number(statsArgs.uploadSpeed ?? 0)
    },
    torrents
  };
}

// qBittorrent --------------------------------------------------------------

class QbittorrentClient {
  private cookie = "";

  constructor(
    private readonly ssh: Client,
    private readonly rpc: TorrentRpcConfig
  ) {}

  async login() {
    const body = Buffer.from(
      `username=${encodeURIComponent(this.rpc.username ?? "")}&password=${encodeURIComponent(this.rpc.password ?? "")}`,
      "utf8"
    );
    const response = await rpcRequest(this.ssh, this.rpc.port ?? 0, {
      method: "POST",
      path: "/api/v2/auth/login",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const cookie = /SID=[^;]+/.exec(response.headers["set-cookie"] ?? "");
    if (response.status !== 200 || !cookie) {
      throw new Error("The qBittorrent WebUI rejected the configured credentials");
    }
    this.cookie = cookie[0];
  }

  async call(
    method: "GET" | "POST",
    path: string,
    form?: Record<string, string>
  ) {
    if (!this.cookie) {
      await this.login();
    }
    const body = form
      ? Buffer.from(
          Object.entries(form)
            .map(
              ([key, value]) =>
                `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
            )
            .join("&"),
          "utf8"
        )
      : undefined;
    const response = await rpcRequest(this.ssh, this.rpc.port ?? 0, {
      method,
      path,
      headers: {
        Cookie: this.cookie,
        ...(body
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {})
      },
      body
    });
    if (response.status === 403) {
      throw new Error("The qBittorrent WebUI denied the request");
    }
    return response;
  }
}

async function qbittorrentStatus(
  ssh: Client,
  rpc: TorrentRpcConfig
): Promise<TorrentsStatus> {
  const client = new QbittorrentClient(ssh, rpc);
  const info = await client.call(
    "GET",
    `/api/v2/torrents/info?limit=${MAX_TORRENTS_RETURNED + 1}`
  );
  if (info.status !== 200) {
    throw new Error("The qBittorrent torrent listing failed");
  }
  const rawTorrents = JSON.parse(info.body.toString("utf8")) as Array<
    Record<string, unknown>
  >;
  const transfer = await client.call("GET", "/api/v2/transfer/info");
  const transferInfo =
    transfer.status === 200
      ? (JSON.parse(transfer.body.toString("utf8")) as Record<string, unknown>)
      : {};

  const torrents = rawTorrents.slice(0, MAX_TORRENTS_RETURNED).map((torrent) => ({
    id: String(torrent.hash ?? ""),
    name: trimName(torrent.name),
    state: trimName(torrent.state) || "unknown",
    percentDone: Math.round(Number(torrent.progress ?? 0) * 1000) / 10,
    ratio: Math.max(0, Math.round(Number(torrent.ratio ?? 0) * 100) / 100),
    sizeBytes: Number(torrent.size ?? 0),
    uploadedBytes: Number(torrent.uploaded ?? 0),
    label: torrent.category ? trimName(torrent.category) : null
  }));
  return {
    client: "qbittorrent",
    torrentCount: rawTorrents.length,
    truncated: rawTorrents.length > MAX_TORRENTS_RETURNED,
    totals: {
      downloadRateBps: Number(transferInfo.dl_info_speed ?? 0),
      uploadRateBps: Number(transferInfo.up_info_speed ?? 0)
    },
    torrents
  };
}

async function qbittorrentAction(
  ssh: Client,
  rpc: TorrentRpcConfig,
  paths: string[],
  form: Record<string, string>
) {
  const client = new QbittorrentClient(ssh, rpc);
  for (const path of paths) {
    const response = await client.call("POST", path, form);
    if (response.status === 200) {
      return;
    }
  }
  throw new Error("The qBittorrent action failed");
}

// Public operations --------------------------------------------------------

export async function getTorrentsStatus(
  ssh: Client,
  config: WhatboxConfig
): Promise<TorrentsStatus> {
  const rpc = requireTorrentRpc(config);
  if (rpc.client === "rtorrent") {
    return rtorrentStatus(ssh, config, rpc);
  }
  return rpc.client === "transmission"
    ? transmissionStatus(ssh, rpc)
    : qbittorrentStatus(ssh, rpc);
}

export async function addTorrent(
  ssh: Client,
  config: WhatboxConfig,
  input: { magnetOrUrl: string; paused: boolean }
) {
  const rpc = requireTorrentRpc(config);
  const source = validateTorrentSource(input.magnetOrUrl);

  if (rpc.client === "rtorrent") {
    return rtorrentAdd(ssh, config, rpc, source, input.paused);
  }

  if (rpc.client === "transmission") {
    const client = new TransmissionClient(ssh, rpc);
    const result = await client.call("torrent-add", {
      filename: source,
      paused: input.paused
    });
    const added = (result["torrent-added"]
      ?? result["torrent-duplicate"]) as Record<string, unknown> | undefined;
    return {
      added: Boolean(result["torrent-added"]),
      duplicate: Boolean(result["torrent-duplicate"]),
      id: added ? String(added.id) : null,
      name: added ? trimName(added.name) : null
    };
  }

  await qbittorrentAction(ssh, rpc, ["/api/v2/torrents/add"], {
    urls: source,
    ...(input.paused ? { stopped: "true", paused: "true" } : {})
  });
  return { added: true, duplicate: false, id: null, name: null };
}

export async function controlTorrent(
  ssh: Client,
  config: WhatboxConfig,
  input: {
    torrentId: string;
    operation: TorrentControlOperation;
    label?: string;
    ratioLimit?: number;
  }
) {
  const rpc = requireTorrentRpc(config);

  if (rpc.client === "rtorrent") {
    return rtorrentControl(ssh, config, rpc, input);
  }

  if (rpc.client === "transmission") {
    const client = new TransmissionClient(ssh, rpc);
    const ids = [Number.parseInt(input.torrentId, 10)];
    if (!Number.isInteger(ids[0])) {
      throw new Error("The Transmission torrent id must be numeric");
    }
    if (input.operation === "pause") {
      await client.call("torrent-stop", { ids });
    } else if (input.operation === "resume") {
      await client.call("torrent-start", { ids });
    } else if (input.operation === "set_label") {
      await client.call("torrent-set", {
        ids,
        labels: [input.label ?? ""]
      });
    } else {
      await client.call("torrent-set", {
        ids,
        seedRatioLimit: input.ratioLimit ?? 0,
        seedRatioMode: 1
      });
    }
    return { completed: true, operation: input.operation };
  }

  const hashes = input.torrentId;
  if (!/^[a-fA-F0-9]{40}$/.test(hashes)) {
    throw new Error("The qBittorrent torrent id must be an info-hash");
  }
  if (input.operation === "pause") {
    await qbittorrentAction(
      ssh,
      rpc,
      ["/api/v2/torrents/stop", "/api/v2/torrents/pause"],
      { hashes }
    );
  } else if (input.operation === "resume") {
    await qbittorrentAction(
      ssh,
      rpc,
      ["/api/v2/torrents/start", "/api/v2/torrents/resume"],
      { hashes }
    );
  } else if (input.operation === "set_label") {
    await qbittorrentAction(ssh, rpc, ["/api/v2/torrents/setCategory"], {
      hashes,
      category: input.label ?? ""
    });
  } else {
    await qbittorrentAction(ssh, rpc, ["/api/v2/torrents/setShareLimits"], {
      hashes,
      ratioLimit: String(input.ratioLimit ?? 0),
      seedingTimeLimit: "-2",
      inactiveSeedingTimeLimit: "-2"
    });
  }
  return { completed: true, operation: input.operation };
}

export async function removeTorrent(
  ssh: Client,
  config: WhatboxConfig,
  input: { torrentId: string; deleteData: boolean }
) {
  const rpc = requireTorrentRpc(config);

  if (rpc.client === "rtorrent") {
    return rtorrentRemove(ssh, config, rpc, input);
  }

  if (rpc.client === "transmission") {
    const client = new TransmissionClient(ssh, rpc);
    const id = Number.parseInt(input.torrentId, 10);
    if (!Number.isInteger(id)) {
      throw new Error("The Transmission torrent id must be numeric");
    }
    await client.call("torrent-remove", {
      ids: [id],
      "delete-local-data": input.deleteData
    });
    return { removed: true, dataDeleted: input.deleteData };
  }

  if (!/^[a-fA-F0-9]{40}$/.test(input.torrentId)) {
    throw new Error("The qBittorrent torrent id must be an info-hash");
  }
  await qbittorrentAction(ssh, rpc, ["/api/v2/torrents/delete"], {
    hashes: input.torrentId,
    deleteFiles: input.deleteData ? "true" : "false"
  });
  return { removed: true, dataDeleted: input.deleteData };
}

// rTorrent (SCGI + XML-RPC) -------------------------------------------------
//
// rTorrent exposes XML-RPC over a local SCGI endpoint (unix socket or
// loopback port). Reached through the existing SSH connection it needs no
// credentials at all: SSH is the security boundary, matching the rest of the
// server. The public https://server/xmlrpc endpoint (account web password)
// is deliberately never used.

const RTORRENT_RC_MAX_BYTES = 16 * 1024;

export interface RtorrentEndpoint {
  kind: "unix" | "tcp";
  path?: string;
  port?: number;
}

export function parseRtorrentRc(
  content: string,
  home: string
): RtorrentEndpoint | null {
  const local = /^\s*(?:scgi_local|network\.scgi\.open_local)\s*=\s*(.+?)\s*$/m.exec(
    content
  );
  if (local) {
    const raw = local[1].replace(/^"|"$/g, "");
    const path = raw === "~" || raw.startsWith("~/")
      ? `${home}${raw.slice(1)}`
      : raw;
    return { kind: "unix", path };
  }

  const port = /^\s*(?:scgi_port|network\.scgi\.open_port)\s*=\s*(?:[\w.]*:)?(\d{2,5})\s*$/m.exec(
    content
  );
  if (port) {
    return { kind: "tcp", port: Number.parseInt(port[1], 10) };
  }

  return null;
}

function readRemoteFileBounded(
  ssh: Client,
  path: string,
  maxBytes: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    ssh.sftp((error, sftp) => {
      if (error) {
        reject(new Error("Unable to open SFTP for endpoint discovery"));
        return;
      }
      sftp.stat(path, (statError, stats) => {
        if (statError || stats.size > maxBytes) {
          sftp.end();
          reject(new Error("The rTorrent configuration file is missing or oversized"));
          return;
        }
        sftp.readFile(path, (readError, data) => {
          sftp.end();
          if (readError) {
            reject(new Error("Unable to read the rTorrent configuration file"));
            return;
          }
          resolve(data.toString("utf8"));
        });
      });
    });
  });
}

async function resolveRtorrentEndpoint(
  ssh: Client,
  config: WhatboxConfig,
  rpc: TorrentRpcConfig
): Promise<RtorrentEndpoint> {
  if (rpc.socketPath) {
    return { kind: "unix", path: rpc.socketPath };
  }
  if (rpc.port) {
    return { kind: "tcp", port: rpc.port };
  }
  const home = `/home/${config.username}`;
  // Whatbox's managed rTorrent keeps its config at ~/.config/rtorrent/
  // per their wiki; ~/.rtorrent.rc is the legacy location.
  const candidates = [
    `${home}/.config/rtorrent/rtorrent.rc`,
    `${home}/.rtorrent.rc`
  ];
  for (const path of candidates) {
    let content: string;
    try {
      content = await withTimeout(
        readRemoteFileBounded(ssh, path, RTORRENT_RC_MAX_BYTES),
        RTORRENT_TIMEOUT_MS,
        "Timed out reading the rTorrent configuration file"
      );
    } catch {
      continue;
    }
    const endpoint = parseRtorrentRc(content, home);
    if (endpoint) {
      return endpoint;
    }
  }
  throw new Error(
    "No SCGI endpoint found in ~/.config/rtorrent/rtorrent.rc or ~/.rtorrent.rc; set WHATBOX_TORRENT_RPC_SOCKET or WHATBOX_TORRENT_RPC_PORT"
  );
}

function openUnixTunnel(client: Client, socketPath: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.openssh_forwardOutStreamLocal(socketPath, (error, stream) => {
      if (error) {
        reject(new Error("Unable to open the unix-socket RPC tunnel"));
        return;
      }
      resolve(stream);
    });
  });
}

export function buildScgiRequest(body: Buffer): Buffer {
  const headers = Buffer.from(
    `CONTENT_LENGTH\0${body.length}\0SCGI\0${1}\0`,
    "ascii"
  );
  return Buffer.concat([
    Buffer.from(`${headers.length}:`, "ascii"),
    headers,
    Buffer.from(",", "ascii"),
    body
  ]);
}

function scgiRequest(
  stream: Duplex,
  body: Buffer,
  timeoutMs = RTORRENT_TIMEOUT_MS
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      action();
    };

    const timer = setTimeout(() => {
      finish(() => {
        stream.destroy();
        reject(new Error("The SCGI request timed out"));
      });
    }, timeoutMs);

    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        finish(() => {
          stream.destroy();
          reject(new Error("The SCGI response exceeded the bounded size"));
        });
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", () =>
      finish(() => reject(new Error("The SCGI stream failed")))
    );
    stream.on("close", () => {
      finish(() => {
        const raw = Buffer.concat(chunks);
        const headerEnd = raw.indexOf("\r\n\r\n");
        resolve(headerEnd === -1 ? raw : raw.subarray(headerEnd + 4));
      });
    });
    stream.end(buildScgiRequest(body));
  });
}

function xmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildXmlMethodCall(
  method: string,
  params: Array<string | number>
) {
  const rendered = params
    .map((param) =>
      typeof param === "number"
        ? `<param><value><i8>${param}</i8></value></param>`
        : `<param><value><string>${xmlEscape(param)}</string></value></param>`
    )
    .join("");
  return Buffer.from(
    `<?xml version="1.0"?><methodCall><methodName>${xmlEscape(method)}</methodName><params>${rendered}</params></methodCall>`,
    "utf8"
  );
}

type XmlRpcValue = string | number | boolean | XmlRpcValue[];

// Minimal XML-RPC response parser for rTorrent's bounded vocabulary:
// string / i4 / i8 / int / double / boolean / array. No external XML
// dependency; input size is already capped by the transport.
export function parseXmlRpcResponse(xml: string): XmlRpcValue {
  if (xml.includes("<fault>")) {
    const message = /<string>([\s\S]*?)<\/string>/.exec(xml);
    throw new Error(
      `rTorrent reported a fault: ${(message?.[1] ?? "unknown").slice(0, 200)}`
    );
  }

  let cursor = 0;

  function parseValue(): XmlRpcValue {
    const open = xml.indexOf("<value>", cursor);
    if (open === -1) {
      throw new Error("The XML-RPC response was malformed");
    }
    cursor = open + "<value>".length;

    const typed = /^\s*<(string|i4|i8|int|double|boolean|array)>/.exec(
      xml.slice(cursor)
    );
    if (!typed) {
      // Untyped <value> defaults to string per XML-RPC.
      const end = xml.indexOf("</value>", cursor);
      const raw = xml.slice(cursor, end);
      cursor = end + "</value>".length;
      return decodeXmlText(raw.trim());
    }

    const type = typed[1];
    cursor += typed[0].length;

    if (type === "array") {
      const values: XmlRpcValue[] = [];
      const dataOpen = xml.indexOf("<data>", cursor);
      cursor = dataOpen + "<data>".length;
      while (true) {
        const nextValue = xml.indexOf("<value>", cursor);
        const dataClose = xml.indexOf("</data>", cursor);
        if (nextValue === -1 || (dataClose !== -1 && dataClose < nextValue)) {
          cursor = dataClose + "</data>".length;
          break;
        }
        values.push(parseValue());
      }
      const arrayClose = xml.indexOf("</array>", cursor);
      const valueClose = xml.indexOf("</value>", arrayClose);
      cursor = valueClose + "</value>".length;
      return values;
    }

    const close = xml.indexOf(`</${type}>`, cursor);
    const raw = xml.slice(cursor, close);
    const valueClose = xml.indexOf("</value>", close);
    cursor = valueClose + "</value>".length;

    if (type === "string") {
      return decodeXmlText(raw);
    }
    if (type === "boolean") {
      return raw.trim() === "1";
    }
    return Number(raw.trim());
  }

  return parseValue();
}

function decodeXmlText(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

async function rtorrentCall(
  ssh: Client,
  endpoint: RtorrentEndpoint,
  method: string,
  params: Array<string | number>
): Promise<XmlRpcValue> {
  const stream = await withTimeout(
    endpoint.kind === "unix"
      ? openUnixTunnel(ssh, endpoint.path ?? "")
      : openLoopbackTunnel(ssh, endpoint.port ?? 0),
    RTORRENT_TIMEOUT_MS,
    "Timed out opening the rTorrent RPC endpoint"
  );
  const response = await scgiRequest(stream, buildXmlMethodCall(method, params));
  return parseXmlRpcResponse(response.toString("utf8"));
}

export function mapRtorrentTorrent(row: XmlRpcValue[]): TorrentSummary {
  const [hash, name, state, complete, sizeBytes, completedBytes, ratio, upTotal, label] =
    row;
  const size = Number(sizeBytes ?? 0);
  return {
    id: String(hash ?? ""),
    name: trimName(name),
    state:
      Number(state) === 0
        ? "stopped"
        : Number(complete) === 1
          ? "seeding"
          : "downloading",
    percentDone:
      size > 0
        ? Math.round((Number(completedBytes ?? 0) / size) * 1000) / 10
        : 0,
    ratio: Math.max(0, Math.round(Number(ratio ?? 0) / 10) / 100),
    sizeBytes: size,
    uploadedBytes: Number(upTotal ?? 0),
    label: label ? trimName(safeDecodeUriComponent(String(label))) : null
  };
}

function safeDecodeUriComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function rtorrentStatus(
  ssh: Client,
  config: WhatboxConfig,
  rpc: TorrentRpcConfig
): Promise<TorrentsStatus> {
  const endpoint = await resolveRtorrentEndpoint(ssh, config, rpc);

  const rows = await rtorrentCall(ssh, endpoint, "d.multicall2", [
    "",
    "main",
    "d.hash=",
    "d.name=",
    "d.state=",
    "d.complete=",
    "d.size_bytes=",
    "d.completed_bytes=",
    "d.ratio=",
    "d.up.total=",
    "d.custom1="
  ]);
  const upRate = await rtorrentCall(ssh, endpoint, "throttle.global_up.rate", []);
  const downRate = await rtorrentCall(ssh, endpoint, "throttle.global_down.rate", []);

  const rawRows = Array.isArray(rows) ? rows : [];
  const torrents = rawRows
    .filter((row): row is XmlRpcValue[] => Array.isArray(row))
    .map(mapRtorrentTorrent)
    // Most-uploaded first: the primary question a seedbox owner asks.
    .sort((a, b) => b.uploadedBytes - a.uploadedBytes);

  return {
    client: "rtorrent",
    torrentCount: torrents.length,
    truncated: torrents.length > MAX_TORRENTS_RETURNED,
    totals: {
      downloadRateBps: Number(downRate ?? 0),
      uploadRateBps: Number(upRate ?? 0)
    },
    torrents: torrents.slice(0, MAX_TORRENTS_RETURNED)
  };
}

function requireRtorrentHash(torrentId: string) {
  if (!/^[a-fA-F0-9]{40}$/.test(torrentId)) {
    throw new Error("The rTorrent torrent id must be a 40-character info-hash");
  }
  return torrentId.toUpperCase();
}

export async function rtorrentAdd(
  ssh: Client,
  config: WhatboxConfig,
  rpc: TorrentRpcConfig,
  source: string,
  paused: boolean
) {
  const endpoint = await resolveRtorrentEndpoint(ssh, config, rpc);
  await rtorrentCall(ssh, endpoint, paused ? "load.normal" : "load.start", [
    "",
    source
  ]);
  return { added: true, duplicate: false, id: null, name: null };
}

export async function rtorrentControl(
  ssh: Client,
  config: WhatboxConfig,
  rpc: TorrentRpcConfig,
  input: { torrentId: string; operation: TorrentControlOperation; label?: string }
) {
  const endpoint = await resolveRtorrentEndpoint(ssh, config, rpc);
  const hash = requireRtorrentHash(input.torrentId);

  if (input.operation === "pause") {
    await rtorrentCall(ssh, endpoint, "d.stop", [hash]);
  } else if (input.operation === "resume") {
    await rtorrentCall(ssh, endpoint, "d.start", [hash]);
  } else if (input.operation === "set_label") {
    await rtorrentCall(ssh, endpoint, "d.custom1.set", [
      hash,
      encodeURIComponent(input.label ?? "")
    ]);
  } else {
    throw new Error(
      "rTorrent does not support per-torrent ratio limits through this tool; use ruTorrent's ratio groups"
    );
  }
  return { completed: true, operation: input.operation };
}

export async function rtorrentRemove(
  ssh: Client,
  config: WhatboxConfig,
  rpc: TorrentRpcConfig,
  input: { torrentId: string; deleteData: boolean }
) {
  if (input.deleteData) {
    throw new Error(
      "rTorrent cannot delete data through d.erase; remove the torrent first, then quarantine the files"
    );
  }
  const endpoint = await resolveRtorrentEndpoint(ssh, config, rpc);
  await rtorrentCall(ssh, endpoint, "d.erase", [
    requireRtorrentHash(input.torrentId)
  ]);
  return { removed: true, dataDeleted: false };
}
