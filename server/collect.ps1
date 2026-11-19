# Hardware Monitor Collector for Windows
# Collects CPU per-core utilization, temperatures, memory, GPU stats via PowerShell/.NET
param(
    [int]$RefreshInterval = 2000
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "SilentlyContinue"

function Get-CpuCoreUtilization {
    $counters = @()
    
    try {
        # Use .NET PerformanceCounter for accurate per-core data
        $procInfo = New-Object System.Diagnostics.ProcessorInfo
        $coreCount = $procInfo.ProcessorCount
        
        if ($coreCount -gt 0) {
            foreach ($i in 0..($coreCount - 1)) {
                $counterName = "_Total"
                if ($PSVersionTable.PSVersion.Major -ge 3) {
                    $counterName = "$i".PadLeft(2, ' ')
                }
                
                try {
                    $pc = New-Object System.Diagnostics.PerformanceCounter("Processor", "% Processor Time", $counterName, $true)
                    Start-Sleep -Milliseconds 100
                    $val = $pc.NextValue()
                    $pc.Dispose()
                    
                    if ([double]::IsNaN([double]$val)) { $val = 0 }
                    $counters += [math]::Round([double]$val, 1)
                } catch {
                    $counters += 0
                }
            }
        } else {
            # Fallback: use LoadPercentage from Win32_Processor
            try {
                $raw = & powershell -Command "(Get-CimInstance Win32_Processor).LoadPercentage" 2>$null
                if ([string]::IsNullOrWhiteSpace($raw)) {
                    throw "CIM failed"
                }
                $loadPct = [int][string]::Join("", $raw.Trim().Split("`n"))
                $cores = if ($coreCount -gt 0) { $coreCount } else { 4 }
                for ($j = 0; $j -lt $cores; $j++) { $counters += $loadPct }
            } catch {
                for ($j = 0; $j -lt 4; $j++) { $counters += 0 }
            }
        }
    } catch {
        for ($j = 0; $j -lt 4; $j++) { $counters += 0 }
    }
    
    $avg = if ($counters.Count -gt 0) { [math]::Round(($counters | Measure-Object -Average).Average, 1) } else { 0 }
    
    return @{
        cores = $counters
        average = $avg
    }
}

function Get-Temperatures {
    $result = @{
        cpu = $null
        gpu = $null
    }
    
    # Method 1: Windows native WMI class MSAcpi_ThermalZoneTemperature (root\WMI namespace)
    try {
        # This is the AC BIOS standard thermal zone interface built into Windows
        $thermalZones = Get-WmiObject -Namespace "root\wmi" -Class "MSAcpi_ThermalZoneTemperature" -ErrorAction Stop
        
        foreach ($zone in $thermalZones) {
            # CurrentTemperature returns value * 10 in Kelvins
            # We want CPU temperature (usually first zone or highest value)
            if ($null -ne $zone.CurrentTemperature -and $zone.CurrentTemperature -gt 0) {
                $kelvin = [double]$zone.CurrentTemperature / 10.0
                $celsius = [math]::Round($kelvin - 273.15, 1)
                
                # Take the highest reading as CPU temp (most zones report ambient, one reports CPU)
                if ($result.cpu -eq $null -or $celsius -gt $result.cpu) {
                    $result.cpu = $celsius
                }
            }
        }
    } catch {}
    
    # Fallback: Try OpenHardwareMonitor via WMI (if installed by user)
    if ($result.cpu -eq $null) {
        try {
            $ohmCpu = Get-WmiObject -Namespace "root/OpenHardwareMonitor" -Class "OpenHardwareMonitorReport" -ErrorAction Stop | 
                      Where-Object { $_.Type -eq "Temperature" -and $_.Name -match "CPU" } | 
                      Sort-Object Value -Descending | Select-Object -First 1
            if ($ohmCpu) {
                $result.cpu = [math]::Round([double]$ohmCpu.Value, 1)
            }
        } catch {}
    }
    
    # NVIDIA GPU temperature and stats via nvidia-smi (bundled with NVIDIA drivers, no extra install needed)
    try {
        # Query: temp, general util, decoder, encoder, vram total/used/free, fb reserved
        $nvidiaSmi = nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,utilization.decoder,utilization.encoder,memory.total,memory.used,memory.free,memory.used.reserved --format=csv,noheader,nounits 2>$null
        
        if (-not [string]::IsNullOrWhiteSpace($nvidiaSmi)) {
            $lines = $nvidiaSmi.Trim().TrimStart().Split("`n") | Where-Object { $_.Trim() -ne "" }
            
            foreach ($line in $lines) {
                $parts = $line.Split(',') | ForEach-Object { $_.Trim() }
                
                if ($parts.Count -ge 8) {
                    # Parse GPU temperature
                    $tempVal = [double]$parts[0]
                    if ([double]::TryParse($tempVal.ToString(), [ref]$null)) {
                        $result.gpu = [math]::Round($tempVal, 1)
                    }
                    
                    # GPU utilization metrics
                    $generalUtil = [double]$parts[1]
                    $decoderUtil = [double]$parts[2]
                    $encoderUtil = [double]$parts[3]
                    
                    # VRAM metrics
                    $vramTotal = [double]$parts[4]
                    $vramUsed = [double]$parts[5]
                    $vramFree = [double]$parts[6]
                    $vramReserved = [double]$parts[7]
                    
                    if ($global:_gpuStats -eq $null) { $global:_gpuStats = @{} }
                    $global:_gpuStats.utilization = $generalUtil
                    $global:_gpuStats.decoder_util = $decoderUtil
                    $global:_gpuStats.encoder_util = $encoderUtil
                    $global:_gpuStats.vram_total_mb = $vramTotal
                    $global:_gpuStats.vram_used_mb = $vramUsed
                    $global:_gpuStats.vram_free_mb = $vramFree
                    $global:_gpuStats.vram_reserved_mb = $vramReserved
                    if ($vramTotal -gt 0) {
                        $global:_gpuStats.vram_percent = [math]::Round(($vramUsed / $vramTotal) * 100, 1)
                        $global:_gpuStats.vram_free_percent = [math]::Round(($vramFree / $vramTotal) * 100, 1)
                    }
                }
                break
            }
        }
    } catch {}
    
    return $result
}

function Get-MemoryStats {
    $totalGB = 0
    $usedGB = 0
    $freeGB = 0
    $percentUsed = 0
    
    # Method 1: Use .NET ManagementObjectSearcher for Win32_OperatingSystem
    try {
        $searcher = New-Object System.Management.ManagementObjectSearcher("SELECT TotalVisibleMemorySize, FreePhysicalMemory FROM Win32_OperatingSystem")
        $results = $searcher.Get()
        
        foreach ($obj in $results) {
            $totalKB = [long]$obj["TotalVisibleMemorySize"]
            $freeKB = [long]$obj["FreePhysicalMemory"]
            
            if ($totalKB -gt 0) {
                $totalGB = [math]::Round($totalKB / 1MB, 2)
                $freeGB = [math]::Round($freeKB / 1MB, 2)
                $usedGB = [math]::Round(($totalKB - $freeKB) / 1MB, 2)
                $percentUsed = [math]::Round((($totalKB - $freeKB) / $totalKB) * 100, 1)
            }
            break
        }
        $results.Dispose()
        $searcher.Dispose()
    } catch {
        # Method 2: Fallback to WMIC command line
        try {
            $wmicOut = & wmic OS get TotalVisibleMemorySize,FreePhysicalMemory /value 2>$null
            if (-not [string]::IsNullOrWhiteSpace($wmicOut)) {
                $totalMatch = [regex]::Match($wmicOut, 'TotalVisibleMemorySize=(\d+)')
                $freeMatch = [regex]::Match($wmicOut, 'FreePhysicalMemory=(\d+)')
                
                if ($totalMatch.Success -and $freeMatch.Success) {
                    $totalKB = [long]$totalMatch.Groups[1].Value
                    $freeKB = [long]$freeMatch.Groups[1].Value
                    
                    if ($totalKB -gt 0) {
                        $totalGB = [math]::Round($totalKB / 1MB, 2)
                        $freeGB = [math]::Round($freeKB / 1MB, 2)
                        $usedGB = [math]::Round(($totalKB - $freeKB) / 1MB, 2)
                        $percentUsed = [math]::Round((($totalKB - $freeKB) / $totalKB) * 100, 1)
                    }
                }
            }
        } catch {}
    }
    
    return @{
        total_gb = $totalGB
        used_gb = $usedGB
        free_gb = $freeGB
        percent_used = $percentUsed
    }
}

function Get-GpuStats {
    $result = @{
        utilization = $null
        decoder_util = $null
        encoder_util = $null
        vram_total_mb = $null
        vram_used_mb = $null
        vram_free_mb = $null
        vram_reserved_mb = $null
        vram_percent = $null
        vram_free_percent = $null
    }
    
    # Reuse data already fetched in Get-Temperatures (avoid redundant nvidia-smi call)
    if ($global:_gpuStats -ne $null) {
        $result.utilization = $global:_gpuStats.utilization
        $result.decoder_util = $global:_gpuStats.decoder_util
        $result.encoder_util = $global:_gpuStats.encoder_util
        $result.vram_total_mb = $global:_gpuStats.vram_total_mb
        $result.vram_used_mb = $global:_gpuStats.vram_used_mb
        $result.vram_free_mb = $global:_gpuStats.vram_free_mb
        $result.vram_reserved_mb = $global:_gpuStats.vram_reserved_mb
        $result.vram_percent = $global:_gpuStats.vram_percent
        $result.vram_free_percent = $global:_gpuStats.vram_free_percent
    } else {
        # Fallback: direct query with extended metrics
        try {
            $output = nvidia-smi --query-gpu=utilization.gpu,utilization.decoder,utilization.encoder,memory.total,memory.used,memory.free,memory.used.reserved --format=csv,noheader,nounits 2>$null
            
            if (-not [string]::IsNullOrWhiteSpace($output)) {
                $lines = $output.Trim().TrimStart().Split("`n") | Where-Object { $_.Trim() -ne "" }
                
                foreach ($line in $lines) {
                    $parts = $line.Split(',') | ForEach-Object { $_.Trim() }
                    
                    if ($parts.Count -ge 7) {
                        $generalUtil = [double]$parts[0]
                        $decoderUtil = [double]$parts[1]
                        $encoderUtil = [double]$parts[2]
                        $vramTotal = [double]$parts[3]
                        $vramUsed = [double]$parts[4]
                        $vramFree = [double]$parts[5]
                        $vramReserved = [double]$parts[6]
                        
                        $result.utilization = $generalUtil
                        $result.decoder_util = $decoderUtil
                        $result.encoder_util = $encoderUtil
                        $result.vram_total_mb = $vramTotal
                        $result.vram_used_mb = $vramUsed
                        $result.vram_free_mb = $vramFree
                        $result.vram_reserved_mb = $vramReserved
                        
                        if ($vramTotal -gt 0) {
                            $result.vram_percent = [math]::Round(($vramUsed / $vramTotal) * 100, 1)
                            $result.vram_free_percent = [math]::Round(($vramFree / $vramTotal) * 100, 1)
                        }
                        
                        break
                    }
                }
            }
        } catch {}
    }
    
    return $result
}

# Main collection function - returns JSON object
$cpuData = Get-CpuCoreUtilization
$tempData = Get-Temperatures
$memData = Get-MemoryStats
$gpuData = Get-GpuStats

$stats = @{
    timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    cpu = @{
        cores = $cpuData.cores
        average = $cpuData.average
    }
    temperatures = $tempData
    memory = $memData
    gpu = $gpuData
}

ConvertTo-Json $stats -Depth 5
