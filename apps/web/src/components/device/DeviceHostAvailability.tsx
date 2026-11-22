import type { DevicePlatform, DevicePlatformAvailability } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { Check, Minus } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

const platformLabel = (platform: DevicePlatform) =>
  platform === "macos" ? "macOS" : platform === "ios" ? "iOS" : "Android";

export function DeviceHostAvailability({
  platforms,
}: {
  platforms: ReadonlyArray<DevicePlatformAvailability>;
}) {
  const gt = useGT();
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {platforms.map((platform) => (
        <Tooltip key={platform.platform}>
          <TooltipTrigger render={<span tabIndex={0} className="inline-flex items-center gap-1" />}>
            {platform.available ? <Check className="size-3" /> : <Minus className="size-3" />}
            {platform.available
              ? gt("{platform} available", {
                  platform: platformLabel(platform.platform),
                })
              : gt("{platform} unavailable", {
                  platform: platformLabel(platform.platform),
                })}
          </TooltipTrigger>
          <TooltipPopup>
            {platform.reason ??
              gt("{platform} available", {
                platform: platformLabel(platform.platform),
              })}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
