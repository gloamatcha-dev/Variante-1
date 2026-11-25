$ErrorActionPreference = 'Stop'
$revision = '65727574dfcd264acbb0c3e07860e4e9e9b221851'
$files = [ordered]@{
    'deu.traineddata' = '97ed7b2b60f2771c07040660ef0f6daf596dc7bf'
    'eng.traineddata' = 'bbef4675053b5b468cdb477053e28b1c698ba08e'
    'LICENSE' = 'd645695673349e3947e8e5ae42332d0ac3164cd7'
}
$destination = Join-Path $PSScriptRoot '../public/ocr/tessdata-4.1.0'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('gloa-ocr-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    foreach ($name in $files.Keys) {
        $target = Join-Path $destination $name
        if (Test-Path -LiteralPath $target) {
            $digest = & git hash-object --no-filters -- $target
            if ($LASTEXITCODE -ne 0 -or $digest -cne $files[$name]) { throw "Existing OCR asset differs: $name" }
            continue
        }
        $file = Join-Path $scratch $name
        Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 40 `
            -Uri "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$revision/$name" -OutFile $file
        $digest = & git hash-object --no-filters -- $file
        if ($LASTEXITCODE -ne 0 -or $digest -cne $files[$name]) { throw "OCR asset integrity check failed: $name" }
    }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    foreach ($name in $files.Keys) {
        $file = Join-Path $scratch $name
        if (Test-Path -LiteralPath $file) { Move-Item -LiteralPath $file -Destination (Join-Path $destination $name) }
    }
    'OCR language assets verified and available locally.'
} finally {
    foreach ($name in $files.Keys) {
        $file = Join-Path $scratch $name
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
    }
    Remove-Item -LiteralPath $scratch
}
