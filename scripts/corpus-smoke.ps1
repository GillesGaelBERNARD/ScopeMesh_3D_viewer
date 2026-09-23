param(
  [string]$CorpusRoot = 'I:\Gilles\Documents\TRAVAIL\photogrammetry',
  [string]$BaseUrl = 'http://127.0.0.1:4173',
  [string]$ReportPath = 'test-results\corpus-smoke-2026-09-22.json'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $CorpusRoot).Path
$objects = @(Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.obj' | Sort-Object FullName)
$results = [System.Collections.Generic.List[object]]::new()
$reportDirectory = Split-Path -Parent $ReportPath
if ($reportDirectory) { New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null }

function Save-Report {
  $payload = [ordered]@{
    corpusRoot = $root
    startedAt = $script:startedAt
    updatedAt = (Get-Date).ToString('o')
    objectCount = $objects.Count
    completedCount = @($results | Where-Object status -eq 'complete').Count
    failedCount = @($results | Where-Object status -eq 'failed').Count
    results = $results
  }
  $payload | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $ReportPath -Encoding utf8
}

$script:startedAt = (Get-Date).ToString('o')
Write-Host "Found $($objects.Count) OBJ files below $root"

for ($index = 0; $index -lt $objects.Count; $index += 1) {
  $object = $objects[$index]
  $ordinal = $index + 1
  $relativePath = [System.IO.Path]::GetRelativePath($root, $object.FullName)
  $label = 'Corpus {0:d3}' -f $ordinal
  $started = Get-Date
  Write-Host "[$ordinal/$($objects.Count)] PREPARE $relativePath"

  try {
    $job = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/prepare" -ContentType 'application/json' -Body (@{
      path = $object.FullName
      label = $label
    } | ConvertTo-Json)
    $lastProgress = -1
    while ($true) {
      Start-Sleep -Milliseconds 700
      $job = Invoke-RestMethod -Uri "$BaseUrl/api/jobs/$($job.id)"
      if ($job.progress -ne $lastProgress) {
        Write-Host "[$ordinal/$($objects.Count)] $($job.progress)% $($job.message)"
        $lastProgress = $job.progress
      }
      if ($job.status -eq 'complete' -or $job.status -eq 'failed') { break }
      if (((Get-Date) - $started).TotalMinutes -gt 30) { throw 'Preparation exceeded the 30-minute per-file limit.' }
    }
    if ($job.status -eq 'failed') { throw $job.message }

    $manifest = Invoke-RestMethod -Uri "$BaseUrl/dataset/$($job.datasetId)/manifest.json"
    $model = Invoke-WebRequest -Method Head -Uri "$BaseUrl$($manifest.modelUrl)"
    if ($model.StatusCode -ne 200) { throw "Model returned HTTP $($model.StatusCode)." }
    if ($manifest.materials.Count -ne $manifest.stats.materials) { throw 'Manifest material count is inconsistent.' }
    if ($manifest.stats.triangles -lt 1) { throw 'Prepared model contains no triangles.' }
    foreach ($material in $manifest.materials) {
      foreach ($tier in @($material.low, $material.medium, $material.full)) {
        $asset = Invoke-WebRequest -Method Head -Uri "$BaseUrl$($tier.url)"
        if ($asset.StatusCode -ne 200) { throw "Asset $($tier.url) returned HTTP $($asset.StatusCode)." }
      }
    }

    $results.Add([ordered]@{
      ordinal = $ordinal
      path = $object.FullName
      relativePath = $relativePath
      bytes = $object.Length
      status = 'complete'
      datasetId = $job.datasetId
      elapsedSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
      triangles = $manifest.stats.triangles
      materials = $manifest.stats.materials
      sourceTextureBytes = $manifest.stats.sourceTextureBytes
      error = $null
    })
    Write-Host "[$ordinal/$($objects.Count)] PASS $($job.datasetId): $($manifest.stats.triangles) triangles, $($manifest.stats.materials) materials"
  } catch {
    $results.Add([ordered]@{
      ordinal = $ordinal
      path = $object.FullName
      relativePath = $relativePath
      bytes = $object.Length
      status = 'failed'
      datasetId = if ($job) { $job.datasetId } else { $null }
      elapsedSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
      triangles = $null
      materials = $null
      sourceTextureBytes = $null
      error = $_.Exception.Message
    })
    Write-Host "[$ordinal/$($objects.Count)] FAIL $relativePath :: $($_.Exception.Message)"
  }
  Save-Report
}

Save-Report
$passed = @($results | Where-Object status -eq 'complete').Count
$failed = @($results | Where-Object status -eq 'failed').Count
Write-Host "CORPUS RESULT: $passed passed, $failed failed, $($objects.Count) total"
if ($failed -gt 0) { exit 1 }
