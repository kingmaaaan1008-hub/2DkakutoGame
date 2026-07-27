// Sprite sheet helpers for the asset build pipeline.
// ASCII only: PowerShell 5.1 reads this file as ANSI, so non-ASCII would corrupt.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace KakutoTools
{
    // A loaded sprite sheet. Keeps raw pixels around for alpha analysis.
    public class Sheet : IDisposable
    {
        public int Width, Height;
        private byte[] _bgra;   // row-major BGRA
        private Bitmap _src;    // straight (non-premultiplied) copy
        private Bitmap _pre;    // premultiplied copy, used for downscaling

        public Sheet(string path)
        {
            using (var loaded = new Bitmap(path))
            {
                Width = loaded.Width;
                Height = loaded.Height;
                _src = new Bitmap(Width, Height, PixelFormat.Format32bppArgb);
                using (var g = Graphics.FromImage(_src))
                {
                    g.CompositingMode = CompositingMode.SourceCopy;
                    g.DrawImage(loaded, new Rectangle(0, 0, Width, Height));
                }
            }

            var bd = _src.LockBits(new Rectangle(0, 0, Width, Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            _bgra = new byte[Width * Height * 4];
            for (int y = 0; y < Height; y++)
                Marshal.Copy(IntPtr.Add(bd.Scan0, y * bd.Stride), _bgra, y * Width * 4, Width * 4);
            _src.UnlockBits(bd);

            // Premultiplied copy avoids dark fringes when the sheet is scaled down.
            _pre = new Bitmap(Width, Height, PixelFormat.Format32bppPArgb);
            using (var g = Graphics.FromImage(_pre))
            {
                g.CompositingMode = CompositingMode.SourceCopy;
                g.DrawImage(_src, new Rectangle(0, 0, Width, Height));
            }
        }

        public Bitmap Premultiplied { get { return _pre; } }

        // Bounds of pixels with alpha > thr inside the rect. Returns {x,y,w,h}, or {0,0,0,0} if empty.
        public int[] BBox(int x0, int y0, int w, int h, int thr)
        {
            int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1;
            int x1 = Math.Min(x0 + w, Width), y1 = Math.Min(y0 + h, Height);
            for (int y = Math.Max(0, y0); y < y1; y++)
            {
                int row = y * Width * 4;
                for (int x = Math.Max(0, x0); x < x1; x++)
                {
                    if (_bgra[row + x * 4 + 3] > thr)
                    {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            if (maxX < 0) return new int[] { 0, 0, 0, 0 };
            return new int[] { minX, minY, maxX - minX + 1, maxY - minY + 1 };
        }

        // Alpha-weighted horizontal centroid inside the rect, or -1 when empty.
        public double CentroidX(int x0, int y0, int w, int h, int thr)
        {
            double sum = 0, wsum = 0;
            int x1 = Math.Min(x0 + w, Width), y1 = Math.Min(y0 + h, Height);
            for (int y = Math.Max(0, y0); y < y1; y++)
            {
                int row = y * Width * 4;
                for (int x = Math.Max(0, x0); x < x1; x++)
                {
                    int a = _bgra[row + x * 4 + 3];
                    if (a > thr) { sum += x * a; wsum += a; }
                }
            }
            return wsum > 0 ? sum / wsum : -1;
        }

        // Alpha-weighted median X inside the rect, or -1 when empty.
        // Preferred over the centroid for anchoring: a thin outlier such as a
        // blade tip dipping into the foot band barely moves the median.
        public double MedianX(int x0, int y0, int w, int h, int thr)
        {
            int x1 = Math.Min(x0 + w, Width), y1 = Math.Min(y0 + h, Height);
            int lo = Math.Max(0, x0);
            var col = new double[Math.Max(0, x1 - lo)];
            double total = 0;
            for (int y = Math.Max(0, y0); y < y1; y++)
            {
                int row = y * Width * 4;
                for (int x = lo; x < x1; x++)
                {
                    int a = _bgra[row + x * 4 + 3];
                    if (a > thr) { col[x - lo] += a; total += a; }
                }
            }
            if (total <= 0) return -1;
            double half = total / 2, acc = 0;
            for (int i = 0; i < col.Length; i++)
            {
                acc += col[i];
                if (acc >= half) return lo + i;
            }
            return lo + col.Length - 1;
        }

        // Opaque pixel count per row. Useful to find the feet / ground line.
        public int[] RowCounts(int x0, int y0, int w, int h, int thr)
        {
            var res = new int[h];
            int x1 = Math.Min(x0 + w, Width), y1 = Math.Min(y0 + h, Height);
            for (int y = Math.Max(0, y0); y < y1; y++)
            {
                int row = y * Width * 4, c = 0;
                for (int x = Math.Max(0, x0); x < x1; x++)
                    if (_bgra[row + x * 4 + 3] > thr) c++;
                res[y - y0] = c;
            }
            return res;
        }

        // Absolute Y (exclusive) of the lowest row that is at least `ratio` as busy
        // as the busiest row in the rect. Finds the soles while ignoring thin
        // outliers that hang lower, such as a blade tip or a trailing cape.
        public int GroundRow(int x0, int y0, int w, int h, int thr, double ratio)
        {
            var counts = RowCounts(x0, y0, w, h, thr);
            int max = 0;
            foreach (var c in counts) if (c > max) max = c;
            if (max == 0) return y0 + h;
            int need = Math.Max(4, (int)(max * ratio));
            for (int i = counts.Length - 1; i >= 0; i--)
                if (counts[i] >= need) return y0 + i + 1;
            return y0 + h;
        }

        public void Dispose()
        {
            if (_src != null) { _src.Dispose(); _src = null; }
            if (_pre != null) { _pre.Dispose(); _pre = null; }
        }
    }

    // Output canvas. Composites in premultiplied space, converts back on save.
    public class Canvas : IDisposable
    {
        private Bitmap _bmp;
        private Graphics _g;

        public Canvas(int w, int h)
        {
            _bmp = new Bitmap(w, h, PixelFormat.Format32bppPArgb);
            _g = Graphics.FromImage(_bmp);
            _g.Clear(Color.Transparent);
            _g.CompositingMode = CompositingMode.SourceCopy;
            _g.CompositingQuality = CompositingQuality.HighQuality;
            _g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            _g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        }

        public void Blit(Sheet src, int sx, int sy, int sw, int sh, int dx, int dy, int dw, int dh)
        {
            using (var attr = new ImageAttributes())
            {
                attr.SetWrapMode(WrapMode.TileFlipXY); // keeps edge sampling from bleeding
                _g.DrawImage(src.Premultiplied, new Rectangle(dx, dy, dw, dh), sx, sy, sw, sh, GraphicsUnit.Pixel, attr);
            }
        }

        public void Save(string path)
        {
            _g.Flush();
            using (var outBmp = new Bitmap(_bmp.Width, _bmp.Height, PixelFormat.Format32bppArgb))
            {
                using (var g2 = Graphics.FromImage(outBmp))
                {
                    g2.CompositingMode = CompositingMode.SourceCopy;
                    g2.DrawImage(_bmp, new Rectangle(0, 0, _bmp.Width, _bmp.Height));
                }
                outBmp.Save(path, ImageFormat.Png);
            }
        }

        public void Dispose()
        {
            if (_g != null) { _g.Dispose(); _g = null; }
            if (_bmp != null) { _bmp.Dispose(); _bmp = null; }
        }
    }
}
