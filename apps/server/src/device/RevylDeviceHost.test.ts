import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { RevylDeviceHostConfig } from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Socket from "effect/socket/Socket";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { AGENT_DEVICE_VERSION } from "./DeviceToolchain.ts";
import * as RevylDeviceHost from "./RevylDeviceHost.ts";

const RUN_ID = "22f76fea-8249-4333-b131-9642526531fd";
const WHEP = "https://bridge.test/play/live-1";
const ANDROID_APP = "https://apps.test/ApiDemos-debug.apk";

const config = (overrides: Partial<RevylDeviceHostConfig> = {}): RevylDeviceHostConfig => ({
  kind: "revyl",
  id: "revyl",
  label: "Revyl",
  apiKey: "revyl-key",
  maxSessions: 2,
  maxSessionMinutes: 30,
  macs: false,
  macIdleMinutes: 15,
  androidAppUrl: ANDROID_APP,
  ...overrides,
});

const exited = (code: number, stdout: string) => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** Revyl's API and WHEP endpoint, and T3's agent-device CLI, recording what was asked of them. */
const fakeRevyl = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly contentType: string | undefined;
    readonly body: string;
  }> = [];
  const commands: Array<{ readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv }> =
    [];
  const actions = yield* Queue.unbounded<{ readonly action: string; readonly body: unknown }>();
  const macActions = yield* Queue.unbounded<unknown>();
  const computers = new Map<
    string,
    { computer_id: string; state: string; run_session_id: string; runs: number }
  >();
  let rotated = false;
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        url: url.origin + url.pathname,
        contentType: request.body._tag === "Uint8Array" ? request.body.contentType : undefined,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      });
      const json = (body: unknown, status = 200) =>
        HttpClientResponse.fromWeb(request, Response.json(body, { status }));
      if (url.origin === "https://bridge.test") {
        return request.method === "POST"
          ? HttpClientResponse.fromWeb(
              request,
              new Response("answer-sdp", {
                status: 201,
                headers: { "content-type": "application/sdp", location: "/play/live-1/view-9" },
              }),
            )
          : json({});
      }
      if (request.headers.authorization !== "Bearer revyl-key") return json({}, 401);
      const body = () =>
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : {};
      if (url.pathname === "/api/v1/computer-runs/persistent")
        return json({ computers: [...computers.values()], total: computers.size });
      if (url.pathname === "/api/v1/computer-runs" && request.method === "POST") {
        const id = body().computer_session_id as string;
        computers.set(id, { computer_id: id, state: "running", run_session_id: "run-1", runs: 1 });
        return json({ computer_session_id: id, state: "starting" });
      }
      const computer = /^\/api\/v1\/computer-runs\/([^/]+)(\/.*)?$/.exec(url.pathname);
      const known = computer ? computers.get(computer[1]!) : undefined;
      if (computer && known) {
        switch (computer[2]) {
          case undefined:
            return json({
              state: known.state === "running" ? "active" : "stopped",
              persistent: known,
            });
          case "/stop":
            known.state = "stopped";
            return json({ state: "stopped" });
          case "/start":
            known.state = "running";
            known.run_session_id = `run-${++known.runs}`;
            return json({ computer_id: known.computer_id, state: "starting" });
          case "/screen/actions":
            Queue.offerUnsafe(macActions, body());
            return json({ screenshot: null });
          case "/screen/screenshot":
            return json({ width: 1280, height: 800, png: btoa("mac-png") });
        }
      }
      if (/\/execution\/device-sessions\/run-\d+$/.test(url.pathname))
        return json({ status: "running", whep_url: WHEP, screen_width: 1280, screen_height: 800 });
      if (url.pathname.endsWith("/streaming/viewer-ice-servers"))
        return json({ ice_servers: [{ urls: "turn:turn.test" }], refresh_after_seconds: 600 });
      if (url.pathname.endsWith("/worker-connection/" + RUN_ID))
        return json({ status: "ready", whep_url: WHEP, ice_servers: [{ urls: "stun:stun.test" }] });
      if (url.pathname.endsWith("/health"))
        return json(
          rotated
            ? { screen_width: 2400, screen_height: 1080, device_connected: true }
            : { screen_width: 1080, screen_height: 2400, device_connected: true },
        );
      if (url.pathname.endsWith("/reset_video")) return json({ success: true });
      const action = /\/device-proxy\/[^/]+\/(tap|input|key|set_orientation)$/.exec(
        url.pathname,
      )?.[1];
      if (action) {
        if (action === "set_orientation") rotated = true;
        Queue.offerUnsafe(actions, {
          action,
          body: JSON.parse(new TextDecoder().decode((request.body as { body: Uint8Array }).body)),
        });
        return json({ success: true });
      }
      return json({}, 404);
    }),
  );
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        const args = input.args.slice(1);
        commands.push({ args, env: input.env ?? {} });
        if (args[0] !== "open") return exited(0, "{}");
        const stateDir = input.env?.AGENT_DEVICE_STATE_DIR ?? "";
        yield* fs.writeFileString(
          path.join(stateDir, "daemon.json"),
          JSON.stringify({ httpPort: 40113, token: "daemon-token", pid: 1 }),
        );
        return exited(
          0,
          JSON.stringify({ success: true, data: { device: "Revyl android " + RUN_ID } }),
        );
      }).pipe(Effect.orDie),
  });
  const ran = (command: string) => commands.filter(({ args }) => args[0] === command);
  return { http, runner, requests, ran, actions, macActions, computers };
});

const makeSecretResolver = () =>
  Layer.succeed(SecretResolver.SecretResolver, {
    read: (references) => Effect.succeed(references.map(() => undefined)),
    invalidate: () => Effect.void,
    label: (provider) => Effect.succeed(provider),
  });

const layer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-revyl-host-" }),
  makeSecretResolver(),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeHost = (
  revyl: Effect.Success<typeof fakeRevyl>,
  hostConfig: RevylDeviceHostConfig,
  scope: Scope.Scope,
  environment: NodeJS.ProcessEnv = {},
) =>
  RevylDeviceHost.make(
    hostConfig,
    Effect.succeed({ nodePath: "node", entryPath: "/tools/agent-device.mjs" }),
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, revyl.http),
    Effect.provideService(ProcessRunner.ProcessRunner, revyl.runner),
    Effect.provideService(HostProcess.Environment, environment),
    Effect.provideService(Scope.Scope, scope),
  );

const openAndroid = (
  revyl: Effect.Success<typeof fakeRevyl>,
  hostConfig = config(),
  environment: NodeJS.ProcessEnv = {},
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const host = yield* makeHost(revyl, hostConfig, scope, environment);
    const ready = yield* host.ensureReady(() => Effect.void);
    const [android] = (yield* ready.devices.list).devices;
    const deviceId = yield* ready.devices.boot(android!);
    return { scope, ready, deviceId };
  });

const post = (url: string, body: unknown) =>
  HttpServerRequest.fromWeb(
    new Request("http://t3.test" + url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const get = (url: string) => HttpServerRequest.fromWeb(new Request("http://t3.test" + url));
const webResponse = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.toWeb(response);

describe("Revyl device host", () => {
  it.effect("starts a Revyl session for agents, then ends it and its daemon on close", () =>
    Effect.gen(function* () {
      const revyl = yield* fakeRevyl;
      const { scope, ready, deviceId } = yield* openAndroid(revyl);

      expect(deviceId).toBe(RUN_ID);
      expect(revyl.ran("plugins")[0]?.args).toContain(
        "@agent-device/revyl@" + AGENT_DEVICE_VERSION,
      );
      const [connect] = revyl.ran("connect");
      expect(connect?.args.slice(0, 6)).toEqual([
        "connect",
        "revyl",
        "--platform",
        "android",
        "--provider-app",
        ANDROID_APP,
      ]);
      expect(connect?.env).toMatchObject({
        REVYL_API_KEY: "revyl-key",
        AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
        AGENT_DEVICE_LEASE_TTL_MS: String(30 * 60_000),
      });
      const binding = yield* ready.devices.agentEndpoint!(deviceId);
      expect(binding).toMatchObject({
        baseUrl: "http://127.0.0.1:40113",
        token: "daemon-token",
        agentDeviceId: null,
        session: connect?.args[connect.args.indexOf("--session") + 1],
        stateDir: connect?.env.AGENT_DEVICE_STATE_DIR,
      });
      expect(
        (yield* ready.devices.list).devices.map((device) => [device.id, device.booted]),
      ).toEqual([
        ["revyl:android", false],
        [RUN_ID, true],
      ]);

      yield* ready.devices.shutdown({ id: deviceId, platform: "android" });
      expect(revyl.ran("close")).toHaveLength(1);
      expect(revyl.ran("disconnect")).toHaveLength(1);
      expect(revyl.ran("daemon")[0]?.args.slice(0, 2)).toEqual(["daemon", "stop"]);
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual([
        "revyl:android",
      ]);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("uses REVYL_API_KEY when no key is saved, and says what is missing without one", () =>
    Effect.gen(function* () {
      const revyl = yield* fakeRevyl;
      const scope = yield* Scope.make();
      const withMachineKey = yield* makeHost(revyl, config({ apiKey: "" }), scope, {
        REVYL_API_KEY: "revyl-key",
      });
      expect(yield* withMachineKey.platformAvailability("android")).toEqual({
        platform: "android",
        available: true,
      });
      expect(yield* withMachineKey.platformAvailability("ios")).toMatchObject({
        available: false,
        reason: "Set an iOS app URL for Revyl.",
      });
      const withoutKey = yield* makeHost(revyl, config({ apiKey: "" }), scope);
      expect(yield* withoutKey.platformAvailability("android")).toMatchObject({
        available: false,
        reason: "Add a Revyl API key for Revyl in Settings, or set REVYL_API_KEY.",
      });
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("talks to REVYL_API_URL, and refuses one that is not an https origin", () =>
    Effect.gen(function* () {
      const revyl = yield* fakeRevyl;
      const { scope } = yield* openAndroid(revyl, config(), {
        REVYL_API_URL: "https://staging.revyl.test/",
      });
      expect(revyl.ran("connect")[0]?.env.REVYL_API_URL).toBe("https://staging.revyl.test");
      expect(
        revyl.requests.filter((request) => request.url.includes("/api/v1/")).map(({ url }) => url),
      ).toEqual([
        "https://staging.revyl.test/api/v1/execution/streaming/worker-connection/" + RUN_ID,
        `https://staging.revyl.test/api/v1/execution/device-proxy/${RUN_ID}/health`,
      ]);
      const plain = yield* makeHost(revyl, config(), scope, {
        REVYL_API_URL: "http://staging.revyl.test/api",
      });
      expect(yield* plain.platformAvailability("android")).toMatchObject({
        available: false,
        reason: "REVYL_API_URL must be an https origin, such as https://backend.revyl.ai.",
      });
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops the daemons of sessions a previous server left open when it starts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const hostDir = path.join(stateDir, "device", "revyl", "revyl");
      yield* fs.makeDirectory(path.join(hostDir, "a1b2c3"), { recursive: true });
      yield* fs.makeDirectory(path.join(hostDir, "home"), { recursive: true });
      const revyl = yield* fakeRevyl;
      const scope = yield* Scope.make();
      const host = yield* makeHost(revyl, config(), scope);
      yield* host.ensureReady(() => Effect.void);

      expect(revyl.ran("daemon").map(({ args }) => args)).toEqual([
        ["daemon", "stop", "--state-dir", path.join(hostDir, "a1b2c3"), "--json"],
      ]);
      expect(revyl.ran("close")).toHaveLength(0);
      expect(yield* fs.readDirectory(hostDir)).toEqual(["home"]);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("caps sessions at the limit", () =>
    Effect.gen(function* () {
      const revyl = yield* fakeRevyl;
      const { scope, ready } = yield* openAndroid(revyl, config({ maxSessions: 1 }));
      const [android] = (yield* ready.devices.list).devices;
      const refused = yield* ready.devices.boot(android!).pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "DeviceBootError",
        diagnostics: "Revyl is limited to 1 device at once. Close one in the Device panel first.",
      });
      expect(revyl.ran("connect")).toHaveLength(1);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("ends a session at its maximum age", () =>
    Effect.gen(function* () {
      const revyl = yield* fakeRevyl;
      yield* openAndroid(revyl, config({ maxSessionMinutes: 5 }));
      yield* TestClock.adjust("299 seconds");
      expect(revyl.ran("close")).toHaveLength(0);
      yield* TestClock.adjust("1 second");
      expect(revyl.ran("close")).toHaveLength(1);
      expect(revyl.ran("daemon")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("serves the panel serve-sim's WebRTC signalling from Revyl's WHEP stream", () =>
    Effect.gen(function* () {
      const revyl = yield* fakeRevyl;
      const { scope, ready } = yield* openAndroid(revyl);
      const serve = ready.serve!;
      const helper = "/vendor/serve-sim/helper/" + RUN_ID;

      const api = webResponse(
        yield* serve(get("/x"), "/vendor/serve-sim/api", new URLSearchParams({ device: RUN_ID })),
      );
      expect(yield* Effect.promise(() => api.json())).toEqual({
        streamSettings: { transport: "webrtc", iceServers: [{ urls: "stun:stun.test" }] },
      });
      const avcc = webResponse(
        yield* serve(get("/x"), helper + "/stream.avcc", new URLSearchParams()),
      );
      expect(avcc.status).toBe(409);
      expect(yield* Effect.promise(() => avcc.json())).toEqual({
        error: "stream_transport_locked",
        transport: "webrtc",
      });

      const answer = webResponse(
        yield* serve(
          post("/x", { type: "offer", sdp: "offer-sdp", sessionId: "view-a", codec: "h264" }),
          helper + "/webrtc/offer",
          new URLSearchParams(),
        ),
      );
      expect(yield* Effect.promise(() => answer.json())).toEqual({
        type: "answer",
        sdp: "answer-sdp",
      });
      expect(revyl.requests.find((request) => request.url === WHEP)).toMatchObject({
        method: "POST",
        contentType: "application/sdp",
        body: "offer-sdp",
      });

      // A static Android screen sends a late viewer nothing until Revyl is asked for a frame.
      const refreshes = () =>
        revyl.requests.filter((request) => request.url.endsWith("/reset_video")).length;
      expect(refreshes()).toBe(0);
      yield* TestClock.adjust("1 second");
      expect(refreshes()).toBe(1);

      yield* serve(
        post("/x", { sessionId: "view-a" }),
        helper + "/webrtc/close",
        new URLSearchParams(),
      );
      expect(revyl.requests.at(-1)).toMatchObject({
        method: "DELETE",
        url: "https://bridge.test/play/live-1/view-9",
      });
      const unknown = webResponse(
        yield* serve(
          get("/x"),
          "/vendor/serve-sim/helper/other/stream.avcc",
          new URLSearchParams(),
        ),
      );
      expect(unknown.status).toBe(404);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("Revyl panel input", () => {
  const frame = (tag: number, payload: unknown) =>
    new Uint8Array([tag, ...new TextEncoder().encode(JSON.stringify(payload))]);
  const key = (usage: number) => [
    frame(0x06, { type: "down", usage }),
    frame(0x06, { type: "up", usage }),
  ];
  const shifted = (usage: number) => [
    frame(0x06, { type: "down", usage: 0xe1 }),
    ...key(usage),
    frame(0x06, { type: "up", usage: 0xe1 }),
  ];

  it.effect("types keys into the field last tapped, then rotates the panel's screen", () =>
    Effect.gen(function* () {
      const revyl = yield* fakeRevyl;
      const { scope, ready, deviceId } = yield* openAndroid(revyl);
      const incoming = yield* Queue.unbounded<Uint8Array>();
      const outgoing = yield* Queue.unbounded<unknown>();
      const socket = Socket.make({
        reader: Effect.succeed({ pull: Queue.takeAll(incoming), upgrade: () => Effect.void }),
        writer: Effect.succeed({
          write: (chunk) =>
            Queue.offer(
              outgoing,
              JSON.parse(new TextDecoder().decode((chunk as Uint8Array).subarray(1)) || "null"),
            ),
          writeAll: () => Effect.void,
        }),
      });
      const upgraded: HttpServerRequest.HttpServerRequest = Object.create(get("/x"), {
        upgrade: { value: Effect.succeed(socket) },
      });
      yield* ready.serve!(
        upgraded,
        "/vendor/serve-sim/helper/ws",
        new URLSearchParams({ device: deviceId }),
      ).pipe(Effect.forkChild);
      expect(yield* Queue.take(outgoing)).toBeNull();
      expect(yield* Queue.take(outgoing)).toEqual({
        width: 1080,
        height: 2400,
        orientation: "portrait",
      });

      yield* Queue.offerAll(incoming, [
        frame(0x03, { type: "begin", x: 0.5, y: 0.25 }),
        frame(0x03, { type: "end", x: 0.5, y: 0.25 }),
        ...shifted(0x0b),
        ...key(0x0c),
        frame(0x06, { type: "down", usage: 0xe3 }),
        ...key(0x19),
        frame(0x06, { type: "up", usage: 0xe3 }),
        ...shifted(0x1e),
        ...key(0x28),
        frame(0x07, { orientation: "landscape_left" }),
      ]);
      expect(yield* Queue.take(revyl.actions)).toEqual({ action: "tap", body: { x: 540, y: 600 } });
      let typed = "";
      let next = yield* Queue.take(revyl.actions);
      while (next.action === "input") {
        expect(next.body).toMatchObject({ x: 540, y: 600, clear_first: false });
        typed += (next.body as { text: string }).text;
        next = yield* Queue.take(revyl.actions);
      }
      expect(typed).toBe("Hi!");
      expect(next).toEqual({ action: "key", body: { key: "ENTER" } });
      expect(yield* Queue.take(revyl.actions)).toEqual({
        action: "set_orientation",
        body: { orientation: "landscape" },
      });
      expect(yield* Queue.take(outgoing)).toEqual({
        width: 2400,
        height: 1080,
        orientation: "landscape_right",
      });
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.each([
    ["portrait_upside_down", false, "portrait", "portrait"],
    ["landscape_left", false, "landscape_right", "landscape"],
    ["portrait_upside_down", true, "portrait_upside_down", "upside_down"],
    ["landscape_right", true, "landscape_right", "landscape_right"],
  ] as const)(
    "rotates a request for %s to what Revyl supports (precise: %s)",
    (requested, precise, shown, sent) => {
      expect(RevylDeviceHost.revylOrientation(requested, precise)).toEqual({
        orientation: shown,
        body: { orientation: sent },
      });
    },
  );
});

describe("Revyl panel touches", () => {
  const screen = { width: 1080, height: 2400 };

  it("taps where a short touch began, in the device's screen units", () => {
    expect(
      RevylDeviceHost.touchAction({ x: 0.5, y: 0.25 }, { x: 0.501, y: 0.25 }, 80, screen),
    ).toEqual({
      action: "tap",
      body: { x: 540, y: 600 },
    });
  });

  it("long-presses a touch held in place", () => {
    expect(
      RevylDeviceHost.touchAction({ x: 0.1, y: 0.1 }, { x: 0.1, y: 0.1 }, 900, screen),
    ).toEqual({
      action: "longpress",
      body: { x: 108, y: 240, duration_ms: 900 },
    });
  });

  it("drags a touch that moved, clamped to the screen", () => {
    expect(
      RevylDeviceHost.touchAction({ x: 0.5, y: 0.8 }, { x: 0.5, y: 1.2 }, 300, screen),
    ).toEqual({
      action: "drag",
      body: { start_x: 540, start_y: 1920, end_x: 540, end_y: 2400 },
    });
  });
});

describe("Revyl Macs", () => {
  const frame = (tag: number, payload: unknown) =>
    new Uint8Array([tag, ...new TextEncoder().encode(JSON.stringify(payload))]);
  const key = (usage: number) => [
    frame(0x06, { type: "down", usage }),
    frame(0x06, { type: "up", usage }),
  ];
  const held = (modifier: number, usage: number) => [
    frame(0x06, { type: "down", usage: modifier }),
    ...key(usage),
    frame(0x06, { type: "up", usage: modifier }),
  ];

  const openMac = (revyl: Effect.Success<typeof fakeRevyl>, hostConfig = config({ macs: true })) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const host = yield* makeHost(revyl, hostConfig, scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const catalog = (yield* ready.devices.list).devices.find(
        (device) => device.id === "revyl:macos",
      );
      const deviceId = yield* ready.devices.boot(catalog!);
      return { scope, ready, deviceId };
    });

  it.effect(
    "creates a Mac from the snapshot, streams it, and stops it with its disk on close",
    () =>
      Effect.gen(function* () {
        const revyl = yield* fakeRevyl;
        const { scope, ready, deviceId } = yield* openMac(
          revyl,
          config({ macs: true, macSnapshot: "t3-base" }),
        );

        const create = revyl.requests.find(
          (request) => request.method === "POST" && request.url.endsWith("/api/v1/computer-runs"),
        );
        expect(JSON.parse(create!.body)).toEqual({
          computer_session_id: deviceId,
          os: "macos",
          persistent: true,
          from_snapshot: "t3-base",
        });
        const listed = (yield* ready.devices.list).devices.filter(
          (device) => device.platform === "macos",
        );
        expect(listed.map(({ id, booted }) => ({ id, booted }))).toEqual([
          { id: "revyl:macos", booted: false },
          { id: deviceId, booted: true },
        ]);

        const settings = yield* ready.serve!(
          get("/x"),
          "/vendor/serve-sim/api",
          new URLSearchParams({ device: deviceId }),
        );
        expect(yield* Effect.promise(() => webResponse(settings).json())).toEqual({
          streamSettings: { transport: "webrtc", iceServers: [{ urls: "turn:turn.test" }] },
        });
        const answer = yield* ready.serve!(
          post("/x", { type: "offer", sdp: "offer-sdp", sessionId: "view-a", codec: "h264" }),
          `/vendor/serve-sim/helper/${deviceId}/webrtc/offer`,
          new URLSearchParams(),
        );
        expect(yield* Effect.promise(() => webResponse(answer).json())).toEqual({
          type: "answer",
          sdp: "answer-sdp",
        });
        expect(new TextDecoder().decode(yield* ready.devices.screenshot(listed[1]!))).toBe(
          "mac-png",
        );

        yield* ready.devices.shutdown({ id: deviceId, platform: "macos" });
        expect(revyl.computers.get(deviceId)?.state).toBe("stopped");
        expect(
          (yield* ready.devices.list).devices.find((device) => device.id === deviceId)?.booted,
        ).toBe(false);
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("starts a stopped Mac again on the stream of its new run", () =>
    Effect.gen(function* () {
      const revyl = yield* fakeRevyl;
      revyl.computers.set("mac-1", {
        computer_id: "mac-1",
        state: "stopped",
        run_session_id: "run-1",
        runs: 1,
      });
      const scope = yield* Scope.make();
      const host = yield* makeHost(revyl, config({ macs: true }), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const stopped = (yield* ready.devices.list).devices.find((device) => device.id === "mac-1");
      expect(stopped).toMatchObject({ platform: "macos", booted: false });

      expect(yield* ready.devices.boot(stopped!)).toBe("mac-1");
      expect(revyl.computers.get("mac-1")).toMatchObject({
        state: "running",
        run_session_id: "run-2",
      });
      expect(revyl.requests.map(({ url }) => url)).toContain(
        "https://backend.revyl.ai/api/v1/execution/device-sessions/run-2",
      );
      yield* Scope.close(scope, Exit.void);
      expect(revyl.computers.get("mac-1")?.state).toBe("stopped");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops a Mac nobody has opened or typed into for its idle time", () =>
    Effect.gen(function* () {
      const revyl = yield* fakeRevyl;
      const { scope, deviceId } = yield* openMac(revyl, config({ macs: true, macIdleMinutes: 5 }));
      yield* TestClock.adjust("4 minutes");
      expect(revyl.computers.get(deviceId)?.state).toBe("running");
      yield* TestClock.adjust("1 minute");
      expect(revyl.computers.get(deviceId)?.state).toBe("stopped");
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("turns panel clicks, drags, typing, and shortcuts into Mac screen actions", () =>
    Effect.gen(function* () {
      const revyl = yield* fakeRevyl;
      const { scope, ready, deviceId } = yield* openMac(revyl);
      const incoming = yield* Queue.unbounded<Uint8Array>();
      const outgoing = yield* Queue.unbounded<unknown>();
      const socket = Socket.make({
        reader: Effect.succeed({ pull: Queue.takeAll(incoming), upgrade: () => Effect.void }),
        writer: Effect.succeed({
          write: (chunk) =>
            Queue.offer(
              outgoing,
              JSON.parse(new TextDecoder().decode((chunk as Uint8Array).subarray(1)) || "null"),
            ),
          writeAll: () => Effect.void,
        }),
      });
      const upgraded: HttpServerRequest.HttpServerRequest = Object.create(get("/x"), {
        upgrade: { value: Effect.succeed(socket) },
      });
      yield* ready.serve!(
        upgraded,
        "/vendor/serve-sim/helper/ws",
        new URLSearchParams({ device: deviceId }),
      ).pipe(Effect.forkChild);
      expect(yield* Queue.take(outgoing)).toBeNull();
      expect(yield* Queue.take(outgoing)).toEqual({
        width: 1280,
        height: 800,
        orientation: "landscape_left",
      });

      yield* Queue.offerAll(incoming, [
        frame(0x03, { type: "begin", x: 0.5, y: 0.25 }),
        frame(0x03, { type: "end", x: 0.5, y: 0.25 }),
        frame(0x03, { type: "begin", x: 0.1, y: 0.1 }),
        frame(0x03, { type: "end", x: 0.6, y: 0.1 }),
        ...held(0xe1, 0x0b),
        ...key(0x0c),
        ...held(0xe3, 0x06),
        ...key(0x28),
      ]);
      const sent = [];
      for (let index = 0; index < 4; index++) sent.push(yield* Queue.take(revyl.macActions));
      const typed = [];
      let next = yield* Queue.take(revyl.macActions);
      while ((next as { action: { action: string } }).action.action === "type") {
        typed.push(next);
        next = yield* Queue.take(revyl.macActions);
      }
      expect(sent.slice(0, 2)).toEqual([
        { action: { action: "click", x: 640, y: 200 }, screenshot: false },
        {
          action: { action: "drag", start_x: 128, start_y: 80, end_x: 768, end_y: 80 },
          screenshot: false,
        },
      ]);
      expect(
        [...sent.slice(2), ...typed, next].map(
          (request) => (request as { action: { text?: string; keys?: string } }).action,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ keys: "cmd+c" }),
          expect.objectContaining({ keys: "enter" }),
        ]),
      );
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("Revyl Mac keys", () => {
  it.each([
    [0x0b, [], { action: "type", text: "h" }],
    [0x0b, [0xe1], { action: "type", text: "H" }],
    [0x06, [0xe3], { action: "key", keys: "cmd+c" }],
    [0x2e, [0xe3, 0xe1], { action: "key", keys: "cmd+shift+=" }],
    [0x2c, [0xe0], { action: "key", keys: "ctrl+space" }],
    [0x2b, [0xe1], { action: "key", keys: "shift+tab" }],
    [0x50, [], { action: "key", keys: "left" }],
    [0x3b, [], { action: "key", keys: "f2" }],
    [0x64, [], null],
  ] as const)("maps HID usage %s with modifiers %j", (usage, modifiers, expected) => {
    expect(RevylDeviceHost.macKeyAction(usage, new Set(modifiers))).toEqual(expected);
  });

  it("clicks on a short touch, right clicks on a long one, and drags a moved one", () => {
    const screen = { width: 1280, height: 800 };
    expect(
      RevylDeviceHost.macTouchAction({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 100, screen),
    ).toEqual({
      action: "click",
      x: 640,
      y: 400,
    });
    expect(
      RevylDeviceHost.macTouchAction({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 900, screen),
    ).toEqual({
      action: "click",
      x: 640,
      y: 400,
      button: "right",
    });
    expect(RevylDeviceHost.macTouchAction({ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, 100, screen)).toEqual(
      {
        action: "drag",
        start_x: 0,
        start_y: 0,
        end_x: 640,
        end_y: 400,
      },
    );
  });
});
