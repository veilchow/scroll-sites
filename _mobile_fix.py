# -*- coding: utf-8 -*-
"""移动端终极修复：绕过视频 scrub，用海报+CSS变换模拟镜头运动"""
import re

# ============ 1. 视频模块：移动端禁用 scrub ============
for vjs, module in [
    ('astra/js/astra-video.js', 'AstraVideo'),
    ('neon/neon-video.js', 'BIOVID'),
    ('biolum/biolum-video.js', 'BIOVID'),
]:
    s = open(vjs, encoding='utf-8').read()
    if 'MOBILE_FALLBACK' in s:
        print(f'{vjs}: already patched')
        continue

    # 在 init() 开头：移动端直接禁用整个模块
    old_init = "function init(opts) {"
    new_init = """function init(opts) {
    /* MOBILE_FALLBACK: 移动端禁用视频 scrub（iOS/Android 的 currentTime 快速 seek
     * 会导致卡死）。改由外壳的海报+CSS变换驱动画面。漫游模式仍用视频正常播放。 */
    if (IS_MOBILE) {
      st.disabled = true;
      var mp = document.getElementById('poster');
      if (mp) { mp.style.opacity = 1; mp.style.display = 'block'; }
      var mlb = document.getElementById('loading');
      if (mlb) mlb.style.display = 'none';
      var mpl = document.getElementById('preloader');
      if (mpl) mpl.classList.add('done');
      return false;
    }"""
    if old_init in s:
        s = s.replace(old_init, new_init, 1)
        open(vjs, 'w', encoding='utf-8').write(s)
        print(f'{vjs}: mobile fallback added')
    else:
        print(f'{vjs}: WARN init anchor not found')

# ============ 2. 外壳：海报相机运动 + 章节切换 ============
# astra 用 astra-main.js, neon 用 app.js, biolum 用 app.js
SHELLS = {
    'astra/js/astra-main.js': {
        'posters': "['assets/approach.png', 'assets/port.png', 'assets/core.png']",
        'ch1': 0.55, 'ch2': 0.75,
        'marker': '// ================= 启动 ================='
    },
    'neon/app.js': {
        'posters': "['assets/keys2/k1.png', 'assets/keys2/k2.png', 'assets/keys2/k4.png']",
        'ch1': 1/3, 'ch2': 2/3,
        'marker': '/* ---------- 启动 ---------- */'
    },
    'biolum/app.js': {
        'posters': "['assets/keys/k1.png', 'assets/keys/k2.png', 'assets/keys/k4.png']",
        'ch1': 1/3, 'ch2': 2/3,
        'marker': '/* ---------- 启动 ---------- */'
    },
}

MOBILE_CAM = """
  /* ================= 移动端海报相机（视频 scrub 禁用时的画面驱动） ================= */
  var MOBILE_CAM_POSTERS = %POSTERS%;
  var MOBILE_CAM_CH = [%CH1%, %CH2%];
  var mobileCamIdx = -1;

  function mobileCamera(p) {
    var posterEl = document.getElementById('poster');
    if (!posterEl) return;

    /* 章节海报切换（带 cross-fade 效果） */
    var idx = p < MOBILE_CAM_CH[0] ? 0 : (p < MOBILE_CAM_CH[1] ? 1 : 2);
    if (idx !== mobileCamIdx) {
      mobileCamIdx = idx;
      var target = MOBILE_CAM_POSTERS[idx];
      if (!posterEl.src.includes(target.split('/').pop())) {
        posterEl.style.opacity = 0;
        setTimeout(function() {
          posterEl.src = target;
          posterEl.style.transition = 'opacity .6s ease';
          posterEl.style.opacity = 1;
        }, 300);
      }
    }

    /* CSS 变换模拟镜头运动：缓放推进 + 轻微平移 */
    var chStart = idx === 0 ? 0 : MOBILE_CAM_CH[idx - 1];
    var chEnd = idx === 2 ? 1 : MOBILE_CAM_CH[idx];
    var localP = Math.max(0, Math.min(1, (p - chStart) / (chEnd - chStart)));

    var scale = 1.0 + localP * 0.25;
    var ty = (0.5 - localP) * 6;
    posterEl.style.transform = 'scale(' + scale.toFixed(4) + ') translateY(' + ty.toFixed(2) + 'vh)';
    posterEl.style.willChange = 'transform';
  }
"""

for path, cfg in SHELLS.items():
    s = open(path, encoding='utf-8').read()
    if 'mobileCamera' in s:
        print(f'{path}: already has mobile camera')
        continue

    cam_code = MOBILE_CAM.replace('%POSTERS%', cfg['posters']).replace('%CH1%', str(cfg['ch1'])).replace('%CH2%', str(cfg['ch2']))

    # 插入在启动标记之前
    if cfg['marker'] in s:
        s = s.replace(cfg['marker'], cam_code + '\n  ' + cfg['marker'])

    # 在主循环中调用（找 updateDOM 或 syncUI 调用点）
    # astra: 在 updateDOM() 调用后
    # neon/biolum: 在 syncUI(curP) 调用后
    if 'updateDOM();' in s:
        s = s.replace('updateDOM();', 'updateDOM();\n    if (typeof mobileCamera === "function" && (typeof IS_MOBILE === "undefined" || !IS_MOBILE)) {} else if (typeof mobileCamera === "function") mobileCamera(st.current !== undefined ? st.current : (typeof curP !== "undefined" ? curP : 0));', 1)
    elif 'syncUI(curP);' in s:
        s = s.replace('syncUI(curP);', 'syncUI(curP);\n      if (typeof mobileCamera === "function" && typeof BIOVID !== "undefined" && BIOVID._state && !BIOVID._state().ready) mobileCamera(curP);\n      else if (typeof mobileCamera === "function" && typeof window !== "undefined" && window.__isMobileSite) mobileCamera(curP);', 1)

    open(path, 'w', encoding='utf-8').write(s)
    print(f'{path}: mobile camera added')

# ============ 3. 检测移动端时标记全局变量 ============
for vjs in ['astra/js/astra-video.js', 'neon/neon-video.js', 'biolum/biolum-video.js']:
    s = open(vjs, encoding='utf-8').read()
    # 在 IS_MOBILE 定义后导出到 window
    if 'window.__isMobileSite' not in s:
        s = s.replace(
            "var IS_MOBILE = (typeof window !== 'undefined' && (",
            "var IS_MOBILE = (typeof window !== 'undefined' && ("
        )
        # 在 IS_MOBILE 定义块的末尾加 window 导出
        # 找 ); 结束行
        match = re.search(r'(var IS_MOBILE = \(typeof window[^\n]+\n.*?\);)', s)
        if match:
            block = match.group(1)
            s = s.replace(block, block + "\n  if (typeof window !== 'undefined') window.__isMobileSite = IS_MOBILE;")
            open(vjs, 'w', encoding='utf-8').write(s)
            print(f'{vjs}: __isMobileSite exported')

print('\nAll mobile fixes applied')
