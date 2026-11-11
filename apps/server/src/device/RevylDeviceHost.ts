/**
 * Alpha: Revyl cloud devices, opened through agent-device's Revyl plugin on a daemon per session so
 * agents drive the same session. The panel's serve-sim requests are answered from Revyl's WHEP
 * stream and device proxy. A crashed server's session ends when its daemon's lease expires, or when
 * the host next starts and stops the daemons it left behind.
 */
import {
  DeviceBootError,
  type DeviceHostSummary,
  DeviceHostUnavailableError,
  DeviceOperationError,
  type DevicePlatform,
  type DevicePlatformAvailability,
  type RevylDeviceHostConfig,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { truncate } from "@t3tools/shared/String";

import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { AGENT_DEVICE_VERSION } from "./DeviceToolchain.ts";
import type { AgentDeviceCli } from "./SimlockDeviceHost.ts";

const REVYL_API = "https://backend.revyl.ai";
const PLUGIN = "@agent-device/revyl";
const REQUEST_TIMEOUT = Duration.seconds(15);
// The plugin waits up to four minutes for Revyl to report the device connected.
const OPEN_TIMEOUT = Duration.minutes(5);
const COMMAND_TIMEOUT = Duration.minutes(2);
const LONG_PRESS_MS = 500;
// A late WHEP viewer of a static Android screen receives no frame until the publisher sends one.
const ANDROID_FRAME_REFRESH_DELAYS = [Duration.seconds(1), Duration.seconds(4)];

const API_PATH = "/vendor/serve-sim/api";
const SCREENSHOT_PATH = "/vendor/serve-sim/api/screenshot";
const INPUT_PATH = "/vendor/serve-sim/helper/ws";
const STREAM_PATH = /^\/vendor\/serve-sim\/helper\/([^/]+)\/stream\.(avcc|mjpeg)$/;
const WEBRTC_PATH = /^\/vendor\/serve-sim\/helper\/([^/]+)\/webrtc\/(offer|close)$/;

const IOS_MSG_TOUCH = 0x03;
const IOS_MSG_BUTTON = 0x04;
const IOS_TAG_SCREEN_CONFIG = 0x82;
const IOS_TAG_INPUT_ADMITTED = 0x83;

const IceServer = Schema.Struct({
  urls: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  username: Schema.optionalKey(Schema.String),
  credential: Schema.optionalKey(Schema.String),
});
const decodeWorkerConnection = Schema.decodeUnknownEffect(
  Schema.Struct({
    status: Schema.String,
    whep_url: Schema.NullOr(Schema.String),
    ice_servers: Schema.optional(Schema.NullOr(Schema.Array(IceServer))),
  }),
);
const decodeHealth = Schema.decodeUnknownEffect(
  Schema.Struct({ screen_width: Schema.Number, screen_height: Schema.Number }),
);
const decodeDaemonInfo = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ httpPort: Schema.Int, token: Schema.String })),
);
const decodeOpened = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Struct({ device: Schema.String }) })),
);
const decodeCliFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({ message: Schema.String, hint: Schema.optional(Schema.String) }),
    }),
  ),
);
const decodeOffer = Schema.decodeUnknownEffect(
  Schema.Struct({ sdp: Schema.String, sessionId: Schema.String }),
);
const decodeClose = Schema.decodeUnknownEffect(Schema.Struct({ sessionId: Schema.String }));
const decodeTouch = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literals(["begin", "move", "end"]),
      x: Schema.Finite,
      y: Schema.Finite,
    }),
  ),
);
const decodeButton = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ button: Schema.String })),
);

interface Screen {
  readonly width: number;
  readonly height: number;
}

interface Lease {
  /** Revyl's workflow run id, which is also the device id T3 lists. */
  readonly runId: string;
  readonly platform: DevicePlatform;
  readonly session: string;
  /** agent-device state of the lease's own daemon. */
  readonly dir: string;
  readonly installDirectory: string;
  readonly daemon: DeviceHost.AgentDaemonEndpoint;
  /** The key the session was started with; ending it must not depend on reading the secret again. */
  readonly apiKey: string;
  readonly screen: Screen;
  readonly whepUrl: string;
  readonly iceServers: ReadonlyArray<typeof IceServer.Type>;
  /** Open WebRTC views, by the client's session id, to their WHEP resource. */
  readonly views: Map<string, string>;
}

interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

/** The device-proxy action one panel touch becomes, in the device's own screen units. */
export const touchAction = (start: TouchPoint, end: TouchPoint, heldMs: number, screen: Screen) => {
  const at = (point: TouchPoint) => ({
    x: Math.round(Math.min(Math.max(point.x, 0), 1) * screen.width),
    y: Math.round(Math.min(Math.max(point.y, 0), 1) * screen.height),
  });
  const from = at(start);
  const to = at(end);
  if (Math.hypot(to.x - from.x, to.y - from.y) > Math.max(screen.width, screen.height) * 0.02) {
    return {
      action: "drag",
      body: { start_x: from.x, start_y: from.y, end_x: to.x, end_y: to.y },
    } as const;
  }
  return heldMs >= LONG_PRESS_MS
    ? ({ action: "longpress", body: { ...from, duration_ms: Math.round(heldMs) } } as const)
    : ({ action: "tap", body: from } as const);
};

const BUTTON_ACTIONS: Readonly<Record<string, string>> = { home: "go_home", back: "back" };

const tagged = (tag: number, payload?: unknown) => {
  const json =
    payload === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
};

const catalogId = (platform: DevicePlatform) => `revyl:${platform}`;
const platformName = (platform: DevicePlatform) => (platform === "ios" ? "iOS" : "Android");
const deviceKind = (platform: DevicePlatform) =>
  platform === "ios" ? "iOS simulator" : "Android emulator";
const RUN_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const make = Effect.fn("RevylDeviceHost.make")(function* (
  config: RevylDeviceHostConfig,
  agentDeviceCli: AgentDeviceCli,
) {
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const server = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcess.Environment;
  const secrets = yield* SecretResolver.SecretResolver;
  const hostScope = yield* Scope.Scope;
  const hostId = config.id;
  const hostDir = path.join(server.stateDir, "device", "revyl", hostId);
  const agentHome = path.join(hostDir, "home");
  const leases = new Map<string, Lease>();
  let starting = 0;
  // Bumped by every stop, so an open that finishes after one ends its session instead of keeping it.
  let stops = 0;
  const slotLock = yield* Semaphore.make(1);
  const maxAge = yield* FiberMap.make<string>();
  let ready: DeviceHost.DeviceHostReady | null = null;
  let cli: { readonly nodePath: string; readonly entryPath: string } | null = null;
  const configuredApi = environment.REVYL_API_URL?.trim() || REVYL_API;
  const parsedApi = URL.canParse(configuredApi) ? new URL(configuredApi) : null;
  const apiOrigin =
    parsedApi?.protocol === "https:" && parsedApi.href === `${parsedApi.origin}/`
      ? parsedApi.origin
      : null;
  const appUrls: Readonly<Record<DevicePlatform, string | undefined>> = {
    ios: config.iosAppUrl,
    android: config.androidAppUrl,
  };

  const unavailable = (reason: string, cause?: unknown) =>
    new DeviceHostUnavailableError({
      hostId,
      hostLabel: config.label,
      reason,
      ...(cause === undefined ? {} : { cause }),
    });

  // Read on each use, so a rotated or unlocked secret applies without rebuilding the host.
  const currentApiKey = Effect.gen(function* () {
    if (apiOrigin === null)
      return yield* unavailable(`REVYL_API_URL must be an https origin, such as ${REVYL_API}.`);
    if (config.apiKey !== "")
      return yield* requireSettingsSecret(secrets, config.apiKey).pipe(
        Effect.mapError((error) => unavailable(error.message, error)),
      );
    const machine = environment.REVYL_API_KEY?.trim();
    if (machine) return machine;
    return yield* unavailable(
      `Add a Revyl API key for ${config.label} in Settings, or set REVYL_API_KEY.`,
    );
  });

  const revyl = (apiKey: string, request: HttpClientRequest.HttpClientRequest) =>
    http
      .execute(request.pipe(HttpClientRequest.bearerToken(apiKey)))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.timeout(REQUEST_TIMEOUT));

  const revylJson = (apiKey: string, method: "GET" | "POST", route: string, body?: unknown) =>
    revyl(
      apiKey,
      method === "GET"
        ? HttpClientRequest.get(`${apiOrigin}${route}`)
        : HttpClientRequest.post(`${apiOrigin}${route}`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body ?? {}),
          ),
    ).pipe(
      Effect.flatMap((response) => response.json),
      Effect.scoped,
    );

  const proxyRoute = (lease: Pick<Lease, "runId">, action: string) =>
    `/api/v1/execution/device-proxy/${encodeURIComponent(lease.runId)}/${action}`;

  const deviceAction = (lease: Lease, action: string, body?: unknown) =>
    revylJson(lease.apiKey, "POST", proxyRoute(lease, action), body);

  const screenshotOf = (lease: Lease) =>
    revyl(
      lease.apiKey,
      HttpClientRequest.get(`${apiOrigin}${proxyRoute(lease, "screenshot")}`),
    ).pipe(
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.scoped,
    );

  const agentEnvironment = (apiKey: string, stateDir: string): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) =>
          !/^AGENT_DEVICE_(DAEMON_BASE_URL|DAEMON_AUTH_TOKEN|CONFIG|STATE_DIR|SESSION)$/.test(name),
      ),
    ),
    ELECTRON_RUN_AS_NODE: "1",
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    AGENT_DEVICE_HOME: agentHome,
    AGENT_DEVICE_STATE_DIR: stateDir,
    // Agents reach the daemon over HTTP with the token it writes to daemon.json.
    AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
    // The lease, not the daemon, bounds the session: a daemon that idled out would end it early.
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
    AGENT_DEVICE_LEASE_TTL_MS: String(config.maxSessionMinutes * 60_000),
    AGENT_DEVICE_LEASE_MAX_TTL_MS: String(config.maxSessionMinutes * 60_000),
    REVYL_API_KEY: apiKey,
    REVYL_API_URL: apiOrigin ?? REVYL_API,
  });

  /** Runs T3's own agent-device CLI on a lease's daemon; its failure message is the reason. */
  const agentDevice = Effect.fn("RevylDeviceHost.agentDevice")(function* (
    lease: Pick<Lease, "session" | "dir" | "apiKey">,
    args: ReadonlyArray<string>,
    options: { readonly cwd?: string; readonly timeout?: Duration.Input } = {},
  ) {
    if (!cli) return yield* unavailable(`${config.label} is not ready.`);
    const result = yield* runner
      .run({
        command: cli.nodePath,
        args: [cli.entryPath, ...args, "--session", lease.session, "--json"],
        env: agentEnvironment(lease.apiKey, lease.dir),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        timeout: options.timeout ?? COMMAND_TIMEOUT,
      })
      .pipe(Effect.mapError((cause) => unavailable("agent-device could not run.", cause)));
    if (result.code !== 0) {
      return yield* unavailable(
        Option.match(decodeCliFailure(result.stdout), {
          onNone: () => `agent-device ${args[0]} failed (exit code ${result.code ?? "none"}).`,
          onSome: ({ error }) => [error.message, error.hint].filter(Boolean).join(" "),
        }),
      );
    }
    return result.stdout;
  });

  /**
   * Ends the Revyl session through its agent-device session, then stops the lease's daemon, whose
   * shutdown ends any Revyl session it still holds.
   */
  const release = Effect.fn("RevylDeviceHost.release")(function* (
    lease: Pick<Lease, "session" | "dir" | "apiKey">,
  ) {
    yield* agentDevice(lease, ["close"]).pipe(Effect.ignore);
    yield* agentDevice(lease, ["disconnect"]).pipe(Effect.ignore);
    yield* stopDaemon(lease);
  });

  /** `daemon stop` never starts a daemon, so it is safe on a state directory with none running. */
  const stopDaemon = Effect.fn("RevylDeviceHost.stopDaemon")(function* (
    lease: Pick<Lease, "session" | "dir" | "apiKey">,
  ) {
    if (!cli) return;
    yield* runner
      .run({
        command: cli.nodePath,
        args: [cli.entryPath, "daemon", "stop", "--state-dir", lease.dir, "--json"],
        env: agentEnvironment(lease.apiKey, lease.dir),
        timeout: COMMAND_TIMEOUT,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Could not stop the daemon of a Revyl session", {
            session: lease.session,
            cause,
          }),
        ),
        Effect.ignore,
      );
    yield* fs.remove(lease.dir, { recursive: true, force: true }).pipe(Effect.ignore);
  });

  const releaseLease = (lease: Lease) =>
    Effect.suspend(() => {
      leases.delete(lease.runId);
      return release(lease);
    });

  const reserveSlot = slotLock.withPermit(
    Effect.suspend(() => {
      if (leases.size + starting >= config.maxSessions) {
        return Effect.fail(
          unavailable(
            `${config.label} is limited to ${config.maxSessions} ${config.maxSessions === 1 ? "device" : "devices"} at once. Close one in the Device panel first.`,
          ),
        );
      }
      starting++;
      return Effect.void;
    }),
  );

  const openLease = Effect.fn("RevylDeviceHost.openLease")(function* (
    device: DeviceHost.HostDevice,
    context: DeviceHost.DeviceOpenContext | undefined,
  ) {
    const platform = (["ios", "android"] as const).find((each) => catalogId(each) === device.id);
    if (!platform) return yield* unavailable("This Revyl session has ended. Open a device again.");
    const appUrl = appUrls[platform];
    if (!appUrl)
      return yield* unavailable(
        `Set an ${platformName(platform)} app URL for ${config.label}; Revyl installs it on every new device.`,
      );
    const apiKey = yield* currentApiKey;
    const suffix = (yield* Random.nextIntBetween(0, 0xffffff)).toString(16).padStart(6, "0");
    const pending = { session: `t3-${suffix}`, dir: path.join(hostDir, suffix), apiKey };
    yield* fs
      .makeDirectory(pending.dir, { recursive: true })
      .pipe(
        Effect.mapError((cause) => unavailable("Could not create the session directory.", cause)),
      );
    // agent-device ties installs to the directory that opened the session.
    const installDirectory = context?.workspaceRoot
      ? yield* fs.realPath(context.workspaceRoot).pipe(Effect.orElseSucceed(() => pending.dir))
      : pending.dir;
    const stopsAtOpen = stops;
    return yield* Effect.gen(function* () {
      yield* agentDevice(pending, [
        "connect",
        "revyl",
        "--platform",
        platform,
        "--provider-app",
        appUrl,
      ]);
      const opened = yield* agentDevice(pending, ["open", "--platform", platform], {
        cwd: installDirectory,
        timeout: OPEN_TIMEOUT,
      });
      const runId = Option.flatMap(decodeOpened(opened), ({ data }) =>
        Option.fromNullishOr(RUN_ID.exec(data.device)?.[1]),
      );
      if (Option.isNone(runId)) return yield* unavailable("agent-device named no Revyl session.");
      const daemon = yield* fs.readFileString(path.join(pending.dir, "daemon.json")).pipe(
        Effect.flatMap(decodeDaemonInfo),
        Effect.mapError((cause) => unavailable("agent-device recorded no HTTP daemon.", cause)),
      );
      const connection = yield* revylJson(
        apiKey,
        "GET",
        `/api/v1/execution/streaming/worker-connection/${encodeURIComponent(runId.value)}`,
      ).pipe(
        Effect.flatMap(decodeWorkerConnection),
        Effect.mapError((cause) =>
          unavailable("Revyl did not describe the device's stream.", cause),
        ),
      );
      if (!connection.whep_url)
        return yield* unavailable("Revyl offers no stream for this device.");
      const health = yield* revylJson(
        apiKey,
        "GET",
        proxyRoute({ runId: runId.value }, "health"),
      ).pipe(
        Effect.flatMap(decodeHealth),
        Effect.mapError((cause) => unavailable("Revyl did not report the device's screen.", cause)),
      );
      const lease: Lease = {
        runId: runId.value,
        platform,
        session: pending.session,
        dir: pending.dir,
        installDirectory,
        daemon: { baseUrl: `http://127.0.0.1:${daemon.httpPort}`, token: daemon.token },
        apiKey,
        screen: { width: health.screen_width, height: health.screen_height },
        whepUrl: connection.whep_url,
        iceServers: connection.ice_servers ?? [],
        views: new Map(),
      };
      if (stops !== stopsAtOpen)
        return yield* unavailable("Device support stopped while the device was opening.");
      leases.set(lease.runId, lease);
      yield* FiberMap.run(
        maxAge,
        lease.runId,
        Effect.sleep(Duration.minutes(config.maxSessionMinutes)).pipe(
          Effect.andThen(
            Effect.logInfo("Ending Revyl session at its maximum age", { runId: lease.runId }),
          ),
          Effect.andThen(releaseLease(lease)),
        ),
      );
      return lease.runId;
    }).pipe(
      // A failed or interrupted open may still hold a session: end it either way.
      Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : release(pending))),
    );
  });

  const operationError = (operation: string) => (cause: unknown) =>
    new DeviceOperationError({ operation, reason: "request_failed", cause });
  const leaseFor = (deviceId: string | null) =>
    deviceId === null ? Option.none<Lease>() : Option.fromNullishOr(leases.get(deviceId));

  const devices: DeviceHost.DeviceOperations = {
    list: Effect.sync(() => ({
      devices: [
        ...(["ios", "android"] as const)
          .filter((platform) => appUrls[platform] !== undefined)
          .map((platform): DeviceHost.HostDevice => ({
            id: catalogId(platform),
            platform,
            name: `Revyl ${deviceKind(platform)}`,
            version: platformName(platform),
            booted: false,
            physical: false,
          })),
        ...[...leases.values()].map((lease): DeviceHost.HostDevice => ({
          id: lease.runId,
          platform: lease.platform,
          name: `Revyl ${deviceKind(lease.platform)} ${lease.runId.slice(0, 8)}`,
          version: platformName(lease.platform),
          booted: true,
          physical: false,
        })),
      ],
      detail: undefined,
    })),
    boot: (device, context) =>
      leases.has(device.id)
        ? Effect.succeed(device.id)
        : Effect.acquireUseRelease(
            reserveSlot,
            () => openLease(device, context),
            () => Effect.sync(() => void starting--),
          ).pipe(
            Effect.mapError(
              (error) =>
                new DeviceBootError({
                  hostId,
                  deviceId: device.id,
                  reason: "launch_failed",
                  diagnostics: truncate(error.reason, 1_997),
                  cause: new Error(error.reason),
                }),
            ),
          ),
    attach: () => Effect.void,
    shutdown: (device) =>
      Option.match(leaseFor(device.id), {
        onNone: () => Effect.void,
        onSome: (lease) =>
          FiberMap.remove(maxAge, lease.runId).pipe(Effect.andThen(releaseLease(lease))),
      }),
    screenshot: (device) =>
      Option.match(leaseFor(device.id), {
        onNone: () =>
          Effect.fail(operationError("screenshot")(new Error("The Revyl session has ended"))),
        onSome: (lease) => screenshotOf(lease).pipe(Effect.mapError(operationError("screenshot"))),
      }),
    agentEndpoint: (deviceId) =>
      Option.match(leaseFor(deviceId), {
        onNone: () => Effect.fail(unavailable("This Revyl session has ended.")),
        onSome: (lease) =>
          Effect.succeed({
            ...lease.daemon,
            agentDeviceId: null,
            session: lease.session,
            stateDir: lease.dir,
            installDirectory: lease.installDirectory,
          }),
      }),
    endsDevices: true,
  };

  /** Starts a WebRTC view: the client's JSON offer goes to Revyl's WHEP endpoint as SDP. */
  const offer = Effect.fn("RevylDeviceHost.offer")(function* (
    lease: Lease,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const { sdp, sessionId } = yield* request.json.pipe(Effect.flatMap(decodeOffer));
    const answer = yield* http
      .execute(
        HttpClientRequest.post(lease.whepUrl).pipe(
          HttpClientRequest.bodyText(sdp, "application/sdp"),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) =>
          response.text.pipe(Effect.map((sdp) => ({ sdp, location: response.headers.location }))),
        ),
        Effect.scoped,
        Effect.timeout(REQUEST_TIMEOUT),
      );
    if (answer.location) lease.views.set(sessionId, new URL(answer.location, lease.whepUrl).href);
    if (lease.platform === "android")
      yield* Effect.forEach(
        ANDROID_FRAME_REFRESH_DELAYS,
        (delay) =>
          Effect.sleep(delay).pipe(
            Effect.andThen(deviceAction(lease, "reset_video")),
            Effect.ignore,
          ),
        { discard: true },
      ).pipe(Effect.forkIn(hostScope));
    return HttpServerResponse.jsonUnsafe({ type: "answer", sdp: answer.sdp });
  });

  const closeView = Effect.fn("RevylDeviceHost.closeView")(function* (
    lease: Lease,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const { sessionId } = yield* request.json.pipe(Effect.flatMap(decodeClose));
    const resource = lease.views.get(sessionId);
    lease.views.delete(sessionId);
    if (resource)
      yield* http
        .execute(HttpClientRequest.delete(resource))
        .pipe(Effect.scoped, Effect.timeout(REQUEST_TIMEOUT), Effect.ignore);
    return HttpServerResponse.jsonUnsafe({});
  });

  /**
   * serve-sim's input socket: touches become taps, long presses, and drags through Revyl's device
   * proxy, one at a time, and the home and back buttons its navigation actions.
   */
  const input = Effect.fn("RevylDeviceHost.input")(function* (
    lease: Lease,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const socket = yield* request.upgrade;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { write } = yield* socket.writer;
        const { pull } = yield* socket.reader;
        yield* write(tagged(IOS_TAG_INPUT_ADMITTED));
        yield* write(tagged(IOS_TAG_SCREEN_CONFIG, { ...lease.screen, orientation: "portrait" }));
        let touch: { readonly start: TouchPoint; readonly at: number } | null = null;
        while (true) {
          for (const frame of yield* pull) {
            if (typeof frame === "string" || frame.length < 2) continue;
            const json = new TextDecoder().decode(frame.subarray(1));
            if (frame[0] === IOS_MSG_BUTTON) {
              const action = Option.flatMap(decodeButton(json), ({ button }) =>
                Option.fromNullishOr(BUTTON_ACTIONS[button]),
              );
              if (Option.isSome(action))
                yield* deviceAction(lease, action.value).pipe(Effect.ignore);
              continue;
            }
            if (frame[0] !== IOS_MSG_TOUCH) continue;
            const event = decodeTouch(json);
            if (Option.isNone(event)) continue;
            const now = yield* Clock.currentTimeMillis;
            if (event.value.type === "begin") touch = { start: event.value, at: now };
            if (event.value.type !== "end" || !touch) continue;
            const gesture = touchAction(touch.start, event.value, now - touch.at, lease.screen);
            touch = null;
            yield* deviceAction(lease, gesture.action, gesture.body).pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Revyl did not take a panel touch", {
                  action: gesture.action,
                  cause,
                }),
              ),
              Effect.ignore,
            );
          }
        }
      }),
    ).pipe(Effect.ignoreCause);
    return HttpServerResponse.empty();
  });

  const serve: NonNullable<DeviceHost.DeviceHostReady["serve"]> = Effect.fn(
    "RevylDeviceHost.serve",
  )(function* (request, hubPath, search) {
    const stream = STREAM_PATH.exec(hubPath);
    const webrtc = WEBRTC_PATH.exec(hubPath);
    // Device ids are Revyl run ids, which URL encoding leaves unchanged.
    const deviceId = stream?.[1] ?? webrtc?.[1] ?? search.get("device");
    const notFound = HttpServerResponse.text("Not Found", { status: 404 });
    const lease = leaseFor(deviceId);
    if (Option.isNone(lease)) return notFound;
    if (hubPath === API_PATH)
      return HttpServerResponse.jsonUnsafe({
        streamSettings: { transport: "webrtc", iceServers: lease.value.iceServers },
      });
    // The client asks for AVCC or MJPEG first; this answer moves it to WebRTC.
    if (stream)
      return HttpServerResponse.jsonUnsafe(
        { error: "stream_transport_locked", transport: "webrtc" },
        { status: 409 },
      );
    const answer =
      hubPath === SCREENSHOT_PATH
        ? screenshotOf(lease.value).pipe(
            Effect.map((png) =>
              HttpServerResponse.uint8Array(png, {
                contentType: "image/png",
                headers: { "cache-control": "no-store, no-transform" },
              }),
            ),
          )
        : webrtc?.[2] === "offer"
          ? offer(lease.value, request)
          : webrtc?.[2] === "close"
            ? closeView(lease.value, request)
            : hubPath === INPUT_PATH
              ? input(lease.value, request)
              : Effect.succeed(notFound);
    return yield* answer.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Revyl device request failed", { hubPath, cause }).pipe(
          Effect.as(HttpServerResponse.text("Revyl did not answer.", { status: 502 })),
        ),
      ),
    );
  });

  const installPlugin = Effect.fn("RevylDeviceHost.installPlugin")(function* (tool: {
    readonly nodePath: string;
    readonly entryPath: string;
  }) {
    const failed = (cause: unknown) =>
      new DeviceHost.DeviceHostError({ hostId, step: "installing the Revyl plugin", cause });
    const installed = yield* fs
      .readFileString(path.join(agentHome, "config.json"))
      .pipe(Effect.orElseSucceed(() => ""));
    if (installed.includes(`"${PLUGIN}"`) && installed.includes(`"${AGENT_DEVICE_VERSION}"`))
      return;
    const result = yield* runner
      .run({
        command: tool.nodePath,
        args: [tool.entryPath, "plugins", "add", `${PLUGIN}@${AGENT_DEVICE_VERSION}`, "--json"],
        env: agentEnvironment("", hostDir),
        timeout: COMMAND_TIMEOUT,
      })
      .pipe(Effect.mapError(failed));
    if (result.code !== 0)
      return yield* failed(new Error(truncate(result.stdout || result.stderr, 500)));
  });

  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = Effect.fn(
    "RevylDeviceHost.ensureReady",
  )(function* (onPhase) {
    if (ready) return ready;
    yield* onPhase("installing");
    const tool = yield* agentDeviceCli;
    yield* installPlugin(tool);
    cli = tool;
    // Sessions a crashed or killed server left open still bill until their daemons stop.
    const apiKey = yield* currentApiKey.pipe(Effect.orElseSucceed(() => ""));
    const leftovers = yield* fs.readDirectory(hostDir).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      leftovers.filter((name) => name !== "home"),
      (name) => stopDaemon({ session: `t3-${name}`, dir: path.join(hostDir, name), apiKey }),
      { discard: true, concurrency: 4 },
    );
    ready = {
      nodePath: tool.nodePath,
      hub: { origin: apiOrigin ?? REVYL_API },
      devices,
      serve,
      run: () =>
        Effect.succeed({
          stdout: "",
          stderr: "Revyl devices cannot run host commands.",
          code: 127,
        }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    };
    return ready;
  });

  const stopAll = Effect.gen(function* () {
    stops++;
    yield* FiberMap.clear(maxAge);
    yield* Effect.forEach([...leases.values()], releaseLease, { discard: true, concurrency: 4 });
  }).pipe(Effect.ignore);
  yield* Effect.addFinalizer(() => stopAll);

  const platformAvailability = (platform: DevicePlatform) =>
    currentApiKey.pipe(
      Effect.map((): DevicePlatformAvailability =>
        appUrls[platform]
          ? { platform, available: true }
          : {
              platform,
              available: false,
              reason: `Set an ${platformName(platform)} app URL for ${config.label}.`,
            },
      ),
      Effect.catch((error) =>
        Effect.succeed<DevicePlatformAvailability>({
          platform,
          available: false,
          reason: error.reason,
        }),
      ),
    );

  const summary: Effect.Effect<DeviceHostSummary> = Effect.gen(function* () {
    return {
      id: hostId,
      label: config.label,
      kind: "revyl" as const,
      platforms: [yield* platformAvailability("ios"), yield* platformAvailability("android")],
      hubInstalled: true,
      agentDeviceInstalled: true,
    };
  });

  return DeviceHost.DeviceHost.of({
    id: hostId,
    label: config.label,
    summary,
    platformAvailability,
    ensureReady,
    ensureAgentReady: Effect.fn("RevylDeviceHost.ensureAgentReady")(function* (onPhase) {
      return { ...(yield* ensureReady(onPhase)), agentDevice: null };
    }),
    current: Effect.sync(() => ready),
    stopAgent: Effect.void,
    stop: stopAll,
  });
});
