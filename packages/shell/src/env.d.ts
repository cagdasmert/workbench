import type { WorkbenchHostBridge } from '@workbench/plugin-host';

declare global {
  interface Window {
    workbenchHost: WorkbenchHostBridge;
  }
}

export {};
