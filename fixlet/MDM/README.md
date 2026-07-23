# MDM Fixlets (Windows)

> ⚠️ **EXPERIMENTAL / UNTESTED.** These fixlets are experimental and have **not** been tested
> on live endpoints. They were authored from Microsoft's MDM Bridge WMI provider documentation
> (`root\cimv2\mdm\dmmap`) and are provided as starting points/examples. **Verify each one on a
> test device before any production use.** Several perform destructive or disruptive actions
> (wipe, reboot, rollback, policy changes) — treat them accordingly and use the commented
> targeting guards where present.

These tasks drive Windows CSPs (Configuration Service Providers) locally through the **MDM Bridge
WMI provider** instead of an OMA-DM/MDM server channel. They run as **SYSTEM** (the BigFix agent's
default context, which the `local-system` partition requires) and use the pattern established in
[`_MDM_Template.bes`](_MDM_Template.bes): resolve the BES client folder from the registry for the
output path, then `New-CimSession` / `Get-CimInstance` / `Set-CimInstance` / `New-CimInstance` /
`InvokeMethod` against `root\cimv2\mdm\dmmap`.

All tasks require `exists wmi "root/cimv2/mdm/dmmap"` (present on Windows 10 / 11+). Read-only
"Export" tasks write a JSON result to `…\BES Client\__BESData\__Global\Logs\` and make no changes.

## Template

| File | Purpose |
| --- | --- |
| [`_MDM_Template.bes`](_MDM_Template.bes) | Starting point for new MDM command fixlets: CIM/MDM-bridge boilerplate, registry-resolved output path, and description prompts. |

## Device actions

| File | CSP class / method | Notes |
| --- | --- | --- |
| `MDM Reboot Device Now - Windows.bes` | `MDM_Reboot` · `RebootNowMethod` | Immediate reboot. Disruptive. |
| `MDM Wipe Computer Persist User Data - Windows.bes` | `MDM_RemoteWipe` · `doWipeMethod` (persist user data) | **Destructive.** Uses a targeting guard. |
| `MDM Wipe Computer Persist Provisioned Data - Windows.bes` | `MDM_RemoteWipe` · `doWipePersistProvisionedDataMethod` | **Destructive.** Uses a targeting guard. |

## Windows Update

| File | CSP class / method | Notes |
| --- | --- | --- |
| `MDM Approve Windows Update by GUID - Windows.bes` | `MDM_Update_ApprovedUpdates01_01` (create instance) | Approval = creating the instance; there is no "ApproveUpdatesMethod". Set `$UpdateGUID`. |
| `MDM Export Approvable Windows Updates - Windows.bes` | `MDM_Update_InstallableUpdates01_01` / `_FailedUpdates01_01` / `_PendingRebootUpdates01_01` | Read-only; exports update GUIDs for use with the approve task. |
| `MDM Roll Back Latest Quality Update - Windows.bes` | `MDM_Update_Rollback01` · `QualityUpdateMethod` | Latest quality update only; SAC devices. ⚠️ MS docs swap the two method descriptions — trusts the method **name**. |
| `MDM Roll Back Latest Feature Update - Windows.bes` | `MDM_Update_Rollback01` · `FeatureUpdateMethod` | Latest feature update only; SAC devices. Same doc-swap caveat. |

## Policy configuration & audit

| File | CSP class | Notes |
| --- | --- | --- |
| `MDM Set Windows Update for Business Policy - Windows.bes` | `MDM_Policy_Config01_Update02` | Defer/pause/active-hours/auto-update/driver settings. `TargetReleaseVersion`/`ProductVersion` are **not** exposed by this class. |
| `MDM Set DeviceLock Password Policy - Windows.bes` | `MDM_Policy_Config01_DeviceLock02` | Password length/complexity/lockout. Deliberately does **not** set the inverted `DevicePasswordEnabled` (0=Enabled). |
| `MDM Set Defender Antivirus Policy - Windows.bes` | `MDM_Policy_Config01_Defender02` | Real-time monitoring, cloud protection, ASR rules. Tamper Protection is **not** exposed by this class. |
| `MDM Export MDM Policy Area - Windows.bes` | `MDM_Policy_Result01_*` | Generic read-only auditor of effective values; defaults to `Update`, retarget via params (`DeviceLock`, `Defender`, …). |

Policy classes are keyed by `ParentID`/`InstanceID` (not singletons), e.g.
`ParentID='./Vendor/MSFT/Policy/Config' and InstanceID='Update'`.

## Inventory & health (read-only exports)

| File | CSP class | Notes |
| --- | --- | --- |
| `MDM Export Device Detail - Windows.bes` | `MDM_DevDetail*` | Device/OS/firmware identifiers. |
| `MDM Get Device Location - Windows.bes` | Location CSP | Device location query. |
| `MDM Export Installed App Inventory - Windows.bes` | `MDM_EnterpriseModernAppManagement*` | Installed modern apps. |
| `MDM Export Installed AppX MSIX Inventory - Windows.bes` | `MDM_EnterpriseModernAppManagement_AppManagement01_03` | Per-package name/version/publisher/flags. |
| `MDM Export Device Security Health - Windows.bes` | `MDM_DeviceStatus*` | Secure Boot, TPM, AV/antispyware, firewall, UAC, encryption compliance, Device Guard/VBS, OS edition. Status fields are CSP enum codes. |
| `MDM Export Windows Hello for Business Config - Windows.bes` | `MDM_PassportForWork*` | Enumerated by tenant GUID (no filter). |

## App management

| File | CSP class / method | Notes |
| --- | --- | --- |
| `MDM Uninstall Provisioned App Package - Windows.bes` | `MDM_EnterpriseModernAppManagement_AppManagement01` · `RemovePackageMethod` | Removes a provisioned AppX/MSIX by PackageFamilyName. |

## Networking & certificates

| File | CSP class | Notes |
| --- | --- | --- |
| `MDM Deploy VPN Profile - Windows.bes` | `MDM_VPNv2_01` | Create instance keyed by profile name; supply a valid `ProfileXML`. |
| `MDM Install PFX Client Certificate - Windows.bes` | `MDM_ClientCertificateInstall_PFXCertInstall01_01` | Supply the PFX as a base64 blob; **provide the password securely at deploy time — do not commit secrets.** |

## Not available via the WMI bridge

The following are commonly requested but are **not** reachable through this provider, so no fixlet
is provided (they would require an OMA-DM/SyncML channel or another mechanism):

- **MSI (Win32) app install/uninstall** — the EnterpriseDesktopAppManagement CSP is OMA-DM only
  (`Add`/`Exec` on `DownloadInstall`, `Delete` to uninstall). For MSI deployment use a normal
  BigFix download + `msiexec` fixlet instead.
- **Wi-Fi profile provisioning** — use the WiFi CSP or `netsh wlan add profile`.
- **Enrollment state (DMClient)** — not exposed as a WMI class; see the DMClient CSP or the
  `HKLM\SOFTWARE\Microsoft\Enrollments` registry key.

## References

- [MDM Bridge WMI provider](https://learn.microsoft.com/en-us/windows/win32/dmwmibridgeprov/mdm-bridge-wmi-provider-portal)
- [Using PowerShell scripting with the WMI Bridge provider](https://learn.microsoft.com/en-us/windows/client-management/mdm/using-powershell-scripting-with-the-wmi-bridge-provider)
- [Configuration service provider (CSP) reference](https://learn.microsoft.com/en-us/windows/client-management/mdm/configuration-service-provider-reference)
