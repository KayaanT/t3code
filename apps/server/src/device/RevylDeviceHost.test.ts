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
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

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
      if (url.pathname.endsWith("/worker-connection/" + RUN_ID))
        return json({ status: "ready", whep_url: WHEP, ice_servers: [{ urls: "stun:stun.test" }] });
      if (url.pathname.endsWith("/health"))
        return json({ screen_width: 1080, screen_height: 2400, device_connected: true });
      if (url.pathname.endsWith("/reset_video")) return json({ success: true });
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
  return { http, runner, requests, ran };
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
