/**
 * Hardware Monitor Dashboard — ECharts visualization engine
 */

const API_BASE = '/api';
let refreshTimer = null;

// Chart instances
let cpuChart, memChart, tempChart, gpuUtilChart, vramChart;

// History buffers for time-series charts (last 60 points)
const HISTORY_LENGTH = 60;
const history = {
    labels: [],
    cpuAvg: [],
    memUsed: [],
    vramUsed: [],
    tempCpu: [],
    tempGpu: [],
    gpuGeneral: [],
    gpuDecoder: [],
    gpuEncoder: []
};

/**
 * Fetch latest hardware stats from backend API
 */
async function fetchStats() {
    try {
        const response = await fetch(`${API_BASE}/stats`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('Failed to fetch hardware stats:', error);
        return null;
    }
}

/**
 * Push a single timestamp and manage buffer size across all series
 */
function addHistoryPoint(label, values) {
    // Enforce max length first
    while (history.labels.length >= HISTORY_LENGTH) {
        history.labels.shift();
        history.cpuAvg.shift();
        history.memUsed.shift();
        history.vramUsed.shift();
        history.tempCpu.shift();
        history.tempGpu.shift();
        history.gpuGeneral.shift();
        history.gpuDecoder.shift();
        history.gpuEncoder.shift();
    }
    
    history.labels.push(label);
    history.cpuAvg.push(values.cpuAvg ?? null);
    history.memUsed.push(values.memUsed ?? null);
    history.vramUsed.push(values.vramUsed ?? null);
    history.tempCpu.push(values.tempCpu ?? null);
    history.tempGpu.push(values.tempGpu ?? null);
    history.gpuGeneral.push(values.gpuGeneral ?? null);
    history.gpuDecoder.push(values.gpuDecoder ?? null);
    history.gpuEncoder.push(values.gpuEncoder ?? null);
}

/**
 * Update CPU core utilization grid
 */
function updateCPU(data) {
    document.getElementById('cpuAvg').textContent = `平均: ${data.cpu.average}%`;

    // Update per-core grid
    const gridEl = document.getElementById('cpuCoreGrid');
    gridEl.innerHTML = '';
    
    data.cpu.cores.forEach((coreUsage, idx) => {
        const coreItem = document.createElement('div');
        coreItem.className = 'core-item';
        
        let color = '#4caf50';
        if (coreUsage > 70) color = '#ff9800';
        if (coreUsage > 90) color = '#f44336';
        
        coreItem.innerHTML = `
            <div class="core-label">核心 ${idx}</div>
            <div class="core-value" style="color: ${color}">${coreUsage}%</div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${coreUsage}%; background: ${color}"></div>
            </div>
        `;
        
        gridEl.appendChild(coreItem);
    });
}

/**
 * Update memory usage display
 */
function updateMemory(data) {
    const percent = data.memory.percent_used || 0;
    const used = data.memory.used_gb || 0;
    const total = data.memory.total_gb || 0;
    
    document.getElementById('memPercent').textContent = `${percent}%`;
    document.getElementById('memDetail').textContent = `${used.toFixed(2)} GB / ${total.toFixed(2)} GB`;
}

/**
 * Update temperature monitoring display
 */
function updateTemperatures(data) {
    const cpuTemp = data.temperatures?.cpu ?? null;
    const gpuTemp = data.temperatures?.gpu ?? null;

    const tempCpuEl = document.getElementById('tempCpu');
    const tempGpuEl = document.getElementById('tempGpu');

    if (cpuTemp !== null) {
        tempCpuEl.textContent = `${cpuTemp}°C`;
        tempCpuEl.className = 'metric-value' + (cpuTemp > 85 ? ' temp-danger' : cpuTemp > 70 ? ' temp-warning' : '');
    } else {
        tempCpuEl.textContent = '--°C';
        tempCpuEl.className = 'metric-value temp-warning';
    }

    if (gpuTemp !== null) {
        tempGpuEl.textContent = `${gpuTemp}°C`;
        tempGpuEl.className = 'metric-value' + (gpuTemp > 85 ? ' temp-danger' : gpuTemp > 70 ? ' temp-warning' : '');
    } else {
        tempGpuEl.textContent = '--°C';
        tempGpuEl.className = 'metric-value temp-danger';
    }
}

/**
 * Update GPU utilization sub-panels and VRAM visualization
 */
function updateGPU(data) {
    const gpu = data.gpu || {};
    
    // General/3D Core Utilization
    const generalUtil = gpu.utilization ?? null;
    const utilEl = document.getElementById('gpuUtilGeneral');
    if (generalUtil !== null) {
        utilEl.textContent = `${generalUtil}%`;
        utilEl.style.color = generalUtil > 90 ? '#f44336' : generalUtil > 70 ? '#ff9800' : '#fff';
    } else {
        utilEl.textContent = '--%';
    }
    
    // Decoder (Video Decode Engine) Utilization
    const decoderUtil = gpu.decoder_util ?? null;
    const decEl = document.getElementById('gpuUtilDecoder');
    if (decoderUtil !== null) {
        decEl.textContent = `${decoderUtil}%`;
        decEl.style.color = decoderUtil > 90 ? '#f44336' : decoderUtil > 70 ? '#ff9800' : '#4caf50';
    } else {
        decEl.textContent = '--%';
    }
    
    // Encoder (Copy/Encode Engine) Utilization
    const encoderUtil = gpu.encoder_util ?? null;
    const encEl = document.getElementById('gpuUtilEncoder');
    if (encoderUtil !== null) {
        encEl.textContent = `${encoderUtil}%`;
        encEl.style.color = encoderUtil > 90 ? '#f44336' : encoderUtil > 70 ? '#ff9800' : '#ff9800';
    } else {
        encEl.textContent = '--%';
    }
    
    // VRAM Detail Grid
    const vramUsed = gpu.vram_used_mb ?? null;
    const vramFree = gpu.vram_free_mb ?? null;
    const vramReserved = gpu.vram_reserved_mb ?? null;
    const vramTotal = gpu.vram_total_mb ?? null;
    
    if (vramUsed !== null && vramTotal !== null) {
        document.getElementById('vramUsedMB').textContent = `${(vramUsed / 1024).toFixed(2)} GB (${vramUsed} MB)`;
        document.getElementById('vramTotalMB').textContent = `${(vramTotal / 1024).toFixed(2)} GB`;
        
        const percent = ((vramUsed / vramTotal) * 100).toFixed(1);
        const vramPercentEl = document.getElementById('vramPercent');
        vramPercentEl.textContent = `${percent}%`;
        vramPercentEl.style.color = percent > 90 ? '#f44336' : percent > 70 ? '#ff9800' : '#fff';
        
        document.getElementById('vramFreeMB').textContent = 
            vramFree !== null ? `${(vramFree / 1024).toFixed(2)} GB (${vramFree} MB)` : 'N/A';
        document.getElementById('vramReservedMB').textContent = 
            vramReserved !== null ? `${(vramReserved / 1024).toFixed(2)} GB (${vramReserved} MB)` : 'N/A';
    } else {
        document.getElementById('vramUsedMB').textContent = '-- MB';
        document.getElementById('vramFreeMB').textContent = '-- MB';
        document.getElementById('vramReservedMB').textContent = '-- MB';
        document.getElementById('vramTotalMB').textContent = '-- MB';
        document.getElementById('vramPercent').textContent = '--%';
    }
    
    return { generalUtil, decoderUtil, encoderUtil };
}

/**
 * Initialize ECharts instances with default options
 */
function initCharts() {
    cpuChart = echarts.init(document.getElementById('cpuChart'));
    memChart = echarts.init(document.getElementById('memChart'));
    tempChart = echarts.init(document.getElementById('tempChart'));
    gpuUtilChart = echarts.init(document.getElementById('gpuUtilChart'));
    vramChart = echarts.init(document.getElementById('vramChart'));

    const commonOption = {
        backgroundColor: 'transparent',
        grid: { top: 30, right: 20, bottom: 30, left: 50 },
        tooltip: { trigger: 'axis' },
        xAxis: {
            type: 'category',
            data: [],
            axisLine: { lineStyle: { color: '#888' } },
            axisLabel: { color: '#aaa' }
        },
        yAxis: {
            type: 'value',
            axisLine: { lineStyle: { color: '#888' } },
            axisLabel: { color: '#aaa' }
        },
        series: []
    };

    // CPU average trend
    cpuChart.setOption({
        ...commonOption,
        title: { text: 'CPU 平均利用率趋势', left: 'center', textStyle: { color: '#aaa', fontSize: 12 } },
        series: [{ name: 'CPU%', type: 'line', smooth: true, data: [], areaStyle: { opacity: 0.3 } }],
        yAxis: { max: 100 }
    });

    // Memory usage trend
    memChart.setOption({
        ...commonOption,
        title: { text: '内存使用率趋势', left: 'center', textStyle: { color: '#aaa', fontSize: 12 } },
        series: [{ name: 'Mem%', type: 'line', smooth: true, data: [], areaStyle: { opacity: 0.3 } }],
        yAxis: { max: 100 }
    });

    // Temperature trend
    tempChart.setOption({
        ...commonOption,
        title: { text: '温度趋势', left: 'center', textStyle: { color: '#aaa', fontSize: 12 } },
        series: [
            { name: 'CPU°', type: 'line', smooth: true, data: [], lineStyle: { color: '#ff9800' } },
            { name: 'GPU°', type: 'line', smooth: true, data: [], lineStyle: { color: '#f44336' } }
        ]
    });

    // GPU Engine Utilization trend (3 engines)
    gpuUtilChart.setOption({
        ...commonOption,
        title: { text: 'GPU 引擎利用率趋势', left: 'center', textStyle: { color: '#aaa', fontSize: 12 } },
        series: [
            { name: '通用计算', type: 'line', smooth: true, data: [], lineStyle: { color: '#4caf50' } },
            { name: '解码器', type: 'line', smooth: true, data: [], lineStyle: { color: '#2196f3' } },
            { name: '编码器', type: 'line', smooth: true, data: [], lineStyle: { color: '#ff9800' } }
        ],
        legend: { bottom: 0, textStyle: { color: '#aaa' } },
        yAxis: { max: 100 }
    });

    // VRAM usage trend
    vramChart.setOption({
        ...commonOption,
        title: { text: '专用显存使用率趋势', left: 'center', textStyle: { color: '#aaa', fontSize: 12 } },
        series: [{ name: 'VRAM%', type: 'line', smooth: true, data: [], areaStyle: { opacity: 0.3 } }],
        yAxis: { max: 100 }
    });
}

/**
 * Render all time-series charts using the shared history buffers
 */
function renderCharts() {
    const labels = history.labels.slice(-HISTORY_LENGTH);
    
    cpuChart.setOption({ xAxis: { data: labels }, series: [{ data: history.cpuAvg }] });
    memChart.setOption({ xAxis: { data: labels }, series: [{ data: history.memUsed }] });
    
    tempChart.setOption({
        xAxis: { data: labels },
        series: [{ data: history.tempCpu }, { data: history.tempGpu }]
    });
    
    gpuUtilChart.setOption({
        xAxis: { data: labels },
        series: [
            { name: '通用计算', data: history.gpuGeneral, lineStyle: { color: '#4caf50' } },
            { name: '解码器', data: history.gpuDecoder, lineStyle: { color: '#2196f3' } },
            { name: '编码器', data: history.gpuEncoder, lineStyle: { color: '#ff9800' } }
        ]
    });
    
    vramChart.setOption({ xAxis: { data: labels }, series: [{ data: history.vramUsed }] });
}

/**
 * Main refresh loop — fetch and update dashboard
 */
async function refreshDashboard() {
    const data = await fetchStats();
    if (!data) return;

    document.getElementById('lastUpdate').textContent = `最后更新: ${new Date().toLocaleTimeString()}`;
    
    const label = new Date().toLocaleTimeString();
    
    try {
        updateCPU(data);
    } catch (e) { console.error('CPU update error:', e); }

    try {
        updateMemory(data);
    } catch (e) { console.error('Memory update error:', e); }

    try {
        updateTemperatures(data);
    } catch (e) { console.error('Temperature update error:', e); }

    let gpuEngines = {};
    try {
        gpuEngines = updateGPU(data);
    } catch (e) { console.error('GPU update error:', e); }

    // Single unified history push per tick — prevents misalignment
    addHistoryPoint(label, {
        cpuAvg: data.cpu.average ?? null,
        memUsed: data.memory.percent_used ?? null,
        vramUsed: (() => {
            const gpu = data.gpu || {};
            if (gpu.vram_total_mb && gpu.vram_used_mb && gpu.vram_total_mb > 0) {
                return parseFloat(((gpu.vram_used_mb / gpu.vram_total_mb) * 100).toFixed(1));
            }
            return null;
        })(),
        tempCpu: data.temperatures?.cpu ?? null,
        tempGpu: data.temperatures?.gpu ?? null,
        gpuGeneral: gpuEngines.generalUtil ?? null,
        gpuDecoder: gpuEngines.decoderUtil ?? null,
        gpuEncoder: gpuEngines.encoderUtil ?? null
    });

    renderCharts();
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    refreshDashboard(); // Initial fetch
    refreshTimer = setInterval(refreshDashboard, 2000); // Refresh every 2 seconds

    // Handle window resize
    window.addEventListener('resize', () => {
        cpuChart.resize();
        memChart.resize();
        tempChart.resize();
        gpuUtilChart.resize();
        vramChart.resize();
    });
});
