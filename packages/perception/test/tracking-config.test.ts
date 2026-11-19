import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TRACKING_CONFIG,
  DEFAULT_TRACKING_MODE,
  TrackingConfigError,
  resolveTrackingConfig,
  type TrackingSpikeVerdict
} from "@chessonglass/perception";

const SPIKE_DOC = "docs/superpowers/spikes/2026-11-08-board-tracking.md";

const PASSING_SPIKE: TrackingSpikeVerdict = {
  status: "pass",
  evidencePath: SPIKE_DOC,
  recordedAtWallMs: Date.parse("2026-11-08T00:00:00.000Z")
};

function verdict(overrides: Partial<TrackingSpikeVerdict> = {}): TrackingSpikeVerdict {
  return { ...PASSING_SPIKE, ...overrides };
}

describe("tracking configuration defaults", () => {
  it("resolves to locator-only with no local tracking and no evidence by default", () => {
    const config = resolveTrackingConfig();
    expect(config).toEqual({
      mode: "locator-only",
      localTrackingAllowed: false,
      spikeEvidence: null
    });
    expect(DEFAULT_TRACKING_MODE).toBe("locator-only");
    expect(DEFAULT_TRACKING_CONFIG).toEqual(config);
  });

  it("returns frozen configuration objects that cannot be flipped in place", () => {
    const config = resolveTrackingConfig();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TRACKING_CONFIG)).toBe(true);
    expect(() => {
      (config as { mode?: string }).mode = "local-assisted";
    }).toThrow(TypeError);
  });

  it("does not enable local tracking when a passing verdict exists but locator-only was requested", () => {
    const config = resolveTrackingConfig({ mode: "locator-only", spikeVerdict: verdict() });
    expect(config.mode).toBe("locator-only");
    expect(config.localTrackingAllowed).toBe(false);
    expect(config.spikeEvidence).toEqual(verdict());
  });
});

describe("local-assisted gate", () => {
  it("enables local-assisted only with a recorded passing spike verdict", () => {
    const config = resolveTrackingConfig({ mode: "local-assisted", spikeVerdict: verdict() });
    expect(config.mode).toBe("local-assisted");
    expect(config.localTrackingAllowed).toBe(true);
    expect(config.spikeEvidence).toEqual(verdict());
  });

  it("rejects local-assisted when no spike verdict was recorded", () => {
    let raised: unknown = null;
    try {
      resolveTrackingConfig({ mode: "local-assisted" });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(TrackingConfigError);
    expect((raised as TrackingConfigError).code).toBe("local-assisted-without-evidence");
  });

  it.each(["fail", "inconclusive"] as const)(
    "rejects local-assisted when the recorded verdict is %s",
    (status) => {
      expect(() =>
        resolveTrackingConfig({ mode: "local-assisted", spikeVerdict: verdict({ status }) })
      ).toThrow(TrackingConfigError);
    }
  );
});

describe("tracking configuration argument validation", () => {
  it("rejects an unknown mode", () => {
    expect(() => resolveTrackingConfig({ mode: "turbo" as never })).toThrow(RangeError);
  });

  it("rejects malformed options", () => {
    expect(() => resolveTrackingConfig(null as never)).toThrow(RangeError);
    expect(() => resolveTrackingConfig(7 as never)).toThrow(RangeError);
  });

  it("rejects malformed spike verdicts", () => {
    const malformed: unknown[] = [
      { status: "pass", recordedAtWallMs: 0 },
      { status: "pass", evidencePath: "   ", recordedAtWallMs: 0 },
      { status: "pass", evidencePath: SPIKE_DOC, recordedAtWallMs: Number.NaN },
      { status: "pass", evidencePath: SPIKE_DOC, recordedAtWallMs: Number.POSITIVE_INFINITY },
      { status: "yes", evidencePath: SPIKE_DOC, recordedAtWallMs: 0 },
      { status: "pass", evidencePath: 3, recordedAtWallMs: 0 },
      { status: "pass", evidencePath: SPIKE_DOC, recordedAtWallMs: "now" },
      { status: "pass", evidencePath: SPIKE_DOC, recordedAtWallMs: 0, summary: 42 },
      SPIKE_DOC
    ];
    for (const bad of malformed) {
      expect(() => resolveTrackingConfig({ spikeVerdict: bad as never })).toThrow(RangeError);
    }
  });
});

describe("locator-only mode stays free of OpenCV and native modules", () => {
  const readSource = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  it("declares no OpenCV or native dependency in the perception package", () => {
    const manifest = JSON.parse(readSource("../package.json")) as {
      dependencies: Record<string, string>;
    };
    // sharp is the one sanctioned npm dependency beyond workspace packages
    // (bounded image/overlay composition, exact version pinned with the app);
    // an OpenCV binding or other native module must never appear here.
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@chessonglass/chess",
      "@chessonglass/contracts",
      "sharp"
    ]);
    expect(manifest.dependencies["sharp"]).toBe("0.35.5");
  });

  it("imports no external module in any tracking module (no OpenCV, no native bindings)", () => {
    const trackingSources = [
      "../src/tracking/board-locator.ts",
      "../src/tracking/geometry-state.ts",
      "../src/tracking/tracking-config.ts",
      "../src/tracking/local-tracker.ts"
    ];
    // Static and dynamic import specifiers only; prose mentions in doc
    // comments are irrelevant, imported modules are not.
    const importSpecifiers = (source: string): string[] =>
      [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)].map(
        (match) => match[1] ?? ""
      );
    // Every specifier must be a workspace package, a relative module or a
    // node builtin: nothing from npm, so no OpenCV binding or native module
    // can sneak into the tracking layer, including the injected-provider
    // contract itself.
    const allowedSpecifier = /^(?:@chessonglass\/|\.{1,2}\/|node:)/;
    for (const source of trackingSources) {
      for (const specifier of importSpecifiers(readSource(source))) {
        expect(specifier).toMatch(allowedSpecifier);
      }
    }
  });

  it("never imports the local tracker from the locator-only production path", () => {
    const locatorOnlySources = [
      "../src/tracking/board-locator.ts",
      "../src/tracking/geometry-state.ts",
      "../src/tracking/tracking-config.ts"
    ];
    for (const source of locatorOnlySources) {
      expect(readSource(source).match(/local-tracker\.js/)).toBeNull();
    }
  });
});
