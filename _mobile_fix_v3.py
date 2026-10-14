# -*- coding: utf-8 -*-
"""移动端终极修复 v3：重写移动端漫游为极简视频播放"""
import re

# ============================================================
# 视频模块：完全重写移动端分支
# ============================================================
for vjs in ['astra/js/astra-video.js', 'neon/neon-video.js', 'biolum/biolum-video.js']:
    s = open(vjs, encoding='utf-8').read()

    # 找到并替换旧的 MOBILE_SCRUB_OFF init 块
    old_mobile_init = """    /* MOBILE_SCRUB_OFF: 移动端禁用视频 scrub（iOS/Android 的 currentTime 快速 seek 机制性卡死）。
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

    new_mobile_init = """    /* MOBILE_V3: 移动端禁用 scrub 架构，用极简漫游播放器替代。
     * 手动滚动 → 海报+CSS相机（外壳驱动，本模块不参与）
     * 自动漫游 → 独立的 video.src 直连播放（不走 Blob/fetch） */
    if (IS_MOBILE) {
      st.disabled = true;
      st.mobileTour = { on: false, idx: 0, el: null };
      var _mp = document.getElementById('poster');
      if (_mp) { _mp.style.opacity = 1; _mp.style.display = 'block'; }
      var _ml = document.getElementById('loading');
      if (_ml) _ml.style.display = 'none';
      var _pl = document.getElementById('preloader');
      if (_pl) _pl.classList.add('done');
      if (typeof window !== 'undefined') window.__isMobileSite = true;

      /* 创建移动端漫游播放器：一个 video 元素，直接 src 播放 */
      var mtv = document.createElement('video');
      mtv.playsInline = true;
      mtv.muted = false;
      mtv.preload = 'auto';
      mtv.setAttribute('playsinline', '');
      mtv.setAttribute('webkit-playsinline', '');
      mtv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .5s ease;z-index:2;pointer-events:none';
      var stage = document.getElementById('stage');
      if (stage) stage.insertBefore(mtv, stage.firstChild);
      st.mobileTour.el = mtv;

      /* 结尾自动下一段 */
      mtv.addEventListener('ended', function() {
        var mt = st.mobileTour;
        if (!mt.on) return;
        mt.idx++;
        if (mt.idx < SEGS_DEF.length) {
          mt.el.src = SEGS_DEF[mt.idx].urls[SEGS_DEF[mt.idx].urls.length - 1];
          mt.el.play().catch(function(){});
          if (O.onTourProgress) O.onTourProgress((mt.idx + 0.01) / SEGS_DEF.length);
        } else {
          /* 全部播完 */
          mt.on = false;
          mt.el.style.opacity = 0;
          var _poster = document.getElementById('poster');
          if (_poster) _poster.style.opacity = 1;
          if (O.onTourDone) O.onTourDone();
        }
      });

      return false;
    }"""

    if old_mobile_init in s:
        s = s.replace(old_mobile_init, new_mobile_init)
    elif 'MOBILE_SCRUB_OFF' in s:
        # 如果旧版本不完全匹配，用正则删除整个旧块
        s = re.sub(
            r'/\* MOBILE_SCRUB_OFF.*?\*/\s*\n\s*if \(IS_MOBILE\) \{.*?\n    \}',
            new_mobile_init,
            s, flags=re.S, count=1
        )
    else:
        print(f'{vjs}: WARN no mobile block found, inserting at init')
        s = s.replace('function init(opts) {', 'function init(opts) {\n' + new_mobile_init, 1)

    # 替换旧的移动端 tourStartEv
    old_mobile_tour = None
    # 找旧的移动端漫游分支
    if 'if (IS_MOBILE) {' in s and 'tourStartEv' in s:
        # 删除旧的移动端漫游分支（从 "/* 移动端漫游" 到对应的闭括号）
        pattern = r'/\* 移动端漫游.*?\*/\s*\n\s*if \(IS_MOBILE\) \{.*?\n    \}'
        match = re.search(pattern, s, re.S)
        if match:
            old_mobile_tour = match.group()
            s = s.replace(match.group(), '')

    # 写新的移动端漫游
    old_ts = "function tourStartEv(fromP) {"
    new_ts = """function tourStartEv(fromP) {
    /* 移动端漫游：极简直连播放（不走 Blob/fetch/scrub） */
    if (IS_MOBILE && st.mobileTour && st.mobileTour.el) {
      var mt = st.mobileTour;
      var ci = logic.coveringSeg(clamp(fromP || 0, 0, 1));
      mt.idx = ci;
      mt.on = true;
      mt.el.src = SEGS_DEF[ci].urls[SEGS_DEF[ci].urls.length - 1]; /* 原画质 mp4 */
      mt.el.style.opacity = 1;
      var _poster = document.getElementById('poster');
      if (_poster) _poster.style.opacity = 0;
      mt.el.play().catch(function() {
        /* 自动播放被拒 → 静音重试 */
        mt.el.muted = true;
        mt.el.play().catch(function() { mt.on = false; mt.el.style.opacity = 0; if (_poster) _poster.style.opacity = 1; });
      });
      return true;
    }"""

    if old_ts in s:
        s = s.replace(old_ts, new_ts, 1)

    # 替换 tourStopEv 加移动端分支
    old_stop = "function tourStopEv() {"
    new_stop = """function tourStopEv() {
    if (IS_MOBILE && st.mobileTour) {
      st.mobileTour.on = false;
      if (st.mobileTour.el) {
        st.mobileTour.el.pause();
        st.mobileTour.el.style.opacity = 0;
      }
      var _poster = document.getElementById('poster');
      if (_poster) _poster.style.opacity = 1;
      return;
    }"""
    if old_stop in s:
        s = s.replace(old_stop, new_stop, 1)

    # evTourActive 加移动端
    old_active = "evTourActive: function () { return evTour.on; }"
    new_active = "evTourActive: function () { return IS_MOBILE ? (st.mobileTour && st.mobileTour.on) : evTour.on; }"
    if old_active in s:
        s = s.replace(old_active, new_active)

    open(vjs, 'w', encoding='utf-8').write(s)
    print(f'{vjs}: MOBILE_V3 rewrite done')

# ============================================================
# 外壳：mobileCamera 中漫游隐藏海报的检查也要适配新架构
# ============================================================
for path, vidmod in [('astra/js/astra-main.js', 'AstraVideo'),
                     ('neon/app.js', 'BIOVID'),
                     ('biolum/app.js', 'BIOVID')]:
    s = open(path, encoding='utf-8').read()

    # 替换旧的漫游检测
    old_check = f"if (typeof {vidmod} !== 'undefined' && {vidmod} && {vidmod}.evTourActive && {vidmod}.evTourActive())"
    if old_check in s:
        s = s.replace(old_check, f"if (typeof {vidmod} !== 'undefined' && {vidmod} && {vidmod}.evTourActive && {vidmod}.evTourActive())", 1)

    open(path, 'w', encoding='utf-8').write(s)

# ============================================================
# init 需要传 onTourProgress 回调（移动端漫游进度同步到滚动位置）
# ============================================================
for path, vidmod_call in [
    ('astra/js/astra-main.js', "if (Vid) Vid.init({"),
    ('neon/app.js', "if (Vid) Vid.init({"),
    ('biolum/app.js', "if (Vid) Vid.init({"),
]:
    s = open(path, encoding='utf-8').read()
    if 'onTourProgress' not in s:
        old = vidmod_call
        new = vidmod_call + "\n      onTourProgress: function(mtP) { if (mtP !== undefined) window.scrollTo(0, mtP * (document.documentElement.scrollHeight - innerHeight)); },"
        if old in s:
            s = s.replace(old, new, 1)
            open(path, 'w', encoding='utf-8').write(s)
            print(f'{path}: onTourProgress callback added')

print('\n=== MOBILE V3 ALL DONE ===')
