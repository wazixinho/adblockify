/**
 * adblockify — blocks audio, billboard, video and sponsored ads and hides the
 * leftover ad UI. Ported to SpotiKit from ririxi's Spicetify extension.
 */

interface ProductStateAPI {
  putOverridesValues(params: { pairs: { [key: string]: string } }): Promise<void>;
  subValues(params: { keys: string[] }, callback: () => void): Promise<void>;
  transport: unknown;
}

interface DisableManager {
  disable?(): void | Promise<void>;
}

interface AdManagers {
  audio: DisableManager & {
    inStreamApi?: {
      adsCoreConnector?: {
        clearSlot?(slotId: string): void;
        subscribeToSlot?(slotId: string, callback: (data: { adSlotEvent: { slotId: string } }) => void): void;
      };
    };
    isNewAdsNpvEnabled?: boolean;
  };
  billboard?: DisableManager;
  embeddedAd?: {
    embeddedAdManager?: DisableManager;
  };
  leaderboard?: {
    disableLeaderboard?(): void | Promise<void>;
  };
  inStreamApi?: DisableManager;
  sponsoredPlaylist?: DisableManager;
  vto?: {
    manager?: DisableManager;
    isNewAdsNpvEnabled?: boolean;
  };
}

interface SettingsClient {
  updateAdServerEndpoint(params: { slotIds: string[]; url: string }): Promise<void>;
  updateDisplayTimeInterval(params: { slotId: string; timeInterval: bigint | string }): Promise<void>;
  updateSlotEnabled(params: { slotId: string; enabled: boolean }): Promise<void>;
  updateStreamTimeInterval(params: { slotId: string; timeInterval: bigint | string }): Promise<void>;
}

interface SlotsClient {
  clearAllAds(params: { slotId: string }): Promise<void>;
  getSlots(): Promise<{ adSlots: AdSlot[] }>;
}

interface TestingClient {
  addPlaytime(params: { seconds: number }): Promise<void>;
}

interface AdSlot {
  slotId?: string;
  slot_id?: string;
}

interface RemoteConfigProperty {
  source?: string;
  type?: string;
  name?: string;
  localValue?: boolean;
}

interface WebpackRequire {
  (id: string | number): any;
  m: Record<string | number, unknown>;
}

interface ChunkQueue {
  push(chunk: unknown): WebpackRequire;
}

interface WebpackCache {
  cache: any[];
  functionModules: any[];
}

const disableManager = async (manager: DisableManager | undefined): Promise<void> => {
  if (typeof manager?.disable === "function") await manager.disable();
};

function usesBigIntTimeInterval([major = 0, minor = 0, patch = 0]: number[]): boolean {
  if (major > 1) return true;
  if (major < 1) return false;
  if (minor > 2) return true;
  if (minor < 2) return false;
  return patch >= 82;
}

const getChunkQueue = (): ChunkQueue | undefined => {
  const w = window as unknown as Record<string, ChunkQueue | undefined>;
  return w?.rspackChunk || w?.webpackChunkclient_web || w?.rspackChunkclient_web;
};

const loadWebpack = async (signal: AbortSignal, sleep: (ms: number) => Promise<void>): Promise<WebpackCache> => {
  try {
    let chunkQueue = getChunkQueue();
    for (let attempt = 0; !chunkQueue && attempt < 20 && !signal.aborted; attempt++) {
      await sleep(50);
      chunkQueue = getChunkQueue();
    }
    if (!chunkQueue) throw new Error("Could not find webpack/rspack chunk queue");

    const req = chunkQueue.push([[Symbol()], {}, (re: WebpackRequire) => re]);
    const cache: any[] = [];
    for (const id of Object.keys(req.m)) {
      try {
        cache.push(req(id));
      } catch {
        // Some factories only run inside Spotify's own runtime; skip them.
      }
    }

    const modules = cache
      .filter((module) => typeof module === "object")
      .flatMap((module) => {
        try {
          return Object.values(module);
        } catch {
          return [];
        }
      });
    const webpackFactories = new Set<unknown>(Object.values(req.m));
    const functionModules: any[] = modules.flatMap((module: any): any[] =>
      typeof module === "function"
        ? [module]
        : typeof module === "object" && module
          ? Object.values(module).filter((value: any) => typeof value === "function" && !webpackFactories.has(value))
          : [],
    );

    return { cache, functionModules };
  } catch (error) {
    console.error("adblockify: Failed to load webpack", error);
    return { cache: [], functionModules: [] };
  }
};

const getSettingsClient = (cache: any[], functionModules: any[] = [], transport: unknown = {}): SettingsClient | null => {
  try {
    const bundled = cache.find((module: any) => module?.settingsClient)?.settingsClient;
    if (bundled) return bundled as SettingsClient;
    const Settings = functionModules.find(
      (module: any) =>
        module?.SERVICE_ID === "spotify.ads.esperanto.settings.proto.Settings" ||
        module?.SERVICE_ID === "spotify.ads.esperanto.proto.Settings",
    );
    return Settings ? (new Settings(transport) as SettingsClient) : null;
  } catch (error) {
    console.error("adblockify: Failed to get ads settings client", error);
    return null;
  }
};

const getSlotsClient = (functionModules: any[], transport: unknown): SlotsClient | null => {
  try {
    const Slots = functionModules.find(
      (module: any) =>
        module?.SERVICE_ID === "spotify.ads.esperanto.slots.proto.Slots" ||
        module?.SERVICE_ID === "spotify.ads.esperanto.proto.Slots",
    );
    return Slots ? (new Slots(transport) as SlotsClient) : null;
  } catch (error) {
    console.error("adblockify: Failed to get slots client", error);
    return null;
  }
};

const getTestingClient = (functionModules: any[], transport: unknown): TestingClient | null => {
  try {
    const Testing = functionModules.find(
      (module: any) =>
        module?.SERVICE_ID === "spotify.ads.esperanto.testing.proto.Testing" ||
        module?.SERVICE_ID === "spotify.ads.esperanto.proto.Testing",
    );
    return Testing ? (new Testing(transport) as TestingClient) : null;
  } catch (error) {
    console.error("adblockify: Failed to get testing client", error);
    return null;
  }
};

const start: SpotiKit.Start = async (ctx) => {
  const { signal } = ctx;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sleeping = new Set<() => void>();

  const after = (fn: () => void, ms: number): void => {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!signal.aborted) fn();
    }, ms);
    timers.add(id);
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const wake = () => {
        resolve();
        sleeping.delete(wake);
      };
      const id = setTimeout(() => {
        timers.delete(id);
        wake();
      }, ms);
      timers.add(id);
      sleeping.add(wake);
    });

  ctx.onStop(() => {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    for (const wake of sleeping) wake();
    sleeping.clear();
  });

  await SpotiKit.ready;

  const webpackCache = await loadWebpack(signal, sleep);

  const getAdManagers = (): AdManagers | undefined => {
    const managers = SpotiKit.Platform.AdManagers as AdManagers | undefined;
    if (!managers || !managers.audio || Object.keys(managers).length === 0) return undefined;
    return managers;
  };

  let found: AdManagers | undefined;
  for (let attempt = 0; attempt < 100 && !signal.aborted; attempt++) {
    found = getAdManagers();
    if (found) break;
    await sleep(100);
  }
  if (!found || signal.aborted) {
    if (!signal.aborted) console.warn("adblockify: AdManagers never became available; not starting.");
    return;
  }
  const adManagers: AdManagers = found;
  const { audio } = adManagers;

  const UserAPI = SpotiKit.Platform.UserAPI as
    | { _product_state?: ProductStateAPI; _product_state_service?: ProductStateAPI }
    | undefined;
  const productState: ProductStateAPI | undefined =
    UserAPI?._product_state || UserAPI?._product_state_service || SpotiKit.Platform.ProductStateAPI?.productStateApi;

  const version: number[] = String(SpotiKit.Platform.version ?? "1.3.0")
    .split(".")
    .map((part) => Number.parseInt(part));

  let slots: AdSlot[] = [];
  for (let attempt = 0; attempt < 10 && !slots.length && !signal.aborted; attempt++) {
    const slotsClient = getSlotsClient(webpackCache.functionModules, productState?.transport);
    if (slotsClient) {
      try {
        slots = (await slotsClient.getSlots()).adSlots ?? [];
      } catch (error) {
        console.error("adblockify: Failed to get ad slots from the slots client\n", error);
      }
    } else {
      try {
        slots = (await SpotiKit.Http.get<AdSlot[]>("sp://ads/v1/slots")) ?? [];
      } catch (error) {
        console.error("adblockify: Failed to fetch sp://ads/v1/slots\n", error);
      }
    }
    if (!slots.length && attempt < 9) await sleep(100);
  }

  const retryCounts = new Map<string, { count: number }>();
  const retryCounter = (slotId: string, action: "increment" | "clear" | "get"): number | undefined => {
    if (!retryCounts.has(slotId)) retryCounts.set(slotId, { count: 0 });
    const entry = retryCounts.get(slotId);
    if (action === "increment" && entry) entry.count++;
    else if (action === "clear") retryCounts.delete(slotId);
    else if (action === "get") return entry?.count;
    return undefined;
  };

  const disableAds = async (): Promise<void> => {
    try {
      await productState?.putOverridesValues({
        pairs: { ads: "0", catalogue: "premium", product: "premium", type: "premium" },
      });
    } catch (error: unknown) {
      console.error("adblockify: Failed inside `disableAds` function\n", error);
    }
  };

  const configureAdManagers = async (): Promise<void> => {
    if (signal.aborted) return;
    try {
      const { billboard, embeddedAd, inStreamApi, leaderboard, sponsoredPlaylist, vto } = adManagers;
      const testingClient = getTestingClient(webpackCache.functionModules, productState?.transport);

      after(disableAds, 100);

      if (testingClient) testingClient.addPlaytime({ seconds: -100000000000 });
      else await SpotiKit.Http.post("sp://ads/v1/testing/playtime", { body: { value: -100000000000 } });

      await disableManager(audio);
      audio.isNewAdsNpvEnabled = false;
      await disableManager(billboard);
      if (typeof leaderboard?.disableLeaderboard === "function") await leaderboard?.disableLeaderboard();
      await disableManager(sponsoredPlaylist);
      await disableManager(inStreamApi);
      if (vto) {
        await disableManager(vto.manager);
        vto.isNewAdsNpvEnabled = false;
      }
      await disableManager(embeddedAd?.embeddedAdManager);
    } catch (error: unknown) {
      console.error("adblockify: Failed inside `configureAdManagers` function\n", error);
    }
  };

  const updateSlotSettings = async (slotId: string): Promise<void> => {
    try {
      const settingsClient = getSettingsClient(webpackCache.cache, webpackCache.functionModules, productState?.transport);
      if (!settingsClient) return;
      const timeInterval = usesBigIntTimeInterval(version) ? 0n : "0";
      await settingsClient.updateAdServerEndpoint({
        slotIds: [slotId],
        url: "http://localhost/no/thanks",
      });
      await settingsClient.updateStreamTimeInterval({ slotId, timeInterval });
      await settingsClient.updateSlotEnabled({ slotId, enabled: false });
      await settingsClient.updateDisplayTimeInterval({ slotId, timeInterval });
    } catch (error: unknown) {
      console.error("adblockify: Failed inside `updateSlotSettings` function\n", error);
    }
  };

  const handleAdSlot = (data: { adSlotEvent: { slotId?: string } }): void => {
    if (signal.aborted) return;
    const slotId = data?.adSlotEvent?.slotId;
    if (!slotId) return;

    try {
      const adsCoreConnector = audio.inStreamApi?.adsCoreConnector;
      if (typeof adsCoreConnector?.clearSlot === "function") adsCoreConnector.clearSlot(slotId);
      const slotsClient = getSlotsClient(webpackCache.functionModules, productState?.transport);
      if (slotsClient) slotsClient.clearAllAds({ slotId });
      void updateSlotSettings(slotId);
    } catch (error: unknown) {
      console.error("adblockify: Failed inside `handleAdSlot` function. Retrying in 1 second...\n", error);
      retryCounter(slotId, "increment");
      if ((retryCounter(slotId, "get") ?? 0) > 5) {
        console.error(`adblockify: Failed inside \`handleAdSlot\` function for 5th time. Giving up...\nSlot id: ${slotId}.`);
        retryCounter(slotId, "clear");
        return;
      }
      after(() => handleAdSlot(data), 1000);
    }
    void configureAdManagers();
  };

  const subToSlot = (slot: string): void => {
    try {
      const connector = audio.inStreamApi?.adsCoreConnector;
      if (typeof connector?.subscribeToSlot !== "function") {
        throw new Error(`No adsCoreConnector available to subscribe to slot "${slot}"`);
      }
      connector.subscribeToSlot(slot, handleAdSlot);
    } catch (error: unknown) {
      console.error("adblockify: Failed inside `subToSlot` function\n", error);
    }
  };

  const bindToSlots = (): void => {
    for (const slot of slots) {
      const slotId = slot?.slotId || slot?.slot_id;
      if (!slotId) continue;
      subToSlot(slotId);
      after(() => handleAdSlot({ adSlotEvent: { slotId } }), 50);
    }
  };

  const updateAllSlotSettings = (): void => {
    for (const slot of slots) {
      const slotId = slot?.slotId || slot?.slot_id;
      if (slotId) void updateSlotSettings(slotId);
    }
  };

  const hideAdLikeElements = (): void => {
    const upgradeText = (
      SpotiKit.Locale.has("upgrade.tooltip.title") ? SpotiKit.Locale.t("upgrade.tooltip.title") : "Upgrade"
    ).replaceAll('"', '\\"');
    const semantic = (name: string): string => {
      const resolved = SpotiKit.classMap[name];
      return `.${typeof resolved === "string" && resolved ? resolved : name}`;
    };
    const selectors = [
      semantic("main-leaderboardComponent-container"),
      semantic("sponsor-container"),
      semantic("main-topBar-UpgradeButton"),
      `button[title="${upgradeText}"]`,
      `button[aria-label="${upgradeText}"]`,
      'a[href*="spotify.com/premium"]',
      'div[data-testid*="hpto"]',
      "#leaderboard-ad-element",
      "#view-billboard-ad",
      '[data-testid="billboard-minimized"]',
      '[data-testid="billboard-image-link"]',
      '[data-testid="home-ad-card"]',
      '[data-testid="home-ads-container"]',
      '[data-testid*="home-ad-"]',
      '[data-testid="signup-bar"]',
      `div:has(> ${semantic("main-leaderboardComponent-container")})`,
    ];
    ctx.style(
      `${selectors.join(", ")} {display: none !important;} ${semantic("main-home-homeHeader")} {height: 256px !important;}`,
    );
  };

  const enableExperimentalFeatures = async (): Promise<void> => {
    if (signal.aborted) return;
    try {
      const expFeatures = JSON.parse(window.localStorage.getItem("spicetify-exp-features") || "{}") as Record<
        string,
        { value?: unknown }
      >;
      if (typeof expFeatures?.enableEsperantoMigration?.value !== "undefined") expFeatures.enableEsperantoMigration.value = true;
      if (typeof expFeatures?.enableInAppMessaging?.value !== "undefined") expFeatures.enableInAppMessaging.value = false;
      if (typeof expFeatures?.hideUpgradeCTA?.value !== "undefined") expFeatures.hideUpgradeCTA.value = true;
      if (typeof expFeatures?.enablePremiumUserForMiniPlayer?.value !== "undefined") {
        expFeatures.enablePremiumUserForMiniPlayer.value = true;
      }
      window.localStorage.setItem("spicetify-exp-features", JSON.stringify(expFeatures));
      const overrides = {
        enableEsperantoMigration: true,
        enableInAppMessaging: false,
        hideUpgradeCTA: true,
        enablePremiumUserForMiniPlayer: true,
      };

      const RemoteConfigDebugAPI = SpotiKit.Platform.RemoteConfigDebugAPI as
        | {
            getProperties?: () => Promise<RemoteConfigProperty[]>;
            setOverride?: (ref: unknown, value: unknown) => Promise<void>;
          }
        | undefined;
      if (
        typeof RemoteConfigDebugAPI?.getProperties === "function" &&
        typeof RemoteConfigDebugAPI?.setOverride === "function"
      ) {
        const properties: RemoteConfigProperty[] = (await RemoteConfigDebugAPI.getProperties()) ?? [];
        for (const [key, value] of Object.entries(overrides)) {
          const ref = properties.find(
            (property) => property?.source === "web" && property?.type === "boolean" && property?.name === key,
          );
          if (!ref) continue;
          await RemoteConfigDebugAPI?.setOverride({ ref, value }, { autoRunOverrideEffects: ref.localValue !== value });
        }
      } else if (typeof RemoteConfigDebugAPI?.setOverride === "function") {
        for (const [key, value] of Object.entries(overrides)) {
          await RemoteConfigDebugAPI?.setOverride({ source: "web", type: "boolean", name: key }, value);
        }
      }
    } catch (error: unknown) {
      console.error("adblockify: Failed inside `enableExperimentalFeatures` function\n", error);
    }
  };

  bindToSlots();
  hideAdLikeElements();

  // No unsubscribe API exists for subValues; the signal guard turns it into a no-op after stop.
  try {
    void productState?.subValues({ keys: ["ads", "catalogue", "product", "type"] }, () => {
      if (!signal.aborted) void configureAdManagers();
    });
  } catch (error: unknown) {
    console.error("adblockify: Failed to subscribe to product state values\n", error);
  }

  void enableExperimentalFeatures();
  after(enableExperimentalFeatures, 3 * 1000);

  // Updated once more after 5 seconds; some settings only stick once Spotify has settled.
  after(updateAllSlotSettings, 5 * 1000);
};

export default start;
