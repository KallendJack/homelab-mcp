import { z } from "zod";
import { httpRequests } from "./http.ts";
import { SourceError } from "./source-error.ts";

export type Container = {
  name: string;
  /** Docker's state: running, exited, restarting, paused, created, removing or dead. */
  state: string;
  /** Docker's status text, such as "Up 2 days (unhealthy)". */
  status: string;
  image: string;
};

export type Docker = {
  containers(): Promise<Container[]>;
  /** The last `lines` lines of a Container's logs, oldest first, each starting with its date and time. */
  logs(name: string, lines: number): Promise<string[]>;
};

/** How a request to start a Container ended. Anything else Docker says is a SourceError carrying its message. */
export type StartResult = "started" | "already running" | "no such container";

/** One Container of a Compose Service, with the config hash Compose stamped on it, if it did. */
export type ServiceContainer = Container & { configHash: string | undefined };

/** Docker as admin mode sees it, through the real socket: the Container list, and starting one. */
export type DockerAdmin = Pick<Docker, "containers"> & {
  start(name: string): Promise<StartResult>;
  /** The Containers Compose made for one Service of one project, found by the labels it puts on them. */
  serviceContainers(project: string, service: string): Promise<ServiceContainer[]>;
  /** Runs a fixed command in a running Container and waits for it: its exit code and what it printed. */
  exec(name: string, command: string[]): Promise<ExecResult>;
};

export type ExecResult =
  | { ran: true; exitCode: number; output: string }
  | { ran: false; reason: "no such container" | "not running" };

const CONFIG_HASH_LABEL = "com.docker.compose.config-hash";

/** The address that lists one Compose Service's Containers, using Docker's label filter. */
export function serviceContainersUrl(url: string, project: string, service: string): string {
  const filters = JSON.stringify({
    label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${service}`],
  });
  return `${url}/containers/json?all=true&filters=${encodeURIComponent(filters)}`;
}

/** Docker's rule for Container names. Nothing else can be one, so anything else can be refused early. */
export const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const containerList = z.array(
  z.object({
    Names: z.array(z.string()).min(1),
    State: z.string(),
    Status: z.string(),
    Image: z.string(),
  }),
);

/** Reads Containers through the read-only socket proxy at `url` (ADR 0002). */
export function docker(fetch: typeof globalThis.fetch, url: string): Docker {
  const { get, getJson } = httpRequests(fetch, url, "Docker");

  return {
    async containers() {
      const list = await getJson("/containers/json?all=true", containerList);
      return list.map((c) => ({
        // Docker prefixes names with a slash.
        name: (c.Names[0] ?? "").replace(/^\//, ""),
        state: c.State,
        status: c.Status,
        image: c.Image,
      }));
    },

    async logs(name, lines) {
      const query = `stdout=1&stderr=1&timestamps=1&tail=${lines}`;
      const path = `/containers/${encodeURIComponent(name)}/logs?${query}`;
      const bytes = await get(path);
      const text = new TextDecoder().decode(isFramed(bytes) ? unframe(bytes) : bytes);
      return text
        .split(/\r?\n/)
        .filter((line) => line !== "")
        .map(shortenTimestamp);
    },
  };
}

const errorMessage = z.object({ message: z.string() });
const execCreated = z.object({ Id: z.string() });
const execInspected = z.object({ ExitCode: z.number().nullable() });

const labelledContainerList = z.array(
  z.object({
    Names: z.array(z.string()).min(1),
    State: z.string(),
    Status: z.string(),
    Image: z.string(),
    Labels: z.record(z.string(), z.string()).nullish(),
  }),
);

/** Docker through the real socket, for admin mode only. `fetch` reaches the socket (`socketFetch`). */
export function dockerAdmin(fetch: typeof globalThis.fetch, url: string): DockerAdmin {
  const { post, getJson } = httpRequests(fetch, url, "Docker");
  const reader = docker(fetch, url);

  return {
    containers: () => reader.containers(),

    async serviceContainers(project, service) {
      const path = serviceContainersUrl("", project, service);
      const list = await getJson(path, labelledContainerList);
      return list.map((c) => ({
        name: (c.Names[0] ?? "").replace(/^\//, ""),
        state: c.State,
        status: c.Status,
        image: c.Image,
        configHash: c.Labels?.[CONFIG_HASH_LABEL],
      }));
    },

    async exec(name, command) {
      const create = await post(`/containers/${encodeURIComponent(name)}/exec`, {
        json: { AttachStdout: true, AttachStderr: true, Cmd: command },
      });
      if (create.status === 404) return { ran: false, reason: "no such container" };
      if (create.status === 409) return { ran: false, reason: "not running" };
      const created = execCreated.safeParse(safeJson(create.text));
      if (create.status !== 201 || !created.success) {
        throw new SourceError(`Docker couldn't run a command in ${name}: ${dockerReason(create)}`);
      }
      const id = encodeURIComponent(created.data.Id);
      // Without Detach, Docker answers with the command's output once it has finished.
      const started = await post(`/exec/${id}/start`, { json: { Detach: false, Tty: false } });
      if (started.status !== 200) {
        throw new SourceError(`Docker couldn't run a command in ${name}: ${dockerReason(started)}`);
      }
      const bytes = isFramed(started.bytes) ? unframe(started.bytes) : started.bytes;
      const { ExitCode } = await getJson(`/exec/${id}/json`, execInspected);
      return {
        ran: true,
        exitCode: ExitCode ?? -1,
        output: new TextDecoder().decode(bytes).trim(),
      };
    },

    async start(name) {
      const { status, text } = await post(`/containers/${encodeURIComponent(name)}/start`);
      if (status === 204) return "started";
      if (status === 304) return "already running";
      if (status === 404) return "no such container";
      // Docker explains a failure in JSON; its message is passed on, and Redaction runs on everything shown.
      const parsed = errorMessage.safeParse(safeJson(text));
      const why = parsed.success ? parsed.data.message : `HTTP ${status}`;
      throw new SourceError(`Docker couldn't start ${name}: ${why}`);
    },
  };
}

/** Docker's own explanation of a failed request, or its status when it gave none. */
function dockerReason({ status, text }: { status: number; text: string }): string {
  const parsed = errorMessage.safeParse(safeJson(text));
  return parsed.success ? parsed.data.message : `HTTP ${status}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Docker frames the logs of a Container that has no terminal: each chunk starts with an 8-byte header of
 * stream (0 to 2), three zero bytes and the chunk's size. A Container with a terminal sends plain text,
 * which can't start that way.
 */
function isFramed(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 && (bytes[0] ?? 3) <= 2 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0
  );
}

/** Joins the chunks of a framed log stream, dropping their headers. Docker sends them in the order written. */
function unframe(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4);
    chunks.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(chunks);
}

/** "2026-09-30T08:00:02.450000000Z text" becomes "2026-09-30 08:00:02 text": seconds are enough to read by. */
function shortenTimestamp(line: string): string {
  return line.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z /, "$1 $2 ");
}
