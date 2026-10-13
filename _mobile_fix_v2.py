# -*- coding: utf-8 -*-
"""移动端终极修复 v2：海报+CSS多层相机替代视频 scrub（画质=原始关键帧）"""
import re

# ============================================================
# 1. 视频模块：移动端禁用 scrub，漫游时用原画质正常播放
# ============================================================
for vjs in ['astra/js/astra-video.js', 'neon/neon-video.js', 'biolum/biolum-video.js']:
    s = open(vjs, encoding='utf-8').read()
    if 'MOBILE_SCRUB_OFF' in s:
        print(f'{vjs}: already patched'); continue

    # init() 开头：移动端禁用 scrub 模块
    old = "function init(opts) {"
    new = """function init(opts) {
    /* MOBILE_SCRUB_OFF: 移动端禁用视频 scrub（iOS/Android 的 currentTime 快速 seek 机制性卡死）。
     * 画面改由外壳的 mobileCamera() 海报+CSS 变换驱动。
     * 漫游模式仍可用：tourStartEv() 单独启动视频正常播放（play，不 seek）。 */
    if (IS_MOBILE) {
      st.disabled = true;
      var _mp = document.getElementById('poster');
      if (_mp) { _mp.style.opacity = 1; _mp.style.display = 'block'; _mp.src = _mp.src || ''; }
      var _ml = document.getElementById('loading');
      if (_ml) _ml.style.display = 'none';
      var _pl = document.getElementById('preloader');
      if (_pl) _pl.classList.add('done');
      if (typeof window !== 'undefined') window.__isMobileSite = true;
      return false;
    }"""
    if old in s:
        s = s.replace(old, new, 1)

    # 漫游模式：移动端绕过 disabled 检查，直接用视频正常播放
    # 找 tourStartEv，在开头加移动端分支
    old_ts = "function tourStartEv(fromP) {"
    new_ts = """function tourStartEv(fromP) {
    /* 移动端漫游：跳过 scrub 禁用，直接正常播放（play，不 seek） */
    if (IS_MOBILE) {
      if (!segs) {
        /* 延迟初始化：只建 DOM 引用，不做 Blob 加载 */
        st.ready = true;
        segs = [];
        for (var mi = 0; mi < SEGS_DEF.length; mi++) {
          (function(def) {
            var el = document.getElementById(def.elId);
            if (!el) return;
            el.playsInline = true; el.muted = false;
            el.setAttribute('playsinline', '');
            el.src = def.urls[def.urls.length - 1];  /* 用最后一个 URL（原画质 mp4） */
            el.style.display = 'none';
            segs.push({ id: def.id, urls: def.urls, span: def.span, el: el, poster: def.poster,
              status: 'idle', dur: 6.58, reveal: 1, revealed: true, want: null, a: 0, op: 0, primed: false });
          })(SEGS_DEF[mi]);
        }
      }
      evTour.on = true;
      /* 直接播当前段 */
      var ci = logic.coveringSeg(clamp(fromP || 0, 0, 1));
      evEngage(ci);
      return true;
    }"""
    if old_ts in s:
        s = s.replace(old_ts, new_ts, 1)

    open(vjs, 'w', encoding='utf-8').write(s)
    print(f'{vjs}: MOBILE_SCRUB_OFF + mobile tour added')

# ============================================================
# 2. 外壳：海报相机（多层 CSS 变换，替代视频 scrub）
# ============================================================
SHELLS = {
    'astra/js/astra-main.js': {
        'posters': "['assets/approach.png', 'assets/port.png', 'assets/core.png']",
        'chs': '[0, 0.55, 0.75, 1]',
        'loop_var': 'st.current',
    },
    'neon/app.js': {
        'posters': "['assets/keys2/k1.png', 'assets/keys2/k2.png', 'assets/keys2/k4.png']",
        'chs': '[0, 0.333, 0.667, 1]',
        'loop_var': 'curP',
    },
    'biolum/app.js': {
        'posters': "['assets/keys/k1.png', 'assets/keys/k2.png', 'assets/keys/k4.png']",
        'chs': '[0, 0.333, 0.667, 1]',
        'loop_var': 'curP',
    },
}

CAM_CODE = """
  /* ================= 移动端海报相机（替代视频 scrub） =================
   * 原理：高清关键帧（1672px）+ CSS transform 模拟镜头推进
   * 每章内：scale 1.0→1.28（缓动推进）+ 轻微纵移
   * 章界处：cross-fade 切换关键帧
   * 漫游时：隐藏海报，显示正在播放的视频 */
  var MC_POSTERS = %POSTERS%;
  var MC_CH = %CHS%;
  var mcIdx = -1;

  function mobileCamera(%P%) {
    var posterEl = document.getElementById('poster');
    if (!posterEl || !window.__isMobileSite) return;

    /* 漫游中：隐藏海报（视频正在播） */
    if (typeof %VIDMOD% !== 'undefined' && %VIDMOD% && %VIDMOD%.evTourActive && %VIDMOD%.evTourActive()) {
      posterEl.style.opacity = 0;
      return;
    }
    posterEl.style.opacity = 1;

    /* 章节判定 */
    var idx = 0;
    for (var ci = 1; ci < 3; ci++) { if (%P% >= MC_CH[ci]) idx = ci; }

    /* 章界 cross-fade */
    if (idx !== mcIdx) {
      mcIdx = idx;
      var target = MC_POSTERS[idx];
      if (posterEl.src.indexOf(target.split('/').pop()) === -1) {
        posterEl.style.opacity = 0;
        setTimeout(function() {
          posterEl.src = target;
          posterEl.style.opacity = 1;
        }, 250);
      }
    }

    /* 章内 CSS 相机：缓动推进 + 纵移 */
    var chS = MC_CH[idx], chE = MC_CH[idx + 1];
    var lp = Math.max(0, Math.min(1, (%P% - chS) / (chE - chS)));
    var e = lp * lp * (3 - 2 * lp);  /* smoothstep */

    var scale = 1.02 + e * 0.26;
    var ty = (0.5 - e) * 4;
    posterEl.style.transform = 'scale(' + scale.toFixed(4) + ') translateY(' + ty.toFixed(2) + 'vh)';
    posterEl.style.willChange = 'transform, opacity';
    posterEl.style.transition = 'opacity .3s ease';
  }
"""

# 视频模块全局名
VIDMOD = {
    'astra/js/astra-main.js': 'AstraVideo',
    'neon/app.js': 'BIOVID',
    'biolum/app.js': 'BIOVID',
}

for path, cfg in SHELLS.items():
    s = open(path, encoding='utf-8').read()
    if 'mobileCamera' in s:
        print(f'{path}: already has mobile camera'); continue

    code = CAM_CODE
    code = code.replace('%POSTERS%', cfg['posters'])
    code = code.replace('%CHS%', cfg['chs'])
    code = code.replace('%P%', cfg['loop_var'])
    code = code.replace('%VIDMOD%', VIDMOD[path])

    # 插入位置：astra 在 frameBody() 内的 updateDOM() 调用后；neon/biolum 在 loop() 内的 syncUI 后
    if path.startswith('astra'):
        s = s.replace('    /* 5) UI/DOM 更新 */\n    updateDOM();',
                      '    /* 5) UI/DOM 更新 */\n    updateDOM();\n    mobileCamera(st.current);')
        # 插入函数定义（在 frame 函数之前）
        s = s.replace('  /* ================= rAF 主循环', code + '\n  /* ================= rAF 主循环')
    else:
        s = s.replace('syncUI(curP);',
                      'syncUI(curP);\n      mobileCamera(curP);', 1)
        # 插入函数定义（在 loop 之前）
        s = s.replace('  /* ---------- 主循环', code + '\n  /* ---------- 主循环')

    open(path, 'w', encoding='utf-8').write(s)
    print(f'{path}: mobileCamera injected')

# ============================================================
# 3. 立即隐藏加载屏（移动端不需要等视频）
# ============================================================
for site in ['astra', 'neon', 'biolum']:
    idx = f'{site}/index.html'
    s = open(idx, encoding='utf-8').read()
    # 已有 8s 兜底，但移动端应该更快
    if '__plMobileFast' not in s:
        fast = """<script>if(/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)||innerWidth<768){setTimeout(function(){var p=document.getElementById('preloader');if(p)p.classList.add('done');var l=document.getElementById('loading');if(l)l.style.display='none'},1500)}</script>
"""
        s = s.replace('</body>', fast + '</body>')
        open(idx, 'w', encoding='utf-8').write(s)
        print(f'{site}: mobile fast preloader exit')

print('\n=== ALL DONE ===')
