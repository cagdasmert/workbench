import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '@workbench/plugin-sdk';
import { assertMayWrite, loadFsPermissions } from './fs-permissions.js';

function manifest(id: string, permissions?: string[]): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: '1.0',
    main: './dist/index.js',
    activationEvents: [],
    contributes: {},
    ...(permissions === undefined ? {} : { permissions }),
  };
}

describe('fs write permissions', () => {
  it('allows a plugin that declares fs:write:user-selected', () => {
    loadFsPermissions([manifest('image-viewer', ['fs:write:user-selected'])]);
    expect(() => assertMayWrite('image-viewer')).not.toThrow();
  });

  it('denies a plugin that declares only read', () => {
    loadFsPermissions([manifest('image-viewer', ['fs:read:user-selected'])]);
    expect(() => assertMayWrite('image-viewer')).toThrow(/declares no fs:write:user-selected/);
  });

  it('denies a plugin with no permissions at all', () => {
    loadFsPermissions([manifest('hello')]);
    expect(() => assertMayWrite('hello')).toThrow(/declares no fs:write:user-selected/);
  });

  it('denies a plugin that was never loaded', () => {
    loadFsPermissions([manifest('image-viewer', ['fs:write:user-selected'])]);
    expect(() => assertMayWrite('stranger')).toThrow(/declares no fs:write:user-selected/);
  });

  it('forgets permissions from a previous load', () => {
    loadFsPermissions([manifest('image-viewer', ['fs:write:user-selected'])]);
    loadFsPermissions([manifest('image-viewer')]);
    expect(() => assertMayWrite('image-viewer')).toThrow(/declares no fs:write:user-selected/);
  });
});
