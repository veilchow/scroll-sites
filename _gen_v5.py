# -*- coding: utf-8 -*-
"""从 v5-template.html 生成三个站点"""
import json, os

TEMPLATE = open('v5-template.html', encoding='utf-8').read()

SITES = {
    'astra': {
        'title': 'ASTRA · 深空信标计划',
        'desc': '一座沉默了一万年的信标站，今夜将要醒来。滚动即航行。',
        'bg': '#04060e', 'ink': '#e8ecf4', 'mut': '#5a6278', 'accent': '#7db8ff',
        'anim': 'star', 'brand': 'ASTRA', 'brand_sub': '深空信标计划',
        'loading_text': 'DEEP SPACE LINK', 'hint_text': '接近下一程',
        'poster_1': 'assets/approach.png',
        'config': {
            'chapters': [
                {'nav': '接近', 'kicker': 'CHAPTER 01 · APPROACH', 'title': '出发，去寂静深处。',
                 'sub': '滚动即航行——每一次滚动都向信标站逼近一程。',
                 'poster': 'assets/approach.png', 'video': 'assets/seg1-scrub.mp4',
                 'hud': {'label': 'RANGE TO PORT', 'start': 120.0, 'end': 0.8, 'unit': 'km', 'sub': '接近速度 102 m/s'}},
                {'nav': '对接', 'kicker': 'CHAPTER 02 · RENDEZVOUS', 'title': '灯塔仍在，等一位访客。',
                 'sub': '轨道修正，对接环解锁，港灯为你亮起。',
                 'poster': 'assets/port.png', 'video': 'assets/seg2-scrub.mp4',
                 'hud': {'label': 'CABIN PRESSURE', 'start': 0, 'end': 101, 'unit': 'kPa', 'sub': 'DOCKING'}},
                {'nav': '点亮', 'kicker': 'CHAPTER 03 · IGNITION', 'title': '点亮它，回应一万光年。',
                 'sub': '晶体逐环亮起——请回应来自星海彼岸的呼叫。',
                 'poster': 'assets/core.png', 'video': 'assets/seg2-scrub.mp4',
                 'hud': {'label': 'SYNC RATE', 'start': 0, 'end': 100, 'unit': '%', 'sub': '信标重启中'}},
            ],
            'titleDuration': 5000,
        }
    },
    'neon': {
        'title': 'NEON DRIFT · 雨夜漫游',
        'desc': '这场雨从四百米高空落进城市心底。滚动即下落。',
        'bg': '#0a0618', 'ink': '#e8ecf4', 'mut': '#5a6278', 'accent': '#ff5fa8',
        'anim': 'rain', 'brand': 'NEON DRIFT', 'brand_sub': '雨夜漫游',
        'loading_text': 'CITY SIGNAL', 'hint_text': '坠落下一段',
        'poster_1': 'assets/keys2/k1.png',
        'config': {
            'chapters': [
                {'nav': '高空', 'kicker': 'CHAPTER 01 · SKYFALL', 'title': '雨落下来，城市才醒。',
                 'sub': '滚动即下落——穿过云层、坠入楼隙。',
                 'poster': 'assets/keys2/k1.png', 'video': 'assets/seg1-scrub.mp4',
                 'hud': {'label': 'ALTITUDE', 'start': 480.0, 'end': 30.0, 'unit': 'm', 'sub': '垂直速度 88m/s'}},
                {'nav': '街面', 'kicker': 'CHAPTER 02 · STREET', 'title': '霓虹之下，人流如数据。',
                 'sub': '湿漉路面反射品红与青色霓虹。',
                 'poster': 'assets/keys2/k2.png', 'video': 'assets/seg2-scrub.mp4',
                 'hud': {'label': 'STREET NO.', 'start': 7, 'end': 19, 'unit': '', 'sub': '中山路'}},
                {'nav': '地下', 'kicker': 'CHAPTER 03 · UNDERGROUND', 'title': '再往下，是城市的心跳。',
                 'sub': '穿过地面开口，沉进地下的暖光。',
                 'poster': 'assets/keys2/k4.png', 'video': 'assets/seg3-scrub.mp4',
                 'hud': {'label': 'DISTANCE', 'start': 12.0, 'end': 0.0, 'unit': 'm', 'sub': '距面档'}},
            ],
            'titleDuration': 4500,
        }
    },
    'biolum': {
        'title': 'BIOLUM · 蓝眼泪',
        'desc': '听说，海今晚会发光。滚动即追光。',
        'bg': '#03121f', 'ink': '#e8f5f1', 'mut': '#5a6278', 'accent': '#3df0c8',
        'anim': 'glow', 'brand': 'BIOLUM', 'brand_sub': '蓝眼泪',
        'loading_text': 'SYNCING GLOW', 'hint_text': '追光下一段',
        'poster_1': 'assets/keys/k1.png',
        'config': {
            'chapters': [
                {'nav': '黄昏', 'kicker': 'CHAPTER 01 · DUSKFALL', 'title': '听说，海今晚会发光。',
                 'sub': '滚动即追光——从黄昏小镇走到夜的海面。',
                 'poster': 'assets/keys/k1.png', 'video': 'assets/seg1-scrub.mp4',
                 'hud': {'label': 'TIDE', 'start': 19.7, 'end': 21.3, 'unit': '', 'sub': '满潮 21:17'}},
                {'nav': '夜海', 'kicker': 'CHAPTER 02 · AWAKENING', 'title': '整片海，在为你发光。',
                 'sub': '浪尖的荧光从一线涨成满海。',
                 'poster': 'assets/keys/k2.png', 'video': 'assets/seg2-scrub.mp4',
                 'hud': {'label': 'GLOW INDEX', 'start': 0, 'end': 100, 'unit': '%', 'sub': '夜光藻爆发中'}},
                {'nav': '水下', 'kicker': 'CHAPTER 03 · SPLASH', 'title': '潜入水下的星河。',
                 'sub': '穿过发光的水面，悬浮在星河之间。',
                 'poster': 'assets/keys/k4.png', 'video': 'assets/seg3-scrub.mp4',
                 'hud': {'label': 'DEPTH', 'start': 0, 'end': 8.0, 'unit': 'm', 'sub': '星河深处'}},
            ],
            'titleDuration': 5000,
        }
    },
}

for site, cfg in SITES.items():
    html = TEMPLATE
    for key, val in cfg.items():
        if key == 'config':
            continue
        html = html.replace(f'__{key.upper()}__', str(val))
    # config 转 JSON
    html = html.replace('__CONFIG__', json.dumps(cfg['config'], ensure_ascii=False, indent=2))
    # 确保没有遗留占位符
    import re
    leftovers = re.findall(r'__[A-Z_]+__', html)
    if leftovers:
        print(f'{site}: WARNING leftover placeholders: {leftovers}')
    out = f'{site}/index-v5.html'
    open(out, 'w', encoding='utf-8').write(html)
    print(f'{site}: {out} generated ({len(html)//1024}KB)')
