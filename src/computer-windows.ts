// SPDX-License-Identifier: Apache-2.0
// Copyright 2026-present the Pofu Code Studio authors. All rights reserved.

import { spawn } from 'node:child_process';
import { COMPUTER_INPUT_TIMEOUT_MS } from './constants.js';

// O programa é fixo; texto e teclas atravessam stdin como JSON, nunca como PowerShell.
export const WINDOWS_COMPUTER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class PofuInput {
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public int x, y; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Key { public ushort code, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct Payload { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Key key; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public Payload payload; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int size);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static void Dpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { SetProcessDPIAware(); } }
  public static string Observe() { uint pid; IntPtr w = GetForegroundWindow(); GetWindowThreadProcessId(w, out pid); return w.ToInt64().ToString() + ":" + pid.ToString(); }
  public static void Focus(string handle, uint expectedPid) {
    IntPtr w = new IntPtr(Int64.Parse(handle)); uint pid;
    GetWindowThreadProcessId(w, out pid);
    if (!IsWindow(w) || !IsWindowVisible(w) || pid != expectedPid) throw new Exception("The observed window is no longer available. Capture the screen again.");
    if (GetForegroundWindow() != w) { SetForegroundWindow(w); Thread.Sleep(80); }
    if (GetForegroundWindow() != w) throw new Exception("Could not focus the observed window. Focus it manually and capture the screen again.");
  }
  static void Send(Input[] input) {
    if (SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(Input))) != input.Length)
      throw new Exception("Windows rejected input. Elevated windows and the secure desktop cannot be controlled.");
  }
  static Input MouseEvent(uint flags, int x, int y, uint data) { Input i = new Input(); i.type=0; i.payload.mouse.flags=flags; i.payload.mouse.x=x; i.payload.mouse.y=y; i.payload.mouse.data=data; return i; }
  static Input KeyEvent(ushort code, ushort scan, uint flags) { Input i = new Input(); i.type=1; i.payload.key.code=code; i.payload.key.scan=scan; i.payload.key.flags=flags; return i; }
  public static void Move(int x, int y) {
    int left=GetSystemMetrics(76), top=GetSystemMetrics(77), width=GetSystemMetrics(78), height=GetSystemMetrics(79);
    if (width<1 || height<1 || x<left || y<top || x>=left+width || y>=top+height) throw new Exception("Display layout changed. Capture the screen again.");
    int nx=(int)(((long)(x-left)*65536+32768)/width), ny=(int)(((long)(y-top)*65536+32768)/height);
    Send(new Input[] { MouseEvent(0xC001, Math.Min(nx,65535), Math.Min(ny,65535),0) });
  }
  public static void Click(string button, bool twice) {
    uint down=button=="right"?8u:button=="middle"?32u:2u, up=down*2;
    try { Send(new Input[] { MouseEvent(down,0,0,0), MouseEvent(up,0,0,0) });
      if(twice) { Thread.Sleep(70); Send(new Input[] { MouseEvent(down,0,0,0), MouseEvent(up,0,0,0) }); }
    } finally { SendInput(1, new Input[] { MouseEvent(up,0,0,0) }, Marshal.SizeOf(typeof(Input))); }
  }
  public static void Scroll(string direction, int amount) {
    int delta=amount*120*((direction=="down" || direction=="left")?-1:1);
    Send(new Input[] { MouseEvent((direction=="left" || direction=="right")?0x1000u:0x800u,0,0,unchecked((uint)delta)) });
  }
  static uint Extended(ushort code) { return (code>=33 && code<=46) || code==91 || code==92 ? 1u:0u; }
  public static void Keys(ushort[] codes) {
    Input[] batch=new Input[codes.Length*2];
    for(int j=0;j<codes.Length;j++) { batch[j]=KeyEvent(codes[j],0,Extended(codes[j])); ushort c=codes[codes.Length-j-1]; batch[codes.Length+j]=KeyEvent(c,0,Extended(c)|2u); }
    try { Send(batch); } finally { for(int j=codes.Length-1;j>=0;j--) SendInput(1,new Input[]{KeyEvent(codes[j],0,Extended(codes[j])|2u)},Marshal.SizeOf(typeof(Input))); }
  }
  public static void Text(string text) {
    for(int start=0;start<text.Length;start+=128) {
      int count=Math.Min(128,text.Length-start); Input[] batch=new Input[count*2];
      for(int j=0;j<count;j++) { char c=text[start+j]; bool special=c=='\n'||c=='\t'; ushort key=special?(ushort)(c=='\n'?13:9):(ushort)0; ushort scan=special?(ushort)0:(ushort)c; uint flag=special?0u:4u; batch[j*2]=KeyEvent(key,scan,flag); batch[j*2+1]=KeyEvent(key,scan,flag|2u); }
      Send(batch);
    }
  }
}
'@
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  [PofuInput]::Dpi()
  if ($request.action -eq 'observe') {
    $observed = [PofuInput]::Observe().Split(':')
    @{success=$true; handle=$observed[0]; pid=[uint32]$observed[1]} | ConvertTo-Json -Compress
    exit 0
  }
  [PofuInput]::Focus([string]$request.target.handle, [uint32]$request.target.pid)
  if ($null -ne $request.x) { [PofuInput]::Move([int]$request.x, [int]$request.y) }
  switch ($request.action) {
    'move' { }
    'click' { [PofuInput]::Click([string]$request.button, $false) }
    'double_click' { [PofuInput]::Click([string]$request.button, $true) }
    'scroll' { [PofuInput]::Scroll([string]$request.direction, [int]$request.amount) }
    'key' { [PofuInput]::Keys([ushort[]]$request.codes) }
    'type' { [PofuInput]::Text([string]$request.text) }
    default { throw 'Unsupported computer action.' }
  }
  @{success=$true} | ConvertTo-Json -Compress
} catch { @{success=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress; exit 1 }
`;

export function windowsComputer(request: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Computer input is currently supported on Windows only.'));
  if (signal?.aborted) return Promise.reject(new Error('Computer action cancelled.'));
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(WINDOWS_COMPUTER_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', settled = false;
    const finish = (error?: Error, value?: any) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => { child.kill(); finish(new Error('Computer action cancelled. Capture the screen before retrying.')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Computer action timed out. Capture the screen before retrying; input may have been partially applied.')); }, COMPUTER_INPUT_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-32768); });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(-2000); });
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('close', () => {
      try { const result = JSON.parse(output.replace(/^\uFEFF/, '').trim()); finish(result.success ? undefined : new Error(result.error || 'Windows input failed.'), result); }
      catch { finish(new Error(errors ? 'Windows input helper failed to initialize.' : 'Windows input helper returned no result.')); }
    });
    child.stdin.end(JSON.stringify(request), 'utf8');
    if (signal?.aborted) abort();
  });
}
