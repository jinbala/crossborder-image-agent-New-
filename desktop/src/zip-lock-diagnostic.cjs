const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
// Restart Manager resource query only. No shutdown/restart APIs are declared.
// https://learn.microsoft.com/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist
async function inspectSmokeZipLock(file) {
  const target = path.resolve(file);
  if (!target.split(path.sep).includes('.smoke-data') || !target.endsWith('.zip')) throw new Error('Lock diagnostics require an owned smoke ZIP');
  if (process.platform !== 'win32') return { supported: false };
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CrossborderZipLockProbe {
 [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint ProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME StartTime; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
  public UniqueProcess Process;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AppName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceName;
  public uint Type, Status, SessionId;
  [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
 }
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session,uint flags,StringBuilder key);
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint session,uint count,string[] files,uint appCount,UniqueProcess[] apps,uint serviceCount,string[] services);
 [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session,out uint needed,ref uint count,[In,Out] ProcessInfo[] apps,ref uint reasons);
 [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
 public static string[] Inspect(string file) {
  uint session; int result=RmStartSession(out session,0,new StringBuilder(33)); if(result!=0)throw new Exception("RmStartSession "+result);
  try {
   result=RmRegisterResources(session,1,new string[]{file},0,null,0,null); if(result!=0)throw new Exception("RmRegisterResources "+result);
   uint needed=0,count=0,reasons=0; result=RmGetList(session,out needed,ref count,null,ref reasons);
   if(result==0)return new string[0]; if(result!=234)throw new Exception("RmGetList "+result);
   var apps=new ProcessInfo[needed]; count=needed; result=RmGetList(session,out needed,ref count,apps,ref reasons); if(result!=0)throw new Exception("RmGetList "+result);
   var names=new string[count]; for(int i=0;i<count;i++)names[i]=apps[i].Process.ProcessId+":"+apps[i].AppName; return names;
  } finally { RmEndSession(session); }
 }
}
'@
$zipLockProcesses = [CrossborderZipLockProbe]::Inspect('${target.replaceAll("'", "''")}')
ConvertTo-Json -InputObject @($zipLockProcesses) -Compress`;
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024 });
  return { supported: true, processes: JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) };
}
module.exports = { inspectSmokeZipLock };
