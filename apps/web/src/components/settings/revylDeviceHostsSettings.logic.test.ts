import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";

import {
  newRevylDeviceHost,
  parseRevylDeviceHostDraft,
  updateRevylDeviceHosts,
} from "./revylDeviceHostsSettings.logic";

describe("Revyl device host settings", () => {
  it("accepts a new host and rejects limits or app URLs Revyl hosts do not allow", () => {
    const host = newRevylDeviceHost("revyl");
    expect(Option.isSome(parseRevylDeviceHostDraft(host))).toBe(true);
    expect(Option.isNone(parseRevylDeviceHostDraft({ ...host, maxSessionMinutes: 2 }))).toBe(true);
    expect(Option.isNone(parseRevylDeviceHostDraft({ ...host, maxSessions: 11 }))).toBe(true);
    expect(
      Option.isNone(
        parseRevylDeviceHostDraft({ ...host, androidAppUrl: "http://apps.test/a.apk" }),
      ),
    ).toBe(true);
    expect(Option.isNone(parseRevylDeviceHostDraft({ ...host, label: " " }))).toBe(true);
  });

  it("keeps each environment's own API key when a save leaves the key unchanged", () => {
    const edited = { ...newRevylDeviceHost("revyl"), label: "Renamed", apiKey: "" };
    const elsewhere = { ...newRevylDeviceHost("revyl"), apiKey: "••••••" };
    expect(updateRevylDeviceHosts([elsewhere], edited, false, true)).toEqual([
      { ...edited, apiKey: "••••••" },
    ]);
    expect(updateRevylDeviceHosts([], { ...edited, apiKey: "••••••" }, false, true)).toEqual([
      { ...edited, apiKey: "" },
    ]);
    expect(updateRevylDeviceHosts([elsewhere], edited, true)).toEqual([]);
  });
});
