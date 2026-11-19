# dsh-hardware-monitor — 硬件状态可视化监视器

DSH 硬件状态可视化监视器插件，实时监测并可视化展示以下指标：

| 指标 | 采集方式 |
|------|----------|
| **CPU 每核利用率** | .NET PerformanceCounter + Win32_Processor LoadPercentage |
| **CPU 温度** | Windows 原生 WMI `MSAcpi_ThermalZoneTemperature`（无需额外软件） |
| **GPU 利用率 & 显存** | NVIDIA 驱动自带 `nvidia-smi`（`utilization.gpu`, `memory.total`, `memory.used`) |
| **GPU 温度** | NVIDIA 驱动自带 `nvidia-smi`（`temperature.gpu`），随显卡驱动自动安装 |
| **内存占用率** | Win32_OperatingSystem (TotalVisibleMemorySize / FreePhysicalMemory) |

## 双重采集机制

插件内置**两种数据采集后端**，自动按优先级切换：

1. **PowerShell 采集（首选）** — 适用于 Windows 环境，利用原生 WMI/.NET API
2. **Python 采集（Fallback）** — 跨平台备选方案，适用于 Linux/macOS 或 PowerShell 不可用时

服务端 `collectHardwareStats()` 函数会先尝试执行 `collect.ps1`，失败后自动切换到 `collect.py`。两者输出完全兼容同一套前端数据结构。

## 安装

将本插件目录复制到 DSH profile 的 node_modules 下：

```powershell
# 方法一：直接拷贝到 profile node_modules
Copy-Item ".\hardware-monitor-plugin" -Destination "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\" -Recurse

# 方法二：在 profile.json 或 dsh.profile.bundles 中添加引用
```

然后在 `.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 中添加：

```json
"dsh": {
    "profile": {
        "bundles": [
            ...existing bundles...,
            "dsh-hardware-monitor"
        ]
    }
}
```

重启 DSH Web UI 即可生效。

## 访问地址

启动后打开浏览器访问：

- **仪表盘**: http://localhost:8999/ui
- **API**: http://localhost:8999/api/stats （获取最新硬件数据 JSON）
- **历史数据**: http://localhost:8999/api/history （最近 100 个采样点）

## 依赖要求

| 依赖 | 说明 |
|------|------|
| NVIDIA Driver | GPU 数据采集必需（nvidia-smi 需在 PATH 中，随驱动自动安装） |
| Windows PowerShell 5.1+ **或** Python 3.6+ | 数据采集脚本运行环境（Windows 优先用 PS，Linux/macOS 用 Python） |
| Node.js >= 18 | DSH 运行时 |

### 温度监测说明

- **CPU 温度**：使用 Windows 原生 WMI 类 `MSAcpi_ThermalZoneTemperature`（位于 `root\wmi` 命名空间），这是 BIOS 标准温度传感器接口，**无需安装任何第三方软件**。该接口在大多数现代主板上都能正常工作。
  
- **GPU 温度**：NVIDIA 显卡通过 `nvidia-smi` 工具获取（NVIDIA 驱动程序自带，无需额外安装）。AMD/Intel 集成显卡暂不支持（未来版本可添加 OpenHardwareMonitor 作为可选扩展）。

## 插件架构

```
hardware-monitor-plugin/
├── package.json              # NPM manifest + DSH plugin metadata
├── cordis.patch.yml          # Cordis bundle patch loader
├── index.js                  # Plugin entry point (inject hook)
├── server/
│   ├── collect.ps1           # PowerShell hardware data collector (Windows 首选)
│   ├── collect.py            # Python cross-platform fallback collector
│   ├── index.js              # HTTP API server + static file serving
│   └── impl.js               # Cordis Service implementation
├── ui/
│   ├── index.html             # Dashboard HTML page
│   └── dashboard.js           # ECharts visualization engine
└── demo.html                  # Standalone demo page (no server needed)
```

## 刷新频率

默认每 **2 秒**采集一次硬件数据并推送到前端，前端自动轮询更新图表。可通过修改 `server/index.js` 中的 `setInterval(refreshDashboard, 2000)` 调整。

## 故障排查

| 问题 | 解决方案 |
|------|----------|
| nvidia-smi 不可用 | 确认 NVIDIA 驱动已正确安装且 nvidia-smi 在系统 PATH 中 |
| CPU 温度显示 --°C | 检查主板是否支持 MSAcpi_ThermalZoneTemperature；Windows 10+ 通常支持 |
| 内存数据显示 0GB | 检查是否有权限读取 Win32_OperatingSystem CIM 类 |
| 页面白屏 | 检查浏览器控制台是否有 CORS 错误；确认服务器端口未被占用 |
| 无数据采集日志 | 打开浏览器控制台查看 `[Hardware Monitor]` 前缀的日志信息 |

## 测试预览

无需安装插件即可预览仪表盘效果：直接双击打开 `demo.html` 文件，使用模拟数据展示完整的实时监控界面。
