/**
 * Hardware Monitor Server for DSH Plugin
 * 
 * Provides HTTP API endpoints for real-time hardware monitoring data:
 * - GET /api/stats - Fetch current hardware statistics
 * - GET /api/history - Fetch historical data points
 * - GET /ui - Serve the visualization dashboard UI
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const UI_DIR = join(__dirname, '..', 'ui');

// In-memory history buffer (last 100 data points)
const HISTORY_BUFFER_SIZE = 100;
let historyData = [];

/**
 * Try executing PowerShell collect.ps1 first, then fall back to Python collect.py
 */
async function collectHardwareStats() {
    let stats = null;
    
    // Method 1: Try PowerShell (Windows native)
    const psScript = join(__dirname, 'collect.ps1');
    if (fs.existsSync(psScript)) {
        try {
            stats = await executeCommand(
                'powershell',
                ['-ExecutionPolicy', 'Bypass', '-File', psScript],
                'PowerShell'
            );
        } catch (e) {
            console.log('[Hardware Monitor] PowerShell collection failed, trying Python...');
        }
    }
    
    // Method 2: Fallback to Python
    if (!stats) {
        const pyScript = join(__dirname, 'collect.py');
        if (fs.existsSync(pyScript)) {
            try {
                stats = await executeCommand(
                    'python3',
                    [pyScript],
                    'Python'
                );
            } catch (e) {
                console.log('[Hardware Monitor] Python collection also failed, using fallback data.');
            }
        }
    }
    
    // Method 3: Ultimate fallback — static demo data
    if (!stats) {
        console.log('[Hardware Monitor] Using fallback demo data.');
        stats = getFallbackData();
    }
    
    // Add to history buffer
    historyData.push({
        timestamp: Date.now(),
        ...stats
    });
    
    if (historyData.length > HISTORY_BUFFER_SIZE) {
        historyData = historyData.slice(-HISTORY_BUFFER_SIZE);
    }
    
    return stats;
}

/**
 * Execute a command and parse JSON output
 */
function executeCommand(cmd, args, label) {
    return new Promise((resolve) => {
        execFile(cmd, args, {
            timeout: 10000,
            maxBuffer: 1024 * 1024
        }, (error, stdout, stderr) => {
            if (error) {
                console.error(`${label} execution error:`, error.message);
                resolve(null);
                return;
            }
            
            try {
                const parsed = JSON.parse(stdout.trim());
                console.log(`[${label}] Collection successful`);
                resolve(parsed);
            } catch (parseError) {
                console.error(`${label} JSON parse error:`, parseError.message);
                resolve(null);
            }
        });
    });
}

/**
 * Fallback data when collection fails
 */
function getFallbackData() {
    return {
        timestamp: new Date().toISOString(),
        cpu: { cores: [0, 0, 0, 0, 0, 0, 0, 0], average: 0 },
        temperatures: { cpu: null, gpu: null },
        memory: { total_gb: 0, used_gb: 0, free_gb: 0, percent_used: 0 },
        gpu: {
            utilization: null,
            decoder_util: null,
            encoder_util: null,
            vram_total_mb: null,
            vram_used_mb: null,
            vram_free_mb: null,
            vram_reserved_mb: null,
            vram_percent: null,
            vram_free_percent: null
        }
    };
}

/**
 * Create HTTP server with API endpoints
 */
class HardwareMonitorServer {
    constructor(port = 8999) {
        this.port = port;
        this.server = null;
        this.collectInterval = null;
    }

    /**
     * Start the server and begin periodic data collection
     */
    async start() {
        return new Promise((resolve) => {
            this.server = http.createServer(async (req, res) => {
                // Enable CORS
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

                if (req.method === 'OPTIONS') {
                    res.writeHead(200);
                    res.end();
                    return;
                }

                // Route: GET /api/stats - Get latest hardware stats
                if (req.url === '/api/stats' && req.method === 'GET') {
                    try {
                        const stats = await collectHardwareStats();
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(stats));
                    } catch (error) {
                        console.error('Stats endpoint error:', error);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: error.message }));
                    }
                    return;
                }

                // Route: GET /api/history - Get historical data
                if (req.url === '/api/history' && req.method === 'GET') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(historyData.slice(-50))); // Last 50 points
                    return;
                }

                // Route: GET /ui or / - Serve visualization dashboard
                if ((req.url === '/' || req.url.startsWith('/ui')) && req.method === 'GET') {
                    const filePath = req.url === '/' ? join(UI_DIR, 'index.html') : join(UI_DIR, req.url.substring(1));
                    
                    try {
                        const content = fs.readFileSync(filePath, 'utf-8');
                        
                        let contentType = 'text/html';
                        if (filePath.endsWith('.js')) contentType = 'application/javascript';
                        else if (filePath.endsWith('.css')) contentType = 'text/css';
                        else if (filePath.endsWith('.png')) contentType = 'image/png';
                        else if (filePath.endsWith('.svg')) contentType = 'image/svg+xml';

                        res.writeHead(200, { 'Content-Type': contentType });
                        res.end(content);
                    } catch (error) {
                        res.writeHead(404, { 'Content-Type': 'text/plain' });
                        res.end('Not Found');
                    }
                    return;
                }

                // Default 404
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            });

            this.server.listen(this.port, () => {
                console.log(`[Hardware Monitor] Server running on http://localhost:${this.port}`);
                
                // Start periodic collection in background
                this.collectInterval = setInterval(async () => {
                    try {
                        await collectHardwareStats();
                    } catch (error) {
                        console.error('Background collection error:', error);
                    }
                }, 2000); // Collect every 2 seconds
                
                resolve();
            });
        });
    }

    /**
     * Stop the server and clear intervals
     */
    stop() {
        return new Promise((resolve) => {
            if (this.collectInterval) {
                clearInterval(this.collectInterval);
                this.collectInterval = null;
            }

            if (this.server) {
                this.server.close(() => {
                    console.log('[Hardware Monitor] Server stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

// Export for use by Cordis plugin
export { HardwareMonitorServer, collectHardwareStats };

// Auto-start when run directly (for standalone testing)
if (import.meta.url === `file://${process.argv[1]}`) {
    const server = new HardwareMonitorServer(8999);
    
    process.on('SIGINT', async () => {
        await server.stop();
        process.exit(0);
    });
    
    server.start().catch(console.error);
}
