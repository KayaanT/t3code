import {
  RevylDeviceHostConfig,
  type RevylDeviceHostConfig as RevylDeviceHostConfigType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const parseRevylDeviceHostDraft = Schema.decodeUnknownOption(RevylDeviceHostConfig);

export const newRevylDeviceHost = (id: string): RevylDeviceHostConfigType => ({
  kind: "revyl",
  id,
  label: "Revyl",
  apiKey: "",
  maxSessions: 2,
  maxSessionMinutes: 30,
});

/**
 * Adds, replaces, or removes one Revyl host. With `keepKey`, each environment keeps the API key it
 * holds, since a saved key arrives redacted; an environment new to the host uses REVYL_API_KEY.
 */
export function updateRevylDeviceHosts(
  hosts: ReadonlyArray<RevylDeviceHostConfigType>,
  host: RevylDeviceHostConfigType,
  remove: boolean,
  keepKey = false,
): ReadonlyArray<RevylDeviceHostConfigType> {
  if (remove) return hosts.filter((candidate) => candidate.id !== host.id);
  const existing = hosts.find((candidate) => candidate.id === host.id);
  const next = keepKey ? { ...host, apiKey: existing?.apiKey ?? "" } : host;
  return existing
    ? hosts.map((candidate) => (candidate.id === host.id ? next : candidate))
    : [...hosts, next];
}

export function revylSessionLimits(host: RevylDeviceHostConfigType) {
  const sessions = host.maxSessions === 1 ? "1 session" : `${host.maxSessions} sessions`;
  return `Up to ${sessions} at once, each stopped after ${host.maxSessionMinutes} min`;
}
