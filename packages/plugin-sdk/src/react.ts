import { createRoot } from 'react-dom/client';
import {
  Component as ReactComponent, createElement,
  type ComponentType, type ReactNode,
} from 'react';
import type { PanelDefinition, PanelContext } from './index.js';

/**
 * Architecture invariant 7 ("panels render inside error boundaries") lives here,
 * not in the shell. A plugin's React tree is its own createRoot, so a boundary in
 * the shell's tree cannot see into it — it has to be inside definePanel.
 */
class PanelErrorBoundary extends ReactComponent<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return createElement(
      'pre',
      { className: 'panel-error' },
      `${this.state.error.message}\n\n${this.state.error.stack ?? ''}`,
    );
  }
}

export function definePanel(
  Component: ComponentType<{ ctx: PanelContext }>,
): PanelDefinition {
  return {
    mount(el, ctx) {
      const root = createRoot(el);
      root.render(createElement(PanelErrorBoundary, null,
        createElement(Component, { ctx })));
      return () => root.unmount();     // per-mount state — no shared closure
    },
  };
}
