import { OverwingError } from "./errors.js";
import { Transport, env, query } from "./http.js";
import type { RequestInitLite, TransportOptions } from "./http.js";
import type {
  RadarCloudTrailResult,
  RadarDecoy,
  RadarDecoyKeyMinted,
  RadarDecoyKind,
  RadarDecoyMinted,
  RadarDecoyRegistered,
  RadarEventInput,
  RadarEventsAccepted,
  RadarFirehoseAck,
  RadarIncidentDetail,
  RadarIncidentSummary,
  RadarResponseInput,
  RadarResponseRecorded,
  RadarResponses,
  RadarStatus,
  RadarSurface,
  RadarSurfaceKind,
  RadarSurfaceNamed,
  RadarThresholdsInput,
  RadarThresholdsState,
} from "./types.js";

/**
 * Overwing Radar: watches shared stores (a cache, a queue, a bucket, a place keys are kept) for agents
 * acting together, and for one stolen login behaving like a machine. You report who touched which
 * artifact, with hashes and sizes and never contents; Radar groups what it finds into incidents and
 * recommends what to do. It recommends only: it changes nothing on your systems.
 *
 * Every call needs a key (`apiKey`, or OVERWING_API_KEY). A key of scope "swarm" can call `sendEvents`,
 * `sendCloudTrail` and `reportResponse` and nothing else, so it is the one to put in the infrastructure
 * you are watching. Everything else needs a key of scope "full".
 *
 *   const radar = new Radar();
 *   await radar.sendEvents([{ id: "evt-1", surfaceId: "scratch-bucket", artifactId: "notes/plan.md", actorId: "agent-17", op: "read", ts: new Date() }]);
 *   const { incidents } = await radar.listIncidents({ status: "open" });
 */
export class Radar {
  private readonly http: Transport;

  constructor(options: TransportOptions & { apiKey?: string } = {}, transport?: Transport) {
    this.http = transport ?? new Transport(options.apiKey ?? env("OVERWING_API_KEY") ?? undefined, options);
  }

  /** Events sent this month against the allowance, monitoring, what is on sale, and the limits of one request. */
  status(): Promise<RadarStatus> {
    return this.request("GET", "/api/v1/swarm");
  }

  /**
   * Report events from shared surfaces: up to 500 and 1,000,000 bytes a request. A batch is taken whole or
   * not at all: one bad event refuses it (OverwingError, 400) and the message names it. An event id sent
   * again is counted once, so the same batch can be sent again when no answer came back.
   * Throws OverwingError with status 402 past the month's allowance and 429 past 120 requests a minute.
   */
  sendEvents(events: RadarEventInput[], options: { drillId?: string } = {}): Promise<RadarEventsAccepted> {
    return this.request("POST", "/api/v1/swarm/events", {
      body: {
        events: events.map((e) => ({
          id: e.id,
          surface_id: e.surfaceId,
          artifact_id: e.artifactId,
          actor_id: e.actorId,
          principal_id: e.principalId,
          op: e.op,
          ts: e.ts instanceof Date ? e.ts.toISOString() : e.ts,
          content_hash: e.contentHash,
          parent_artifact_hash: e.parentArtifactHash,
          size_bytes: e.sizeBytes,
          metadata: e.metadata,
        })),
        drill_id: options.drillId,
      },
    });
  }

  /** The surfaces this account has events for or has named, with what each saw in the last day. */
  listSurfaces(): Promise<{ surfaces: RadarSurface[] }> {
    return this.request("GET", "/api/v1/swarm/surfaces");
  }

  /**
   * Name a surface before its first event, or change its kind and label. Both are replaced by what is
   * sent: a `kind` or `label` left out is set to null.
   */
  nameSurface(surfaceId: string, options: { kind?: RadarSurfaceKind | null; label?: string | null } = {}): Promise<RadarSurfaceNamed> {
    return this.request("POST", "/api/v1/swarm/surfaces", { body: { id: surfaceId, kind: options.kind, label: options.label } });
  }

  /** Decoys planted and retired. Their contents and keys are never stored, so they are not here. */
  listDecoys(): Promise<{ decoys: RadarDecoy[] }> {
    return this.request("GET", "/api/v1/swarm/decoys");
  }

  /**
   * Mint a decoy. Its `content` is in the answer once and is never stored.
   *
   * `kind: "key"` mints a decoy key: `base_url` and `key` (and both as env lines in `content`) to keep
   * where real keys are kept. Nothing there needs instrumenting; the first request that carries the key
   * opens a critical incident. `surfaceId` is your name for the place it is kept.
   *
   * Any other kind (default "notes") mints an entry: write `content` to `artifact_id` on the surface and
   * report that write like any other event, with the same `content_hash`. Planting is not counted as a touch.
   *
   * Throws OverwingError with status 422 at the limit of planted decoys.
   */
  mintDecoy(input: { surfaceId: string; kind: "key"; label?: string | null }): Promise<RadarDecoyKeyMinted>;
  mintDecoy(input: { surfaceId: string; kind?: RadarDecoyKind; label?: string | null }): Promise<RadarDecoyMinted>;
  mintDecoy(input: { surfaceId: string; kind?: RadarDecoyKind | "key"; label?: string | null }): Promise<RadarDecoyMinted | RadarDecoyKeyMinted> {
    return this.request("POST", "/api/v1/swarm/decoys", { body: { surface_id: input.surfaceId, kind: input.kind, label: input.label } });
  }

  /** Register an entry of your own as a decoy: where it lies and the hash of its content. Throws OverwingError with status 409 when a decoy already lies there. */
  registerDecoy(input: { surfaceId: string; artifactId: string; contentHash: string; label?: string | null }): Promise<RadarDecoyRegistered> {
    return this.request("POST", "/api/v1/swarm/decoys", { body: { surface_id: input.surfaceId, artifact_id: input.artifactId, content_hash: input.contentHash, label: input.label } });
  }

  /** Retire a decoy. It stops opening incidents; what it already caught stays. A retired decoy key is answered as a wrong key. */
  retireDecoy(decoyId: string): Promise<{ id: string; retired: true }> {
    return this.request("DELETE", `/api/v1/swarm/decoys/${encodeURIComponent(decoyId)}`);
  }

  /** Incidents, the most recently active first. `limit` is 1 to 200, default 50. A fire drill's incidents are not listed here. */
  listIncidents(filter: { status?: "open" | "closed"; limit?: number } = {}): Promise<{ incidents: RadarIncidentSummary[] }> {
    return this.request("GET", `/api/v1/swarm/incidents${query({ status: filter.status, limit: filter.limit })}`);
  }

  /** One incident, with its evidence and a timeline of the events that evidence names. */
  getIncident(incidentId: string): Promise<RadarIncidentDetail> {
    return this.request("GET", `/api/v1/swarm/incidents/${encodeURIComponent(incidentId)}`);
  }

  /** Close an incident once it is dealt with. New evidence later opens a new one. Throws OverwingError with status 404 when it is not open. */
  closeIncident(incidentId: string): Promise<RadarIncidentSummary> {
    return this.request("POST", `/api/v1/swarm/incidents/${encodeURIComponent(incidentId)}/close`);
  }

  /** What your own responder reported doing about an incident, and the seconds from the incident opening to the first action carried out. */
  listResponses(incidentId: string): Promise<RadarResponses> {
    return this.request("GET", `/api/v1/swarm/incidents/${encodeURIComponent(incidentId)}/responses`);
  }

  /**
   * Report one thing your responder did about an incident, or decided not to do. This records it;
   * Overwing itself acts on nothing. An incident keeps 50 reports (OverwingError, 422, past that).
   */
  reportResponse(incidentId: string, report: RadarResponseInput): Promise<RadarResponseRecorded> {
    return this.request("POST", `/api/v1/swarm/incidents/${encodeURIComponent(incidentId)}/responses`, { body: { action: report.action, status: report.status, target: report.target, detail: report.detail, by: report.by } });
  }

  /** The detector thresholds in force, what this account changed, and the defaults. */
  getThresholds(): Promise<RadarThresholdsState> {
    return this.request("GET", "/api/v1/swarm/config");
  }

  /**
   * Change detector thresholds. What is sent replaces everything this account changed before, it is not
   * merged with it: send every part that should differ from the defaults. An empty object restores them all.
   * Throws OverwingError with status 400 for a value out of bounds or a misspelt name.
   */
  setThresholds(thresholds: RadarThresholdsInput): Promise<RadarThresholdsState> {
    return this.request("PUT", "/api/v1/swarm/config", { body: thresholds });
  }

  /**
   * Send what AWS CloudTrail saw, as it is: a log file (`{ Records: [...] }`), or an EventBridge event with
   * a CloudTrail record in `detail`. S3, Secrets Manager and Parameter Store calls become events; every
   * other call is skipped. Up to 5,000 records and 4,000,000 bytes a request. A body in the form of a
   * Firehose HTTP delivery is answered the way Firehose requires, with `requestId` and `timestamp`.
   */
  sendCloudTrail(body: Record<string, unknown> | unknown[]): Promise<RadarCloudTrailResult | RadarFirehoseAck> {
    return this.request("POST", "/api/v1/swarm/connectors/aws", { body });
  }

  private request<T>(method: string, path: string, init: RequestInitLite = {}): Promise<T> {
    // Nothing in Radar works without a key. Say so here, before a request that would come back 401.
    if (!this.http.hasToken) {
      return Promise.reject(new OverwingError("Overwing API key missing. Every Radar call needs one. Pass { apiKey } or set OVERWING_API_KEY. A key of scope \"swarm\" can send events; everything else needs scope \"full\".", 0));
    }
    return this.http.request<T>(method, path, init);
  }
}

const encoder = new TextEncoder();

/**
 * Check that a webhook came from Overwing and is recent. True only when the `X-Overwing-Signature` header
 * (`t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`) matches your webhook secret over the body exactly
 * as it arrived, and `t` is within `toleranceSeconds` (default 300) of now. A missing or malformed header
 * is false, not an error. Give it the raw body, not a parsed and re-serialized one.
 *
 *   const raw = await request.text();
 *   if (!(await verifyRadarWebhook(secret, request.headers.get("x-overwing-signature"), raw))) return new Response(null, { status: 401 });
 *   const event = JSON.parse(raw) as RadarIncidentWebhook;
 *
 * Every Overwing webhook is signed this way, so this checks an `evaluation.completed` webhook too.
 */
export async function verifyRadarWebhook(secret: string, signatureHeader: string | null | undefined, rawBody: string | Uint8Array, options: { toleranceSeconds?: number; now?: Date | number } = {}): Promise<boolean> {
  if (!secret || typeof signatureHeader !== "string") return false;
  let t: string | null = null;
  let v1: string | null = null;
  for (const part of signatureHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim(), v = part.slice(eq + 1).trim();
    if (k === "t" && /^\d{1,15}$/.test(v)) t = v;
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1 = v;
  }
  if (t === null || v1 === null) return false;

  const now = options.now === undefined ? Date.now() : options.now instanceof Date ? options.now.getTime() : options.now;
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isFinite(now) || !(Math.abs(now / 1000 - Number(t)) <= tolerance)) return false;

  const prefix = encoder.encode(`${t}.`);
  const body = typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const mac = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) mac[i] = parseInt(v1.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  // HMAC verify is the timing-safe compare: the runtime checks the MAC itself, and no signature is compared as a string here.
  return crypto.subtle.verify("HMAC", key, mac, signed);
}
