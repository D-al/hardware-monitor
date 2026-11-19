#!/usr/bin/env python3
"""
Hardware Monitor Collector for Windows/Linux/Mac
Cross-platform alternative to collect.ps1 for when PowerShell is unavailable.
Collects CPU per-core utilization, temperatures, memory, GPU stats.
"""

import json
import time
import sys
import platform
import subprocess
from datetime import datetime


def get_cpu_core_utilization():
    """Get CPU core utilization using /proc/stat on Linux or psutil fallback."""
    cores = []
    
    # Method 1: Try reading /proc/stat (Linux)
    if platform.system() == "Linux":
        try:
            with open("/proc/stat", "r") as f:
                lines = f.readlines()
            
            cpu_lines = [l for l in lines if l.startswith("cpu")]
            if len(cpu_lines) > 1:  # Per-core data available
                for line in cpu_lines[1:]:  # Skip total cpu line
                    parts = line.split()
                    if len(parts) >= 8:
                        user = int(parts[1])
                        nice = int(parts[2])
                        system = int(parts[3])
                        idle = int(parts[4])
                        iowait = int(parts[5])
                        irq = int(parts[6])
                        softirq = int(parts[7])
                        
                        total = user + nice + system + idle + iowait + irq + softirq
                        active = total - idle
                        
                        # Read again after short delay for accurate measurement
                        time.sleep(0.1)
                        with open("/proc/stat", "r") as f2:
                            lines2 = f2.readlines()
                            parts2 = lines2[int(line.split()[0].replace("cpu", ""))].split()
                            
                        if len(parts2) >= 8:
                            user2 = int(parts2[1])
                            nice2 = int(parts2[2])
                            system2 = int(parts2[3])
                            idle2 = int(parts2[4])
                            iowait2 = int(parts2[5])
                            irq2 = int(parts2[6])
                            softirq2 = int(parts2[7])
                            
                            total2 = user2 + nice2 + system2 + idle2 + iowait2 + irq2 + softirq2
                            active2 = total2 - idle2
                            
                            diff_active = active2 - active
                            diff_total = total2 - total
                            
                            if diff_total > 0:
                                usage = round((diff_active / diff_total) * 100, 1)
                                cores.append(min(usage, 100.0))
        except Exception:
            pass
    
    # Method 2: Use psutil if available
    try:
        import psutil
        
        # Get per-CPU utilization
        per_cpu = psutil.cpu_percent(interval=0.1, percpu=True)
        cores = [float(c) for c in per_cpu]
        
    except ImportError:
        pass
    
    # Fallback: use os.cpu_count and estimate
    if not cores:
        core_count = os.cpu_count() or 4
        cores = [0.0] * core_count
    
    avg = round(sum(cores) / len(cores), 1) if cores else 0.0
    
    return {"cores": cores, "average": avg}


def get_temperatures():
    """Get CPU and GPU temperatures."""
    result = {"cpu": None, "gpu": None}
    
    # Try reading temperature sensors via various methods
    
    # Method 1: Try /sys/class/thermal on Linux
    if platform.system() == "Linux":
        try:
            import glob
            
            thermal_zones = glob.glob("/sys/class/thermal/thermal_zone*/temp")
            max_temp = 0
            
            for zone_file in thermal_zones:
                with open(zone_file, "r") as f:
                    temp_milli = int(f.read().strip())
                    temp_celsius = temp_milli / 1000.0
                    
                    if temp_celsius > max_temp:
                        max_temp = temp_celsius
            
            if max_temp > 0:
                result["cpu"] = round(max_temp, 1)
        except Exception:
            pass
    
    # Method 2: Try nvidia-smi for GPU temperature
    try:
        output = subprocess.run(
            ["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )
        
        if output.returncode == 0 and output.stdout.strip():
            lines = [l.strip() for l in output.stdout.strip().split("\n") if l.strip()]
            if lines:
                result["gpu"] = float(lines[0])
    except (FileNotFoundError, ValueError):
        pass
    
    # Method 3: Try hwmon on Linux for GPU
    if result["gpu"] is None and platform.system() == "Linux":
        try:
            import glob
            gpu_hwmon = glob.glob("/sys/class/hwmon/hwmon*/temp*_input")
            
            for hwmon_file in sorted(gpu_hwmon, key=lambda x: int(x.split("_")[-2]), reverse=True)[:1]:
                with open(hwmon_file, "r") as f:
                    temp_milli = int(f.read().strip())
                    result["gpu"] = round(temp_milli / 1000.0, 1)
                    break
        except Exception:
            pass
    
    return result


def get_memory_stats():
    """Get memory usage statistics."""
    total_gb = 0
    used_gb = 0
    free_gb = 0
    percent_used = 0.0
    
    if platform.system() == "Linux":
        try:
            with open("/proc/meminfo", "r") as f:
                meminfo = {}
                for line in f.readlines():
                    parts = line.split(":")
                    if len(parts) == 2:
                        key = parts[0].strip()
                        value = int(parts[1].strip().split()[0])  # Value in kB
                        meminfo[key] = value
                
                total_kb = meminfo.get("MemTotal", 0)
                free_kb = meminfo.get("MemAvailable", meminfo.get("MemFree", 0))
                
                total_gb = round(total_kb / (1024 * 1024), 2)
                free_gb = round(free_kb / (1024 * 1024), 2)
                used_kb = total_kb - free_kb
                used_gb = round(used_kb / (1024 * 1024), 2)
                
                if total_kb > 0:
                    percent_used = round((used_kb / total_kb) * 100, 1)
        except Exception:
            pass
    
    elif platform.system() == "Windows":
        try:
            output = subprocess.run(
                ["powershell", "-Command", 
                 "$os = Get-CimInstance Win32_OperatingSystem; " +
                 "$totalKB = [long]$os.TotalVisibleMemorySize; " +
                 "$freeKB = [long]$os.FreePhysicalMemory; " +
                 "Write-Host ('{0} {1}' -f $totalKB, $freeKB)"],
                capture_output=True, text=True, timeout=5
            )
            
            if output.returncode == 0 and output.stdout.strip():
                parts = output.stdout.strip().split()
                if len(parts) >= 2:
                    total_kb = int(parts[0])
                    free_kb = int(parts[1])
                    
                    total_gb = round(total_kb / (1024 * 1024), 2)
                    free_gb = round(free_kb / (1024 * 1024), 2)
                    used_kb = total_kb - free_kb
                    used_gb = round(used_kb / (1024 * 1024), 2)
                    
                    if total_kb > 0:
                        percent_used = round((used_kb / total_kb) * 100, 1)
        except Exception:
            pass
    
    return {
        "percent_used": percent_used,
        "used_gb": used_gb,
        "total_gb": total_gb
    }


def get_gpu_stats():
    """Get GPU utilization and VRAM statistics."""
    result = {
        "utilization": None,
        "decoder_util": None,
        "encoder_util": None,
        "vram_total_mb": None,
        "vram_used_mb": None,
        "vram_free_mb": None,
        "vram_reserved_mb": None,
        "vram_percent": None,
        "vram_free_percent": None
    }
    
    # Try nvidia-smi first with extended metrics
    try:
        output = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu,utilization.decoder,utilization.encoder,memory.total,memory.used,memory.free,memory.used.reserved",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )
        
        if output.returncode == 0 and output.stdout.strip():
            lines = [l.strip() for l in output.stdout.strip().split("\n") if l.strip()]
            
            for line in lines:
                parts = [p.strip() for p in line.split(",")]
                
                if len(parts) >= 7:
                    general_util = float(parts[0])
                    decoder_util = float(parts[1])
                    encoder_util = float(parts[2])
                    vram_total = float(parts[3])
                    vram_used = float(parts[4])
                    vram_free = float(parts[5])
                    vram_reserved = float(parts[6])
                    
                    result["utilization"] = general_util
                    result["decoder_util"] = decoder_util
                    result["encoder_util"] = encoder_util
                    result["vram_total_mb"] = vram_total
                    result["vram_used_mb"] = vram_used
                    result["vram_free_mb"] = vram_free
                    result["vram_reserved_mb"] = vram_reserved
                    
                    if vram_total > 0:
                        result["vram_percent"] = round((vram_used / vram_total) * 100, 1)
                        result["vram_free_percent"] = round((vram_free / vram_total) * 100, 1)
                    
                    break
    except (FileNotFoundError, ValueError):
        pass
    
    return result


def main():
    """Main entry point to collect all hardware stats and output JSON."""
    print("Collecting hardware statistics...", file=sys.stderr)
    
    cpu_data = get_cpu_core_utilization()
    temp_data = get_temperatures()
    mem_data = get_memory_stats()
    gpu_data = get_gpu_stats()
    
    stats = {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "cpu": {
            "cores": cpu_data["cores"],
            "average": cpu_data["average"]
        },
        "temperatures": {
            "cpu": temp_data["cpu"],
            "gpu": temp_data["gpu"]
        },
        "memory": {
            "percent_used": mem_data["percent_used"],
            "used_gb": mem_data["used_gb"],
            "total_gb": mem_data["total_gb"]
        },
        "gpu": {
            "utilization": gpu_data["utilization"],
            "vram_total_mb": gpu_data["vram_total_mb"],
            "vram_used_mb": gpu_data["vram_used_mb"],
            "vram_percent": gpu_data["vram_percent"]
        }
    }
    
    # Output JSON
    print(json.dumps(stats, indent=2))
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
