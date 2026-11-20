/* Canvas charts — DPR-aware, no chart library. */
(function (global) {
  function dprCtx(canvas, cssH) {
    var cssW = canvas.clientWidth || canvas.width || 300;
    var h = cssH || canvas.clientHeight || 200;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    canvas.style.height = h + "px";
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: cssW, h: h };
  }

  function yOf(v, lo, hi, top, bottom) {
    if (hi === lo) return (top + bottom) / 2;
    return bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  }

  function drawEquity(canvas, opts) {
    opts = opts || {};
    var box = dprCtx(canvas, opts.height || 200);
    var ctx = box.ctx, w = box.w, h = box.h;
    ctx.clearRect(0, 0, w, h);
    var points = (opts.points && opts.points.length) ? opts.points.slice() : [{ value: 0 }];
    var vals = points.map(function (p) { return Number(p.value != null ? p.value : p); });
    var start = opts.start != null ? Number(opts.start) : vals[0];
    var min = Math.min.apply(null, vals.concat([start]));
    var max = Math.max.apply(null, vals.concat([start]));
    var pad = (max - min) === 0 ? (Math.abs(min) * 0.08 || 1) : (max - min) * 0.18;
    var lo = min - pad, hi = max + pad;
    var left = 12, right = w - 12, top = 28, bottom = h - 16;

    // dashed start line
    var yStart = yOf(start, lo, hi, top, bottom);
    ctx.save();
    ctx.strokeStyle = "rgba(235,235,245,0.3)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(left, yStart);
    ctx.lineTo(right, yStart);
    ctx.stroke();
    ctx.restore();

    function xy(i, v) {
      var x = left + (vals.length === 1 ? (right - left) / 2 : (i / (vals.length - 1)) * (right - left));
      return [x, yOf(v, lo, hi, top, bottom)];
    }

    // line + fill
    ctx.beginPath();
    vals.forEach(function (v, i) {
      var p = xy(i, v);
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    });
    var last = xy(vals.length - 1, vals[vals.length - 1]);
    ctx.lineTo(last[0], bottom);
    ctx.lineTo(xy(0, vals[0])[0], bottom);
    ctx.closePath();
    var grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, "rgba(0,211,90,0.28)");
    grad.addColorStop(1, "rgba(0,211,90,0)");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    vals.forEach(function (v, i) {
      var p = xy(i, v);
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    });
    ctx.strokeStyle = "#00d35a";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "#00d35a";
    ctx.beginPath();
    ctx.arc(last[0], last[1], 3, 0, Math.PI * 2);
    ctx.fill();

    // marks above the line, later marks move up a row, never overlap
    var marks = (opts.marks || []).slice();
    marks.sort(function (a, b) { return String(a.ts || "").localeCompare(String(b.ts || "")); });
    var placed = [];
    var minGap = 64;
    ctx.font = "11px ui-monospace, SF Mono, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    marks.forEach(function (m) {
      var x;
      if (m.ts && points[0] && points[0].ts) {
        var times = points.map(function (p) { return p.ts; });
        var i = 0, best = 0, bd = Infinity;
        for (i = 0; i < times.length; i++) {
          var d = Math.abs(Date.parse(times[i]) - Date.parse(m.ts));
          if (!isNaN(d) && d < bd) { bd = d; best = i; }
        }
        x = xy(best, vals[best])[0];
      } else {
        x = (left + right) / 2;
      }
      var row = 0;
      for (var guard = 0; guard < 6; guard++) {
        var clash = placed.some(function (p) {
          return p.row === row && Math.abs(p.x - x) < minGap;
        });
        if (!clash) break;
        row += 1;
      }
      placed.push({ x: x, row: row });
      var y = top - 2 - row * 13;
      if (y < 11) y = 11;
      ctx.fillStyle = m.color || "#0a84ff";
      ctx.fillText(String(m.label || ""), x, y);
    });
  }

  function drawCandles(canvas, opts) {
    opts = opts || {};
    var box = dprCtx(canvas, opts.height || 180);
    var ctx = box.ctx, w = box.w, h = box.h;
    ctx.clearRect(0, 0, w, h);
    var candles = opts.candles || [];
    if (!candles.length) return;
    var highs = candles.map(function (c) { return Number(c.high != null ? c.high : c.close || c.price || 0); });
    var lows = candles.map(function (c) { return Number(c.low != null ? c.low : c.close || c.price || 0); });
    if (opts.exit != null) { highs.push(Number(opts.exit)); lows.push(Number(opts.exit)); }
    var min = Math.min.apply(null, lows);
    var max = Math.max.apply(null, highs);
    var pad = (max - min) === 0 ? (Math.abs(min) * 0.08 || 0.0001) : (max - min) * 0.12;
    var lo = min - pad, hi = max + pad;
    var left = 8, right = w - 8, top = 8, bottom = h - 8;

    if (opts.exit != null) {
      var ye = yOf(Number(opts.exit), lo, hi, top, bottom);
      ctx.save();
      ctx.strokeStyle = "#ff9f0a";
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(left, ye);
      ctx.lineTo(right, ye);
      ctx.stroke();
      ctx.restore();
    }

    var n = candles.length;
    var slot = (right - left) / Math.max(n, 1);
    var cw = Math.max(1.5, Math.min(7, slot * 0.6));
    candles.forEach(function (c, i) {
      var o = Number(c.open != null ? c.open : c.price || c.close || 0);
      var cl = Number(c.close != null ? c.close : c.price || o);
      var hiC = Number(c.high != null ? c.high : Math.max(o, cl));
      var loC = Number(c.low != null ? c.low : Math.min(o, cl));
      var x = left + slot * i + slot / 2;
      var up = cl >= o;
      ctx.strokeStyle = up ? "#00d35a" : "#ff453a";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(x, yOf(hiC, lo, hi, top, bottom));
      ctx.lineTo(x, yOf(loC, lo, hi, top, bottom));
      ctx.stroke();
      var y1 = yOf(o, lo, hi, top, bottom);
      var y2 = yOf(cl, lo, hi, top, bottom);
      var topC = Math.min(y1, y2), bh = Math.max(1, Math.abs(y2 - y1));
      ctx.fillRect(x - cw / 2, topC, cw, bh);
    });
  }

  global.DeskChart = { drawEquity: drawEquity, drawCandles: drawCandles, drawLineChart: function (c, values) {
    var pts = (values || []).map(function (v) { return { value: v }; });
    drawEquity(c, { points: pts, marks: [], start: pts.length ? pts[0].value : 0 });
  } };
})(this);
