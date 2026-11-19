/**
 * Hardware Monitor Plugin — Cordis entry point for DSH
 * 
 * This plugin integrates a real-time hardware monitoring dashboard into the DSH Web UI.
 * It monitors:
 * - CPU per-core utilization and average
 * - CPU and GPU temperatures
 * - Memory usage (total, used, free, percentage)
 * - GPU utilization and VRAM usage
 * 
 * Architecture:
 * 1. PowerShell script (server/collect.ps1) collects hardware stats via WMI/nvidia-smi
 * 2. Node.js HTTP server (server/index.js) exposes REST API at :8999
 * 3. ECharts-based frontend (ui/) renders real-time visualization dashboard
 * 4. Cordis service mounts the server when DSH boots
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Robust Service base class fallback for standalone testing environment
let ServiceClass;
try {
    const cordis = await import('@deepseek-ai/cordis');
    ServiceClass = cordis.Service;
} catch {
    ServiceClass = class Service {
        static init = Symbol.for('cordis.init');
        constructor(ctx, name) {
            this.ctx = ctx;
            this.name = name;
        }
    };
}

/** Implementation module, resolved next to this (possibly cached) shim. */
const IMPL_URL = new URL('./server/impl.js', import.meta.url);

/**
 * Import the impl, cache-busted by its own content hash.
 */
async function loadImpl() {
    let href = IMPL_URL.href;
    try {
        const bytes = await readFile(IMPL_URL);
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
        href = `${IMPL_URL.href}?v=${hash}`;
    } catch {
        // Fall back to plain URL so import can surface real error
    }
    return await import(/* @vite-ignore */ href);
}

export const inject = ['logger'];

/**
 * Mount the Hardware Monitor Server. Runs only after injected services are up.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function apply(ctx) {
    // Prevent duplicate mounting
    if (ctx.get('hardwareMonitorServer')) return;
    
    const mod = await loadImpl();
    
    // Re-check after the await: a concurrent apply may have mounted meanwhile
    if (ctx.get('hardwareMonitorServer')) return;
    
    ctx.plugin(mod.HardwareMonitorService);
}
