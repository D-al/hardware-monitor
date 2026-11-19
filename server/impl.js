/**
 * Hardware Monitor Service — Cordis plugin implementation
 * 
 * Mounts the HTTP server and exposes hardware monitoring functionality to DSH.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import the server module
import { HardwareMonitorServer } from './index.js';

/**
 * HardwareMonitorService — Cordis service that manages the hardware monitor server lifecycle
 */
export class HardwareMonitorService extends ServiceClass {
    #server;
    #port = 8999;

    constructor(ctx) {
        super(ctx, 'hardwareMonitorService');
    }

    /**
     * Initialize the service — start the HTTP server
     */
    async [ServiceClass.init || Symbol.for('cordis.init')]() {
        const ctx = this.ctx;
        const logger = ctx.logger ?? console;

        try {
            // Create and start the hardware monitor server
            this.#server = new HardwareMonitorServer(this.#port);
            
            await this.#server.start();
            
            logger.info(`[Hardware Monitor] Dashboard available at http://localhost:${this.#port}/ui`);
            
            // Register a getter so other plugins can access the server
            Object.defineProperty(ctx.getter || {}, '__hardwareMonitor', {
                get: () => ({
                    url: `http://localhost:${this.#port}`,
                    dashboard: `http://localhost:${this.#port}/ui`,
                    api: `http://localhost:${this.#port}/api/stats`
                }),
                configurable: true,
                enumerable: true
            });
            
        } catch (error) {
            logger.error('[Hardware Monitor] Failed to start:', error.message);
            throw error;
        }
    }

    /**
     * Dispose the service — stop the HTTP server
     */
    dispose() {
        if (this.#server) {
            this.#server.stop().catch(err => {
                console.error('[Hardware Monitor] Error stopping server:', err);
            });
            this.#server = null;
        }
    }
}
