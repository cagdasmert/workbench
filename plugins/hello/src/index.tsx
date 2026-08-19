import type { Plugin } from '@workbench/plugin-sdk';
import { definePanel } from '@workbench/plugin-sdk/react';

export const plugin: Plugin = {
  activate(ctx) {
    ctx.log.info('hello activating');

    ctx.registerPanel('hello.main', definePanel(({ ctx: panelCtx }) => (
      <div style={{ padding: 24, fontFamily: 'system-ui' }}>
        <h1>Hello from {panelCtx.plugin.id}</h1>
        <p>Edit this file and watch it reload.</p>
      </div>
    )));

    ctx.registerCommand('hello.open', () => ctx.workspace.openPanel('hello.main'));
  },

  deactivate() {
    console.log('hello deactivating');
  },
};
