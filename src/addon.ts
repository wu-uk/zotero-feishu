import { config } from "../package.json";
import hooks from "./hooks";
import { SyncService } from "./modules/syncService";
import { SyncStatusService } from "./modules/syncStatus";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    preferencePaneID?: string;
    menuIDs?: string[];
    prefs?: { window: Window; error?: unknown };
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  public sync: SyncService;
  public syncStatus: SyncStatusService;
  // APIs
  public api: object;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
    };
    this.hooks = hooks;
    this.sync = new SyncService();
    this.syncStatus = new SyncStatusService();
    this.api = {};
  }
}

export default Addon;
