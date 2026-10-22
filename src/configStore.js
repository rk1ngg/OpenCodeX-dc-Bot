// src/configStore.js
// Simple JSON‑file based configuration store for per‑guild settings.
// Stores data under ./config/guilds.json. Creates the file if missing.

import { promises as fs } from 'fs';
import path from 'path';

const CONFIG_DIR = path.resolve('config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'guilds.json');

/** Ensure the config directory and file exist */
async function ensureConfig() {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.access(CONFIG_PATH);
  } catch (_) {
    // File missing – initialise with empty object
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ }, null, 2), 'utf8');
  }
}

/** Read the entire config object from disk */
async function readAll() {
  await ensureConfig();
  const data = await fs.readFile(CONFIG_PATH, 'utf8');
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/** Write the entire config object to disk */
async function writeAll(obj) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

/** Get the config for a specific guild (creates empty entry if absent) */
export async function getConfig(guildId) {
  const all = await readAll();
  if (!all[guildId]) all[guildId] = {};
  return all[guildId];
}

/** Set/merge config for a specific guild */
export async function setConfig(guildId, newPartial) {
  const all = await readAll();
  const existing = all[guildId] || {};
  all[guildId] = { ...existing, ...newPartial };
  await writeAll(all);
}
