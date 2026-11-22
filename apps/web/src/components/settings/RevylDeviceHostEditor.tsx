import { useId, useState } from "react";
import * as Option from "effect/Option";
import {
  isSecretReference,
  type EnvironmentId,
  type RevylDeviceHostConfig,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { XIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { parseRevylDeviceHostDraft } from "./revylDeviceHostsSettings.logic";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";

// An empty field removes the URL instead of saving "".
function withAppUrl(
  host: RevylDeviceHostConfig,
  field: "iosAppUrl" | "androidAppUrl",
  value: string,
): RevylDeviceHostConfig {
  if (value) return { ...host, [field]: value };
  const next = { ...host };
  delete next[field];
  return next;
}

export function RevylDeviceHostEditor(props: {
  environmentId: EnvironmentId;
  host: RevylDeviceHostConfig;
  isNew: boolean;
  busy: boolean;
  onSave: (host: RevylDeviceHostConfig) => void;
  onClose: () => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState(props.host);
  const keyId = useId();
  const secretSources = useSecretSources(props.environmentId);
  const [keyValid, setKeyValid] = useState(true);
  const [keyInputKey, setKeyInputKey] = useState(0);
  // A saved key arrives redacted; only a replacement or a clear changes it.
  const [apiKey, setApiKey] = useState<
    { kind: "saved" } | { kind: "new"; value: SettingsSecretValue } | { kind: "cleared" }
  >(props.host.apiKey ? { kind: "saved" } : { kind: "cleared" });
  const next: RevylDeviceHostConfig = {
    ...draft,
    label: draft.label.trim(),
    apiKey: apiKey.kind === "saved" ? props.host.apiKey : apiKey.kind === "new" ? apiKey.value : "",
  };
  const valid = keyValid && Option.isSome(parseRevylDeviceHostDraft(next));
  const problem = valid
    ? null
    : !keyValid
      ? gt("Enter a valid secret reference.")
      : gt("Give the host a name, https app URLs, and limits within the ranges shown.");

  const appUrl = (field: "iosAppUrl" | "androidAppUrl", label: string, placeholder: string) => (
    <label className="block space-y-1.5 text-sm">
      <span>{label}</span>
      <Input
        type="url"
        value={draft[field] ?? ""}
        placeholder={placeholder}
        disabled={props.busy}
        onChange={(event) => {
          const value = event.target.value.trim();
          setDraft((current) => withAppUrl(current, field, value));
        }}
      />
    </label>
  );

  const limit = (
    field: "maxSessions" | "maxSessionMinutes" | "macIdleMinutes",
    label: string,
    min: number,
    max: number,
  ) => (
    <label className="block space-y-1.5">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={draft[field]}
        disabled={props.busy}
        onChange={(event) => {
          const value = Number(event.target.value);
          setDraft((current) => ({ ...current, [field]: value }));
        }}
      />
    </label>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!props.busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !props.busy) props.onSave(next);
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.isNew ? gt("Add Revyl host") : gt("Edit Revyl host")}</DialogTitle>
            <DialogDescription>
              <T>
                The environment's server starts cloud simulators and emulators on Revyl with this
                key. Without a key here it uses REVYL_API_KEY.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block space-y-1.5 text-sm">
              <span>
                <T>Name</T>
              </span>
              <Input
                autoFocus
                required
                value={draft.label}
                disabled={props.busy}
                onChange={(event) => {
                  const label = event.target.value;
                  setDraft((current) => ({ ...current, label }));
                }}
              />
            </label>
            <div className="space-y-1.5 text-sm">
              <label htmlFor={keyId} className="block">
                <T>Revyl API key</T>
              </label>
              <div className="flex items-center gap-2">
                <SecretSourceInput
                  key={keyInputKey}
                  id={keyId}
                  aria-label={gt("Revyl API key")}
                  className="min-w-0 flex-1"
                  configured={apiKey.kind === "saved" && typeof props.host.apiKey === "string"}
                  value={
                    apiKey.kind === "new"
                      ? apiKey.value
                      : apiKey.kind === "saved" && isSecretReference(props.host.apiKey)
                        ? props.host.apiKey
                        : ""
                  }
                  sources={secretSources}
                  onValidityChange={setKeyValid}
                  onSecretChange={(secret) =>
                    setApiKey(secret ? { kind: "new", value: secret } : { kind: "cleared" })
                  }
                  disabled={props.busy}
                  placeholder={gt("Optional")}
                  onChange={(event) => {
                    const value = event.target.value;
                    setApiKey(
                      value
                        ? { kind: "new", value }
                        : props.host.apiKey
                          ? { kind: "saved" }
                          : { kind: "cleared" },
                    );
                  }}
                />
                {apiKey.kind !== "cleared" ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost-destructive"
                    aria-label={gt("Clear API key")}
                    onClick={() => {
                      setApiKey({ kind: "cleared" });
                      setKeyValid(true);
                      setKeyInputKey((key) => key + 1);
                    }}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
            {appUrl("iosAppUrl", gt("iOS app URL"), "https://…/MyApp-simulator.zip")}
            {appUrl("androidAppUrl", gt("Android app URL"), "https://…/app-debug.apk")}
            <p className="text-xs text-muted-foreground">
              <T>
                Revyl installs the app on every new device: a zipped simulator .app for iOS, an .apk
                for Android. A platform without an app URL is not offered.
              </T>
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.macs}
                disabled={props.busy}
                onChange={(event) => {
                  const macs = event.target.checked;
                  setDraft((current) => ({ ...current, macs }));
                }}
              />
              <span>{gt("Offer persistent Revyl Macs")}</span>
            </label>
            {draft.macs ? (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label className="block space-y-1.5">
                  <span>{gt("Mac snapshot")}</span>
                  <Input
                    value={draft.macSnapshot ?? ""}
                    placeholder={gt("Clean Mac")}
                    disabled={props.busy}
                    onChange={(event) => {
                      const value = event.target.value.trim();
                      setDraft((current) => {
                        const next = { ...current };
                        delete next.macSnapshot;
                        return value ? { ...next, macSnapshot: value } : next;
                      });
                    }}
                  />
                </label>
                {limit("macIdleMinutes", gt("Idle minutes"), 5, 240)}
              </div>
            ) : null}
            {draft.macs ? (
              <p className="text-xs text-muted-foreground">
                <T>
                  A Mac keeps its disk when it stops. It stops when its device closes, or after the
                  idle minutes with nobody opening or typing into it, and starts again when opened.
                </T>
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-3 text-sm">
              {limit("maxSessions", gt("Sessions at once"), 1, 10)}
              {limit("maxSessionMinutes", gt("Session minutes"), 5, 120)}
            </div>
            <p className="text-xs text-muted-foreground">
              {props.isNew
                ? gt(
                    "Sessions bill the Revyl organization until they stop, so each one ends after the session minutes even if it is still open.",
                  )
                : gt(
                    "Sessions bill the Revyl organization until they stop, so each one ends after the session minutes even if it is still open. Saving restarts this host, which stops its running sessions.",
                  )}
            </p>
            {problem === null ? null : (
              <p className="text-xs text-destructive" role="alert">
                {problem}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={props.busy} onClick={props.onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={props.busy || !valid}>
              {props.busy ? <Spinner size="xs" /> : null} <T>Save host</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
