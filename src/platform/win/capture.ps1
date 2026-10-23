# "Orbit anywhere": look at one window. Captures just that window with PrintWindow
# (PW_RENDERFULLCONTENT: works while it's covered by other windows; a minimized one comes back
# black), saves it as a PNG for Orbit (downscaled to at most -MaxWidth), and reads its text with
# Windows' own on-device OCR (Windows.Media.Ocr: nothing leaves this PC). One JSON line on stdout:
#   {"ok":true,"path":"...png","w":..,"h":..,"lit":0.93,"ocr":"text...","lang":"en-US"}
#   {"ok":false,"error":"no_window|minimized|capture_failed|...","message":"..."}
# "lit": the share of pixels that aren't black (a black capture means there was nothing to see).
param([long]$Hwnd = 0, [string]$Out = '', [int]$MaxWidth = 1600, [switch]$NoOcr)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Say($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)) }

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class OrbitCapture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

  public static string Check(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (hwnd <= 0 || !IsWindow(h)) return "no_window";
    if (IsIconic(h)) return "minimized";
    return "";
  }

  // Returns the share of lit pixels; the picture goes to `path` (PNG), at most maxWidth wide.
  public static double Grab(long hwnd, string path, int maxWidth, out int outW, out int outH) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    IntPtr h = new IntPtr(hwnd);
    RECT wr; GetWindowRect(h, out wr);
    RECT fr; bool hasFrame = DwmGetWindowAttribute(h, 9, out fr, Marshal.SizeOf(typeof(RECT))) == 0;
    int w = wr.R - wr.L, hh = wr.B - wr.T;
    if (w <= 0 || hh <= 0) throw new InvalidOperationException("empty window");
    using (Bitmap full = new Bitmap(w, hh, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(full)) {
        IntPtr dc = g.GetHdc();
        bool ok = PrintWindow(h, dc, 2); // PW_RENDERFULLCONTENT
        g.ReleaseHdc(dc);
        if (!ok) throw new InvalidOperationException("PrintWindow failed");
      }
      // Crop the invisible resize border (the visible frame from DWM).
      Rectangle crop = new Rectangle(0, 0, w, hh);
      if (hasFrame) crop = Rectangle.Intersect(new Rectangle(fr.L - wr.L, fr.T - wr.T, fr.R - fr.L, fr.B - fr.T), crop);
      double scale = crop.Width > maxWidth ? (double)maxWidth / crop.Width : 1.0;
      int tw = Math.Max(1, (int)Math.Round(crop.Width * scale)), th = Math.Max(1, (int)Math.Round(crop.Height * scale));
      using (Bitmap pic = new Bitmap(tw, th, PixelFormat.Format24bppRgb)) {
        using (Graphics g = Graphics.FromImage(pic)) {
          g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
          g.DrawImage(full, new Rectangle(0, 0, tw, th), crop, GraphicsUnit.Pixel);
        }
        pic.Save(path, ImageFormat.Png);
        outW = tw; outH = th;
        // Lit share, sampled on a grid.
        int lit = 0, n = 0;
        for (int y = 0; y < th; y += Math.Max(1, th / 60)) for (int x = 0; x < tw; x += Math.Max(1, tw / 60)) {
          Color c = pic.GetPixel(x, y); n++;
          if (c.R + c.G + c.B > 24) lit++;
        }
        return n == 0 ? 0 : (double)lit / n;
      }
    }
  }
}
'@

try {
  $why = [OrbitCapture]::Check($Hwnd)
  if ($why) { Say @{ ok = $false; error = $why; message = $(if ($why -eq 'minimized') { 'That window is minimized, so there is nothing to see.' } else { 'That window is gone.' }) }; exit 0 }
  if (-not $Out) { $Out = Join-Path $env:TEMP ("orbit-look-" + [guid]::NewGuid().ToString('N') + '.png') }
  $w = 0; $h = 0
  $lit = [OrbitCapture]::Grab($Hwnd, $Out, $MaxWidth, [ref]$w, [ref]$h)
  $res = [ordered]@{ ok = $true; path = $Out; w = $w; h = $h; lit = [Math]::Round($lit, 3); ocr = ''; lang = '' }
  if (-not $NoOcr -and $lit -gt 0.05) {
    try {
      # Windows' own OCR (WinRT), on this PC only. PowerShell 5.1 awaits WinRT through AsTask.
      Add-Type -AssemblyName System.Runtime.WindowsRuntime
      $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
      $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
      $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
      $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
      function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(15000) | Out-Null; $task.Result }
      $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Out)) ([Windows.Storage.StorageFile])
      $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
      if ($engine) {
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $res.ocr = (($result.Lines | ForEach-Object { $_.Text }) -join "`n")
        $res.lang = $engine.RecognizerLanguage.LanguageTag
      }
      $stream.Dispose()
    } catch { $res.ocr_error = $_.Exception.GetType().Name }
  }
  Say $res
} catch {
  # It may have been minimized (or closed) while being captured.
  $why = [OrbitCapture]::Check($Hwnd)
  if ($why) { Say @{ ok = $false; error = $why; message = $(if ($why -eq 'minimized') { 'That window is minimized, so there is nothing to see.' } else { 'That window is gone.' }) }; exit 0 }
  Say @{ ok = $false; error = 'capture_failed'; message = $_.Exception.Message.Substring(0, [Math]::Min(200, $_.Exception.Message.Length)) }
}
