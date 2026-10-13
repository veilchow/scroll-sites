# -*- coding: utf-8 -*-
"""给三个站点加主题加载屏 + 视频模块绑定 preloader 淡出"""
import re

LOADERS = {
    'astra': {'bg': '#04060e', 'color': '#7db8ff', 'glow': 'rgba(120,200,255,.4)', 'text': 'ASTRA', 'sub': 'DEEP SPACE LINK', 'anim': 'star'},
    'neon': {'bg': '#0a0618', 'color': '#ff5fa8', 'glow': 'rgba(255,95,168,.3)', 'text': 'NEON DRIFT', 'sub': 'CITY SIGNAL', 'anim': 'rain'},
    'biolum': {'bg': '#03121f', 'color': '#3df0c8', 'glow': 'rgba(61,240,200,.3)', 'text': 'BIOLUM', 'sub': 'SYNCING GLOW', 'anim': 'glow'}
}

def make_css(c):
    return f"""
  /* 主题加载屏 */
  #preloader{{position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:18px;background:{c['bg']};transition:opacity .8s ease,visibility .8s}}
  #preloader.done{{opacity:0;visibility:hidden;pointer-events:none}}
  #preloader .pl-anim{{width:48px;height:48px;position:relative}}
  #preloader .pl-anim.star::before,#preloader .pl-anim.star::after{{content:'';position:absolute;left:50%;top:50%;width:3px;height:3px;border-radius:50%;background:{c['color']};box-shadow:0 0 10px {c['glow']};animation:pl-star 2s ease-in-out infinite}}
  #preloader .pl-anim.star::after{{animation-delay:1s}}
  @keyframes pl-star{{0%,100%{{transform:translate(-50%,-50%) scale(0);opacity:0}}50%{{transform:translate(-50%,-50%) scale(3);opacity:1}}}}
  #preloader .pl-anim.glow{{width:52px;height:52px;border-radius:50%;background:radial-gradient(circle,{c['glow']} 0%,transparent 70%);animation:pl-glow 2.4s ease-in-out infinite}}
  @keyframes pl-glow{{0%,100%{{transform:scale(.6);opacity:.3}}50%{{transform:scale(1.2);opacity:1}}}}
  #preloader .pl-anim.rain{{width:2px;height:36px;background:linear-gradient(180deg,transparent,{c['color']});animation:pl-rain 1.2s ease-in infinite;border-radius:2px}}
  @keyframes pl-rain{{0%{{transform:translateY(-20px);opacity:0}}30%{{opacity:1}}100%{{transform:translateY(24px);opacity:0}}}}
  #preloader .pl-title{{font-family:var(--mono,monospace);font-size:12px;letter-spacing:.5em;color:{c['color']};opacity:.8}}
  #preloader .pl-sub{{font-family:var(--mono,monospace);font-size:9px;letter-spacing:.3em;color:rgba(255,255,255,.3);animation:pl-sub-pulse 2s ease-in-out infinite}}
  @keyframes pl-sub-pulse{{0%,100%{{opacity:.2}}50%{{opacity:.6}}}}
  @media(prefers-reduced-motion:reduce){{#preloader .pl-anim,#preloader .pl-sub{{animation:none}}}}
"""

def make_html(c):
    return f'  <div id="preloader" aria-hidden="true"><div class="pl-anim {c["anim"]}"></div><div class="pl-title">{c["text"]}</div><div class="pl-sub">{c["sub"]}</div></div>'

# ============ 1. 加 HTML + CSS ============
for site in ['astra', 'neon', 'biolum']:
    idx = f'{site}/index.html'
    s = open(idx, encoding='utf-8').read()
    c = LOADERS[site]
    if 'id="preloader"' in s:
        print(f'{site}: already has preloader')
        continue
    css = make_css(c)
    html = make_html(c)
    s = s.replace('</style>', css + '</style>')
    s = re.sub(r'(<body[^>]*>)', r'\1\n' + html, s, count=1)
    open(idx, 'w', encoding='utf-8').write(s)
    print(f'{site}: preloader HTML+CSS added')

# ============ 2. 视频模块：显影时淡出 preloader ============
for vjs in ['astra/js/astra-video.js', 'neon/neon-video.js', 'biolum/biolum-video.js']:
    s = open(vjs, encoding='utf-8').read()
    if 'preloader' in s:
        print(f'{vjs}: already patched')
        continue
    # 在 seeked 事件的 reveal 逻辑处，同时淡出 preloader
    old = "seg.revealed = true;"
    new = "seg.revealed = true;\n            var pl = document.getElementById('preloader');\n            if (pl) pl.classList.add('done');"
    if old in s:
        s = s.replace(old, new, 1)
    open(vjs, 'w', encoding='utf-8').write(s)
    print(f'{vjs}: preloader fade-out on reveal')

# ============ 3. 兜底：8秒后强制淡出（防视频加载失败卡死加载屏） ============
for site in ['astra', 'neon', 'biolum']:
    idx = f'{site}/index.html'
    s = open(idx, encoding='utf-8').read()
    if '__plFallback' in s:
        continue
    # 在 </body> 前加兜底脚本
    fallback = """<script>setTimeout(function(){var p=document.getElementById('preloader');if(p)p.classList.add('done')},8000)</script>
"""
    s = s.replace('</body>', fallback + '</body>')
    open(idx, 'w', encoding='utf-8').write(s)
    print(f'{site}: 8s fallback timer added')

print('\\nAll done')
