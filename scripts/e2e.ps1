<#
.SYNOPSIS
    End-to-end test for TAILIEU TTN, on Windows.

.DESCRIPTION
    The PowerShell twin of scripts/e2e.sh. The server this project deploys to is
    Windows Server 2012 R2, where bash is not available — so the full user
    journey needs a test that runs there, not only on a developer's Linux box.

    Hits the FRONTEND origin by default, not the API port directly. That means
    every request travels the path production uses (frontend → API proxy →
    backend) and exercises the proxy, which is where cookie and streaming bugs
    actually live.

.PARAMETER BaseUrl
    Frontend origin. Default http://localhost:5173

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
    powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1 -BaseUrl https://tailieu.5125121.com

.NOTES
    Written for PowerShell 4.0 (what Server 2012 R2 ships with): no `??`, no
    ternary operator, no `-Parallel`. Uses Invoke-RestMethod rather than curl,
    because `curl` in PowerShell is an alias for Invoke-WebRequest that behaves
    differently — a distinction that silently breaks scripts copied from
    tutorials.
#>

[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://localhost:5173'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Api = "$BaseUrl/api/v1"

$script:Pass = 0
$script:Fail = 0
$script:Failures = @()

# PowerShell sends `Content-Type: application/x-www-form-urlencoded` on a POST
# with no body. Fastify has no parser for that type, so it answers 415 — and
# curl sends no Content-Type at all in the same situation, which is why the
# bash twin never hit this. Every write therefore carries an explicit JSON body,
# even an empty one, so both scripts make the same request.
function New-RequestParams {
    param(
        [string]$Uri,
        [string]$Method,
        [string]$Body,
        [Microsoft.PowerShell.Commands.WebRequestSession]$Session,
        [hashtable]$Headers
    )
    $params = @{
        Uri             = $Uri
        Method          = $Method
        UseBasicParsing = $true
    }

    $isWrite = @('POST', 'PUT', 'PATCH', 'DELETE') -contains $Method
    if ($Body) {
        $params['Body'] = $Body
        $params['ContentType'] = 'application/json'
    } elseif ($isWrite) {
        $params['Body'] = '{}'
        $params['ContentType'] = 'application/json'
    }

    if ($Session) { $params['WebSession'] = $Session }
    if ($Headers) { $params['Headers'] = $Headers }
    return $params
}

function Check {
    param(
        [string]$Name,
        [string]$Expected,
        [string]$Actual
    )
    if ($Expected -eq $Actual) {
        Write-Host "  [PASS] $Name" -ForegroundColor Green
        $script:Pass = $script:Pass + 1
    } else {
        Write-Host "  [FAIL] $Name" -ForegroundColor Red
        Write-Host "         expected '$Expected', got '$Actual'" -ForegroundColor DarkGray
        $script:Fail = $script:Fail + 1
        $script:Failures += $Name
    }
}

# Status code of a request, without throwing on 4xx/5xx.
function Get-Status {
    param(
        [string]$Uri,
        [string]$Method = 'GET',
        [string]$Body,
        [Microsoft.PowerShell.Commands.WebRequestSession]$Session,
        [hashtable]$Headers
    )
    $params = New-RequestParams -Uri $Uri -Method $Method -Body $Body -Session $Session -Headers $Headers

    try {
        $response = Invoke-WebRequest @params
        return [string]$response.StatusCode
    } catch {
        # Deliberately an untyped catch. Windows PowerShell 5.1 throws
        # System.Net.WebException here; PowerShell 7 throws
        # Microsoft.PowerShell.Commands.HttpResponseException. Naming either
        # type makes this whole script fail on the other runtime, and the two
        # expose the status through the same $_.Exception.Response.
        if ($_.Exception.Response) {
            return [string][int]$_.Exception.Response.StatusCode
        }
        return '0'
    }
}

# Safe deep read of a dotted path such as 'data.0.replies.0.body'.
#
# StrictMode 2.0 makes a missing property a *terminating* error, so a plain
# `$response.data.stats.comments` against an error response aborts the entire
# run instead of failing one check. Every nested read in this script goes
# through here for that reason.
function Get-Path {
    param($Object, [string]$Path)
    $current = $Object
    foreach ($part in $Path.Split('.')) {
        if ($null -eq $current) { return '' }
        if ($part -match '^\d+$') {
            $index = [int]$part
            if (@($current).Count -le $index) { return '' }
            $current = @($current)[$index]
        } else {
            if (-not (@($current.PSObject.Properties.Name) -contains $part)) { return '' }
            $current = $current.$part
        }
    }
    if ($null -eq $current) { return '' }
    return [string]$current
}

function Get-Json {
    param(
        [string]$Uri,
        [string]$Method = 'GET',
        [string]$Body,
        [Microsoft.PowerShell.Commands.WebRequestSession]$Session,
        [hashtable]$Headers
    )
    $params = New-RequestParams -Uri $Uri -Method $Method -Body $Body -Session $Session -Headers $Headers

    try {
        return Invoke-RestMethod @params
    } catch {
        return $null
    }
}

# The response body as a string, for assertions about what is NOT in it.
#
# A leak test has to read the bytes: asserting on a parsed object only checks
# the fields the test already knows about, so a field added to the DTO later
# re-introduces the leak without failing anything.
function Get-Raw {
    param(
        [string]$Uri,
        [Microsoft.PowerShell.Commands.WebRequestSession]$Session,
        [hashtable]$Headers
    )
    $params = New-RequestParams -Uri $Uri -Method 'GET' -Session $Session -Headers $Headers

    try {
        # UseBasicParsing is set by New-RequestParams, so .Content is a string
        # here rather than a byte array on Windows PowerShell 5.1.
        $response = Invoke-WebRequest @params
        return [string]$response.Content
    } catch {
        if ($_.Exception.Response) { return '' }
        return ''
    }
}

Write-Host ''
Write-Host 'TAILIEU TTN - end-to-end'
Write-Host "target: $BaseUrl"
Write-Host ''

# `[System.IO.Path]::GetTempPath()` rather than `$env:TEMP`: the environment
# variable is Windows-only, so a script that reads it dies on the first line of
# work anywhere else. This project targets Windows Server 2012 R2 in production
# and is developed on Linux, so both paths have to work.
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("tailieu-e2e-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

# Clear rate-limit counters so this run is judged on its own traffic rather than
# the previous run's. Several sign-ins happen below, and two separate mechanisms
# have to be cleared — clearing only one is worse than clearing neither,
# because it looks like the problem is solved:
#
#   fastify-rate-limit-*  the route plugin's request counter
#   auth:fail:*           the per-account lockout, which counts *failures* and
#                         survives the first reset, so run two fails at login
#                         while every other check still passes
#
# Windows has no `docker` on Server 2012 R2, so this is best-effort: on the
# production host the container name will not resolve and the run proceeds
# against whatever quota is left. That is the previous behaviour, made visible
# rather than silent.
$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
    foreach ($pattern in @('fastify-rate-limit-*', 'auth:fail:*')) {
        $keys = & docker exec -i tailieu-redis redis-cli --scan --pattern $pattern 2>$null
        $clean = @($keys | Where-Object { $_ -and "$_".Trim() })
        if ($clean.Count -gt 0) {
            & docker exec -i tailieu-redis redis-cli DEL @clean 2>$null | Out-Null
        }
    }
}

try {

    # --- 1. Reachability ------------------------------------------------------
    Write-Host '1. Ket noi'
    Check 'trang chu tra ve 200' '200' (Get-Status "$BaseUrl/")
    Check 'health qua proxy'     '200' (Get-Status "$BaseUrl/api/health")

    $faculties = Get-Json "$Api/taxonomy/faculties?limit=100"
    $facultyTotal = 0
    if ($faculties) { $facultyTotal = $faculties.meta.total }
    $expectedFacultyTotal = 7
    Check 'proxy chuyen tiep toi API' ([string]$expectedFacultyTotal) ([string]$facultyTotal)

    # --- 2. Taxonomy ----------------------------------------------------------
    Write-Host ''
    Write-Host '2. Taxonomy (du lieu 2026)'
    $tree = Get-Json "$Api/taxonomy/tree"
    $facultyCount = 0
    $programCount = 0
    if ($tree) {
        $facultyCount = $tree.data.Count
        foreach ($f in $tree.data) { $programCount = $programCount + $f.programs.Count }
    }
    Check '7 khoa'  '7'  ([string]$facultyCount)
    Check '37 nganh' '37' ([string]$programCount)

    $facultyList = Get-Json "$Api/taxonomy/faculties?q=C%C3%B4ng%20ngh%E1%BB%87"
    $facultyId = $facultyList.data[0].id
    Check 'lay duoc khoa CNTT' 'yes' $(if ($facultyId) { 'yes' } else { 'no' })

    $docTypes = Get-Json "$Api/taxonomy/document-types?limit=100"
    $docTypeId = $null
    foreach ($t in $docTypes.data) { if ($t.code -eq 'lecture') { $docTypeId = $t.id } }
    Check 'lay duoc loai tai lieu' 'yes' $(if ($docTypeId) { 'yes' } else { 'no' })

    # --- 3. Vietnamese search -------------------------------------------------
    Write-Host ''
    Write-Host '3. Tim kiem tieng Viet'
    $suggest = Get-Json "$Api/search/suggest?q=cong"
    $hasAccented = 'no'
    foreach ($s in $suggest.data) {
        if ($s.label -like '*Công nghệ*') { $hasAccented = 'yes' }
    }
    Check 'goi y khong dau ra ket qua co dau' 'yes' $hasAccented
    Check 'tim kiem rong bi tu choi' '422' (Get-Status "$Api/search/suggest?q=")

    # --- 4. Auth --------------------------------------------------------------
    Write-Host ''
    Write-Host '4. Xac thuc'
    $email = "e2e-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + "-" + (Get-Random -Maximum 99999) + "@tailieu.test"
    $registerBody = @{
        email       = $email
        password    = 'MatKhauRatDai2026'
        displayName = 'E2E Tester'
    } | ConvertTo-Json

    $registerStatus = Get-Status -Uri "$Api/auth/register" -Method 'POST' -Body $registerBody
    Check 'dang ky tra 201' '201' $registerStatus

    $duplicateStatus = Get-Status -Uri "$Api/auth/register" -Method 'POST' -Body $registerBody
    Check 'dang ky trung email bi tu choi' '409' $duplicateStatus

    # A web session carries the refresh and CSRF cookies automatically, which is
    # the whole point of testing through the frontend origin.
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $loginBody = @{ email = 'student@tailieu.local'; password = 'ChangeMe_Student_2026' } | ConvertTo-Json

    $login = Get-Json -Uri "$Api/auth/login" -Method 'POST' -Body $loginBody -Session $session
    $token = $null
    if ($login) { $token = $login.data.accessToken }
    Check 'dang nhap sinh vien' 'yes' $(if ($token) { 'yes' } else { 'no' })

    $csrfCookie = $session.Cookies.GetCookies($BaseUrl) | Where-Object { $_.Name -eq 'csrf' }
    $csrf = ''
    if ($csrfCookie) { $csrf = $csrfCookie.Value }
    Check 'cookie CSRF duoc dat' 'yes' $(if ($csrf) { 'yes' } else { 'no' })

    $authHeader = @{ Authorization = "Bearer $token" }

    $me = Get-Json -Uri "$Api/auth/me" -Session $session
    Check 'khong token thi 401' '401' (Get-Status "$Api/auth/me")

    # --- 5. Chunked upload ----------------------------------------------------
    Write-Host ''
    Write-Host '5. Tai len chia phan'

    # A minimal valid PDF. Must be a real PDF header — the server validates by
    # magic bytes and rejects anything else, which is what makes the test below
    # meaningful.
    $pdfPath = Join-Path $tempDir 'bai-giang.pdf'
    $pdfContent = "%PDF-1.4`n1 0 obj<</Type/Catalog>>endobj`ntrailer<</Root 1 0 R>>`n%%EOF`n"
    [System.IO.File]::WriteAllText($pdfPath, $pdfContent)
    $pdfSize = (Get-Item $pdfPath).Length

    $intentBody = @{
        fileName  = 'bai-giang-e2e.pdf'
        sizeBytes = $pdfSize
        mimeType  = 'application/pdf'
    } | ConvertTo-Json

    $intent = Get-Json -Uri "$Api/uploads" -Method 'POST' -Body $intentBody -Session $session -Headers $authHeader
    # The auth header has to be added by hand: a WebSession carries cookies, not
    # bearer tokens.
    $uploadId = $null
    if ($intent) { $uploadId = $intent.data.uploadId }
    Check 'tao phien tai len' 'yes' $(if ($uploadId) { 'yes' } else { 'no' })

    if ($uploadId) {
        $chunkParams = @{
            Uri             = "$Api/uploads/$uploadId/chunks/0"
            Method          = 'PUT'
            Body            = [System.IO.File]::ReadAllBytes($pdfPath)
            ContentType     = 'application/octet-stream'
            Headers         = @{ Authorization = "Bearer $token"; 'x-csrf-token' = $csrf }
            UseBasicParsing = $true
        }
        try {
            $chunkResponse = Invoke-RestMethod @chunkParams
            Check 'gui phan 0 thanh cong' '1' ([string]$chunkResponse.data.receivedChunks)
        } catch {
            Check 'gui phan 0 thanh cong' '1' '0'
        }

        $completeParams = New-RequestParams -Uri "$Api/uploads/$uploadId/complete" -Method 'POST' `
            -Headers @{ Authorization = "Bearer $token"; 'x-csrf-token' = $csrf }
        $complete = $null
        try { $complete = Invoke-RestMethod @completeParams } catch { }

        $detected = ''
        if ($complete) { $detected = $complete.data.detectedMime }
        Check 'nhan dang dung PDF' 'application/pdf' $detected
    }

    # A PNG wearing a .pdf name must be refused.
    $fakePath = Join-Path $tempDir 'gia-mao.pdf'
    $pngHeader = [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    $padding = New-Object byte[] 500
    [System.IO.File]::WriteAllBytes($fakePath, ($pngHeader + $padding))
    $fakeSize = (Get-Item $fakePath).Length

    $fakeIntentBody = @{ fileName = 'gia-mao.pdf'; sizeBytes = $fakeSize; mimeType = 'application/pdf' } | ConvertTo-Json
    $fakeIntent = Get-Json -Uri "$Api/uploads" -Method 'POST' -Body $fakeIntentBody -Session $session -Headers $authHeader

    if ($fakeIntent) {
        $fakeParams = @{
            Uri             = "$Api/uploads/$($fakeIntent.data.uploadId)/chunks/0"
            Method          = 'PUT'
            Body            = [System.IO.File]::ReadAllBytes($fakePath)
            ContentType     = 'application/octet-stream'
            Headers         = @{ Authorization = "Bearer $token"; 'x-csrf-token' = $csrf }
            UseBasicParsing = $true
        }
        $fakeStatus = '0'
        try { Invoke-RestMethod @fakeParams | Out-Null; $fakeStatus = '200' }
        catch {
            if ($_.Exception.Response) { $fakeStatus = [string][int]$_.Exception.Response.StatusCode }
        }
        Check 'tep gia mao bi tu choi (415)' '415' $fakeStatus
    }

    # --- 6. Document ----------------------------------------------------------
    Write-Host ''
    Write-Host '6. Tai lieu'

    $docBody = @{
        title            = 'Bai giang E2E - Lap trinh C++'
        description      = 'Tai lieu kiem thu dau-cuoi'
        documentTypeId   = $docTypeId
        facultyId        = $facultyId
        visibility       = 'public'
        uploadIds        = @($uploadId)
        tags             = @('C++', 'Kiem thu')
        uploaderConfirmed = $true
    } | ConvertTo-Json

    $document = Get-Json -Uri "$Api/documents" -Method 'POST' -Body $docBody -Session $session -Headers $authHeader
    $docId = $null
    if ($document) { $docId = $document.data.id }
    Check 'tao tai lieu' 'yes' $(if ($docId) { 'yes' } else { 'no' })

    if ($docId) {
        $fileCount = $document.data.files.Count
        Check 'gan duoc tep' '1' ([string]$fileCount)

        # Storage internals must never reach the client.
        $raw = Invoke-WebRequest -Uri "$Api/documents/$docId" -Headers $authHeader -UseBasicParsing
        $leaked = 'clean'
        foreach ($needle in @('objectKey', 'storageKey', 'contentHash')) {
            if ($raw.Content -like "*$needle*") { $leaked = 'LEAK' }
        }
        Check 'khong ro ri khoa luu tru' 'clean' $leaked

        # --- 7. Preview and download ------------------------------------------
        Write-Host ''
        Write-Host '=== cho quet virus (neu dang bat) ==='

        # When SCAN_ENABLED is true a file stays pending and is deliberately not
        # downloadable until the scanner clears it. Waiting here is the feature
        # working, not a flaky test — asserting immediately would only pass with
        # scanning switched off, which is not the configuration under test.
        $scanWait = 0
        while ($scanWait -lt 20) {
            $probe = Get-Json -Uri "$Api/documents/$docId/download" -Headers $authHeader
            if (Get-Path $probe 'data.url') { break }
            $scanWait = $scanWait + 1
            Start-Sleep -Seconds 3
        }
        if ($scanWait -gt 0) { Write-Host "  tep san sang sau ~$($scanWait * 3)s" }

        Write-Host ''
        Write-Host '7. Xem truoc va tai xuong'

        $preview = Get-Json -Uri "$Api/documents/$docId/preview" -Session $session -Headers $authHeader
        $previewKind = ''
        if ($preview) { $previewKind = $preview.data.kind }
        Check 'xem truoc nhan dang PDF' 'pdf' $previewKind

        $download = Get-Json -Uri "$Api/documents/$docId/download" -Session $session -Headers $authHeader
        $downloadUrl = $null
        if ($download) { $downloadUrl = $download.data.url }
        Check 'tai xuong tra URL co chu ky' 'yes' $(if ($downloadUrl) { 'yes' } else { 'no' })

        if ($downloadUrl) {
            $downloadedPath = Join-Path $tempDir 'downloaded.pdf'
            Invoke-WebRequest -Uri $downloadUrl -OutFile $downloadedPath -UseBasicParsing

            $originalHash = (Get-FileHash $pdfPath -Algorithm SHA256).Hash
            $downloadedHash = (Get-FileHash $downloadedPath -Algorithm SHA256).Hash
            Check 'noi dung tai ve khop ban goc' $originalHash $downloadedHash
        }
    }

    # --- 8. Permissions -------------------------------------------------------
    Write-Host ''
    Write-Host '8. Phan quyen'

    $modBody = @{ email = 'moderator@tailieu.local'; password = 'ChangeMe_Mod_2026' } | ConvertTo-Json
    $modLogin = Get-Json -Uri "$Api/auth/login" -Method 'POST' -Body $modBody
    $modToken = ''
    if ($modLogin) { $modToken = $modLogin.data.accessToken }

    $newFaculty = @{ code = "E2E$(Get-Random -Maximum 99999)"; name = 'Khoa E2E' } | ConvertTo-Json
    Check 'sinh vien khong tao duoc khoa' '403' `
        (Get-Status -Uri "$Api/taxonomy/faculties" -Method 'POST' -Body $newFaculty -Session $session -Headers $authHeader)

    $modStatus = '0'
    try {
        Invoke-RestMethod -Uri "$Api/taxonomy/faculties" -Method 'POST' -Body $newFaculty `
            -ContentType 'application/json' -Headers @{ Authorization = "Bearer $modToken" } -UseBasicParsing | Out-Null
        $modStatus = '201'
    } catch {
        if ($_.Exception.Response) { $modStatus = [string][int]$_.Exception.Response.StatusCode }
    }
    Check 'kiem duyet vien khong tao duoc khoa' '403' $modStatus

    # --- 9. Community: posts and the comment thread ---------------------------
    Write-Host ''
    Write-Host '9. Cong dong'

    # Fresh sign-in: the CSRF section below logs this session out, and the
    # cleanup section needs a live token.
    $freshBody = @{ email = 'student@tailieu.local'; password = 'ChangeMe_Student_2026' } | ConvertTo-Json
    $freshLogin = Get-Json -Uri "$Api/auth/login" -Method 'POST' -Body $freshBody
    $freshToken = ''
    if ($freshLogin) { $freshToken = $freshLogin.data.accessToken }
    $freshHeader = @{ Authorization = "Bearer $freshToken" }

    $postBody = @{
        body       = 'E2E- bai kiem thu luong binh luan'
        visibility = 'public'
        postKind   = 'status'
        tags       = @()
    } | ConvertTo-Json

    $post = Get-Json -Uri "$Api/posts" -Method 'POST' -Body $postBody -Headers $freshHeader
    $postId = ''
    if ($post) { $postId = $post.data.id }
    Check 'dang duoc bai' 'yes' $(if ($postId) { 'yes' } else { 'no' })

    $rootBody = @{ targetType = 'post'; targetId = $postId; body = 'E2E- goc' } | ConvertTo-Json
    $rootComment = Get-Json -Uri "$Api/comments" -Method 'POST' -Body $rootBody -Headers $freshHeader
    $rootId = ''
    if ($rootComment) { $rootId = $rootComment.data.id }

    $replyBody = @{
        targetType      = 'post'
        targetId        = $postId
        body            = 'E2E- tra loi'
        parentCommentId = $rootId
    } | ConvertTo-Json

    $replyComment = Get-Json -Uri "$Api/comments" -Method 'POST' -Body $replyBody -Headers $freshHeader
    $replyId = ''
    if ($replyComment) { $replyId = $replyComment.data.id }

    $thread = Get-Json -Uri "$Api/comments?targetType=post&targetId=$postId&limit=50"
    Check 'luong co 1 binh luan goc' '1' (Get-Path $thread 'meta.total')
    Check 'tra loi nam duoi goc' 'E2E- tra loi' (Get-Path $thread 'data.0.replies.0.body')

    $postAfter = Get-Json -Uri "$Api/posts/$postId"
    Check 'bai dem dung 2 binh luan' '2' (Get-Path $postAfter 'data.stats.comments')

    # The regression this section exists for. Deleting a top-level comment used
    # to take its whole subtree with it: the thread came back empty while the
    # post went on advertising the full count. A live reply must survive its
    # parent's removal.
    Check 'xoa duoc binh luan goc' '200' `
        (Get-Status -Uri "$Api/comments/$rootId" -Method 'DELETE' -Headers $freshHeader)

    $after = Get-Json -Uri "$Api/comments?targetType=post&targetId=$postId&limit=50"
    Check 'goc da xoa van giu cho trong luong' '1' (Get-Path $after 'meta.total')
    Check 'goc da xoa duoc danh dau' 'True' (Get-Path $after 'data.0.deleted')
    Check 'than binh luan da xoa bi giu kin' '' (Get-Path $after 'data.0.body')
    Check 'ten tac gia da xoa bi giu kin' '' (Get-Path $after 'data.0.author.id')
    Check 'tra loi con song van hien thi' 'E2E- tra loi' (Get-Path $after 'data.0.replies.0.body')

    $orphanBody = @{
        targetType      = 'post'
        targetId        = $postId
        body            = 'mo coi'
        parentCommentId = $rootId
    } | ConvertTo-Json
    Check 'khong tra loi duoc vao binh luan da xoa' '404' `
        (Get-Status -Uri "$Api/comments" -Method 'POST' -Body $orphanBody -Headers $freshHeader)

    # A count the thread cannot account for is the symptom of the bug above, so
    # the two are asserted against each other rather than each against a constant.
    $slots = 0
    $threadItems = @()
    if ($null -ne $after) { $threadItems = @($after.data) }
    foreach ($c in $threadItems) {
        $slots = $slots + 1
        $slots = $slots + @($c.replies).Count
    }
    Check 'so dem khop so cho trong luong' '2' ([string]$slots)

    $likeBody = @{ liked = $true } | ConvertTo-Json
    $liked = Get-Json -Uri "$Api/likes/post/$postId" -Method 'PUT' -Body $likeBody -Headers $freshHeader
    Check 'thich duoc bai' 'True' (Get-Path $liked 'data.liked')

    $unlikeBody = @{ liked = $false } | ConvertTo-Json
    $unliked = Get-Json -Uri "$Api/likes/post/$postId" -Method 'PUT' -Body $unlikeBody -Headers $freshHeader
    Check 'bo thich duoc bai' 'False' (Get-Path $unliked 'data.liked')

    # --- 10. Bo suu tap -------------------------------------------------------
    Write-Host ''
    Write-Host '10. Bo suu tap'

    # The leak this section exists for. A collection is a list of *pointers*,
    # and the pointers are what leak: a public collection holding a post that
    # later becomes private must stop showing it, and the count above the list
    # has to move with it. Asserting only on the item list would miss the
    # count, and asserting only on the count would miss a title in the response
    # body — so both are checked, and the body is checked as a raw string.
    $colPostBody = @{
        body       = 'E2E- bai trong bo suu tap'
        visibility = 'public'
        postKind   = 'status'
        tags       = @()
    } | ConvertTo-Json
    $colPost = Get-Json -Uri "$Api/posts" -Method 'POST' -Body $colPostBody -Headers $freshHeader
    $colPostId = Get-Path $colPost 'data.id'
    Check 'tao bai de luu vao bo suu tap' 'yes' $(if ($colPostId) { 'yes' } else { 'no' })

    $colBody = @{ title = 'E2E- bo suu tap kiem thu'; visibility = 'public' } | ConvertTo-Json
    $col = Get-Json -Uri "$Api/collections" -Method 'POST' -Body $colBody -Headers $freshHeader
    $colId = Get-Path $col 'data.id'
    Check 'tao duoc bo suu tap' 'yes' $(if ($colId) { 'yes' } else { 'no' })

    # Two collections differing only in capitalisation are the same collection
    # to a reader, and the unique index folds case for that reason.
    $dupBody = @{ title = 'E2E- BO SUU TAP KIEM THU'; visibility = 'public' } | ConvertTo-Json
    Check 'trung ten khac hoa bi tu choi' '409' `
        (Get-Status -Uri "$Api/collections" -Method 'POST' -Body $dupBody -Headers $freshHeader)

    $itemBody = @{ targetType = 'post'; targetId = $colPostId } | ConvertTo-Json
    Check 'them duoc muc vao bo suu tap' '201' `
        (Get-Status -Uri "$Api/collections/$colId/items" -Method 'POST' -Body $itemBody -Headers $freshHeader)

    $anonCol = Get-Json -Uri "$Api/collections/$colId"
    Check 'khach an danh thay dung 1 muc' '1' (Get-Path $anonCol 'data.itemCount')
    Check 'so dem khop so muc hien thi' '1' ([string]@($anonCol.data.items).Count)

    # Hide the post. Nothing about the collection changed — but everything the
    # reader is shown must.
    $hideBody = @{ visibility = 'private' } | ConvertTo-Json
    Get-Json -Uri "$Api/posts/$colPostId" -Method 'PATCH' -Body $hideBody -Headers $freshHeader | Out-Null

    $hidden = Get-Json -Uri "$Api/collections/$colId"
    Check 'bai rieng tu bien mat khoi bo suu tap cong khai' '0' (Get-Path $hidden 'data.itemCount')

    $hiddenRaw = Get-Raw -Uri "$Api/collections/$colId"
    $leaks = $hiddenRaw -match 'E2E- bai trong bo suu tap'
    Check 'khong ro ri tieu de qua than phan hoi' 'clean' $(if ($leaks) { 'leak' } else { 'clean' })

    # The owner keeps seeing what they always could. If this were 0 the fix
    # would have been "hide it from everyone", which is a different bug.
    $ownerCol = Get-Json -Uri "$Api/collections/$colId" -Headers $freshHeader
    Check 'chu so huu van thay muc cua minh' '1' (Get-Path $ownerCol 'data.itemCount')

    $anonCreate = @{ title = 'E2E- khong dang nhap' } | ConvertTo-Json
    Check 'khong tao duoc bo suu tap khi chua dang nhap' '401' `
        (Get-Status -Uri "$Api/collections" -Method 'POST' -Body $anonCreate)

    # A private collection must answer 404 to someone who cannot see it, never
    # 403. A 403 would confirm the id exists, which turns the uuid space into
    # an oracle.
    $privBody = @{ title = 'E2E- bo suu tap rieng tu' } | ConvertTo-Json
    $priv = Get-Json -Uri "$Api/collections" -Method 'POST' -Body $privBody -Headers $freshHeader
    $colPrivId = Get-Path $priv 'data.id'
    Check 'tao duoc bo suu tap rieng tu' 'private' `
        (Get-Path (Get-Json -Uri "$Api/collections/$colPrivId" -Headers $freshHeader) 'data.visibility')
    Check 'khach an danh nhan 404 cho bo suu tap rieng tu' '404' `
        (Get-Status -Uri "$Api/collections/$colPrivId")

    # --- 11. CSRF -------------------------------------------------------------
    Write-Host ''
    Write-Host '11. Bao ve CSRF'

    Check 'thieu header CSRF thi 403' '403' `
        (Get-Status -Uri "$Api/auth/logout" -Method 'POST' -Session $session -Headers $authHeader)

    # `-Session $session` is the entire point of these two checks: the CSRF
    # cookie has to be *sent* for the guard to compare against it. Without it
    # the request carries the header but no cookie, the guard rejects both
    # calls, and the first check passes for the wrong reason while the second
    # fails — which is exactly how this section read before the session was
    # attached.
    $logoutParams = New-RequestParams -Uri "$Api/auth/logout" -Method 'POST' `
        -Session $session -Headers @{ Authorization = "Bearer $token"; 'x-csrf-token' = $csrf }
    $logoutStatus = '0'
    try { Invoke-RestMethod @logoutParams | Out-Null; $logoutStatus = '200' }
    catch {
        if ($_.Exception.Response) { $logoutStatus = [string][int]$_.Exception.Response.StatusCode }
    }
    Check 'dung header CSRF thi 200' '200' $logoutStatus

    $afterLogout = Get-Status -Uri "$Api/auth/me" -Headers $authHeader
    Check 'token chet sau khi dang xuat' '401' $afterLogout

    # --- 12. Cleanup ----------------------------------------------------------
    Write-Host ''
    Write-Host '12. Don dep'

    # Leave no trace. A test that creates rows and abandons them makes the next
    # run's assertions drift, and the drift looks like a product bug.
    #
    # The post goes before anything else: comments are polymorphic, so there is
    # no foreign key from a comment to its post and deleting the post would
    # strand them.
    # Collections first: an item is polymorphic, so nothing cascades from a post
    # deletion to the row pointing at it — the item would be left behind
    # pointing at nothing.
    if ($colId) {
        Check 'don bo suu tap' '200' `
            (Get-Status -Uri "$Api/collections/$colId" -Method 'DELETE' -Headers $freshHeader)
    }

    if ($colPrivId) {
        Check 'don bo suu tap rieng tu' '200' `
            (Get-Status -Uri "$Api/collections/$colPrivId" -Method 'DELETE' -Headers $freshHeader)
    }

    if ($colPostId) {
        Check 'don bai trong bo suu tap' '200' `
            (Get-Status -Uri "$Api/posts/$colPostId" -Method 'DELETE' -Headers $freshHeader)
    }

    if ($postId) {
        Check 'don bai kiem thu' '200' `
            (Get-Status -Uri "$Api/posts/$postId" -Method 'DELETE' -Headers $freshHeader)
    }

} finally {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# --- Result -------------------------------------------------------------------

Write-Host ''
Write-Host '------------------------------------------'

$total = $script:Pass + $script:Fail
if ($script:Fail -eq 0) {
    Write-Host "TAT CA DAT  $script:Pass/$total kiem tra dat" -ForegroundColor Green
    exit 0
} else {
    Write-Host "CO LOI  $script:Pass/$total dat, $script:Fail loi:" -ForegroundColor Red
    foreach ($f in $script:Failures) { Write-Host "     - $f" }
    exit 1
}
