// Built by spotikit-kit from src/extension.ts. Edit that file, not this one.

// src/extension.ts
var disableManager = async (manager) => {
  if (typeof manager?.disable === "function") await manager.disable();
};
function usesBigIntTimeInterval([major = 0, minor = 0, patch = 0]) {
  if (major > 1) return true;
  if (major < 1) return false;
  if (minor > 2) return true;
  if (minor < 2) return false;
  return patch >= 82;
}
var getChunkQueue = () => {
  const w = window;
  return w?.rspackChunk || w?.webpackChunkclient_web || w?.rspackChunkclient_web;
};
var loadWebpack = async (signal, sleep) => {
  try {
    let chunkQueue = getChunkQueue();
    for (let attempt = 0; !chunkQueue && attempt < 20 && !signal.aborted; attempt++) {
      await sleep(50);
      chunkQueue = getChunkQueue();
    }
    if (!chunkQueue) throw new Error("Could not find webpack/rspack chunk queue");
    const req = chunkQueue.push([[/* @__PURE__ */ Symbol()], {}, (re) => re]);
    const cache = [];
    for (const id of Object.keys(req.m)) {
      try {
        cache.push(req(id));
      } catch {
      }
    }
    const modules = cache.filter((module) => typeof module === "object").flatMap((module) => {
      try {
        return Object.values(module);
      } catch {
        return [];
      }
    });
    const webpackFactories = new Set(Object.values(req.m));
    const functionModules = modules.flatMap(
      (module) => typeof module === "function" ? [module] : typeof module === "object" && module ? Object.values(module).filter((value) => typeof value === "function" && !webpackFactories.has(value)) : []
    );
    return { cache, functionModules };
  } catch (error) {
    console.error("adblockify: Failed to load webpack", error);
    return { cache: [], functionModules: [] };
  }
};
var getSettingsClient = (cache, functionModules = [], transport = {}) => {
  try {
    const bundled = cache.find((module) => module?.settingsClient)?.settingsClient;
    if (bundled) return bundled;
    const Settings = functionModules.find(
      (module) => module?.SERVICE_ID === "spotify.ads.esperanto.settings.proto.Settings" || module?.SERVICE_ID === "spotify.ads.esperanto.proto.Settings"
    );
    return Settings ? new Settings(transport) : null;
  } catch (error) {
    console.error("adblockify: Failed to get ads settings client", error);
    return null;
  }
};
var getSlotsClient = (functionModules, transport) => {
  try {
    const Slots = functionModules.find(
      (module) => module?.SERVICE_ID === "spotify.ads.esperanto.slots.proto.Slots" || module?.SERVICE_ID === "spotify.ads.esperanto.proto.Slots"
    );
    return Slots ? new Slots(transport) : null;
  } catch (error) {
    console.error("adblockify: Failed to get slots client", error);
    return null;
  }
};
var getTestingClient = (functionModules, transport) => {
  try {
    const Testing = functionModules.find(
      (module) => module?.SERVICE_ID === "spotify.ads.esperanto.testing.proto.Testing" || module?.SERVICE_ID === "spotify.ads.esperanto.proto.Testing"
    );
    return Testing ? new Testing(transport) : null;
  } catch (error) {
    console.error("adblockify: Failed to get testing client", error);
    return null;
  }
};
var start = async (ctx) => {
  const { signal } = ctx;
  const timers = /* @__PURE__ */ new Set();
  const sleeping = /* @__PURE__ */ new Set();
  const after = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!signal.aborted) fn();
    }, ms);
    timers.add(id);
  };
  const sleep = (ms) => new Promise((resolve) => {
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
  const getAdManagers = () => {
    const managers = SpotiKit.Platform.AdManagers;
    if (!managers || !managers.audio || Object.keys(managers).length === 0) return void 0;
    return managers;
  };
  let found;
  for (let attempt = 0; attempt < 100 && !signal.aborted; attempt++) {
    found = getAdManagers();
    if (found) break;
    await sleep(100);
  }
  if (!found || signal.aborted) {
    if (!signal.aborted) console.warn("adblockify: AdManagers never became available; not starting.");
    return;
  }
  const adManagers = found;
  const { audio } = adManagers;
  const UserAPI = SpotiKit.Platform.UserAPI;
  const productState = UserAPI?._product_state || UserAPI?._product_state_service || SpotiKit.Platform.ProductStateAPI?.productStateApi;
  const version = String(SpotiKit.Platform.version ?? "1.3.0").split(".").map((part) => Number.parseInt(part));
  let slots = [];
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
        slots = await SpotiKit.Http.get("sp://ads/v1/slots") ?? [];
      } catch (error) {
        console.error("adblockify: Failed to fetch sp://ads/v1/slots\n", error);
      }
    }
    if (!slots.length && attempt < 9) await sleep(100);
  }
  const retryCounts = /* @__PURE__ */ new Map();
  const retryCounter = (slotId, action) => {
    if (!retryCounts.has(slotId)) retryCounts.set(slotId, { count: 0 });
    const entry = retryCounts.get(slotId);
    if (action === "increment" && entry) entry.count++;
    else if (action === "clear") retryCounts.delete(slotId);
    else if (action === "get") return entry?.count;
    return void 0;
  };
  const disableAds = async () => {
    try {
      await productState?.putOverridesValues({
        pairs: { ads: "0", catalogue: "premium", product: "premium", type: "premium" }
      });
    } catch (error) {
      console.error("adblockify: Failed inside `disableAds` function\n", error);
    }
  };
  const configureAdManagers = async () => {
    if (signal.aborted) return;
    try {
      const { billboard, embeddedAd, inStreamApi, leaderboard, sponsoredPlaylist, vto } = adManagers;
      const testingClient = getTestingClient(webpackCache.functionModules, productState?.transport);
      after(disableAds, 100);
      if (testingClient) testingClient.addPlaytime({ seconds: -1e11 });
      else await SpotiKit.Http.post("sp://ads/v1/testing/playtime", { body: { value: -1e11 } });
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
    } catch (error) {
      console.error("adblockify: Failed inside `configureAdManagers` function\n", error);
    }
  };
  const updateSlotSettings = async (slotId) => {
    try {
      const settingsClient = getSettingsClient(webpackCache.cache, webpackCache.functionModules, productState?.transport);
      if (!settingsClient) return;
      const timeInterval = usesBigIntTimeInterval(version) ? 0n : "0";
      await settingsClient.updateAdServerEndpoint({
        slotIds: [slotId],
        url: "http://localhost/no/thanks"
      });
      await settingsClient.updateStreamTimeInterval({ slotId, timeInterval });
      await settingsClient.updateSlotEnabled({ slotId, enabled: false });
      await settingsClient.updateDisplayTimeInterval({ slotId, timeInterval });
    } catch (error) {
      console.error("adblockify: Failed inside `updateSlotSettings` function\n", error);
    }
  };
  const handleAdSlot = (data) => {
    if (signal.aborted) return;
    const slotId = data?.adSlotEvent?.slotId;
    if (!slotId) return;
    try {
      const adsCoreConnector = audio.inStreamApi?.adsCoreConnector;
      if (typeof adsCoreConnector?.clearSlot === "function") adsCoreConnector.clearSlot(slotId);
      const slotsClient = getSlotsClient(webpackCache.functionModules, productState?.transport);
      if (slotsClient) slotsClient.clearAllAds({ slotId });
      void updateSlotSettings(slotId);
    } catch (error) {
      console.error("adblockify: Failed inside `handleAdSlot` function. Retrying in 1 second...\n", error);
      retryCounter(slotId, "increment");
      if ((retryCounter(slotId, "get") ?? 0) > 5) {
        console.error(`adblockify: Failed inside \`handleAdSlot\` function for 5th time. Giving up...
Slot id: ${slotId}.`);
        retryCounter(slotId, "clear");
        return;
      }
      after(() => handleAdSlot(data), 1e3);
    }
    void configureAdManagers();
  };
  const subToSlot = (slot) => {
    try {
      const connector = audio.inStreamApi?.adsCoreConnector;
      if (typeof connector?.subscribeToSlot !== "function") {
        throw new Error(`No adsCoreConnector available to subscribe to slot "${slot}"`);
      }
      connector.subscribeToSlot(slot, handleAdSlot);
    } catch (error) {
      console.error("adblockify: Failed inside `subToSlot` function\n", error);
    }
  };
  const bindToSlots = () => {
    for (const slot of slots) {
      const slotId = slot?.slotId || slot?.slot_id;
      if (!slotId) continue;
      subToSlot(slotId);
      after(() => handleAdSlot({ adSlotEvent: { slotId } }), 50);
    }
  };
  const updateAllSlotSettings = () => {
    for (const slot of slots) {
      const slotId = slot?.slotId || slot?.slot_id;
      if (slotId) void updateSlotSettings(slotId);
    }
  };
  const hideAdLikeElements = () => {
    const upgradeText = (SpotiKit.Locale.has("upgrade.tooltip.title") ? SpotiKit.Locale.t("upgrade.tooltip.title") : "Upgrade").replaceAll('"', '\\"');
    const semantic = (name) => {
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
      `div:has(> ${semantic("main-leaderboardComponent-container")})`
    ];
    ctx.style(
      `${selectors.join(", ")} {display: none !important;} ${semantic("main-home-homeHeader")} {height: 256px !important;}`
    );
  };
  const enableExperimentalFeatures = async () => {
    if (signal.aborted) return;
    try {
      const expFeatures = JSON.parse(window.localStorage.getItem("spicetify-exp-features") || "{}");
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
        enablePremiumUserForMiniPlayer: true
      };
      const RemoteConfigDebugAPI = SpotiKit.Platform.RemoteConfigDebugAPI;
      if (typeof RemoteConfigDebugAPI?.getProperties === "function" && typeof RemoteConfigDebugAPI?.setOverride === "function") {
        const properties = await RemoteConfigDebugAPI.getProperties() ?? [];
        for (const [key, value] of Object.entries(overrides)) {
          const ref = properties.find(
            (property) => property?.source === "web" && property?.type === "boolean" && property?.name === key
          );
          if (!ref) continue;
          await RemoteConfigDebugAPI?.setOverride({ ref, value }, { autoRunOverrideEffects: ref.localValue !== value });
        }
      } else if (typeof RemoteConfigDebugAPI?.setOverride === "function") {
        for (const [key, value] of Object.entries(overrides)) {
          await RemoteConfigDebugAPI?.setOverride({ source: "web", type: "boolean", name: key }, value);
        }
      }
    } catch (error) {
      console.error("adblockify: Failed inside `enableExperimentalFeatures` function\n", error);
    }
  };
  bindToSlots();
  hideAdLikeElements();
  try {
    void productState?.subValues({ keys: ["ads", "catalogue", "product", "type"] }, () => {
      if (!signal.aborted) void configureAdManagers();
    });
  } catch (error) {
    console.error("adblockify: Failed to subscribe to product state values\n", error);
  }
  void enableExperimentalFeatures();
  after(enableExperimentalFeatures, 3 * 1e3);
  after(updateAllSlotSettings, 5 * 1e3);
};
var extension_default = start;
export {
  extension_default as default
};
