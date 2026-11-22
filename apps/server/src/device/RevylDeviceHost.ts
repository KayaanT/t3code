/**
 * Alpha: Revyl cloud devices on an agent-device daemon per session, which agents drive, with the
 * panel served from Revyl's WHEP stream. Persistent Revyl Macs open by create or start and close by
 * stop, which saves their disk; they are watched and driven through Revyl screen actions only.
 */
import {
  DeviceBootError,
  type DeviceHostSummary,
  DeviceHostUnavailableError,
  DeviceOperationError,
  type DevicePlatform,
  type DevicePlatformAvailability,
  type MobileDevicePlatform,
  type RevylDeviceHostConfig,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
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
const IOS_MSG_KEY = 0x06;
const IOS_MSG_ORIENTATION = 0x07;
const IOS_TAG_SCREEN_CONFIG = 0x82;
const IOS_TAG_INPUT_ADMITTED = 0x83;

const MAC_CATALOG_ID = "revyl:macos";
const MAC_START_ATTEMPTS = 8;
const MAC_START_RETRY = Duration.seconds(15);
const MAC_POLL = Duration.seconds(3);
const MAC_IDLE_CHECK = Duration.minutes(1);

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
const PersistentComputer = Schema.Struct({
  computer_id: Schema.String,
  state: Schema.String,
  run_session_id: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodePersistentComputers = Schema.decodeUnknownEffect(
  Schema.Struct({ computers: Schema.Array(PersistentComputer) }),
);
const decodeComputer = Schema.decodeUnknownEffect(
  Schema.Struct({ persistent: Schema.optional(Schema.NullOr(PersistentComputer)) }),
);
const decodeScreenFeed = Schema.decodeUnknownEffect(
  Schema.Struct({
    whep_url: Schema.optional(Schema.NullOr(Schema.String)),
    screen_width: Schema.optional(Schema.NullOr(Schema.Number)),
    screen_height: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
);
const decodeViewerIceServers = Schema.decodeUnknownEffect(
  Schema.Struct({ ice_servers: Schema.Array(IceServer) }),
);
const decodeScreenshot = Schema.decodeUnknownEffect(Schema.Struct({ png: Schema.String }));
const decodeApiError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ detail: Schema.String })),
);
const decodeHealth = Schema.decodeUnknownEffect(
  Schema.Struct({
    screen_width: Schema.Number,
    screen_height: Schema.Number,
    supports_precise_orientation: Schema.optional(Schema.Boolean),
  }),
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
const decodeKey = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.Literals(["down", "up"]), usage: Schema.Int }),
  ),
);
const Orientation = Schema.Literals([
  "portrait",
  "portrait_upside_down",
  "landscape_left",
  "landscape_right",
]);
type Orientation = typeof Orientation.Type;
const decodeOrientation = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ orientation: Orientation })),
);

interface Screen {
  readonly width: number;
  readonly height: number;
}

interface PanelScreen extends Screen {
  readonly orientation: Orientation;
}

interface Lease {
  /** Revyl's workflow run id, which is also the device id T3 lists. */
  readonly runId: string;
  readonly platform: MobileDevicePlatform;
  readonly session: string;
  /** agent-device state of the lease's own daemon. */
  readonly dir: string;
  readonly installDirectory: string;
  readonly daemon: DeviceHost.AgentDaemonEndpoint;
  /** The key the session was started with; ending it must not depend on reading the secret again. */
  readonly apiKey: string;
  /** Changes when the panel rotates the device. */
  screen: PanelScreen;
  /** Without it, Revyl rotates to portrait and one landscape only. */
  readonly preciseOrientation: boolean;
  readonly whepUrl: string;
  readonly iceServers: ReadonlyArray<typeof IceServer.Type>;
  /** Open WebRTC views, by the client's session id, to their WHEP resource. */
  readonly views: Map<string, string>;
}

/** A persistent Revyl Mac this server started or attached to, while it runs. */
interface Mac {
  /** The computer's id, which stays the same across starts and is the device id T3 lists. */
  readonly computerId: string;
  readonly platform: "macos";
  readonly apiKey: string;
  readonly screen: PanelScreen;
  /** Read after each start: a start opens a new run session with a new stream. */
  readonly whepUrl: string;
  readonly iceServers: ReadonlyArray<typeof IceServer.Type>;
  readonly views: Map<string, string>;
  /** When someone last opened its screen or sent it input. */
  activeAt: number;
}

/** A Revyl screen action: a click, drag, key chord, or typed text, in the Mac's screen pixels. */
export type MacScreenAction =
  | {
      readonly action: "click";
      readonly x: number;
      readonly y: number;
      readonly button?: "right";
    }
  | {
      readonly action: "drag";
      readonly start_x: number;
      readonly start_y: number;
      readonly end_x: number;
      readonly end_y: number;
    }
  | { readonly action: "key"; readonly keys: string }
  | { readonly action: "type"; readonly text: string };

type PanelInput =
  | { readonly kind: "act"; readonly action: string; readonly body?: unknown }
  | { readonly kind: "touch"; readonly gesture: ReturnType<typeof touchAction> }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "rotate"; readonly orientation: Orientation };

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

/** A panel touch on a Mac: a click, a right click for a long press, or a drag. */
export const macTouchAction = (
  start: TouchPoint,
  end: TouchPoint,
  heldMs: number,
  screen: Screen,
): MacScreenAction => {
  const gesture = touchAction(start, end, heldMs, screen);
  switch (gesture.action) {
    case "drag":
      return { action: "drag", ...gesture.body };
    case "longpress":
      return { action: "click", x: gesture.body.x, y: gesture.body.y, button: "right" };
    case "tap":
      return { action: "click", ...gesture.body };
  }
};

const BUTTON_ACTIONS: Readonly<Record<string, string>> = { home: "go_home", back: "back" };

const HID_SHIFT = new Set([0xe1, 0xe5]);
/** Control, Option, and Command, whose shortcuts type nothing on the device. */
const HID_SHORTCUT = new Set([0xe0, 0xe2, 0xe3, 0xe4, 0xe6, 0xe7]);
const HID_KEYS: Readonly<Record<number, "ENTER" | "BACKSPACE">> = {
  0x28: "ENTER",
  0x58: "ENTER",
  0x2a: "BACKSPACE",
};
type HidKey = readonly [usage: number, keys: readonly [plain: string, shifted: string]];
const HID_TEXT = new Map<number, readonly [string, string]>([
  ...Array.from("abcdefghijklmnopqrstuvwxyz", (letter, index): HidKey => [
    0x04 + index,
    [letter, letter.toUpperCase()],
  ]),
  ...Array.from("1234567890", (digit, index): HidKey => [
    0x1e + index,
    [digit, "!@#$%^&*()"[index]!],
  ]),
  [0x2c, [" ", " "]],
  [0x2d, ["-", "_"]],
  [0x2e, ["=", "+"]],
  [0x2f, ["[", "{"]],
  [0x30, ["]", "}"]],
  [0x31, ["\\", "|"]],
  [0x33, [";", ":"]],
  [0x34, ["'", '"']],
  [0x35, ["`", "~"]],
  [0x36, [",", "<"]],
  [0x37, [".", ">"]],
  [0x38, ["/", "?"]],
]);

/** The text a key types on a US layout, or null for a key that types nothing. */
const hidText = (usage: number, shifted: boolean) => HID_TEXT.get(usage)?.[shifted ? 1 : 0] ?? null;

const MAC_MODIFIERS: Readonly<Record<number, "ctrl" | "shift" | "alt" | "cmd">> = {
  0xe0: "ctrl",
  0xe1: "shift",
  0xe2: "alt",
  0xe3: "cmd",
  0xe4: "ctrl",
  0xe5: "shift",
  0xe6: "alt",
  0xe7: "cmd",
};
const MAC_NAMED_KEYS = new Map<number, string>([
  [0x28, "enter"],
  [0x58, "enter"],
  [0x29, "escape"],
  [0x2a, "backspace"],
  [0x2b, "tab"],
  [0x4a, "home"],
  [0x4b, "pageup"],
  [0x4c, "delete"],
  [0x4d, "end"],
  [0x4e, "pagedown"],
  [0x4f, "right"],
  [0x50, "left"],
  [0x51, "down"],
  [0x52, "up"],
  ...Array.from({ length: 12 }, (_, index): readonly [number, string] => [
    0x3a + index,
    `f${index + 1}`,
  ]),
]);

const isMacModifier = (usage: number) => MAC_MODIFIERS[usage] !== undefined;

/**
 * The screen action one key press becomes on a Mac, given the modifier keys held: text for a plain
 * or shifted key, and a chord such as `cmd+c` or `shift+tab` for a shortcut or a named key.
 */
export const macKeyAction = (usage: number, held: ReadonlySet<number>): MacScreenAction | null => {
  const modifiers = [...new Set([...held].flatMap((key) => MAC_MODIFIERS[key] ?? []))];
  const named = MAC_NAMED_KEYS.get(usage);
  if (named) return { action: "key", keys: [...modifiers, named].join("+") };
  const shifted = modifiers.includes("shift");
  const text = hidText(usage, shifted);
  if (text === null) return null;
  if (modifiers.every((modifier) => modifier === "shift")) return { action: "type", text };
  const plain = hidText(usage, false)!;
  return { action: "key", keys: [...modifiers, plain === " " ? "space" : plain].join("+") };
};

/** The orientation Revyl can rotate to that is nearest the one the panel asked for. */
export const revylOrientation = (requested: Orientation, precise: boolean) => {
  if (precise)
    return {
      orientation: requested,
      body: { orientation: requested === "portrait_upside_down" ? "upside_down" : requested },
    };
  return requested.startsWith("landscape")
    ? { orientation: "landscape_right" as const, body: { orientation: "landscape" } }
    : { orientation: "portrait" as const, body: { orientation: "portrait" } };
};

const tagged = (tag: number, payload?: unknown) => {
  const json =
    payload === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + json.length);
  out[0] = tag;
  out.set(json, 1);
  return out;
};

const catalogId = (platform: MobileDevicePlatform) => `revyl:${platform}`;
const platformName = (platform: MobileDevicePlatform) => (platform === "ios" ? "iOS" : "Android");
const deviceKind = (platform: MobileDevicePlatform) =>
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
  const macs = new Map<string, Mac>();
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
  const appUrls: Readonly<Record<MobileDevicePlatform, string | undefined>> = {
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

  const computerRoute = (computerId: string, action = "") =>
    `/api/v1/computer-runs/${encodeURIComponent(computerId)}${action}`;

  const readComputer = (apiKey: string, computerId: string) =>
    revylJson(apiKey, "GET", computerRoute(computerId)).pipe(
      Effect.flatMap(decodeComputer),
      Effect.map(({ persistent }) => persistent ?? null),
    );

  /** The organization's persistent Macs, or null when Revyl did not list them. */
  const listMacs = currentApiKey.pipe(
    Effect.flatMap((apiKey) =>
      revylJson(apiKey, "GET", "/api/v1/computer-runs/persistent?limit=50"),
    ),
    Effect.flatMap(decodePersistentComputers),
    Effect.map(({ computers }) => computers),
    Effect.tapError((cause) => Effect.logDebug("Revyl did not list persistent Macs", { cause })),
    Effect.orElseSucceed(() => null),
  );

  const createMac = Effect.fn("RevylDeviceHost.createMac")(function* (apiKey: string) {
    const computerId = yield* Effect.sync(() => SecureRandom.uuidV4Unsafe());
    yield* revylJson(apiKey, "POST", "/api/v1/computer-runs", {
      computer_session_id: computerId,
      os: "macos",
      persistent: true,
      ...(config.macSnapshot ? { from_snapshot: config.macSnapshot } : {}),
    });
    yield* Effect.logInfo("Created a Revyl Mac", { computerId });
    return computerId;
  });

  /**
   * Starts a stopped Mac. Revyl refuses a start while the last run is still ending, so that
   * conflict is retried; a Mac that is already starting or running needs no start.
   */
  const startMac = Effect.fn("RevylDeviceHost.startMac")(function* (
    apiKey: string,
    computerId: string,
  ) {
    for (let attempt = 1; ; attempt++) {
      const answer = yield* http
        .execute(
          HttpClientRequest.post(`${apiOrigin}${computerRoute(computerId, "/start")}`).pipe(
            HttpClientRequest.bearerToken(apiKey),
            HttpClientRequest.bodyJsonUnsafe({}),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
          ),
          Effect.scoped,
          Effect.timeout(REQUEST_TIMEOUT),
        );
      if (answer.status < 300) return;
      const detail = Option.match(decodeApiError(answer.text), {
        onNone: () => `status ${answer.status}`,
        onSome: (error) => error.detail,
      });
      const current = yield* readComputer(apiKey, computerId).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (current?.state === "starting" || current?.state === "running") return;
      if (detail !== "run_conflict" || attempt >= MAC_START_ATTEMPTS)
        return yield* unavailable(
          detail === "saved_disk_expired"
            ? "This Mac's saved disk has expired. Delete it and open a new Revyl Mac."
            : `Revyl did not start the Mac (${detail}).`,
        );
      yield* Effect.sleep(MAC_START_RETRY);
    }
  });

  /** Waits for the Mac to run, then reads its current run's stream; the URL is never logged. */
  const attachMac = Effect.fn("RevylDeviceHost.attachMac")(function* (
    apiKey: string,
    computerId: string,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(OPEN_TIMEOUT);
    const waitFor = Effect.fn("RevylDeviceHost.waitForMac")(function* <A, E>(
      read: Effect.Effect<A | null, E>,
      what: string,
    ) {
      while ((yield* Clock.currentTimeMillis) < deadline) {
        const value = yield* read.pipe(Effect.orElseSucceed(() => null));
        if (value !== null) return value;
        yield* Effect.sleep(MAC_POLL);
      }
      return yield* unavailable(`The Revyl Mac did not ${what} in time.`);
    });
    const runSessionId = yield* waitFor(
      readComputer(apiKey, computerId).pipe(
        Effect.map((computer) =>
          computer?.state === "running" ? (computer.run_session_id ?? null) : null,
        ),
      ),
      "start",
    );
    const feed = yield* waitFor(
      revylJson(
        apiKey,
        "GET",
        `/api/v1/execution/device-sessions/${encodeURIComponent(runSessionId)}?include_computers=true`,
      ).pipe(
        Effect.flatMap(decodeScreenFeed),
        Effect.map((feed) => (feed.whep_url ? { ...feed, whep_url: feed.whep_url } : null)),
      ),
      "publish its screen",
    );
    const iceServers = yield* revylJson(
      apiKey,
      "GET",
      "/api/v1/execution/streaming/viewer-ice-servers",
    ).pipe(
      Effect.flatMap(decodeViewerIceServers),
      Effect.map(({ ice_servers }) => ice_servers),
      Effect.orElseSucceed(() => []),
    );
    const width = feed.screen_width ?? 1280;
    const height = feed.screen_height ?? 800;
    const mac: Mac = {
      computerId,
      platform: "macos",
      apiKey,
      screen: { width, height, orientation: width > height ? "landscape_left" : "portrait" },
      whepUrl: feed.whep_url,
      iceServers,
      views: new Map(),
      activeAt: yield* Clock.currentTimeMillis,
    };
    return mac;
  });

  /** Stops a Mac, which saves its disk; a stop that fails leaves the run to its lifetime limit. */
  const stopMac = (apiKey: string, computerId: string) =>
    revylJson(apiKey, "POST", computerRoute(computerId, "/stop")).pipe(
      Effect.andThen(Effect.logInfo("Stopped a Revyl Mac", { computerId })),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not stop a Revyl Mac", { computerId, cause }),
      ),
      Effect.ignore,
    );

  const releaseMac = (mac: Mac) =>
    Effect.suspend(() => {
      macs.delete(mac.computerId);
      return stopMac(mac.apiKey, mac.computerId);
    });

  const macIdleKey = (computerId: string) => `mac:${computerId}`;

  const openMac = Effect.fn("RevylDeviceHost.openMac")(
    function* (device: DeviceHost.HostDevice) {
      const apiKey = yield* currentApiKey;
      const stopsAtOpen = stops;
      const computerId = device.id === MAC_CATALOG_ID ? yield* createMac(apiKey) : device.id;
      if (device.id !== MAC_CATALOG_ID) yield* startMac(apiKey, computerId);
      const mac = yield* attachMac(apiKey, computerId).pipe(
        Effect.tapError(() => stopMac(apiKey, computerId)),
      );
      if (stops !== stopsAtOpen) {
        yield* stopMac(apiKey, computerId);
        return yield* unavailable("Device support stopped while the Mac was opening.");
      }
      macs.set(computerId, mac);
      const idleMs = config.macIdleMinutes * 60_000;
      yield* FiberMap.run(
        maxAge,
        macIdleKey(computerId),
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(MAC_IDLE_CHECK);
            if ((yield* Clock.currentTimeMillis) - mac.activeAt < idleMs) continue;
            yield* Effect.logInfo("Stopping an idle Revyl Mac", { computerId });
            return yield* releaseMac(mac);
          }
        }),
      );
      return computerId;
    },
    Effect.mapError((error) =>
      error._tag === "DeviceHostUnavailableError"
        ? error
        : unavailable("Revyl did not answer.", error),
    ),
  );

  const macScreenshot = (mac: Mac) =>
    revylJson(mac.apiKey, "GET", computerRoute(mac.computerId, "/screen/screenshot")).pipe(
      Effect.flatMap(decodeScreenshot),
      Effect.map(({ png }) => new Uint8Array(Buffer.from(png, "base64"))),
    );

  const macAct = (mac: Mac, action: MacScreenAction) =>
    revylJson(mac.apiKey, "POST", computerRoute(mac.computerId, "/screen/actions"), {
      action,
      screenshot: false,
    });

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
      if (leases.size + macs.size + starting >= config.maxSessions) {
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
        screen: {
          width: health.screen_width,
          height: health.screen_height,
          orientation: health.screen_width > health.screen_height ? "landscape_left" : "portrait",
        },
        preciseOrientation: health.supports_precise_orientation === true,
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

  const phoneDevices = () => [
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
  ];

  const devices: DeviceHost.DeviceOperations = {
    list: Effect.gen(function* () {
      const listedMacs = config.macs ? yield* listMacs : [];
      return {
        devices: [
          ...phoneDevices(),
          ...(listedMacs === null || !config.macs
            ? []
            : [
                {
                  id: MAC_CATALOG_ID,
                  platform: "macos" as const,
                  name: "New Revyl Mac",
                  version: "macOS",
                  booted: false,
                  physical: false,
                },
                ...listedMacs.map((computer): DeviceHost.HostDevice => ({
                  id: computer.computer_id,
                  platform: "macos",
                  name: `Revyl Mac ${computer.computer_id.slice(0, 8)}`,
                  version: "macOS",
                  booted: macs.has(computer.computer_id),
                  physical: false,
                })),
              ]),
        ],
        detail: undefined,
        ...(listedMacs === null ? { incompletePlatforms: ["macos" as const] } : {}),
      };
    }),
    boot: (device, context) =>
      leases.has(device.id) || macs.has(device.id)
        ? Effect.succeed(device.id)
        : Effect.acquireUseRelease(
            reserveSlot,
            () => (device.platform === "macos" ? openMac(device) : openLease(device, context)),
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
    shutdown: (device) => {
      const mac = macs.get(device.id);
      if (mac)
        return FiberMap.remove(maxAge, macIdleKey(mac.computerId)).pipe(
          Effect.andThen(releaseMac(mac)),
        );
      if (device.platform === "macos")
        return currentApiKey.pipe(
          Effect.flatMap((apiKey) => stopMac(apiKey, device.id)),
          Effect.ignore,
        );
      return Option.match(leaseFor(device.id), {
        onNone: () => Effect.void,
        onSome: (lease) =>
          FiberMap.remove(maxAge, lease.runId).pipe(Effect.andThen(releaseLease(lease))),
      });
    },
    screenshot: (device) => {
      const mac = macs.get(device.id);
      if (mac) return macScreenshot(mac).pipe(Effect.mapError(operationError("screenshot")));
      return Option.match(leaseFor(device.id), {
        onNone: () =>
          Effect.fail(operationError("screenshot")(new Error("The Revyl session has ended"))),
        onSome: (lease) => screenshotOf(lease).pipe(Effect.mapError(operationError("screenshot"))),
      });
    },
    agentEndpoint: (deviceId) =>
      macs.has(deviceId)
        ? Effect.fail(unavailable("Device tools cannot drive a Revyl Mac."))
        : Option.match(leaseFor(deviceId), {
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
    lease: Lease | Mac,
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
    lease: Lease | Mac,
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
   * serve-sim's input socket. Touches become taps, long presses, and drags through Revyl's device
   * proxy; the home and back buttons its navigation actions; keys text typed into the field last
   * tapped, or Enter and Backspace; and rotation its nearest orientation. Requests go one at a time,
   * in the order the panel sent them.
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
        const queued = yield* Queue.unbounded<PanelInput>();
        const act = (action: string, body?: unknown) =>
          deviceAction(lease, action, body).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Revyl did not take panel input", { action, cause }),
            ),
            Effect.ignore,
          );
        const held: Array<PanelInput> = [];
        let field: { readonly x: number; readonly y: number } | null = null;
        const next = Effect.gen(function* () {
          const item = held.shift() ?? (yield* Queue.take(queued));
          switch (item.kind) {
            case "act":
              return yield* act(item.action, item.body);
            case "touch":
              if (item.gesture.action === "tap") field = item.gesture.body;
              return yield* act(item.gesture.action, item.gesture.body);
            case "rotate": {
              const target = revylOrientation(item.orientation, lease.preciseOrientation);
              // Revyl reports the screen in the units its taps use: an iOS simulator keeps its
              // portrait framebuffer, which the panel turns, and an Android emulator turns its own.
              lease.screen = yield* deviceAction(lease, "set_orientation", target.body).pipe(
                Effect.andThen(revylJson(lease.apiKey, "GET", proxyRoute(lease, "health"))),
                Effect.flatMap(decodeHealth),
                Effect.map((health): PanelScreen => ({
                  width: health.screen_width,
                  height: health.screen_height,
                  orientation: target.orientation,
                })),
                Effect.tapError((cause) =>
                  Effect.logWarning("Revyl did not rotate the device", { cause }),
                ),
                Effect.orElseSucceed(() => lease.screen),
              );
              return yield* write(tagged(IOS_TAG_SCREEN_CONFIG, lease.screen));
            }
            case "text": {
              // Revyl types at a point, tapping it first, so keys typed meanwhile go in one request.
              held.push(...(yield* Queue.clear(queued)));
              const typing = held.findIndex((later) => later.kind !== "text");
              const text = [item, ...held.splice(0, typing === -1 ? held.length : typing)]
                .flatMap((typed) => (typed.kind === "text" ? [typed.text] : []))
                .join("");
              if (!field) return yield* Effect.logDebug("Dropped panel typing before any tap");
              return yield* act("input", { ...field, text, clear_first: false });
            }
          }
        });
        yield* Effect.forkScoped(Effect.forever(next));

        yield* write(tagged(IOS_TAG_INPUT_ADMITTED));
        yield* write(tagged(IOS_TAG_SCREEN_CONFIG, lease.screen));
        let touch: { readonly start: TouchPoint; readonly at: number } | null = null;
        const modifiers = new Set<number>();
        while (true) {
          for (const frame of yield* pull) {
            if (typeof frame === "string" || frame.length < 2) continue;
            const json = new TextDecoder().decode(frame.subarray(1));
            const panelInput = yield* Effect.gen(function* (): Effect.fn.Return<PanelInput | null> {
              switch (frame[0]) {
                case IOS_MSG_BUTTON: {
                  const action = Option.flatMap(decodeButton(json), ({ button }) =>
                    Option.fromNullishOr(BUTTON_ACTIONS[button]),
                  );
                  return Option.isSome(action) ? { kind: "act", action: action.value } : null;
                }
                case IOS_MSG_ORIENTATION:
                  return Option.match(decodeOrientation(json), {
                    onNone: () => null,
                    onSome: ({ orientation }) => ({ kind: "rotate", orientation }),
                  });
                case IOS_MSG_KEY: {
                  const key = decodeKey(json);
                  if (Option.isNone(key)) return null;
                  const { type, usage } = key.value;
                  if (HID_SHIFT.has(usage) || HID_SHORTCUT.has(usage)) {
                    if (type === "down") modifiers.add(usage);
                    else modifiers.delete(usage);
                    return null;
                  }
                  if (type !== "down" || [...modifiers].some((held) => HID_SHORTCUT.has(held)))
                    return null;
                  const named = HID_KEYS[usage];
                  if (named) return { kind: "act", action: "key", body: { key: named } };
                  const text = hidText(
                    usage,
                    [...modifiers].some((held) => HID_SHIFT.has(held)),
                  );
                  return text === null ? null : { kind: "text", text };
                }
                case IOS_MSG_TOUCH: {
                  const event = decodeTouch(json);
                  if (Option.isNone(event)) return null;
                  const now = yield* Clock.currentTimeMillis;
                  if (event.value.type === "begin") touch = { start: event.value, at: now };
                  if (event.value.type !== "end" || !touch) return null;
                  const gesture = touchAction(
                    touch.start,
                    event.value,
                    now - touch.at,
                    lease.screen,
                  );
                  touch = null;
                  return { kind: "touch", gesture };
                }
                default:
                  return null;
              }
            });
            if (panelInput) yield* Queue.offer(queued, panelInput);
          }
        }
      }),
    ).pipe(Effect.ignoreCause);
    return HttpServerResponse.empty();
  });

  /**
   * serve-sim's input socket for a Mac. Touches become clicks, right clicks for long presses, and
   * drags; keys become typed text, or chords for shortcuts and named keys. Requests go one at a
   * time, in order, and keys typed while one is in flight go together.
   */
  const macInput = Effect.fn("RevylDeviceHost.macInput")(function* (
    mac: Mac,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const socket = yield* request.upgrade;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { write } = yield* socket.writer;
        const { pull } = yield* socket.reader;
        const queued = yield* Queue.unbounded<MacScreenAction>();
        const held: Array<MacScreenAction> = [];
        const next = Effect.gen(function* () {
          let action = held.shift() ?? (yield* Queue.take(queued));
          if (action.action === "type") {
            held.push(...(yield* Queue.clear(queued)));
            const typing = held.findIndex((later) => later.action !== "type");
            const text = [action, ...held.splice(0, typing === -1 ? held.length : typing)]
              .flatMap((typed) => (typed.action === "type" ? [typed.text] : []))
              .join("");
            action = { action: "type", text };
          }
          yield* macAct(mac, action).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Revyl did not take Mac input", { action: action.action, cause }),
            ),
            Effect.ignore,
          );
        });
        yield* Effect.forkScoped(Effect.forever(next));

        yield* write(tagged(IOS_TAG_INPUT_ADMITTED));
        yield* write(tagged(IOS_TAG_SCREEN_CONFIG, mac.screen));
        let touch: { readonly start: TouchPoint; readonly at: number } | null = null;
        const modifiers = new Set<number>();
        while (true) {
          for (const frame of yield* pull) {
            if (typeof frame === "string" || frame.length < 2) continue;
            const json = new TextDecoder().decode(frame.subarray(1));
            const now = yield* Clock.currentTimeMillis;
            let action: MacScreenAction | null = null;
            if (frame[0] === IOS_MSG_KEY) {
              const key = decodeKey(json);
              if (Option.isNone(key)) continue;
              const { type, usage } = key.value;
              if (isMacModifier(usage)) {
                if (type === "down") modifiers.add(usage);
                else modifiers.delete(usage);
                continue;
              }
              if (type === "down") action = macKeyAction(usage, modifiers);
            } else if (frame[0] === IOS_MSG_TOUCH) {
              const event = decodeTouch(json);
              if (Option.isNone(event)) continue;
              if (event.value.type === "begin") touch = { start: event.value, at: now };
              if (event.value.type === "end" && touch) {
                action = macTouchAction(touch.start, event.value, now - touch.at, mac.screen);
                touch = null;
              }
            }
            if (!action) continue;
            mac.activeAt = now;
            yield* Queue.offer(queued, action);
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
    const mac = deviceId === null ? undefined : macs.get(deviceId);
    const lease = Option.getOrUndefined(leaseFor(deviceId));
    const target = mac ?? lease;
    if (!target) return notFound;
    if (hubPath === API_PATH)
      return HttpServerResponse.jsonUnsafe({
        streamSettings: { transport: "webrtc", iceServers: target.iceServers },
      });
    // The client asks for AVCC or MJPEG first; this answer moves it to WebRTC.
    if (stream)
      return HttpServerResponse.jsonUnsafe(
        { error: "stream_transport_locked", transport: "webrtc" },
        { status: 409 },
      );
    if (mac) mac.activeAt = yield* Clock.currentTimeMillis;
    const answer =
      hubPath === SCREENSHOT_PATH
        ? (mac ? macScreenshot(mac) : screenshotOf(lease!)).pipe(
            Effect.map((png) =>
              HttpServerResponse.uint8Array(png, {
                contentType: "image/png",
                headers: { "cache-control": "no-store, no-transform" },
              }),
            ),
          )
        : webrtc?.[2] === "offer"
          ? offer(target, request)
          : webrtc?.[2] === "close"
            ? closeView(target, request)
            : hubPath === INPUT_PATH
              ? mac
                ? macInput(mac, request)
                : input(lease!, request)
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
    yield* Effect.forEach([...macs.values()], releaseMac, { discard: true, concurrency: 4 });
  }).pipe(Effect.ignore);
  yield* Effect.addFinalizer(() => stopAll);

  const platformAvailability = (platform: DevicePlatform) =>
    currentApiKey.pipe(
      Effect.map((): DevicePlatformAvailability =>
        (platform === "macos" ? config.macs : appUrls[platform])
          ? { platform, available: true }
          : {
              platform,
              available: false,
              reason:
                platform === "macos"
                  ? `Turn on Revyl Macs for ${config.label}.`
                  : `Set an ${platformName(platform)} app URL for ${config.label}.`,
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
      platforms: [
        yield* platformAvailability("ios"),
        yield* platformAvailability("android"),
        yield* platformAvailability("macos"),
      ],
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
