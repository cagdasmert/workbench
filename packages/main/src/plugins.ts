import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CommandArgSchema, PluginManifest, PropertySchema, SettingsSchema,
} from '@workbench/plugin-sdk';

/** id → absolute plugin directory. Populated by scanPlugins, read by the protocol handler. */
export const pluginRoots = new Map<string, string>();

/** Host API version. A plugin declaring a different major is not activated. */
const SUPPORTED_API_MAJOR = 1;

function requireString(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${where}: "${key}" must be a non-empty string`);
  }
  return v;
}

function requireObject(v: unknown, key: string, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where}: "${key}" must be an object`);
  }
  return v as Record<string, unknown>;
}

function stringArray(v: unknown, key: string, where: string): string[] {
  if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) {
    throw new Error(`${where}: "${key}" must be an array of strings`);
  }
  return v as string[];
}

/**
 * Shallow entry validation. Only the fields the shell actually reads are checked —
 * a hand-written check is deliberate for M0; a schema validator is M3.
 */
function entries<T>(
  v: unknown,
  key: string,
  where: string,
  read: (o: Record<string, unknown>, at: string) => T,
): T[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error(`${where}: "${key}" must be an array`);
  return v.map((e, i) => read(requireObject(e, `${key}[${i}]`, where), `${where} ${key}[${i}]`));
}

const PROP_TYPES = new Set(['string', 'number', 'boolean']);

const MODIFIER_ORDER = ['cmd', 'alt', 'ctrl', 'shift'];

/**
 * Canonical chord form, so a manifest writing "Shift+Cmd+F" and a user rebind
 * writing "cmd+shift+f" compare equal. Normalizing at discovery means the
 * matcher never has to.
 */
export function normalizeChord(raw: string, where: string): string {
  const parts = raw.toLowerCase().split('+').map((p) => p.trim()).filter((p) => p !== '');
  const mods: string[] = [];
  let key = '';

  for (const part of parts) {
    const mod = part === 'meta' || part === 'command' ? 'cmd'
      : part === 'control' ? 'ctrl'
      : part === 'option' ? 'alt'
      : part;
    if (MODIFIER_ORDER.includes(mod)) {
      if (!mods.includes(mod)) mods.push(mod);
    } else if (key === '') {
      key = mod;
    } else {
      throw new Error(`${where}: chord "${raw}" has more than one non-modifier key`);
    }
  }

  if (key === '') throw new Error(`${where}: chord "${raw}" has no key`);
  mods.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return [...mods, key].join('+');
}

/**
 * The shell renders a form from this and writes values back, so a malformed
 * schema is not a cosmetic problem — it is an uneditable or mistyped setting.
 * Check it at discovery, where the plugin can be marked broken.
 */
function validateSettings(raw: unknown, where: string): SettingsSchema {
  const o = requireObject(raw, 'settings', where);
  const out: SettingsSchema = {};

  for (const [key, value] of Object.entries(o)) {
    const at = `${where} settings.${key}`;
    const prop = requireObject(value, key, at);
    const type = prop['type'];
    if (typeof type !== 'string' || !PROP_TYPES.has(type)) {
      throw new Error(`${at}: "type" must be one of ${[...PROP_TYPES].join(', ')}`);
    }

    const description = prop['description'];
    if (description !== undefined && typeof description !== 'string') {
      throw new Error(`${at}: "description" must be a string`);
    }

    const enumValues = prop['enum'];
    if (enumValues !== undefined) {
      if (!Array.isArray(enumValues) || enumValues.some((e) => typeof e !== 'string')) {
        throw new Error(`${at}: "enum" must be an array of strings`);
      }
      if (type !== 'string') throw new Error(`${at}: "enum" is only valid for type "string"`);
    }

    const dflt = prop['default'];
    if (dflt !== undefined) {
      if (typeof dflt !== type) throw new Error(`${at}: "default" must be a ${type}`);
      if (Array.isArray(enumValues) && !enumValues.includes(dflt as string)) {
        throw new Error(`${at}: "default" must be one of ${(enumValues as string[]).join(', ')}`);
      }
    }

    out[key] = {
      type: type as PropertySchema['type'],
      ...(description === undefined ? {} : { description }),
      ...(enumValues === undefined ? {} : { enum: enumValues as string[] }),
      ...(dflt === undefined ? {} : { default: dflt as string | number | boolean }),
    };
  }
  return out;
}

export function validateManifest(raw: unknown, where: string): PluginManifest {
  const o = requireObject(raw, 'manifest', where);

  const apiVersion = requireString(o, 'apiVersion', where);
  const major = Number.parseInt(apiVersion.split('.')[0] ?? '', 10);
  if (!Number.isInteger(major)) {
    throw new Error(`${where}: apiVersion "${apiVersion}" is not a version string`);
  }
  if (major !== SUPPORTED_API_MAJOR) {
    throw new Error(
      `${where}: apiVersion ${apiVersion} is incompatible — host supports ${SUPPORTED_API_MAJOR}.x`,
    );
  }

  const c = requireObject(o['contributes'], 'contributes', where);

  const panels = entries(c['panels'], 'panels', where, (p, at) => ({
    id: requireString(p, 'id', at),
    title: requireString(p, 'title', at),
  }));

  const menu = entries(c['menu'], 'menu', where, (m, at) => {
    const group = m['group'];
    if (group !== undefined && typeof group !== 'string') {
      throw new Error(`${at}: "group" must be a string when present`);
    }
    return {
      command: requireString(m, 'command', at),
      label: requireString(m, 'label', at),
      ...(group === undefined ? {} : { group }),
    };
  });

  const commands = entries(c['commands'], 'commands', where, (cmd, at) => {
    const args = cmd['args'];
    if (args !== undefined) {
      const a = requireObject(args, 'args', at);
      if (a['type'] !== 'object') throw new Error(`${at}: args.type must be "object"`);
      requireObject(a['properties'], 'args.properties', at);
    }
    return {
      id: requireString(cmd, 'id', at),
      title: requireString(cmd, 'title', at),
      ...(args === undefined ? {} : { args: args as CommandArgSchema }),
    };
  });

  const keybindings = entries(c['keybindings'], 'keybindings', where, (kb, at) => ({
    command: requireString(kb, 'command', at),
    key: normalizeChord(requireString(kb, 'key', at), at),
  }));

  const accepts = c['accepts'] === undefined
    ? undefined : stringArray(c['accepts'], 'accepts', where);
  const emits = c['emits'] === undefined
    ? undefined : stringArray(c['emits'], 'emits', where);
  const settings = c['settings'] === undefined
    ? undefined : validateSettings(c['settings'], where);
  const permissions = o['permissions'] === undefined
    ? undefined : stringArray(o['permissions'], 'permissions', where);

  return {
    id: requireString(o, 'id', where),
    name: requireString(o, 'name', where),
    version: requireString(o, 'version', where),
    apiVersion,
    main: requireString(o, 'main', where),
    activationEvents: stringArray(o['activationEvents'], 'activationEvents', where),
    contributes: {
      ...(panels === undefined ? {} : { panels }),
      ...(menu === undefined ? {} : { menu }),
      ...(commands === undefined ? {} : { commands }),
      ...(accepts === undefined ? {} : { accepts }),
      ...(emits === undefined ? {} : { emits }),
      ...(settings === undefined ? {} : { settings }),
      ...(keybindings === undefined ? {} : { keybindings }),
    },
    ...(permissions === undefined ? {} : { permissions }),
  };
}

/**
 * Read every manifest under `dir`. Never executes plugin code — main is the
 * privileged process and running plugin code here would collapse the security model.
 */
export async function scanPlugins(dir: string): Promise<PluginManifest[]> {
  const out: PluginManifest[] = [];
  pluginRoots.clear();

  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    console.warn(`[plugins] no plugin directory at ${dir}`);
    return out;                       // directory absent is not an error
  }

  for (const e of dirents) {
    if (!e.isDirectory()) continue;
    const root = path.join(dir, e.name);
    try {
      const raw = await readFile(path.join(root, 'plugin.json'), 'utf8');
      const manifest = validateManifest(JSON.parse(raw), e.name);
      if (pluginRoots.has(manifest.id)) {
        throw new Error(`duplicate plugin id "${manifest.id}"`);
      }
      pluginRoots.set(manifest.id, root);
      out.push(manifest);
    } catch (err) {
      console.error(`[plugins] bad manifest in ${e.name}:`, err);
      // keep going — one broken plugin must not stop discovery
    }
  }
  return out;
}
