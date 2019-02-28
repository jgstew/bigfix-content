
**See also:**
- https://www.google.com/search?q=Relevance+bigfix.me%2Fuser%2Fjgstew+site%3Abigfix.me
- https://github.com/jgstew/bigfix-content/tree/master/relevance
- https://github.com/jgstew/bigfix-content/blob/master/session_relevance/README.md

### Client Relevance: 
1. `(it as trimmed string) of following texts of firsts ":" of lines whose(it starts with "q:" OR it starts with "Q:") of files "C:\Users\jgstew\Documents\_Code\sample_qna.txt"`
1. `sets of (it as trimmed string) of following texts of firsts ":" of lines whose(it starts with "q:" OR it starts with "Q:") of files "C:\Users\jgstew\Documents\_Code\sample_qna.txt"`
1. `("<Property Name=%22QnA%22 ID=%221%22 EvaluationPeriod=%22PT12H%22>" & it & "</Property>") of (it as trimmed string) of following texts of firsts ":" of lines whose(it starts with "q:" OR it starts with "Q:") of files "C:\Users\jgstew\Documents\_Code\sample_qna.txt"`
1. WinHTTP Proxy Settings - https://bigfix.me/relevance/details/3021642 - `unique values of following texts of lasts "%00%00%00" of preceding texts of lasts "%00%00%00%00" of (hexadecimal strings it) of unique values of (it as string) of values "WinHttpSettings" of keys "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings\Connections" of (x64 registries; x32 registries)`
1. Relevance for Mirror Server Folder: (root or relay) `folders "Mirror Server" of ( folders "/var/opt/BESRelay"; folders "/var/opt/BESServer"; (if (windows of operating system) then ( (parent folders of regapps "BESRelay.exe") ; ( (folder it) of (it as string) of values "StoragePath" of keys "HKEY_LOCAL_MACHINE\SOFTWARE\BigFix\Enterprise Server\GlobalOptions" of (x64 registries; x32 registries) ) ) else NOTHINGS) )`
1. DownloadCache.db on root or relay: `files "DownloadCache.db" of folders "config" of folders "Mirror Server" of ( folders "/var/opt/BESRelay"; folders "/var/opt/BESServer"; (if (windows of operating system) then ( (parent folders of regapps "BESRelay.exe") ; ( (folder it) of (it as string) of values "StoragePath" of keys "HKEY_LOCAL_MACHINE\SOFTWARE\BigFix\Enterprise Server\GlobalOptions" of (x64 registries; x32 registries) ) ) else NOTHINGS) )`

### Session Relevance:

1. CVEs in Windows OS Patch site: `unique values of (it as trimmed string) of substrings separated by "; " of unique values of cve id lists of fixlets of bes site whose(name of it = "Enterprise Security")`
