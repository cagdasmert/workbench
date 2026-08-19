import { useEffect, useRef } from 'react';
import type { ActivePanel } from '@workbench/plugin-host';
import type { PanelTeardown } from '@workbench/plugin-sdk';

/**
 * Invariant 7, the non-React half. The error boundary inside definePanel catches
 * render errors in React plugins, but it cannot catch a mount() that throws before
 * any tree exists, and it does not exist at all for a plugin drawing to a canvas.
 */
function renderErrorCard(el: HTMLElement, err: unknown, onReload?: () => void): void {
  const error = err instanceof Error ? err : new Error(String(err));
  el.replaceChildren();

  const card = el.ownerDocument.createElement('div');
  card.className = 'panel-error';

  const trace = el.ownerDocument.createElement('pre');
  trace.textContent = `Panel failed to mount\n\n${error.message}\n\n${error.stack ?? ''}`;
  card.append(trace);

  // Architecture §4.4 promises this button on every failure card.
  if (onReload !== undefined) {
    const button = el.ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = 'Reload plugin';
    button.addEventListener('click', onReload);
    card.append(button);
  }

  el.append(card);
}

export function PanelHost({
  panel,
  onReload,
}: {
  panel: ActivePanel | null;
  onReload?: (pluginId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // mount() and its teardown are both async, but React's cleanup contract is
  // synchronous — a cleanup cannot await. Without a queue, a hot reload runs the
  // old panel's teardown *after* the new panel has mounted into the same element,
  // which wipes the new React root and throws NotFoundError from the old one.
  // React always runs cleanup(N) before effect(N+1), so appending both to one
  // chain gives: mount(N) → teardown(N) → mount(N+1), in order, always.
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const el = ref.current;
    if (el === null || panel === null) return;

    let disposed = false;
    let teardown: PanelTeardown | void;

    const runTeardown = async (): Promise<void> => {
      try {
        await teardown?.();
      } catch (err) {
        console.error('[shell] panel teardown failed', err);
      }
      teardown = undefined;
    };

    queue.current = queue.current.then(async () => {
      if (disposed) return;              // torn down before our turn came up
      try {
        teardown = await panel.definition.mount(el, panel.ctx);
      } catch (err: unknown) {
        const owner = panel.ctx.plugin.id;   // invariant 7, non-React path
        renderErrorCard(el, err, onReload === undefined ? undefined : () => onReload(owner));
      }
    });

    return () => {
      disposed = true;
      queue.current = queue.current.then(async () => {
        await runTeardown();
        el.replaceChildren();   // the plugin owned this subtree, React never did
      });
    };
  }, [panel, onReload]);

  // The container div is rendered unconditionally and never swapped. If React were
  // allowed to unmount it when no panel is open, a reload would destroy the
  // plugin's subtree out from under its own React root.
  return (
    <>
      {panel === null && (
        <div className="panel-empty">
          <p>No panel open. Pick one from the <strong>Plugins</strong> menu.</p>
        </div>
      )}
      <div ref={ref} className="panel-host" hidden={panel === null} />
    </>
  );
}
