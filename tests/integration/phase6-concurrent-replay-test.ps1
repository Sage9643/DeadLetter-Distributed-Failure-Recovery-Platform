$jobId = "26a1f8db-6822-4563-86e0-16e2e505ed60"
$job1 = Start-Job -ScriptBlock { param($id) curl.exe -s -w "`nHTTP_STATUS:%{http_code}`n" -X POST "http://localhost:3000/api/jobs/$id/replay" } -ArgumentList $jobId
$job2 = Start-Job -ScriptBlock { param($id) curl.exe -s -w "`nHTTP_STATUS:%{http_code}`n" -X POST "http://localhost:3000/api/jobs/$id/replay" } -ArgumentList $jobId
Wait-Job $job1, $job2 | Out-Null
Write-Host "--- Request A ---"
Receive-Job $job1
Write-Host "--- Request B ---"
Receive-Job $job2