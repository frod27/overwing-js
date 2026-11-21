import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { Overwing, OverwingError, Radar, verifyRadarWebhook } from "../dist/index.js";
import type { Call } from "./helpers.ts";
import { scriptedFetch } from "./helpers.ts";

const BASE = "https://example.test";
const INCIDENT_ID = "swi_AAAAAAAAAAAAAAAAAAAA";
const DECOY_ID = "swd_BBBBBBBBBBBBBBBBBBBB";

const incident = {
  id: INCIDENT_ID, status: "open", severity: "critical", title: "A decoy key was tried", detectors: ["decoy_credential"], surfaces: ["ci-secrets"], actors: ["ip:203.0.113.7"],
  first_event_at: "2026-11-20T12:00:00.000Z", last_event_at: "2026-11-20T12:00:05.000Z", opened_at: "2026-11-20T12:00:06.000Z", updated_at: "2026-11-20T12:00:06.000Z", closed_at: null, closed_by: null, drill_id: null,
  recommended_actions: [{ action: "rotate_secrets", surface: "ci-secrets", reason: "A decoy key kept here was tried." }, { action: "block_source", surface: null, actors: ["ip:203.0.113.7"], reason: "The addresses the decoy key was tried from." }],
  enforced: false, responses: [], contained_in_seconds: null, url: `${BASE}/dashboard/swarm/incidents/${INCIDENT_ID}`,
};
const decoy = { id: DECOY_ID, kind: "artifact", surface_id: "scratch-bucket", artifact_id: "notes/handover-2026.md", content_hash: "sha256:41bd77aa", label: null, created_at: "2026-11-20T12:00:00.000Z", retired_at: null };
const thresholds = {
  windowMinutes: 30, decoyTouch: { enabled: true }, sweep: { enabled: true, minArtifacts: 20, windowSeconds: 60, exemptActors: [] }, convergence: { enabled: true, minActors: 3, windowSeconds: 600 },
  relayChain: { enabled: true, minActors: 3, minLength: 3 }, coldStart: { enabled: true, minActors: 5, burstSeconds: 120, newWithinSeconds: 600 }, incident: { mergeWindowSeconds: 1800, quietCloseSeconds: 1800 }, response: { enabled: false, minSeverity: "critical" },
};

function radarWith(responses: Parameters<typeof scriptedFetch>[0]): { radar: Radar; calls: Call[] } {
  const { fetch, calls } = scriptedFetch(responses);
  return { radar: new Radar({ apiKey: "ow_live_test", fetch, baseUrl: BASE, maxRetries: 0 }), calls };
}

/** Asserts one recorded call: method, path, the key, and the JSON body (or that there is none). */
function sent(call: Call | undefined, method: string, path: string, body?: unknown): void {
  assert.ok(call, "a request was made");
  assert.equal(call.init.method, method);
  assert.equal(call.url, `${BASE}${path}`);
  assert.equal((call.init.headers as Record<string, string>).Authorization, "Bearer ow_live_test");
  if (body === undefined) assert.equal(call.init.body, undefined);
  else assert.deepEqual(JSON.parse(String(call.init.body)), body);
}

describe("Radar client", () => {
  it("reads the account's status", async () => {
    const body = { product: "Overwing Radar", events_this_month: 12, monthly_allowance: 10_000, monitoring: { active: false, status: "none", current_period_end: null, cancel_at_period_end: false }, pricing: { drill_usd: 99, monitoring_monthly_usd: 199, free_monthly_events: 10_000, monitoring_monthly_events: 10_000_000 }, limits: { events_per_request: 500, request_bytes: 1_000_000, requests_per_minute: 120, retention_days: 30, surfaces: 200, decoys: 500 } };
    const { radar, calls } = radarWith([{ status: 200, body }]);
    const status = await radar.status();
    assert.equal(status.events_this_month, 12);
    assert.equal(status.limits.events_per_request, 500);
    sent(calls[0], "GET", "/api/v1/swarm");
  });

  it("sends events under the API's snake_case names, with a Date as an ISO time", async () => {
    const { radar, calls } = radarWith([{ status: 202, body: { accepted: 2, duplicates: 0, drill_id: null } }]);
    const answer = await radar.sendEvents([
      { id: "evt-000001", surfaceId: "scratch-bucket", artifactId: "notes/plan.md", actorId: "agent-17", principalId: "team-a", op: "read", ts: new Date("2026-11-20T12:00:00Z"), contentHash: "sha256:9f2c0e11", sizeBytes: 812 },
      { id: "evt-000002", surfaceId: "scratch-bucket", artifactId: "out/agent-17/step.txt", actorId: "agent-17", op: "write", ts: 1795348820000, contentHash: "sha256:41bd77aa", parentArtifactHash: "sha256:9f2c0e11", sizeBytes: 240, metadata: { region: "us-east-1", retried: false } },
    ]);
    assert.deepEqual(answer, { accepted: 2, duplicates: 0, drill_id: null });
    sent(calls[0], "POST", "/api/v1/swarm/events", {
      events: [
        { id: "evt-000001", surface_id: "scratch-bucket", artifact_id: "notes/plan.md", actor_id: "agent-17", principal_id: "team-a", op: "read", ts: "2026-11-20T12:00:00.000Z", content_hash: "sha256:9f2c0e11", size_bytes: 812 },
        { id: "evt-000002", surface_id: "scratch-bucket", artifact_id: "out/agent-17/step.txt", actor_id: "agent-17", op: "write", ts: 1795348820000, content_hash: "sha256:41bd77aa", parent_artifact_hash: "sha256:9f2c0e11", size_bytes: 240, metadata: { region: "us-east-1", retried: false } },
      ],
    });
  });

  it("sends a drill id with the events when given one, and an ISO string as it is", async () => {
    const drillId = "swdr_CCCCCCCCCCCCCCCCCCCC";
    const { radar, calls } = radarWith([{ status: 202, body: { accepted: 1, duplicates: 0, drill_id: drillId } }]);
    const answer = await radar.sendEvents([{ id: "e1", surfaceId: "s", artifactId: "a", actorId: "x", op: "list", ts: "2026-11-20T12:00:00Z" }], { drillId });
    assert.equal(answer.drill_id, drillId);
    sent(calls[0], "POST", "/api/v1/swarm/events", { events: [{ id: "e1", surface_id: "s", artifact_id: "a", actor_id: "x", op: "list", ts: "2026-11-20T12:00:00Z" }], drill_id: drillId });
  });

  it("lists surfaces and names one", async () => {
    const named = { id: "scratch-bucket", kind: "bucket", label: "Scratch", created_at: "2026-11-20T12:00:00.000Z" };
    const { radar, calls } = radarWith([
      { status: 200, body: { surfaces: [{ ...named, last_24h: { events: 40, actors: 3, last_event_at: "2026-11-20T12:00:20.000Z" } }] } },
      { status: 201, body: named },
      { status: 201, body: { ...named, kind: null, label: null } },
    ]);
    assert.equal((await radar.listSurfaces()).surfaces[0]?.last_24h.actors, 3);
    sent(calls[0], "GET", "/api/v1/swarm/surfaces");
    assert.equal((await radar.nameSurface("scratch-bucket", { kind: "bucket", label: "Scratch" })).kind, "bucket");
    sent(calls[1], "POST", "/api/v1/swarm/surfaces", { id: "scratch-bucket", kind: "bucket", label: "Scratch" });
    await radar.nameSurface("scratch-bucket");
    sent(calls[2], "POST", "/api/v1/swarm/surfaces", { id: "scratch-bucket" });
  });

  it("lists decoys, mints one, registers one and retires one", async () => {
    const { radar, calls } = radarWith([
      { status: 200, body: { decoys: [decoy] } },
      { status: 201, body: { ...decoy, content: "# handover notes\n...", content_shown_once: true, plant: "Write `content` to `artifact_id` on the surface." } },
      { status: 201, body: { ...decoy, content: "aws_access_key_id=AKIA...", content_shown_once: true, plant: "p" } },
      { status: 201, body: { ...decoy, artifact_id: "backups/keys.txt", label: "ours", plant: "Recorded. Any touch of this artifact now opens an incident." } },
      { status: 200, body: { id: DECOY_ID, retired: true } },
    ]);
    assert.equal((await radar.listDecoys()).decoys[0]?.id, DECOY_ID);
    sent(calls[0], "GET", "/api/v1/swarm/decoys");

    const minted = await radar.mintDecoy({ surfaceId: "scratch-bucket" });
    assert.equal(minted.content_shown_once, true);
    assert.equal(minted.artifact_id, "notes/handover-2026.md");
    sent(calls[1], "POST", "/api/v1/swarm/decoys", { surface_id: "scratch-bucket" });

    await radar.mintDecoy({ surfaceId: "scratch-bucket", kind: "credentials", label: "aws" });
    sent(calls[2], "POST", "/api/v1/swarm/decoys", { surface_id: "scratch-bucket", kind: "credentials", label: "aws" });

    const registered = await radar.registerDecoy({ surfaceId: "scratch-bucket", artifactId: "backups/keys.txt", contentHash: "sha256:41bd77aa", label: "ours" });
    assert.equal(registered.artifact_id, "backups/keys.txt");
    sent(calls[3], "POST", "/api/v1/swarm/decoys", { surface_id: "scratch-bucket", artifact_id: "backups/keys.txt", content_hash: "sha256:41bd77aa", label: "ours" });

    assert.deepEqual(await radar.retireDecoy(DECOY_ID), { id: DECOY_ID, retired: true });
    sent(calls[4], "DELETE", `/api/v1/swarm/decoys/${DECOY_ID}`);
  });

  it("mints a decoy key: the answer has base_url, key and content", async () => {
    const answer = { ...decoy, kind: "key", surface_id: "ci-secrets", artifact_id: "credential:llm-gateway-a1b2c3", label: "llm gateway", base_url: "https://overwing.ai/api/gw/v1", key: "sk-gw-test", content: "# internal model gateway\nLLM_GATEWAY_BASE_URL=https://overwing.ai/api/gw/v1\nLLM_GATEWAY_API_KEY=sk-gw-test\n", content_shown_once: true, plant: "Keep `content` where real keys are kept." };
    const { radar, calls } = radarWith([{ status: 201, body: answer }]);
    const minted = await radar.mintDecoy({ surfaceId: "ci-secrets", kind: "key", label: "llm gateway" });
    assert.equal(minted.kind, "key");
    assert.equal(minted.base_url, "https://overwing.ai/api/gw/v1");
    assert.equal(minted.key, "sk-gw-test");
    assert.match(minted.content, /LLM_GATEWAY_API_KEY=sk-gw-test/);
    sent(calls[0], "POST", "/api/v1/swarm/decoys", { surface_id: "ci-secrets", kind: "key", label: "llm gateway" });
  });

  it("lists incidents with and without a filter, reads one and closes one", async () => {
    const detail = { ...incident, evidence: [{ detector: "decoy_credential", score: 1, summary: "s", surfaces: ["ci-secrets"], actors: ["ip:203.0.113.7"], artifacts: ["credential:llm-gateway-a1b2c3"], event_ids: ["key-1"], from: incident.first_event_at, to: incident.last_event_at }], webhook: null, timeline: [{ at: incident.first_event_at, event_id: "key-1", actor_id: "ip:203.0.113.7", principal_id: null, op: "read", surface_id: "ci-secrets", artifact_id: "credential:llm-gateway-a1b2c3", content_hash: null, parent_artifact_hash: null, size_bytes: null, metadata: { path: "/v1/chat/completions" } }] };
    const { radar, calls } = radarWith([
      { status: 200, body: { incidents: [{ ...incident, evidence_count: 1 }] } },
      { status: 200, body: { incidents: [] } },
      { status: 200, body: detail },
      { status: 200, body: { ...incident, status: "closed", closed_at: "2026-11-20T13:00:00.000Z", closed_by: "key:ow_live_test", evidence_count: 1 } },
    ]);
    const { incidents } = await radar.listIncidents({ status: "open", limit: 10 });
    assert.equal(incidents[0]?.severity, "critical");
    assert.equal(incidents[0]?.enforced, false);
    assert.equal(incidents[0]?.evidence_count, 1);
    sent(calls[0], "GET", "/api/v1/swarm/incidents?status=open&limit=10");

    assert.deepEqual((await radar.listIncidents()).incidents, []);
    sent(calls[1], "GET", "/api/v1/swarm/incidents");

    const one = await radar.getIncident(INCIDENT_ID);
    assert.equal(one.evidence[0]?.event_ids[0], "key-1");
    assert.equal(one.timeline[0]?.actor_id, "ip:203.0.113.7");
    sent(calls[2], "GET", `/api/v1/swarm/incidents/${INCIDENT_ID}`);

    assert.equal((await radar.closeIncident(INCIDENT_ID)).status, "closed");
    sent(calls[3], "POST", `/api/v1/swarm/incidents/${INCIDENT_ID}/close`);
  });

  it("escapes an id in the path", async () => {
    const { radar, calls } = radarWith([{ status: 400, body: { error: "Not an incident id." } }, { status: 400, body: { error: "Not a decoy id." } }]);
    await assert.rejects(radar.getIncident("a/b?c"), OverwingError);
    assert.equal(calls[0]?.url, `${BASE}/api/v1/swarm/incidents/a%2Fb%3Fc`);
    await assert.rejects(radar.retireDecoy("../x"), OverwingError);
    assert.equal(calls[1]?.url, `${BASE}/api/v1/swarm/decoys/..%2Fx`);
  });

  it("lists what a responder reported and reports one more", async () => {
    const stored = { action: "revoke_identity", target: "arn:aws:iam::111122223333:user/svc-reports", status: "done", detail: "rule: quarantine an IAM user; exit 0", by: "responder-east", at: "2026-11-20T12:00:48.000Z" };
    const { radar, calls } = radarWith([
      { status: 200, body: { incident_id: INCIDENT_ID, responses: [stored], contained_in_seconds: 42 } },
      { status: 201, body: { incident_id: INCIDENT_ID, recorded: true, responses: 2, contained_in_seconds: 42 } },
      { status: 201, body: { incident_id: INCIDENT_ID, recorded: true, responses: 3, contained_in_seconds: 42 } },
    ]);
    const listed = await radar.listResponses(INCIDENT_ID);
    assert.equal(listed.responses[0]?.status, "done");
    assert.equal(listed.contained_in_seconds, 42);
    sent(calls[0], "GET", `/api/v1/swarm/incidents/${INCIDENT_ID}/responses`);

    const recorded = await radar.reportResponse(INCIDENT_ID, { action: "block_source", status: "dry_run", target: "ip:203.0.113.7", detail: "would add a deny rule", by: "responder-east" });
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.responses, 2);
    sent(calls[1], "POST", `/api/v1/swarm/incidents/${INCIDENT_ID}/responses`, { action: "block_source", status: "dry_run", target: "ip:203.0.113.7", detail: "would add a deny rule", by: "responder-east" });

    await radar.reportResponse(INCIDENT_ID, { action: "rotate_secrets", status: "skipped" });
    sent(calls[2], "POST", `/api/v1/swarm/incidents/${INCIDENT_ID}/responses`, { action: "rotate_secrets", status: "skipped" });
  });

  it("reads the thresholds and puts the changed parts as they are", async () => {
    const changed = { sweep: { exemptActors: ["svc-backup"], minArtifacts: 40 }, coldStart: { enabled: false }, response: { enabled: true, minSeverity: "critical" as const } };
    const inForce = { ...thresholds, sweep: { ...thresholds.sweep, exemptActors: ["svc-backup"], minArtifacts: 40 }, coldStart: { ...thresholds.coldStart, enabled: false }, response: { enabled: true, minSeverity: "critical" } };
    const { radar, calls } = radarWith([
      { status: 200, body: { thresholds, changed: {}, defaults: thresholds } },
      { status: 200, body: { thresholds: inForce, changed, defaults: thresholds } },
      { status: 200, body: { thresholds, changed: {}, defaults: thresholds } },
    ]);
    const before = await radar.getThresholds();
    assert.equal(before.thresholds.sweep.minArtifacts, 20);
    assert.deepEqual(before.changed, {});
    sent(calls[0], "GET", "/api/v1/swarm/config");

    const after = await radar.setThresholds(changed);
    assert.equal(after.thresholds.sweep.minArtifacts, 40);
    assert.equal(after.defaults.sweep.minArtifacts, 20);
    sent(calls[1], "PUT", "/api/v1/swarm/config", changed);

    await radar.setThresholds({});
    sent(calls[2], "PUT", "/api/v1/swarm/config", {});
  });

  it("sends a CloudTrail body as it is", async () => {
    const log = { Records: [{ eventSource: "s3.amazonaws.com", eventName: "GetObject", eventTime: "2026-11-20T12:00:00Z", userIdentity: { arn: "arn:aws:iam::111122223333:user/svc-reports" }, requestParameters: { bucketName: "acme-build-artifacts", key: "a.txt" } }] };
    const { radar, calls } = radarWith([{ status: 202, body: { records: 1, accepted: 1, duplicates: 0, skipped: 0 } }]);
    assert.deepEqual(await radar.sendCloudTrail(log), { records: 1, accepted: 1, duplicates: 0, skipped: 0 });
    sent(calls[0], "POST", "/api/v1/swarm/connectors/aws", log);
  });

  it("throws OverwingError for an error answer, with the status and the API's message", async () => {
    const refused = (status: number, error: string, headers?: Record<string, string>) => radarWith([{ status, body: { error }, headers }]).radar;
    const event = { id: "e1", surfaceId: "s", artifactId: "a", actorId: "x", op: "read" as const, ts: 1 };

    await assert.rejects(refused(400, "events[0]: ts is older than 30 days, the longest events are kept.").sendEvents([event]), (err: unknown) => err instanceof OverwingError && err.status === 400 && /^events\[0\]: ts is older/.test(err.message));
    await assert.rejects(refused(402, "Over the month's allowance.").sendEvents([event]), (err: unknown) => err instanceof OverwingError && err.status === 402);
    await assert.rejects(refused(403, "This key's scope (\"swarm\") does not allow GET /api/v1/swarm/incidents. Use a key with scope \"full\".").listIncidents(), (err: unknown) => err instanceof OverwingError && err.status === 403 && /scope/.test(err.message));
    await assert.rejects(refused(404, "No incident with this id on this account.").getIncident(INCIDENT_ID), (err: unknown) => err instanceof OverwingError && err.status === 404 && err.message === "No incident with this id on this account.");
    await assert.rejects(refused(409, "There is already a decoy at this artifact_id on this surface.").registerDecoy({ surfaceId: "s", artifactId: "a", contentHash: "sha256:41bd77aa" }), (err: unknown) => err instanceof OverwingError && err.status === 409);
    await assert.rejects(refused(422, "An incident keeps 50 reports and this one has them.").reportResponse(INCIDENT_ID, { action: "revoke_identity", status: "done" }), (err: unknown) => err instanceof OverwingError && err.status === 422);
    await assert.rejects(refused(400, "Bad thresholds: sweep.minArtifacts Too small.").setThresholds({ sweep: { minArtifacts: 1 } }), (err: unknown) => err instanceof OverwingError && err.status === 400);
    await assert.rejects(refused(503, "Overwing Radar is not switched on for this deployment.").status(), (err: unknown) => err instanceof OverwingError && err.status === 503);
  });

  it("does not wait out a long Retry-After: a 429 on ingest throws with the seconds to wait", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 429, body: { error: "Too many ingest requests." }, headers: { "Retry-After": "30" } }]);
    const radar = new Radar({ apiKey: "ow_live_test", fetch, baseUrl: BASE });
    await assert.rejects(radar.sendEvents([{ id: "e1", surfaceId: "s", artifactId: "a", actorId: "x", op: "read", ts: 1 }]), (err: unknown) => err instanceof OverwingError && err.status === 429 && err.retryAfterSeconds === 30);
    assert.equal(calls.length, 1);
  });

  it("fails before any request when there is no key, for every method", async () => {
    const saved = process.env.OVERWING_API_KEY;
    delete process.env.OVERWING_API_KEY;
    try {
      const { fetch, calls } = scriptedFetch([{ status: 200, body: {} }]);
      for (const radar of [new Radar({ fetch, baseUrl: BASE }), new Overwing({ fetch, baseUrl: BASE }).radar]) {
        const every: Array<() => Promise<unknown>> = [
          () => radar.status(),
          () => radar.sendEvents([{ id: "e1", surfaceId: "s", artifactId: "a", actorId: "x", op: "read", ts: 1 }]),
          () => radar.listSurfaces(),
          () => radar.nameSurface("s"),
          () => radar.listDecoys(),
          () => radar.mintDecoy({ surfaceId: "s" }),
          () => radar.mintDecoy({ surfaceId: "s", kind: "key" }),
          () => radar.registerDecoy({ surfaceId: "s", artifactId: "a", contentHash: "sha256:41bd77aa" }),
          () => radar.retireDecoy(DECOY_ID),
          () => radar.listIncidents(),
          () => radar.getIncident(INCIDENT_ID),
          () => radar.closeIncident(INCIDENT_ID),
          () => radar.listResponses(INCIDENT_ID),
          () => radar.reportResponse(INCIDENT_ID, { action: "revoke_identity", status: "done" }),
          () => radar.getThresholds(),
          () => radar.setThresholds({}),
          () => radar.sendCloudTrail({ Records: [] }),
        ];
        for (const call of every) await assert.rejects(call(), (err: unknown) => err instanceof OverwingError && err.status === 0 && /API key missing/.test(err.message));
      }
      assert.equal(calls.length, 0);
    } finally {
      if (saved) process.env.OVERWING_API_KEY = saved;
    }
  });

  it("reads OVERWING_API_KEY, and is reachable from the main client with its key", async () => {
    const saved = process.env.OVERWING_API_KEY;
    process.env.OVERWING_API_KEY = "ow_live_env";
    try {
      const { fetch, calls } = scriptedFetch([{ status: 200, body: { incidents: [] } }]);
      await new Radar({ fetch, baseUrl: BASE }).listIncidents();
      assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer ow_live_env");
      const ow = new Overwing({ apiKey: "ow_live_test", fetch, baseUrl: BASE });
      assert.ok(ow.radar instanceof Radar);
      await ow.radar.listIncidents({ status: "closed" });
      sent(calls[1], "GET", "/api/v1/swarm/incidents?status=closed");
    } finally {
      if (saved) process.env.OVERWING_API_KEY = saved;
      else delete process.env.OVERWING_API_KEY;
    }
  });
});

describe("verifyRadarWebhook", () => {
  const secret = "whsec_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const body = JSON.stringify({ type: "swarm.incident.opened", created_at: "2026-11-20T12:00:06.000Z", data: { id: INCIDENT_ID, severity: "critical", response: { requested: false } } });
  const t = 1795348806;
  const now = new Date(t * 1000 + 2_000);
  /** Signed the way the API signs: hex HMAC-SHA256 of "t.body". */
  const sign = (withSecret: string, at: number, payload: string): string => `t=${at},v1=${createHmac("sha256", withSecret).update(`${at}.${payload}`).digest("hex")}`;
  const header = sign(secret, t, body);

  it("accepts a valid signature, over a string or over bytes", async () => {
    assert.equal(await verifyRadarWebhook(secret, header, body, { now }), true);
    assert.equal(await verifyRadarWebhook(secret, header, new TextEncoder().encode(body), { now }), true);
    assert.equal(await verifyRadarWebhook(secret, header, Buffer.from(body), { now: now.getTime() }), true);
    assert.equal(await verifyRadarWebhook(secret, ` v1=${header.split("v1=")[1]} , t=${t} `, body, { now }), true);
    const fresh = Math.floor(Date.now() / 1000);
    assert.equal(await verifyRadarWebhook(secret, sign(secret, fresh, body), body), true);
  });

  it("refuses a wrong secret", async () => {
    assert.equal(await verifyRadarWebhook("whsec_wrong", header, body, { now }), false);
    assert.equal(await verifyRadarWebhook(secret, sign("whsec_wrong", t, body), body, { now }), false);
    assert.equal(await verifyRadarWebhook("", header, body, { now }), false);
  });

  it("refuses a changed body, and a timestamp that is not the signed one", async () => {
    assert.equal(await verifyRadarWebhook(secret, header, body.replace("critical", "low"), { now }), false);
    assert.equal(await verifyRadarWebhook(secret, header, `${body} `, { now }), false);
    assert.equal(await verifyRadarWebhook(secret, header.replace(`t=${t}`, `t=${t + 1}`), body, { now }), false);
  });

  it("refuses a stale timestamp, and one too far ahead", async () => {
    assert.equal(await verifyRadarWebhook(secret, header, body, { now: new Date((t + 300) * 1000) }), true);
    assert.equal(await verifyRadarWebhook(secret, header, body, { now: new Date((t + 301) * 1000) }), false);
    assert.equal(await verifyRadarWebhook(secret, header, body, { now: new Date((t - 301) * 1000) }), false);
    assert.equal(await verifyRadarWebhook(secret, header, body, { now: new Date((t + 31) * 1000), toleranceSeconds: 30 }), false);
    assert.equal(await verifyRadarWebhook(secret, header, body, { now: new Date((t + 3600) * 1000), toleranceSeconds: 7200 }), true);
    assert.equal(await verifyRadarWebhook(secret, sign(secret, 1, body), body), false);
  });

  it("refuses a malformed or missing header without throwing", async () => {
    const hex = header.split("v1=")[1]!;
    for (const bad of [null, undefined, "", "garbage", `t=${t}`, `v1=${hex}`, `t=,v1=${hex}`, `t=abc,v1=${hex}`, `t=${t},v1=`, `t=${t},v1=${hex.slice(0, 62)}`, `t=${t},v1=${hex.toUpperCase()}`, `t=${t},v1=${"z".repeat(64)}`, `t=${t},v0=${hex}`, `t=${t};v1=${hex}`]) {
      assert.equal(await verifyRadarWebhook(secret, bad, body, { now }), false, `header ${JSON.stringify(bad)}`);
    }
  });
});
