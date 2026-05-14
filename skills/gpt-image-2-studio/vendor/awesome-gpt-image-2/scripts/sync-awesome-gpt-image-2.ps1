param(
  [string]$Root = "skills\gpt-image-2-studio\vendor\awesome-gpt-image-2\upstream"
)

$ErrorActionPreference = "Stop"
$base = "https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main"
$files = @(
  @{ Url = "$base/data/cases.json"; Path = "$Root/data/cases.json" },
  @{ Url = "$base/data/style-library.json"; Path = "$Root/data/style-library.json" },
  @{ Url = "$base/agents/skills/gpt-image-2-style-library/SKILL.md"; Path = "$Root/agents/skills/gpt-image-2-style-library/SKILL.md" },
  @{ Url = "$base/agents/skills/gpt-image-2-style-library/references/style-library.md"; Path = "$Root/agents/skills/gpt-image-2-style-library/references/style-library.md" }
)

foreach ($file in $files) {
  $dir = Split-Path -Parent $file.Path
  New-Item -ItemType Directory -Force $dir | Out-Null
  Write-Host "Downloading $($file.Url)"
  Invoke-WebRequest -Uri $file.Url -OutFile $file.Path -UseBasicParsing
}

Write-Host "Done. Upstream files saved to $Root"
