//@name risustand
//@display-name RisuStand
//@api 3.0
//@version 1.2.0
//@update-url https://raw.githubusercontent.com/rusinus12-droid/RisuStand/refs/heads/main/risustand.js
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright (c) 2026 rusinus12

(async function risustandPluginMain() {
    // Kept in sync with //@version by tools/release_version.cjs
    const RISUSTAND_VERSION = '1.2.0';
    // Brand mark glyph (source: docs/brand/risustand-mark.svg), tinted via currentColor.
    const RS_MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false" fill="currentColor"><g transform="translate(0 -2.5)"><g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M27.76 20.26 A6 6 0 0 1 36.24 20.26"/><path d="M24.22 16.72 A11 11 0 0 1 39.78 16.72" opacity="0.6"/></g><path d="M30.8 26.3C24.6 22.8 18.2 22.3 13 23.2V41C18.5 40.4 24.9 41.1 30.8 44.3Z"/><path d="M33.2 26.3C39.4 22.8 45.8 22.3 51 23.2V41C45.5 40.4 39.1 41.1 33.2 44.3Z"/><g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 43.5L32 49L53.5 43.5"/><path d="M32 49V54"/><path d="M25 54H39"/></g></g></svg>';
    const STORAGE_KEY = 'risustand_v1';
    const LEGACY_STORAGE_KEY = 'risu_ultra_custom_shell_v2';
    const STYLE_ATTR = 'x-risustand-style';
    const SHELL_BAR_ATTR = 'x-risustand-topbar';

    const FONT_STACKS = {
        inherit: {
            label: 'RisuAI 기본 글꼴 유지',
            css: 'inherit',
        },
        'epub-serif': {
            label: '전자책 명조 (리디바탕 / KoPub 바탕 / AppleMyungjo / 바탕)',
            css: '"RIDIBatang", "KoPub Batang", "AppleMyungjo", "Batang", "바탕", "NanumMyeongjo", "Noto Serif KR", Georgia, serif',
        },
        'epub-sans': {
            label: '눈 편한 고딕 (Pretendard / Apple SD Gothic Neo / 맑은 고딕)',
            css: '"Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "맑은 고딕", "Noto Sans KR", system-ui, -apple-system, sans-serif',
        },
        'epub-clean': {
            label: '챗봇 공홈 산세리프 (시스템 기본)',
            css: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", "맑은 고딕", Roboto, sans-serif',
        },
    };

    // stealth.mode: 'off' | 'soft' (공홈/EPUB 수준 에셋 숨김) | 'full' (완전 감추기)
    const DEFAULT_CONFIG = {
        antiFlicker: {
            enabled: true,
            lockMs: 850,
            preserveScrollAnchor: false,
            smoothFade: true,
        },
        stealth: {
            mode: 'off', // 'off' | 'soft' | 'full'
            hideSidebarAvatars: false,
        },
        layout: {
            showFloatingTopBar: true,
            autoMinimizeSec: 5,
            topBarPos: null, // { x: number, y: number } or null (top-center)
            floatingCapsuleInput: true,
            zenMode: false,
            sidebarRight: false,
            hoverActionsOnly: true,
            compactHeaders: true,
            customScrollbar: true,
            epubTwoPage: true,
            epubShowAssets: true,
            autoRefreshClone: true,
        },
        theme: {
            preset: 'ai-gemini',
            bubbleStyle: 'chatbot', // 'default' | 'card' | 'glass' | 'flat' | 'epub' | 'chatbot'
            fontFamily: 'epub-clean',
            justifyText: false,
            bubbleRadius: 20,
            chatMaxWidth: 780,
            fontSize: 15,
            lineHeight: 1.75,
            accentColor: '#8ab4f8',
            quoteColor: '#a8c7fa',
            surfaceAlpha: 0.78,
            customCSS: '',
        },
    };

    const PRESETS = {
        original: {
            label: '기본값 (원본)',
            brandTitle: 'RisuAI',
            brandModel: '',
            shortIcon: '✦',
            desc: '커스텀 레이아웃·테마를 끄고 RisuAI 원본으로 복원합니다.',
            useNativeDefault: true,
            scheme: null,
            textTheme: null,
            defaults: {
                bubbleStyle: 'default',
                fontFamily: 'inherit',
                justifyText: false,
                bubbleRadius: 8,
                chatMaxWidth: 860,
                fontSize: 15,
                lineHeight: 1.6,
                accentColor: '#5c7cfa',
                quoteColor: '#8be9fd',
                surfaceAlpha: 0,
            },
            stealthDefaults: { mode: 'off', hideSidebarAvatars: false },
            layoutDefaults: { floatingCapsuleInput: false, hoverActionsOnly: false, compactHeaders: false },
            bgGradient: '',
            cardBgRgb: '',
            borderColor: '',
        },
        'ai-gemini': {
            label: '✦ Gemini 공홈 (외출용)',
            brandTitle: 'Gemini',
            brandModel: '2.5 Pro',
            shortIcon: '✦',
            desc: '구글 Gemini 공식 다크 UI · 캡슐 입력창 · 에셋 자동 숨김',
            isChatbot: true,
            badgeBg: 'linear-gradient(135deg, #4285f4 0%, #9b72cb 60%, #d96570 100%)',
            inputBg: '#1e1f20',
            inputBorder: '#3c4043',
            topBarBg: 'rgba(19, 19, 20, 0.90)',
            topBarText: '#e3e3e3',
            userBubbleBg: '#282a2c',
            scheme: {
                bgcolor: '#131314',
                darkbg: '#1e1f20',
                borderc: '#2e2f31',
                selected: '#282a2c',
                draculared: '#f28b82',
                textcolor: '#e3e3e3',
                textcolor2: '#9aa0a6',
                darkBorderc: '#2d2e30',
                darkbutton: '#1e1f20',
                type: 'dark',
            },
            textTheme: {
                FontColorStandard: '#e3e3e3',
                FontColorBold: '#ffffff',
                FontColorItalic: '#c4c7c5',
                FontColorItalicBold: '#e3e3e3',
                FontColorQuote1: '#a8c7fa',
                FontColorQuote2: '#c2e7ff',
            },
            defaults: {
                bubbleStyle: 'chatbot',
                fontFamily: 'epub-clean',
                justifyText: false,
                bubbleRadius: 24,
                chatMaxWidth: 780,
                fontSize: 15,
                lineHeight: 1.75,
                accentColor: '#8ab4f8',
                quoteColor: '#a8c7fa',
                surfaceAlpha: 0,
            },
            stealthDefaults: { mode: 'soft', hideSidebarAvatars: true },
            layoutDefaults: { floatingCapsuleInput: true, hoverActionsOnly: true, compactHeaders: true },
            bgGradient: '#131314',
            cardBgRgb: '30, 31, 32',
            borderColor: 'rgba(255, 255, 255, 0.08)',
            dividerColor: 'rgba(255, 255, 255, 0.06)',
        },
        'ai-claude': {
            label: '✴ Claude 공홈 (외출용)',
            brandTitle: 'Claude',
            brandModel: 'Sonnet',
            shortIcon: '✴',
            desc: 'Anthropic Claude 웜 페이퍼 UI · 캡슐 입력창 · 에셋 자동 숨김',
            isChatbot: true,
            badgeBg: '#d97757',
            inputBg: '#ffffff',
            inputBorder: '#dcd8cc',
            topBarBg: 'rgba(250, 249, 245, 0.94)',
            topBarText: '#1a1918',
            userBubbleBg: '#f0eee6',
            scheme: {
                bgcolor: '#faf9f5',
                darkbg: '#f0eee6',
                borderc: '#e2dfd5',
                selected: '#e8e5db',
                draculared: '#c84b31',
                textcolor: '#1a1918',
                textcolor2: '#6b6860',
                darkBorderc: '#dcd8cc',
                darkbutton: '#ece9df',
                type: 'light',
            },
            textTheme: {
                FontColorStandard: '#1a1918',
                FontColorBold: '#0f0e0d',
                FontColorItalic: '#57544d',
                FontColorItalicBold: '#2b2926',
                FontColorQuote1: '#9e4a2f',
                FontColorQuote2: '#3f5f58',
            },
            defaults: {
                bubbleStyle: 'chatbot',
                fontFamily: 'epub-serif',
                justifyText: false,
                bubbleRadius: 18,
                chatMaxWidth: 740,
                fontSize: 16,
                lineHeight: 1.82,
                accentColor: '#d97757',
                quoteColor: '#9e4a2f',
                surfaceAlpha: 0,
            },
            stealthDefaults: { mode: 'soft', hideSidebarAvatars: true },
            layoutDefaults: { floatingCapsuleInput: true, hoverActionsOnly: true, compactHeaders: true },
            bgGradient: '#faf9f5',
            cardBgRgb: '240, 238, 230',
            borderColor: 'rgba(26, 25, 24, 0.10)',
            dividerColor: 'rgba(26, 25, 24, 0.07)',
        },
        'ai-chatgpt': {
            label: '● ChatGPT 공홈 (외출용)',
            brandTitle: 'ChatGPT',
            brandModel: '5',
            shortIcon: '●',
            desc: 'OpenAI ChatGPT 다크 UI · 캡슐 입력창 · 에셋 자동 숨김',
            isChatbot: true,
            badgeBg: '#10a37f',
            inputBg: '#2f2f2f',
            inputBorder: '#424242',
            topBarBg: 'rgba(33, 33, 33, 0.92)',
            topBarText: '#ececec',
            userBubbleBg: '#2f2f2f',
            scheme: {
                bgcolor: '#212121',
                darkbg: '#171717',
                borderc: '#343434',
                selected: '#2f2f2f',
                draculared: '#ef4444',
                textcolor: '#ececec',
                textcolor2: '#9b9b9b',
                darkBorderc: '#2f2f2f',
                darkbutton: '#2a2a2a',
                type: 'dark',
            },
            textTheme: {
                FontColorStandard: '#ececec',
                FontColorBold: '#ffffff',
                FontColorItalic: '#bdbdbd',
                FontColorItalicBold: '#e0e0e0',
                FontColorQuote1: '#ececec',
                FontColorQuote2: '#d4d4d4',
            },
            defaults: {
                bubbleStyle: 'chatbot',
                fontFamily: 'epub-clean',
                justifyText: false,
                bubbleRadius: 24,
                chatMaxWidth: 768,
                fontSize: 15,
                lineHeight: 1.75,
                accentColor: '#10a37f',
                quoteColor: '#ececec',
                surfaceAlpha: 0,
            },
            stealthDefaults: { mode: 'soft', hideSidebarAvatars: true },
            layoutDefaults: { floatingCapsuleInput: true, hoverActionsOnly: true, compactHeaders: true },
            bgGradient: '#212121',
            cardBgRgb: '47, 47, 47',
            borderColor: 'rgba(255, 255, 255, 0.08)',
            dividerColor: 'rgba(255, 255, 255, 0.06)',
        },
        'epub-sepia-scroll': {
            label: '📜 EPUB 세피아 (1쪽 스크롤)',
            brandTitle: 'EPUB',
            brandModel: '1쪽 세피아',
            shortIcon: '📜',
            desc: '전자책 명조 기본 · 위아래로 쭈욱 읽는 1쪽 스크롤 · 이미지 포함',
            isEpub: true,
            epubSpread: false,
            badgeBg: '#9c5a34',
            inputBg: '#f6efe0',
            inputBorder: '#cfc1a3',
            topBarBg: 'rgba(232, 222, 198, 0.94)',
            topBarText: '#2c241b',
            userBubbleBg: '#efe5ce',
            pageBg: '#f7f0e1',
            scheme: {
                bgcolor: '#e8dec6',
                darkbg: '#dfd3b8',
                borderc: '#cfc1a3',
                selected: '#d9ccb0',
                draculared: '#b8432e',
                textcolor: '#2c241b',
                textcolor2: '#6d5e4c',
                darkBorderc: '#c7b897',
                darkbutton: '#dfd4bb',
                type: 'light',
            },
            textTheme: {
                FontColorStandard: '#2c241b',
                FontColorBold: '#17120c',
                FontColorItalic: '#665746',
                FontColorItalicBold: '#493c2e',
                FontColorQuote1: '#7c3626',
                FontColorQuote2: '#2b5954',
            },
            defaults: {
                bubbleStyle: 'epub',
                fontFamily: 'epub-serif',
                justifyText: true,
                bubbleRadius: 0,
                chatMaxWidth: 700,
                fontSize: 16,
                lineHeight: 1.95,
                accentColor: '#9c5a34',
                quoteColor: '#7c3626',
                surfaceAlpha: 1,
            },
            stealthDefaults: { mode: 'off', hideSidebarAvatars: false },
            layoutDefaults: { floatingCapsuleInput: true, hoverActionsOnly: true, compactHeaders: true, epubTwoPage: false },
            bgGradient: '#e8dec6',
            cardBgRgb: '246, 239, 224',
            borderColor: 'rgba(130, 108, 76, 0.22)',
            dividerColor: 'rgba(130, 108, 76, 0.14)',
        },
        'epub-night-scroll': {
            label: '📜 EPUB 다크 (1쪽 스크롤)',
            brandTitle: 'EPUB',
            brandModel: '1쪽 다크',
            shortIcon: '📜',
            desc: '야간 전자책 명조 기본 · 위아래로 쭈욱 읽는 1쪽 스크롤 · 이미지 포함',
            isEpub: true,
            epubSpread: false,
            badgeBg: '#c49b66',
            inputBg: '#1d1d22',
            inputBorder: '#32323a',
            topBarBg: 'rgba(18, 18, 21, 0.92)',
            topBarText: '#d6d2c9',
            userBubbleBg: '#232329',
            pageBg: '#1b1b20',
            scheme: {
                bgcolor: '#121215',
                darkbg: '#0d0d10',
                borderc: '#2a2a30',
                selected: '#202026',
                draculared: '#e06c75',
                textcolor: '#d6d2c9',
                textcolor2: '#8d8980',
                darkBorderc: '#232329',
                darkbutton: '#18181c',
                type: 'dark',
            },
            textTheme: {
                FontColorStandard: '#d6d2c9',
                FontColorBold: '#f0ece3',
                FontColorItalic: '#a8a399',
                FontColorItalicBold: '#c7c2b8',
                FontColorQuote1: '#e3bf88',
                FontColorQuote2: '#9ac4c2',
            },
            defaults: {
                bubbleStyle: 'epub',
                fontFamily: 'epub-serif',
                justifyText: true,
                bubbleRadius: 0,
                chatMaxWidth: 700,
                fontSize: 16,
                lineHeight: 1.95,
                accentColor: '#c49b66',
                quoteColor: '#e3bf88',
                surfaceAlpha: 1,
            },
            stealthDefaults: { mode: 'off', hideSidebarAvatars: false },
            layoutDefaults: { floatingCapsuleInput: true, hoverActionsOnly: true, compactHeaders: true, epubTwoPage: false },
            bgGradient: '#121215',
            cardBgRgb: '26, 26, 30',
            borderColor: 'rgba(255, 255, 255, 0.08)',
            dividerColor: 'rgba(255, 255, 255, 0.06)',
        },
        'epub-sepia': {
            label: '📖 EPUB 세피아',
            brandTitle: 'EPUB',
            brandModel: '2쪽 세피아',
            shortIcon: '📖',
            desc: '눈이 편안한 종이책 세피아 톤과 전자책 명조 스타일',
            isEpub: true,
            epubSpread: true,
            badgeBg: '#9c5a34',
            inputBg: '#f6efe0',
            inputBorder: '#cfc1a3',
            topBarBg: 'rgba(232, 222, 198, 0.94)',
            topBarText: '#2c241b',
            userBubbleBg: '#efe5ce',
            pageBg: '#f7f0e1',
            scheme: {
                bgcolor: '#e8dec6',
                darkbg: '#dfd3b8',
                borderc: '#cfc1a3',
                selected: '#d9ccb0',
                draculared: '#b8432e',
                textcolor: '#2c241b',
                textcolor2: '#6d5e4c',
                darkBorderc: '#c7b897',
                darkbutton: '#dfd4bb',
                type: 'light',
            },
            textTheme: {
                FontColorStandard: '#2c241b',
                FontColorBold: '#17120c',
                FontColorItalic: '#665746',
                FontColorItalicBold: '#493c2e',
                FontColorQuote1: '#7c3626',
                FontColorQuote2: '#2b5954',
            },
            defaults: {
                bubbleStyle: 'epub',
                fontFamily: 'epub-serif',
                justifyText: true,
                bubbleRadius: 0,
                chatMaxWidth: 700,
                fontSize: 16,
                lineHeight: 1.95,
                accentColor: '#9c5a34',
                quoteColor: '#7c3626',
                surfaceAlpha: 1,
            },
            stealthDefaults: { mode: 'off', hideSidebarAvatars: false },
            layoutDefaults: { floatingCapsuleInput: true, hoverActionsOnly: true, compactHeaders: true },
            bgGradient: '#e8dec6',
            cardBgRgb: '246, 239, 224',
            borderColor: 'rgba(130, 108, 76, 0.22)',
            dividerColor: 'rgba(130, 108, 76, 0.14)',
        },
        'epub-night': {
            label: '🌙 EPUB 다크',
            brandTitle: 'EPUB',
            brandModel: '2쪽 다크',
            shortIcon: '🌙',
            desc: '야간 장시간 독서를 위한 저자극 다크 전자책 스타일',
            isEpub: true,
            epubSpread: true,
            badgeBg: '#c49b66',
            inputBg: '#1d1d22',
            inputBorder: '#32323a',
            topBarBg: 'rgba(18, 18, 21, 0.92)',
            topBarText: '#d6d2c9',
            userBubbleBg: '#232329',
            pageBg: '#1b1b20',
            scheme: {
                bgcolor: '#121215',
                darkbg: '#0d0d10',
                borderc: '#2a2a30',
                selected: '#202026',
                draculared: '#e06c75',
                textcolor: '#d6d2c9',
                textcolor2: '#8d8980',
                darkBorderc: '#232329',
                darkbutton: '#18181c',
                type: 'dark',
            },
            textTheme: {
                FontColorStandard: '#d6d2c9',
                FontColorBold: '#f0ece3',
                FontColorItalic: '#a8a399',
                FontColorItalicBold: '#c7c2b8',
                FontColorQuote1: '#e3bf88',
                FontColorQuote2: '#9ac4c2',
            },
            defaults: {
                bubbleStyle: 'epub',
                fontFamily: 'epub-serif',
                justifyText: true,
                bubbleRadius: 0,
                chatMaxWidth: 700,
                fontSize: 16,
                lineHeight: 1.95,
                accentColor: '#c49b66',
                quoteColor: '#e3bf88',
                surfaceAlpha: 1,
            },
            stealthDefaults: { mode: 'off', hideSidebarAvatars: false },
            layoutDefaults: { floatingCapsuleInput: true, hoverActionsOnly: true, compactHeaders: true },
            bgGradient: '#121215',
            cardBgRgb: '26, 26, 30',
            borderColor: 'rgba(255, 255, 255, 0.08)',
            dividerColor: 'rgba(255, 255, 255, 0.06)',
        },
        'midnight-glass': {
            label: '미드나잇 글래스',
            brandTitle: 'Midnight',
            brandModel: 'Studio',
            shortIcon: '✨',
            desc: '깊은 밤하늘 톤과 은은한 광택의 다크 채팅 카드',
            badgeBg: '#7c8cff',
            inputBg: '#161e31',
            inputBorder: '#2a3759',
            topBarBg: 'rgba(15, 20, 34, 0.90)',
            topBarText: '#e6ecf8',
            userBubbleBg: '#1c2640',
            scheme: {
                bgcolor: '#0f1422',
                darkbg: '#0a0e19',
                borderc: '#26314d',
                selected: '#1e2a45',
                draculared: '#ff6b81',
                textcolor: '#e6ecf8',
                textcolor2: '#94a3c4',
                darkBorderc: '#1d263d',
                darkbutton: '#161e31',
                type: 'dark',
            },
            textTheme: {
                FontColorStandard: '#e6ecf8',
                FontColorBold: '#ffffff',
                FontColorItalic: '#a8b7d9',
                FontColorItalicBold: '#c7d4f4',
                FontColorQuote1: '#ffd480',
                FontColorQuote2: '#9be7ff',
            },
            defaults: {
                bubbleStyle: 'glass',
                fontFamily: 'epub-sans',
                justifyText: false,
                bubbleRadius: 16,
                chatMaxWidth: 820,
                fontSize: 15,
                lineHeight: 1.75,
                accentColor: '#7c8cff',
                quoteColor: '#ffd480',
                surfaceAlpha: 0.78,
            },
            stealthDefaults: { mode: 'off', hideSidebarAvatars: false },
            layoutDefaults: { floatingCapsuleInput: true, hoverActionsOnly: true, compactHeaders: false },
            bgGradient: 'radial-gradient(circle at 20% 10%, rgba(124, 140, 255, 0.14), transparent 45%), radial-gradient(circle at 85% 85%, rgba(56, 189, 248, 0.10), transparent 45%), #0f1422',
            cardBgRgb: '20, 27, 46',
            borderColor: 'rgba(124, 140, 255, 0.24)',
        },
        'sakura-dream': {
            label: '사쿠라 파스텔',
            brandTitle: 'Sakura',
            brandModel: 'Pastel',
            shortIcon: '🌸',
            desc: '부드러운 로즈 플럼 다크 톤과 은은한 핑크 포인트',
            badgeBg: '#f48fb1',
            inputBg: '#261a28',
            inputBorder: '#47304a',
            topBarBg: 'rgba(27, 20, 28, 0.90)',
            topBarText: '#f6eaf4',
            userBubbleBg: '#322035',
            scheme: {
                bgcolor: '#1b141c',
                darkbg: '#140e15',
                borderc: '#3d2a3f',
                selected: '#322035',
                draculared: '#ff7597',
                textcolor: '#f6eaf4',
                textcolor2: '#bfa4bc',
                darkBorderc: '#312133',
                darkbutton: '#261a28',
                type: 'dark',
            },
            textTheme: {
                FontColorStandard: '#f6eaf4',
                FontColorBold: '#ffffff',
                FontColorItalic: '#d1b3ce',
                FontColorItalicBold: '#e6cce3',
                FontColorQuote1: '#ffb3c9',
                FontColorQuote2: '#ffd6a5',
            },
            defaults: {
                bubbleStyle: 'glass',
                fontFamily: 'epub-sans',
                justifyText: false,
                bubbleRadius: 20,
                chatMaxWidth: 800,
                fontSize: 15,
                lineHeight: 1.78,
                accentColor: '#f48fb1',
                quoteColor: '#ffb3c9',
                surfaceAlpha: 0.8,
            },
            stealthDefaults: { mode: 'off', hideSidebarAvatars: false },
            layoutDefaults: { floatingCapsuleInput: true, hoverActionsOnly: true, compactHeaders: false },
            bgGradient: 'radial-gradient(circle at 15% 15%, rgba(244, 143, 177, 0.14), transparent 45%), radial-gradient(circle at 80% 80%, rgba(186, 104, 200, 0.12), transparent 50%), #1b141c',
            cardBgRgb: '39, 27, 41',
            borderColor: 'rgba(244, 143, 177, 0.25)',
        },
        'forest-moss': {
            label: '포레스트 모스',
            brandTitle: 'Forest',
            brandModel: 'Moss',
            shortIcon: '🌿',
            desc: '차분한 딥 에메랄드와 세이지 톤의 장시간 독서용 테마',
            badgeBg: '#68b892',
            inputBg: '#16231e',
            inputBorder: '#2a4037',
            topBarBg: 'rgba(17, 25, 22, 0.90)',
            topBarText: '#e4efe9',
            userBubbleBg: '#1c2e27',
            scheme: {
                bgcolor: '#111916',
                darkbg: '#0c1210',
                borderc: '#24372f',
                selected: '#1c2e27',
                draculared: '#e06c75',
                textcolor: '#e4efe9',
                textcolor2: '#95afa2',
                darkBorderc: '#1d2d26',
                darkbutton: '#16231e',
                type: 'dark',
            },
            textTheme: {
                FontColorStandard: '#e4efe9',
                FontColorBold: '#f7fcf9',
                FontColorItalic: '#9cb7a9',
                FontColorItalicBold: '#bdd6c9',
                FontColorQuote1: '#f0c674',
                FontColorQuote2: '#8abeb7',
            },
            defaults: {
                bubbleStyle: 'card',
                fontFamily: 'epub-sans',
                justifyText: false,
                bubbleRadius: 14,
                chatMaxWidth: 800,
                fontSize: 15,
                lineHeight: 1.8,
                accentColor: '#68b892',
                quoteColor: '#f0c674',
                surfaceAlpha: 0.82,
            },
            stealthDefaults: { mode: 'off', hideSidebarAvatars: false },
            layoutDefaults: { floatingCapsuleInput: true, hoverActionsOnly: true, compactHeaders: false },
            bgGradient: 'radial-gradient(circle at 25% 10%, rgba(104, 184, 146, 0.12), transparent 45%), #111916',
            cardBgRgb: '22, 34, 29',
            borderColor: 'rgba(104, 184, 146, 0.22)',
        },
        'minimal-amoled': {
            label: '미니멀 리얼블랙',
            brandTitle: 'Minimal',
            brandModel: 'AMOLED',
            shortIcon: '◼',
            desc: '순수 블랙 배경과 미니멀한 타이포그래피 중심 테마',
            badgeBg: '#a1a1aa',
            inputBg: '#0e0e11',
            inputBorder: '#27272c',
            topBarBg: 'rgba(0, 0, 0, 0.92)',
            topBarText: '#ececef',
            userBubbleBg: '#141417',
            scheme: {
                bgcolor: '#000000',
                darkbg: '#000000',
                borderc: '#242428',
                selected: '#141417',
                draculared: '#ff5555',
                textcolor: '#ececef',
                textcolor2: '#8a8a94',
                darkBorderc: '#1c1c20',
                darkbutton: '#0e0e11',
                type: 'dark',
            },
            textTheme: {
                FontColorStandard: '#ececef',
                FontColorBold: '#ffffff',
                FontColorItalic: '#9d9da8',
                FontColorItalicBold: '#c7c7d1',
                FontColorQuote1: '#f5d08a',
                FontColorQuote2: '#9ecbff',
            },
            defaults: {
                bubbleStyle: 'flat',
                fontFamily: 'epub-sans',
                justifyText: false,
                bubbleRadius: 10,
                chatMaxWidth: 780,
                fontSize: 15,
                lineHeight: 1.8,
                accentColor: '#a1a1aa',
                quoteColor: '#f5d08a',
                surfaceAlpha: 0.9,
            },
            stealthDefaults: { mode: 'off', hideSidebarAvatars: false },
            layoutDefaults: { floatingCapsuleInput: true, hoverActionsOnly: true, compactHeaders: false },
            bgGradient: '#000000',
            cardBgRgb: '14, 14, 17',
            borderColor: 'rgba(255, 255, 255, 0.10)',
        },
    };

    let config = structuredClone(DEFAULT_CONFIG);
    let rootDoc = null;
    let pointerListenerId = null;
    let docMoveListenerId = null;
    let docUpListenerId = null;
    let mutationObserver = null;
    let lockReleaseTimer = null;
    let isLockActive = false;
    let lastKnownHeights = [];
    let lastAnchorIndex = -1;
    let domPermissionGranted = false;
    let currentIframeMode = null; // 'studio' | 'clone' | null
    let lastCloneMode = 'ai-gemini';
    let chatOutputListener = null;
    let cloneWatcherTimer = null;
    let lastCloneSignature = '';
    let pendingCloneRefresh = false;

    function stopCloneWatcher() {
        if (cloneWatcherTimer) {
            clearInterval(cloneWatcherTimer);
            cloneWatcherTimer = null;
        }
    }

    async function computeChatSignature() {
        try {
            const charIdx = await risuai.getCurrentCharacterIndex();
            const chatIdx = await risuai.getCurrentChatIndex();
            if (charIdx < 0 || chatIdx < 0) return '';
            const chatObj = await risuai.getChatFromIndex(charIdx, chatIdx);
            const msgs = chatObj && Array.isArray(chatObj.message) ? chatObj.message : [];
            const len = msgs.length;
            const last = len > 0 ? msgs[len - 1] : null;
            const lastDataLen = last && last.data ? String(last.data).length : 0;
            const prev = len > 1 ? msgs[len - 2] : null;
            const prevDataLen = prev && prev.data ? String(prev.data).length : 0;
            return `${charIdx}:${chatIdx}:${len}:${lastDataLen}:${prevDataLen}`;
        } catch (_) {
            return '';
        }
    }

    function startCloneWatcher() {
        stopCloneWatcher();
        if (!config.layout.autoRefreshClone) return;
        cloneWatcherTimer = setInterval(async () => {
            if (currentIframeMode !== 'clone' || !config.layout.autoRefreshClone || pendingCloneRefresh) return;
            const sig = await computeChatSignature();
            if (sig && lastCloneSignature && sig !== lastCloneSignature) {
                // Mark dirty silently — DO NOT interrupt the user's current page!
                pendingCloneRefresh = true;
            }
        }, 4000);
    }

    // Top bar state (minimizable, auto-minimizing, draggable)
    let topBarMinimized = true;
    let autoMinimizeTimer = null;
    let dragState = null; // { startX, startY, origLeft, origTop, moved, barEl }
    let studioPointerUpHandler = null;

    async function unwrapArray(safeArr) {
        if (!safeArr) return [];
        if (Array.isArray(safeArr)) return safeArr;
        if (typeof risuai.unwarpSafeArray === 'function') {
            return await risuai.unwarpSafeArray(safeArr);
        }
        const len = await safeArr.length();
        const out = [];
        for (let i = 0; i < len; i++) {
            out.push(await safeArr.at(i));
        }
        return out;
    }

    // Canonical U+A turn counting (aligned with HAYAKU & Flashback Memory)
    function computeUATurnStats(messages) {
        const list = Array.isArray(messages) ? messages : [];
        let completed = 0;
        let hasPendingUser = false;
        let hasAssistantInPair = false;
        let activeTurnNum = 0;
        const turnByIndex = new Array(list.length).fill(0);
        for (let i = 0; i < list.length; i += 1) {
            const m = list[i];
            if (!m || typeof m !== 'object') continue;
            if (m.disabled === true || m.isComment === true || m.isFirstMessage === true) continue;
            const rawBody = m.data ?? m.raw ?? m.content ?? m.text ?? '';
            let hasBody = String(rawBody).trim().length > 0;
            if (!hasBody && m.html) {
                hasBody = String(m.html).replace(/<[^>]+>/g, ' ').trim().length > 0 || /<img\b/i.test(String(m.html));
            }
            if (!hasBody) continue;
            const roleRaw = String(m.role || '').toLowerCase();
            if (roleRaw === 'user') {
                if (!hasPendingUser) {
                    activeTurnNum = completed + 1;
                    hasPendingUser = true;
                    hasAssistantInPair = false;
                } else if (hasAssistantInPair) {
                    completed += 1;
                    activeTurnNum = completed + 1;
                    hasPendingUser = true;
                    hasAssistantInPair = false;
                }
                turnByIndex[i] = activeTurnNum;
            } else if (roleRaw === 'char' || roleRaw === 'assistant' || roleRaw === 'bot' || roleRaw === 'model') {
                if (!hasPendingUser) {
                    turnByIndex[i] = 0;
                } else {
                    hasAssistantInPair = true;
                    turnByIndex[i] = activeTurnNum;
                }
            }
        }
        if (hasPendingUser && hasAssistantInPair) completed += 1;
        return {
            completedTurns: completed,
            pendingTurn: (hasPendingUser && !hasAssistantInPair) ? activeTurnNum : 0,
            turnByIndex,
        };
    }

    function mergeConfig(saved) {
        if (!saved || typeof saved !== 'object') return structuredClone(DEFAULT_CONFIG);
        const merged = {
            antiFlicker: { ...DEFAULT_CONFIG.antiFlicker, ...(saved.antiFlicker || {}) },
            stealth: { ...DEFAULT_CONFIG.stealth, ...(saved.stealth || {}) },
            layout: { ...DEFAULT_CONFIG.layout, ...(saved.layout || {}) },
            theme: { ...DEFAULT_CONFIG.theme, ...(saved.theme || {}) },
        };
        // Migrate legacy stealth fields
        if (saved.stealth && typeof saved.stealth.hideChatAssets === 'boolean' && !saved.stealth.mode) {
            merged.stealth.mode = saved.stealth.hideChatAssets ? 'soft' : 'off';
        }
        if (merged.stealth.mode === 'full') {
            merged.stealth.mode = 'soft';
        }
        if (merged.theme.preset === 'epub-sepia-scroll') merged.theme.preset = 'epub-sepia';
        if (merged.theme.preset === 'epub-night-scroll') merged.theme.preset = 'epub-night';
        return merged;
    }

    async function loadConfig() {
        try {
            let raw = await risuai.pluginStorage.getItem(STORAGE_KEY);
            if (!raw) {
                raw = await risuai.pluginStorage.getItem(LEGACY_STORAGE_KEY);
            }
            if (raw) {
                const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                config = mergeConfig(parsed);
            }
        } catch (err) {
            console.warn('[RisuStand] 설정 불러오기 실패:', err);
        }
    }

    async function saveConfig() {
        try {
            await risuai.pluginStorage.setItem(STORAGE_KEY, JSON.stringify(config));
        } catch (err) {
            console.warn('[RisuStand] 설정 저장 실패:', err);
        }
    }

    async function ensureRootDocument() {
        if (rootDoc) return rootDoc;
        try {
            rootDoc = await risuai.getRootDocument();
            domPermissionGranted = Boolean(rootDoc);
        } catch (_) {
            domPermissionGranted = false;
            rootDoc = null;
        }
        return rootDoc;
    }

    async function upsertStyleTag(styleKey, cssText) {
        const doc = await ensureRootDocument();
        if (!doc) return false;

        const selector = `style[${STYLE_ATTR}="${styleKey}"]`;
        let styleEl = await doc.querySelector(selector);
        if (!cssText || !cssText.trim()) {
            if (styleEl) await styleEl.remove();
            return true;
        }

        if (!styleEl) {
            styleEl = await doc.createElement('style');
            await styleEl.setAttribute(STYLE_ATTR, styleKey);
            const head = await doc.querySelector('head');
            if (head) await head.appendChild(styleEl);
            else await doc.appendChild(styleEl);
        }
        await styleEl.setTextContent(cssText);
        return true;
    }

    // =========================================================================
    // 1. Draggable, Auto-Minimizing Top Bar with Eye Dropdown
    // =========================================================================
    function clearAutoMinimize() {
        if (autoMinimizeTimer) {
            clearTimeout(autoMinimizeTimer);
            autoMinimizeTimer = null;
        }
    }

    function scheduleAutoMinimize() {
        clearAutoMinimize();
        const sec = Math.max(2, Math.min(30, Number(config.layout.autoMinimizeSec) || 5));
        autoMinimizeTimer = setTimeout(async () => {
            if (!dragState && !topBarMinimized) {
                topBarMinimized = true;
                await syncTopBar();
            }
        }, sec * 1000);
    }

    async function removeTopBar() {
        if (!rootDoc) return;
        try {
            const existing = await rootDoc.querySelector(`[${SHELL_BAR_ATTR}="root"]`);
            if (existing) await existing.remove();
        } catch (_) {}
    }

    async function setupDragDocumentListeners() {
        if (!rootDoc) return;
        if (docMoveListenerId) {
            await rootDoc.removeEventListener('pointermove', docMoveListenerId);
            docMoveListenerId = null;
        }
        if (docUpListenerId) {
            await rootDoc.removeEventListener('pointerup', docUpListenerId);
            docUpListenerId = null;
        }

        docMoveListenerId = await rootDoc.addEventListener('pointermove', async (ev) => {
            const st = dragState;
            if (!st || !st.barEl) return;
            const dx = ev.clientX - st.startX;
            const dy = ev.clientY - st.startY;
            if (!st.moved && Math.hypot(dx, dy) > 5) {
                st.moved = true;
                clearAutoMinimize();
            }
            if (st.moved) {
                const newLeft = Math.max(8, Math.round(st.origLeft + dx));
                const newTop = Math.max(8, Math.round(st.origTop + dy));
                st.lastLeft = newLeft;
                st.lastTop = newTop;
                const now = Date.now();
                if (st.updating || (st.lastMoveAt && now - st.lastMoveAt < 16)) return;
                st.lastMoveAt = now;
                st.updating = true;
                const barEl = st.barEl;
                try {
                    // Single GPU-composited transform IPC call (zero layout reflow!)
                    if (!st.primed) {
                        st.primed = true;
                        await barEl.setStyleAttribute(`${st.baseStyle} left:0; top:0; transform:translate3d(${newLeft}px,${newTop}px,0);`);
                    } else {
                        await barEl.setStyle('transform', `translate3d(${newLeft}px,${newTop}px,0)`);
                    }
                } catch (_) {
                    // Ignore if bar was re-rendered or detached mid-drag
                } finally {
                    st.updating = false;
                }
            }
        });

        docUpListenerId = await rootDoc.addEventListener('pointerup', async () => {
            if (!dragState) return;
            const st = dragState;
            dragState = null;
            if (st.moved && typeof st.lastLeft === 'number') {
                config.layout.topBarPos = { x: st.lastLeft, y: st.lastTop };
                await saveConfig();
                if (!topBarMinimized) scheduleAutoMinimize();
            } else if (st.onTap) {
                await st.onTap();
            }
        });
    }

    async function syncTopBar() {
        const doc = await ensureRootDocument();
        if (!doc) return;

        const preset = PRESETS[config.theme.preset] || PRESETS['ai-gemini'];
        if (!config.layout.showFloatingTopBar || preset.useNativeDefault) {
            clearAutoMinimize();
            await removeTopBar();
            return;
        }

        const [_, bar, body] = await Promise.all([
            removeTopBar(),
            doc.createElement('div'),
            doc.querySelector('body'),
        ]);

        const isLight = preset.scheme && preset.scheme.type === 'light';
        const pillBg = isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)';
        const pillBorder = isLight ? 'rgba(0,0,0,0.13)' : 'rgba(255,255,255,0.14)';
        const textCol = preset.topBarText || '#e3e3e3';
        const barBg = preset.topBarBg || 'rgba(19, 19, 20, 0.90)';

        const pos = config.layout.topBarPos;
        const posStyle = pos
            ? `left:0; top:0; transform:translate3d(${pos.x}px,${pos.y}px,0);`
            : `left:50%; top:10px; transform:translateX(-50%);`;

        if (topBarMinimized) {
            const minBaseStyle =
                `position:fixed; z-index:46; display:flex; align-items:center; gap:5px; ` +
                `padding:4px 9px; border-radius:999px; background:${barBg}; color:${textCol}; ` +
                `border:1px solid ${pillBorder}; box-shadow:0 3px 10px rgba(0,0,0,0.20); ` +
                `font-size:11.5px; font-weight:700; cursor:grab; user-select:none; opacity:0.74; ` +
                `will-change:transform; font-family:system-ui,-apple-system,"Malgun Gothic",sans-serif;`;
            const stealthDot = config.stealth.mode !== 'off' ? ' 🕶️' : '';

            await Promise.all([
                bar.setAttribute(SHELL_BAR_ATTR, 'root'),
                bar.setStyleAttribute(`${minBaseStyle} ${posStyle}`),
                bar.setTextContent(`${preset.shortIcon || '✦'}${stealthDot}`),
                bar.addEventListener('pointerdown', async (ev) => {
                    const rect = await bar.getBoundingClientRect();
                    dragState = {
                        startX: ev.clientX,
                        startY: ev.clientY,
                        origLeft: rect.left,
                        origTop: rect.top,
                        moved: false,
                        primed: false,
                        baseStyle: minBaseStyle,
                        barEl: bar,
                        onTap: async () => {
                            topBarMinimized = false;
                            await syncTopBar();
                            scheduleAutoMinimize();
                        },
                    };
                }),
            ]);

            if (body) await body.appendChild(bar);
            else await doc.appendChild(bar);
            return;
        }

        const expBaseStyle =
            `position:fixed; z-index:46; display:flex; align-items:center; gap:6px; ` +
            `padding:5px 10px; border-radius:999px; background:${barBg}; color:${textCol}; ` +
            `border:1px solid ${pillBorder}; box-shadow:0 4px 14px rgba(0,0,0,0.24); ` +
            `font-size:12px; font-weight:600; user-select:none; will-change:transform; ` +
            `font-family:system-ui,-apple-system,"Malgun Gothic",sans-serif; max-width:calc(100vw - 16px); overflow-x:auto; scrollbar-width:none;`;

        const makePill = async (label, active, onClick) => {
            const btn = await doc.createElement('button');
            const bg = active ? (config.theme.accentColor || '#6366f1') : pillBg;
            const fg = active ? getContrastText(config.theme.accentColor || '#6366f1') : textCol;
            await Promise.all([
                btn.setStyleAttribute(
                    `border:1px solid ${pillBorder}; background:${bg}; color:${fg}; border-radius:999px; ` +
                    `padding:4px 9px; font-size:11.5px; font-weight:600; cursor:pointer; white-space:nowrap;`
                ),
                btn.setTextContent(label),
                btn.addEventListener('click', async () => {
                    scheduleAutoMinimize();
                    await onClick();
                }),
            ]);
            return btn;
        };

        const dragHandlePromise = (async () => {
            const dh = await doc.createElement('span');
            await Promise.all([
                dh.setStyleAttribute(
                    `display:flex; align-items:center; gap:5px; padding:2px 6px; cursor:grab; white-space:nowrap; opacity:0.9;`
                ),
                dh.setTextContent(`⠿ ${preset.brandTitle || 'AI'} ${preset.brandModel || ''}`.trim()),
                dh.addEventListener('pointerdown', async (ev) => {
                    const rect = await bar.getBoundingClientRect();
                    dragState = {
                        startX: ev.clientX,
                        startY: ev.clientY,
                        origLeft: rect.left,
                        origTop: rect.top,
                        moved: false,
                        primed: false,
                        baseStyle: expBaseStyle,
                        barEl: bar,
                        onTap: null,
                    };
                }),
            ]);
            return dh;
        })();

        const eyeLabel = config.stealth.mode !== 'off' ? '🕶️ 가리기 ON' : '👁️ 가리기 OFF';

        const [, , dragHandle, btnBottom, eyeBtn, btnZen, btnClone, btnStudio, btnMin] = await Promise.all([
            bar.setAttribute(SHELL_BAR_ATTR, 'root'),
            bar.setStyleAttribute(`${expBaseStyle} ${posStyle}`),
            dragHandlePromise,
            makePill('⬇', false, async () => {
                try {
                    const latestMsg = await doc.querySelector('.default-chat-screen .chat-message-container');
                    if (latestMsg) {
                        await latestMsg.scrollIntoView({ behavior: 'smooth', block: 'end' });
                    }
                } catch (_) {}
            }),
            makePill(eyeLabel, config.stealth.mode !== 'off', async () => {
                const next = config.stealth.mode === 'off' ? 'soft' : 'off';
                config.stealth.mode = next;
                config.stealth.hideSidebarAvatars = next !== 'off';
                saveConfig();
                await Promise.all([
                    upsertStyleTag('theme-layout-stealth', buildLayoutAndThemeCSS()),
                    syncTopBar(),
                ]);
                scheduleAutoMinimize();
            }),
            makePill(config.layout.zenMode ? '🧘 집중 ON' : '🧘 집중', config.layout.zenMode, async () => {
                config.layout.zenMode = !config.layout.zenMode;
                saveConfig();
                await Promise.all([
                    upsertStyleTag('theme-layout-stealth', buildLayoutAndThemeCSS()),
                    syncTopBar(),
                ]);
            }),
            makePill('🖥️ 공홈·EPUB', false, async () => {
                topBarMinimized = true;
                await syncTopBar();
                await openCloneView();
            }),
            makePill('🎨 테마', false, async () => {
                topBarMinimized = true;
                await syncTopBar();
                await openStudio();
            }),
            makePill('—', false, async () => {
                clearAutoMinimize();
                topBarMinimized = true;
                await syncTopBar();
            }),
        ]);

        for (const child of [dragHandle, btnBottom, eyeBtn, btnZen, btnClone, btnStudio, btnMin]) {
            await bar.appendChild(child);
        }

        if (body) await body.appendChild(bar);
        else await doc.appendChild(bar);
    }

    // =========================================================================
    // 2. Anti-Flicker Engine (position: fixed safe!)
    // =========================================================================
    function buildStabilityCSS() {
        if (!config.antiFlicker.enabled) return '';
        const fadeRule = config.antiFlicker.smoothFade
            ? `.default-chat-screen .chat-message-container .chattext { transition: opacity 140ms ease-out; }`
            : '';
        return `
            .default-chat-screen { overflow-anchor: auto !important; scroll-behavior: auto; }
            .default-chat-screen .chat-message-container { overflow-anchor: auto; }
            ${fadeRule}
        `;
    }

    let lastSnapshotAt = 0;
    let reapplyDebounceTimer = null;

    async function snapshotAndLockMessageHeights() {
        if (!config.antiFlicker.enabled || !rootDoc || currentIframeMode !== null) return;
        const now = Date.now();
        if (now - lastSnapshotAt < 250) return;
        lastSnapshotAt = now;

        try {
            const containersSafe = await rootDoc.querySelectorAll('.default-chat-screen .chat-message-container');
            const containers = await unwrapArray(containersSafe);
            if (!containers.length) return;

            // Batch-read clientHeight in parallel (avoids sequential IPC stalls)
            const measured = await Promise.all(containers.map((el) => el.clientHeight()));
            const heights = measured.map((h, i) => (h >= 48 ? h : (lastKnownHeights[i] || 0)));

            // Batch-write minHeight in parallel
            const writeJobs = [];
            for (let i = 0; i < containers.length; i++) {
                if (heights[i] >= 48) {
                    writeJobs.push(containers[i].setStyle('minHeight', `${heights[i]}px`));
                }
            }
            if (writeJobs.length) await Promise.all(writeJobs);

            if (config.antiFlicker.preserveScrollAnchor) {
                const screenEl = await rootDoc.querySelector('.default-chat-screen');
                const screenRect = screenEl ? await screenEl.getBoundingClientRect() : null;
                if (screenRect) {
                    const rects = await Promise.all(containers.map((el) => el.getBoundingClientRect()));
                    let bestIdx = -1;
                    let bestScore = Infinity;
                    for (let i = 0; i < rects.length; i++) {
                        if (measured[i] < 48) continue;
                        const rect = rects[i];
                        if (rect.bottom > screenRect.top && rect.top < screenRect.bottom) {
                            const dist = Math.abs(screenRect.bottom - rect.bottom);
                            if (dist < bestScore) {
                                bestScore = dist;
                                bestIdx = i;
                            }
                        }
                    }
                    if (bestIdx !== -1) lastAnchorIndex = bestIdx;
                }
            }

            if (heights.some((v) => v >= 48)) lastKnownHeights = heights;
            isLockActive = true;
            if (lockReleaseTimer) clearTimeout(lockReleaseTimer);
            const lockDuration = Math.max(300, Math.min(3000, Number(config.antiFlicker.lockMs) || 850));
            lockReleaseTimer = setTimeout(() => { releaseMessageHeightLocks(); }, lockDuration);
        } catch (_) {}
    }

    function scheduleReapplyLocks() {
        if (!isLockActive || reapplyDebounceTimer) return;
        reapplyDebounceTimer = setTimeout(async () => {
            reapplyDebounceTimer = null;
            await reapplyLocksToNewNodes();
        }, 120);
    }

    async function reapplyLocksToNewNodes() {
        if (!isLockActive || !config.antiFlicker.enabled || !rootDoc || !lastKnownHeights.length) return;
        try {
            const containersSafe = await rootDoc.querySelectorAll('.default-chat-screen .chat-message-container');
            const containers = await unwrapArray(containersSafe);
            const jobs = [];
            for (let i = 0; i < containers.length && i < lastKnownHeights.length; i++) {
                if (lastKnownHeights[i] >= 48) {
                    jobs.push(containers[i].setStyle('minHeight', `${lastKnownHeights[i]}px`));
                }
            }
            if (jobs.length) await Promise.all(jobs);
        } catch (_) {}
    }

    async function releaseMessageHeightLocks() {
        isLockActive = false;
        lockReleaseTimer = null;
        if (reapplyDebounceTimer) {
            clearTimeout(reapplyDebounceTimer);
            reapplyDebounceTimer = null;
        }
        if (!rootDoc) return;
        try {
            const containersSafe = await rootDoc.querySelectorAll('.default-chat-screen .chat-message-container');
            const containers = await unwrapArray(containersSafe);
            await Promise.all(containers.map((el) => el.setStyle('minHeight', '')));
            if (config.antiFlicker.preserveScrollAnchor && lastAnchorIndex >= 0 && lastAnchorIndex < containers.length) {
                const screenEl = await rootDoc.querySelector('.default-chat-screen');
                if (screenEl) {
                    const screenRect = await screenEl.getBoundingClientRect();
                    const anchorRect = await containers[lastAnchorIndex].getBoundingClientRect();
                    if (anchorRect.bottom < screenRect.top + 20 || anchorRect.top > screenRect.bottom - 20) {
                        await containers[lastAnchorIndex].scrollIntoView({ behavior: 'instant', block: 'nearest' });
                    }
                }
            }
        } catch (_) {}
    }

    async function setupAntiFlickerEngine() {
        await upsertStyleTag('anti-flicker', buildStabilityCSS());
        if (!rootDoc) return;

        if (pointerListenerId) {
            await rootDoc.removeEventListener('pointerdown', pointerListenerId);
            pointerListenerId = null;
        }
        if (mutationObserver) {
            await mutationObserver.disconnect();
            mutationObserver = null;
        }
        if (!config.antiFlicker.enabled) return;

        pointerListenerId = await rootDoc.addEventListener('pointerdown', async () => {
            await snapshotAndLockMessageHeights();
        }, { capture: true });

        mutationObserver = await risuai.createMutationObserver(() => {
            if (isLockActive) scheduleReapplyLocks();
        });

        const targetEl = (await rootDoc.querySelector('.default-chat-screen')) || (await rootDoc.querySelector('body'));
        if (targetEl) {
            await mutationObserver.observe(targetEl, { childList: true, subtree: false });
        }
    }

    // =========================================================================
    // 3. Layout Overhaul + Stealth (Soft / Full) + Theme CSS (position: fixed safe!)
    // =========================================================================
    function buildLayoutAndThemeCSS() {
        const t = config.theme;
        const l = config.layout;
        const s = config.stealth;
        const preset = PRESETS[t.preset] || PRESETS['ai-gemini'];
        if (preset.useNativeDefault && !t.customCSS.trim() && !l.zenMode && s.mode === 'off') {
            return '';
        }

        const rgb = preset.cardBgRgb || '20, 27, 46';
        const alpha = Math.max(0, Math.min(1, Number(t.surfaceAlpha)));
        const radius = Math.max(0, Math.min(28, Number(t.bubbleRadius)));
        const maxWidth = Math.max(560, Math.min(1200, Number(t.chatMaxWidth) || 780));
        const fontSize = Math.max(12, Math.min(22, Number(t.fontSize) || 15));
        const lineHeight = Math.max(1.2, Math.min(2.4, Number(t.lineHeight) || 1.75));
        const accent = t.accentColor || '#8ab4f8';
        const borderCol = preset.borderColor || 'rgba(255, 255, 255, 0.10)';
        const dividerCol = preset.dividerColor || 'rgba(128, 128, 128, 0.12)';
        const fontStack = (FONT_STACKS[t.fontFamily] || FONT_STACKS.inherit).css;
        const badgeBg = preset.badgeBg || accent;
        const isEpub = t.bubbleStyle === 'epub';
        const isChatbot = t.bubbleStyle === 'chatbot';

        let css = '';

        if (l.zenMode) {
            css += `.rs-sidebar { display: none !important; }`;
        }
        if (l.sidebarRight) {
            css += `main > div.w-full.h-full.flex, main.flex { flex-direction: row-reverse !important; }`;
        }

        // Floating Capsule Input Dock
        if (l.floatingCapsuleInput && !preset.useNativeDefault) {
            const inBg = preset.inputBg || `rgba(${rgb}, 0.92)`;
            const inBorder = preset.inputBorder || borderCol;
            css += `
                .default-chat-screen > div:first-child {
                    max-width: ${maxWidth}px !important;
                    width: calc(100% - 28px) !important;
                    margin: 10px auto 16px auto !important;
                    padding: 6px 8px !important;
                    background: ${inBg} !important;
                    border: 1px solid ${inBorder} !important;
                    border-radius: ${Math.max(radius, 22)}px !important;
                    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18) !important;
                    align-items: center !important;
                }
                .default-chat-screen > div:first-child .text-input-area {
                    border: none !important;
                    background: transparent !important;
                    margin-left: 6px !important;
                    padding: 8px 10px !important;
                    font-size: 15px !important;
                    box-shadow: none !important;
                }
            `;
        }

        if (l.hoverActionsOnly) {
            css += `
                .default-chat-screen .risu-chat .button-icon-tray,
                .default-chat-screen .risu-chat button.text-textcolor2 {
                    opacity: 0.12;
                    transition: opacity 160ms ease;
                }
                .default-chat-screen .risu-chat:hover .button-icon-tray,
                .default-chat-screen .risu-chat:hover button.text-textcolor2 {
                    opacity: 1;
                }
            `;
        }

        if (l.customScrollbar) {
            css += `
                .default-chat-screen::-webkit-scrollbar { width: 7px; }
                .default-chat-screen::-webkit-scrollbar-track { background: transparent; }
                .default-chat-screen::-webkit-scrollbar-thumb { background: ${borderCol}; border-radius: 999px; }
                .default-chat-screen ::selection { background: ${accent}44; }
            `;
        }

        if (preset.bgGradient) {
            css += `.default-chat-screen { background: ${preset.bgGradient} !important; background-attachment: fixed !important; }`;
        }

        if (isChatbot) {
            css += `
                .default-chat-screen .risu-chat {
                    background: transparent !important;
                    border: none !important;
                    border-bottom: 1px solid ${dividerCol} !important;
                    border-radius: 0 !important;
                    box-shadow: none !important;
                    margin: 0 auto !important;
                    padding: 18px 20px !important;
                    max-width: ${maxWidth}px !important;
                    width: 100% !important;
                }
            `;
        } else if (isEpub) {
            css += `
                .default-chat-screen .risu-chat {
                    background: rgba(${rgb}, ${Math.max(alpha, 0.94)}) !important;
                    border-left: 1px solid ${borderCol} !important;
                    border-right: 1px solid ${borderCol} !important;
                    border-bottom: 1px solid ${dividerCol} !important;
                    border-radius: 0 !important;
                    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
                    margin: 0 auto !important;
                    padding: 22px 40px !important;
                    max-width: ${maxWidth}px !important;
                    width: calc(100% - 24px) !important;
                }
                @media (max-width: 640px) {
                    .default-chat-screen .risu-chat { padding: 18px 20px !important; width: 100% !important; }
                }
            `;
        } else if (t.bubbleStyle === 'glass') {
            css += `
                .default-chat-screen .risu-chat {
                    background: linear-gradient(145deg, rgba(${rgb}, ${Math.min(0.95, alpha + 0.08)}), rgba(${rgb}, ${alpha})) !important;
                    border: 1px solid ${borderCol} !important;
                    border-radius: ${radius}px !important;
                    box-shadow: inset 0 1px 0 rgba(255,255,255,0.07), 0 4px 14px rgba(0,0,0,0.18);
                    margin: 10px auto !important;
                    padding: 18px 22px !important;
                    max-width: ${maxWidth}px !important;
                    width: calc(100% - 24px) !important;
                }
            `;
        } else if (t.bubbleStyle === 'card') {
            css += `
                .default-chat-screen .risu-chat {
                    background: rgba(${rgb}, ${Math.max(alpha, 0.85)}) !important;
                    border: 1px solid ${borderCol} !important;
                    border-radius: ${radius}px !important;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.14);
                    margin: 10px auto !important;
                    padding: 18px 22px !important;
                    max-width: ${maxWidth}px !important;
                    width: calc(100% - 24px) !important;
                }
            `;
        } else if (t.bubbleStyle === 'flat') {
            css += `
                .default-chat-screen .risu-chat {
                    background: rgba(${rgb}, ${alpha}) !important;
                    border-left: 3px solid ${accent} !important;
                    border-radius: ${radius}px !important;
                    margin: 8px auto !important;
                    padding: 14px 20px !important;
                    max-width: ${maxWidth}px !important;
                    width: calc(100% - 24px) !important;
                }
            `;
        }

        if (l.compactHeaders) {
            css += `
                .default-chat-screen .risu-chat .chat-width.text-xl {
                    font-size: 0.86rem !important;
                    font-weight: 600 !important;
                    opacity: 0.72;
                    margin-bottom: 4px !important;
                }
            `;
        }

        const fontRule = fontStack !== 'inherit' ? `font-family: ${fontStack} !important;` : '';
        const justifyRule = t.justifyText ? 'text-align: justify; text-justify: inter-word;' : '';
        const pGap = isEpub ? '0.9em' : isChatbot ? '0.72em' : '0.55em';

        css += `
            .default-chat-screen .chattext {
                ${fontRule}
                font-size: ${fontSize}px !important;
                line-height: ${lineHeight} !important;
                letter-spacing: ${isEpub ? '-0.015em' : '-0.01em'};
                word-break: keep-all;
                overflow-wrap: break-word;
                -webkit-font-smoothing: antialiased;
            }
            .default-chat-screen .chattext p {
                margin-top: ${pGap};
                margin-bottom: ${pGap};
                ${justifyRule}
            }
        `;

        // Stealth Mode: Hide images/assets (and empty image border wrappers) & replace avatars with AI badge
        if (s.mode !== 'off') {
            css += `
                .default-chat-screen .chattext img,
                .default-chat-screen .chattext video,
                .default-chat-screen .chattext picture,
                .default-chat-screen .chattext canvas,
                .default-chat-screen .chattext figure,
                .default-chat-screen .root-loaded-image,
                .default-chat-screen .chattext div:has(> img:only-child) {
                    display: none !important;
                }
                .default-chat-screen .chattext [style*="background-image"] {
                    background-image: none !important;
                }
                .default-chat-screen + div img,
                .default-chat-screen + div video,
                .default-chat-screen + div [style*="background-image"] {
                    display: none !important;
                    background-image: none !important;
                }
                .default-chat-screen .risu-chat > div > .shadow-lg.bg-textcolor2 {
                    background-image: none !important;
                    background: ${badgeBg} !important;
                    width: 28px !important;
                    height: 28px !important;
                    min-width: 28px !important;
                    min-height: 28px !important;
                    border-radius: 9999px !important;
                    box-shadow: none !important;
                    margin-top: 2px !important;
                    opacity: 0.92 !important;
                }
            `;
        }

        if (s.hideSidebarAvatars || s.mode !== 'off') {
            css += `
                .avatar img,
                .avatar [style*="background-image"] {
                    opacity: 0 !important;
                    background-image: none !important;
                }
                .avatar {
                    background: ${badgeBg} !important;
                    border-radius: 9999px !important;
                }
            `;
        }

        // 8) WCAG Contrast Guard for RisuAI Alerts, Modals & Hardcoded Tailwind Classes
        if (preset.scheme && preset.scheme.type === 'light') {
            css += `
                .bg-darkbg .text-gray-100,
                .bg-darkbg .text-gray-200,
                .bg-darkbg .text-gray-300,
                .bg-bgcolor .text-gray-100,
                .bg-bgcolor .text-gray-200,
                .bg-bgcolor .text-gray-300,
                .bg-selected .text-gray-100,
                .bg-selected .text-gray-200,
                .bg-selected .text-gray-300,
                .bg-darkbg .text-white,
                .bg-bgcolor .text-white {
                    color: ${preset.scheme.textcolor} !important;
                }
                .bg-darkbg .text-gray-400,
                .bg-darkbg .text-gray-500,
                .bg-bgcolor .text-gray-400,
                .bg-bgcolor .text-gray-500,
                .bg-selected .text-gray-400,
                .bg-selected .text-gray-500 {
                    color: ${preset.scheme.textcolor2} !important;
                }
                .bg-blue-500, .bg-blue-600, .bg-red-500, .bg-red-600,
                .bg-green-500, .bg-green-600, .bg-indigo-500, .bg-indigo-600,
                .bg-blue-500 *, .bg-blue-600 *, .bg-red-500 *, .bg-red-600 *,
                .bg-green-500 *, .bg-green-600 *, .bg-indigo-500 *, .bg-indigo-600 * {
                    color: #ffffff !important;
                }
                .z-1100 > .bg-darkbg {
                    border: 1px solid ${preset.scheme.borderc} !important;
                    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25) !important;
                }
                .default-chat-screen .chattext {
                    color: ${preset.scheme.textcolor};
                }
            `;
        } else if (preset.scheme && preset.scheme.type === 'dark') {
            css += `
                .z-1100 > .bg-darkbg {
                    border: 1px solid ${preset.scheme.borderc} !important;
                    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55) !important;
                }
                .z-1100 > .bg-darkbg .text-gray-300,
                .z-1100 > .bg-darkbg .text-gray-200 {
                    color: ${preset.scheme.textcolor} !important;
                }
                .z-1100 > .bg-darkbg .text-gray-500,
                .z-1100 > .bg-darkbg .text-gray-400 {
                    color: ${preset.scheme.textcolor2} !important;
                }
                .default-chat-screen .chattext {
                    color: ${preset.scheme.textcolor};
                }
            `;
        }

        css += `\n${t.customCSS || ''}`;
        return css;
    }

    async function applyAll() {
        const t = config.theme;
        const preset = PRESETS[t.preset] || PRESETS['ai-gemini'];

        try {
            if (preset.useNativeDefault) {
                await risuai.changeColorScheme('default');
                await risuai.changeTextTheme('standard');
            } else {
                if (preset.scheme) await risuai.setColorScheme(preset.scheme);
                if (preset.textTheme) {
                    await risuai.setCustomTextTheme({
                        ...preset.textTheme,
                        FontColorQuote1: t.quoteColor || preset.textTheme.FontColorQuote1,
                    });
                }
            }
        } catch (err) {
            console.warn('[RisuStand] 네이티브 테마 적용 오류:', err);
        }

        await upsertStyleTag('theme-layout-stealth', buildLayoutAndThemeCSS());
        await syncTopBar();
        await updateQuickButtons();
    }

    // =========================================================================
    // 4. Fullscreen Clone & 2-Page EPUB Book Reader (Preserves HUDs & Assets, Hides CoT!)
    // =========================================================================
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // Shared chrome for the plugin's own settings panels (Studio, Remote Bridge).
    // Dark glass base, tinted by the active preset's accent so each theme feels native.
    function buildPanelChromeCSS() {
        const preset = PRESETS[config.theme.preset] || PRESETS['ai-gemini'];
        const acc = /^#[0-9a-f]{6}$/i.test(config.theme.accentColor || '')
            ? config.theme.accentColor
            : (preset.defaults && preset.defaults.accentColor) || '#818cf8';
        return `
            :root {
                --acc: ${acc}; --on-acc: ${getContrastText(acc)};
                --acc-soft: color-mix(in srgb, ${acc} 16%, transparent);
                --acc-line: color-mix(in srgb, ${acc} 55%, transparent);
                --bg0: #0c0e14; --bg1: #12151d; --bg2: #181c26; --bg3: #20252f;
                --line: rgba(255, 255, 255, 0.08); --line2: rgba(255, 255, 255, 0.14);
                --tx: #eceff6; --tx2: #a3abbe; --tx3: #737c90;
                --ok: #4ade80; --warn: #fbbf24;
                color-scheme: dark;
            }
            * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif; -webkit-tap-highlight-color: transparent; }
            html { margin: 0; padding: 0; width: 100%; height: 100%; background: transparent !important; }
            body {
                margin: 0; padding: 0; width: 100%; height: 100%; color: var(--tx);
                background: rgba(6, 8, 12, 0.72);
                -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
                -webkit-font-smoothing: antialiased;
            }
            button { font-family: inherit; }
            :focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
            * { scrollbar-width: thin; scrollbar-color: var(--bg3) transparent; }
            ::-webkit-scrollbar { width: 8px; height: 8px; }
            ::-webkit-scrollbar-thumb { background: var(--bg3); border-radius: 8px; }
            input[type="checkbox"] {
                -webkit-appearance: none; appearance: none; flex-shrink: 0; cursor: pointer; margin: 0;
                width: 42px; height: 24px; border-radius: 999px; position: relative;
                background: var(--bg3); border: 1px solid var(--line2);
                transition: background 160ms ease, border-color 160ms ease;
            }
            input[type="checkbox"]::after {
                content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
                background: #cfd5e3; box-shadow: 0 1px 3px rgba(0,0,0,0.4); transition: transform 160ms ease, background 160ms ease;
            }
            input[type="checkbox"]:checked { background: var(--acc); border-color: var(--acc); }
            input[type="checkbox"]:checked::after { transform: translateX(18px); background: var(--on-acc); }
            input[type="range"] { accent-color: var(--acc); height: 22px; cursor: pointer; }
            select, textarea, input[type="text"], input[type="password"], input[type="number"] {
                width: 100%; background: var(--bg0); color: var(--tx); border: 1px solid var(--line2); border-radius: 10px;
                padding: 9px 11px; font-size: 13.5px; outline: none; transition: border-color 140ms ease, box-shadow 140ms ease;
            }
            select:focus, textarea:focus, input[type="text"]:focus, input[type="password"]:focus, input[type="number"]:focus {
                border-color: var(--acc); box-shadow: 0 0 0 3px var(--acc-soft);
            }
            @media (pointer: coarse) {
                select, textarea, input[type="text"], input[type="password"], input[type="number"] { font-size: 16px; }
            }
            .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 16px; min-height: 38px; border-radius: 10px; border: 1px solid transparent; font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap; transition: filter 140ms ease, background 140ms ease, transform 100ms ease; }
            .btn:active { transform: scale(0.97); }
            .btn-primary { background: var(--acc); color: var(--on-acc); }
            .btn-primary:hover { filter: brightness(1.08); }
            .btn-ghost { background: var(--bg2); color: var(--tx); border-color: var(--line2); }
            .btn-ghost:hover { background: var(--bg3); }
        `;
    }

    function getContrastText(hex) {
        if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) return '#ffffff';
        const clean = hex.replace('#', '');
        const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
        const r = parseInt(full.slice(0, 2), 16);
        const g = parseInt(full.slice(2, 4), 16);
        const b = parseInt(full.slice(4, 6), 16);
        if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return '#ffffff';
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return lum > 0.62 ? '#111318' : '#ffffff';
    }

    function stripThinkingFromRaw(raw) {
        if (!raw) return '';
        return String(raw)
            .replace(/<!--\s*HAYAKU[\s\S]*?-->/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
            .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
            .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
            .trim();
    }

    function cleanRenderedHtml(html, { hideAssets, fullHide }) {
        if (!html) return '';
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // 1) Remove all CoT / Thinking blocks (<details> whose summary indicates thought/CoT, or raw tags)
        doc.querySelectorAll('details').forEach((det) => {
            const sum = det.querySelector('summary');
            const sumText = (sum ? sum.textContent : '').trim().toLowerCase();
            if (
                sumText.includes('thought') ||
                sumText.includes('think') ||
                sumText.includes('추론') ||
                sumText.includes('생각') ||
                sumText.includes('cot') ||
                sumText.includes('reason')
            ) {
                det.remove();
            }
        });
        doc.querySelectorAll('thoughts, think, thinking, thought, reasoning').forEach((el) => el.remove());

        // 2) Never allow position: fixed widgets inside clone/EPUB iframe to cover the reader UI
        doc.querySelectorAll('[style*="position: fixed"], [style*="position:fixed"]').forEach((el) => {
            el.style.position = 'static';
        });

        // 3) Asset visibility handling
        if (hideAssets || fullHide) {
            doc.querySelectorAll('img, video, picture, canvas, figure').forEach((el) => el.remove());
            doc.querySelectorAll('[style*="background-image"]').forEach((el) => {
                el.style.backgroundImage = 'none';
            });
        } else {
            doc.querySelectorAll('img, picture, figure').forEach((el) => {
                if (el.style && el.style.display === 'none') el.style.display = '';
            });
        }
        if (fullHide) {
            doc.querySelectorAll('table, [class*="hud"], [class*="HUD"], [class*="status"], [class*="card"]').forEach((el) => el.remove());
        }

        // Remove scripts, inline event handlers, and unsafe URL schemes for safety
        doc.querySelectorAll('script').forEach((el) => el.remove());
        doc.querySelectorAll('*').forEach((el) => {
            for (const attr of Array.from(el.attributes)) {
                const name = attr.name.toLowerCase();
                if (name.startsWith('on')) {
                    el.removeAttribute(attr.name);
                } else if (name === 'href' || name === 'src' || name === 'xlink:href') {
                    const val = String(attr.value || '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
                    if (val.startsWith('javascript:') || val.startsWith('vbscript:') || val.startsWith('data:text/html')) {
                        el.removeAttribute(attr.name);
                    }
                }
            }
        });

        return doc.body.innerHTML.trim();
    }

    const iframeAssetDataCache = new Map(); // assetPath -> blob:/data:... (capped at 60)
    const iframeInlayDataCache = new Map(); // inlayId -> data:<mime>;base64,... (capped at 40)

    function cacheSetBounded(map, key, value, maxEntries, onEvict) {
        if (map.has(key)) map.delete(key);
        while (map.size >= maxEntries) {
            const oldestKey = map.keys().next().value;
            const oldestVal = map.get(oldestKey);
            map.delete(oldestKey);
            if (onEvict) onEvict(oldestVal, oldestKey);
        }
        map.set(key, value);
    }

    function revokeBlobIfNeeded(url) {
        if (typeof url === 'string' && url.startsWith('blob:')) {
            try { URL.revokeObjectURL(url); } catch (_) {}
        }
    }

    function clearIframeCaches() {
        for (const url of iframeAssetDataCache.values()) revokeBlobIfNeeded(url);
        iframeAssetDataCache.clear();
        for (const url of iframeInlayDataCache.values()) revokeBlobIfNeeded(url);
        iframeInlayDataCache.clear();
    }

    async function getIframeDataUrlForInlay(inlayId) {
        if (!inlayId) return null;
        if (iframeInlayDataCache.has(inlayId)) {
            return iframeInlayDataCache.get(inlayId);
        }
        try {
            if (typeof risuai.readInlay !== 'function') return null;
            const res = await risuai.readInlay(inlayId);
            if (res && res.data && String(res.data).startsWith('data:')) {
                cacheSetBounded(iframeInlayDataCache, inlayId, res.data, 40, revokeBlobIfNeeded);
                return res.data;
            }
        } catch (_) {}
        return null;
    }

    function detectImageMime(bytes, assetPath) {
        if (bytes && bytes.length >= 12) {
            if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
            if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
            if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
            if (
                bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
                bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
            ) return 'image/webp';
            if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'image/avif';
        }
        const lower = String(assetPath || '').toLowerCase();
        if (lower.endsWith('.png')) return 'image/png';
        if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
        if (lower.endsWith('.gif')) return 'image/gif';
        if (lower.endsWith('.avif')) return 'image/avif';
        return 'image/webp';
    }

    function uint8ToBase64(bytes) {
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    async function getIframeDataUrlForAsset(assetPath) {
        if (!assetPath) return null;
        if (iframeAssetDataCache.has(assetPath)) {
            return iframeAssetDataCache.get(assetPath);
        }
        try {
            const raw = await risuai.readImage(assetPath);
            if (!raw) return null;
            const bytes = raw instanceof Uint8Array
                ? raw
                : ArrayBuffer.isView(raw)
                ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
                : raw instanceof ArrayBuffer
                ? new Uint8Array(raw)
                : new Uint8Array(Object.values(raw));
            if (!bytes.length) return null;
            const mime = detectImageMime(bytes, assetPath);
            let url = null;
            try {
                const blob = new Blob([bytes], { type: mime });
                url = URL.createObjectURL(blob);
            } catch (_) {
                url = `data:${mime};base64,${uint8ToBase64(bytes)}`;
            }
            cacheSetBounded(iframeAssetDataCache, assetPath, url, 60, revokeBlobIfNeeded);
            return url;
        } catch (err) {
            console.warn('[RisuStand] readImage 실패:', assetPath, err);
            return null;
        }
    }

    function buildAssetLookup(charObj) {
        const list = [];
        const pushAsset = (name, path) => {
            if (name && path) {
                list.push({ name: String(name).trim().toLowerCase(), path: String(path).trim() });
            }
        };
        if (charObj && Array.isArray(charObj.additionalAssets)) {
            for (const a of charObj.additionalAssets) {
                if (Array.isArray(a)) pushAsset(a[0], a[1]);
            }
        }
        if (charObj && Array.isArray(charObj.emotionImages)) {
            for (const e of charObj.emotionImages) {
                if (Array.isArray(e)) pushAsset(e[0], e[1]);
            }
        }
        const exact = new Map(list.map((item) => [item.name, item.path]));
        const findPath = (rawName) => {
            if (!rawName) return null;
            const key = String(rawName).trim().toLowerCase();
            if (!key) return null;
            if (exact.has(key)) return exact.get(key);
            const noExt = key.replace(/\.[a-z0-9]{2,5}$/i, '');
            if (exact.has(noExt)) return exact.get(noExt);
            for (const item of list) {
                const itemNoExt = item.name.replace(/\.[a-z0-9]{2,5}$/i, '');
                if (itemNoExt === noExt || item.name.startsWith(noExt + '.')) {
                    return item.path;
                }
            }
            // Normalized fallback (ignores _, -, spaces, extension)
            const norm = (s) => s.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\s_\-]+/g, '').toLowerCase();
            const normKey = norm(key);
            if (normKey.length >= 2) {
                for (const item of list) {
                    if (norm(item.name) === normKey) return item.path;
                }
                for (const item of list) {
                    if (norm(item.name).includes(normKey) || normKey.includes(norm(item.name))) {
                        return item.path;
                    }
                }
            }
            return null;
        };
        return { findPath };
    }

    function extractRawAssetNames(rawMsg) {
        if (!rawMsg) return [];
        const text = String(rawMsg);
        const patterns = [
            /\{\{(?:img|raw|asset|image|emotion)::([^}]+)\}\}/gi,
            /<img\s*=\s*["']?([^"'\s>]+)["']?\s*\/?>/gi,
            /<img[^>]+src\s*=\s*["']([^"']+)["']/gi,
            /!\[[^\]]*\]\(([^)\s]+)\)/gi,
            /\[(?:img|image)\s*[:=]\s*([^\]]+)\]/gi,
        ];
        const matches = [];
        for (const re of patterns) {
            let m;
            while ((m = re.exec(text)) !== null) {
                const val = (m[1] || '').trim();
                if (val && !val.startsWith('http://') && !val.startsWith('https://') && !val.startsWith('data:')) {
                    matches.push({ idx: m.index, val });
                }
            }
        }
        matches.sort((a, b) => a.idx - b.idx);
        return matches.map((m) => m.val);
    }

    async function rehydrateBlockedImagesInHtml(html, rawMsg, assetLookup) {
        if (!html) return html;
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const rawNames = extractRawAssetNames(rawMsg);
        let rawCursor = 0;

        const isBlockedSrc = (s) => {
            if (!s) return true;
            const low = s.toLowerCase();
            return (
                low.startsWith('blob:') ||
                low.startsWith('asset:') ||
                low.startsWith('tauri:') ||
                low.startsWith('file:') ||
                low.includes('asset.localhost') ||
                low.includes('tauri.localhost') ||
                low.startsWith('http://localhost') ||
                low.startsWith('http://127.0.0.1') ||
                (!low.startsWith('http://') && !low.startsWith('https://') && !low.startsWith('data:'))
            );
        };

        const extractAssetPathFromTauriUrl = (s) => {
            if (!s) return null;
            try {
                const decoded = decodeURIComponent(s).replace(/\\/g, '/');
                const m = decoded.match(/(assets\/[^/?#]+)$/i);
                if (m) return m[1];
            } catch (_) {}
            return null;
        };

        const resolveNext = async (candidates, rawUrl) => {
            const directPath = extractAssetPathFromTauriUrl(rawUrl);
            if (directPath) {
                const directData = await getIframeDataUrlForAsset(directPath);
                if (directData) return directData;
            }
            for (const cand of candidates) {
                const assetPath = assetLookup.findPath(cand);
                if (assetPath) {
                    const dataUrl = await getIframeDataUrlForAsset(assetPath);
                    if (dataUrl) return dataUrl;
                }
            }
            return null;
        };

        let rehydratedAssetCount = 0;

        // 1) Rehydrate <img> tags
        const imgs = Array.from(doc.querySelectorAll('img'));
        for (const img of imgs) {
            const srcAttr = (img.getAttribute('src') || '').trim();
            if (!isBlockedSrc(srcAttr)) {
                continue;
            }
            const candidates = [];
            if (srcAttr && !srcAttr.includes(':')) candidates.push(srcAttr);
            const altAttr = (img.getAttribute('alt') || '').trim();
            if (altAttr) candidates.push(altAttr);
            if (rawCursor < rawNames.length) {
                candidates.push(rawNames[rawCursor]);
                rawCursor += 1;
            }
            const dataUrl = await resolveNext(candidates, srcAttr);
            if (dataUrl) {
                img.setAttribute('src', dataUrl);
                img.removeAttribute('noimage');
                img.style.display = 'block';
                img.setAttribute('decoding', 'async');
                rehydratedAssetCount += 1;
            }
        }

        // 2) Rehydrate CSS background-image: url(blob:/asset:/...) elements
        const bgEls = Array.from(doc.querySelectorAll('[style*="background-image"], [style*="background:"]'));
        for (const el of bgEls) {
            const st = el.getAttribute('style') || '';
            const m = st.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i);
            if (!m) continue;
            const urlVal = m[1].trim();
            if (!isBlockedSrc(urlVal)) {
                continue;
            }
            const candidates = [];
            if (!urlVal.includes(':')) candidates.push(urlVal);
            if (rawCursor < rawNames.length) {
                candidates.push(rawNames[rawCursor]);
                rawCursor += 1;
            }
            const dataUrl = await resolveNext(candidates, urlVal);
            if (dataUrl) {
                // Convert CSS background-image asset into a real <img> so it never collapses to height:0px
                el.style.backgroundImage = 'none';
                const realImg = doc.createElement('img');
                realImg.setAttribute('src', dataUrl);
                realImg.setAttribute('alt', candidates[0] || 'asset');
                realImg.style.display = 'block';
                realImg.setAttribute('decoding', 'async');
                el.appendChild(realImg);
                rehydratedAssetCount += 1;
            }
        }

        // 2.5) Rehydrate blocked url(...) inside inline <style> blocks
        const styleEls = Array.from(doc.querySelectorAll('style'));
        for (const stEl of styleEls) {
            let cssTxt = stEl.textContent || '';
            const urlMatches = Array.from(cssTxt.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi));
            let changed = false;
            for (const um of urlMatches) {
                const rawUrl = (um[1] || '').trim();
                if (!isBlockedSrc(rawUrl)) continue;
                const candidates = [];
                if (!rawUrl.includes(':')) candidates.push(rawUrl);
                if (rawCursor < rawNames.length) {
                    candidates.push(rawNames[rawCursor]);
                    rawCursor += 1;
                }
                const dataUrl = await resolveNext(candidates, rawUrl);
                if (dataUrl) {
                    cssTxt = cssTxt.replace(um[0], `url("${dataUrl}")`);
                    changed = true;
                }
            }
            if (changed) stEl.textContent = cssTxt;
        }

        // 3) Guaranteed fallback: if rawMsg referenced character assets that weren't rehydrated in DOM, inject them cleanly
        if (rehydratedAssetCount === 0 && rawNames.length > 0) {
            for (const name of rawNames.slice(0, 3)) {
                const assetPath = assetLookup.findPath(name);
                if (!assetPath) continue;
                const dataUrl = await getIframeDataUrlForAsset(assetPath);
                if (dataUrl) {
                    const fallbackImg = doc.createElement('img');
                    fallbackImg.setAttribute('src', dataUrl);
                    fallbackImg.setAttribute('alt', name);
                    fallbackImg.setAttribute('decoding', 'async');
                    doc.body.insertBefore(fallbackImg, doc.body.firstChild);
                }
            }
        }

        return doc.body.innerHTML;
    }

    async function collectMessagesForReader(modeKey) {
        const isEpub = Boolean(PRESETS[modeKey]?.isEpub);
        const fullHide = false;
        const hideAssets = isEpub
            ? !config.layout.epubShowAssets
            : (config.stealth.mode !== 'off' || Boolean(PRESETS[modeKey]?.isChatbot));

        // Map rendered HTML directly from RisuAI's live DOM so Status HUDs & Image Assets stay intact!
        const renderedMap = new Map();
        if (rootDoc) {
            try {
                const containersSafe = await rootDoc.querySelectorAll('.default-chat-screen .chat-message-container');
                const containers = await unwrapArray(containersSafe);
                // Chats.svelte uses flex-col-reverse, so containers[0] is latest message
                // Batch-read .chattext innerHTML in parallel (reduces IPC round-trips from ~60 to 2!)
                const textEls = await Promise.all(containers.map((c) => c.querySelector('.chattext')));
                const htmls = await Promise.all(textEls.map((t) => (t ? t.getInnerHTML() : Promise.resolve(null))));
                for (let i = 0; i < htmls.length; i++) {
                    if (htmls[i]) renderedMap.set(i, htmls[i]);
                }
            } catch (_) {}
        }

        let rawMessages = [];
        let charObj = null;
        try {
            const charIdx = await risuai.getCurrentCharacterIndex();
            const chatIdx = await risuai.getCurrentChatIndex();
            charObj = await risuai.getCharacter();
            if (charIdx >= 0 && chatIdx >= 0) {
                const chatObj = await risuai.getChatFromIndex(charIdx, chatIdx);
                if (chatObj && Array.isArray(chatObj.message)) {
                    rawMessages = chatObj.message;
                }
            }
        } catch (_) {}
        const assetLookup = buildAssetLookup(charObj);

        const total = rawMessages.length;
        const startIdx = Math.max(0, total - 30);
        const items = [];

        for (let idx = startIdx; idx < total; idx++) {
            const m = rawMessages[idx];
            const reverseIdx = total - 1 - idx;
            let html = '';

            // Use RisuAI's live rendered HTML (preserves all bot Display-Regex status windows & HUDs!)
            // while converting any blocked Tauri/blob/background-image assets into real data-URI <img> tags!
            if (renderedMap.has(reverseIdx)) {
                html = cleanRenderedHtml(renderedMap.get(reverseIdx), { hideAssets, fullHide });
                if (!hideAssets && !fullHide) {
                    html = await rehydrateBlockedImagesInHtml(html, m.data, assetLookup);
                }
            } else {
                // Fallback for unmounted older messages: strip CoT & HTML comments, preserve HTML status HUDs, resolve asset tags in-place!
                const stripped = stripThinkingFromRaw(m.data);

                // Step A: Protect HTML status/HUD blocks (<statusdata>, <details>, <div...>, <table>, <style>) from escapeHtml
                const htmlBlocks = [];
                const htmlBlockRegex = /<statusdata\b[^>]*>[\s\S]*?<\/statusdata>|<details\b[^>]*>[\s\S]*?<\/details>|<table\b[^>]*>[\s\S]*?<\/table>|<div\b[^>]*>[\s\S]*?<\/div>|<style\b[^>]*>[\s\S]*?<\/style>/gi;
                const withHtmlTokens = stripped.replace(htmlBlockRegex, (match) => {
                    const hIdx = htmlBlocks.length;
                    htmlBlocks.push(match);
                    return `\n\n@@RISU_HTML_BLOCK_${hIdx}@@\n\n`;
                });

                // Step B: Protect image asset tags
                const tagRegex = /<img\s*=\s*["']?([^"'\s>]+)["']?\s*\/?>|\{\{(?:img|raw|asset|image|emotion)::([^}]+)\}\}|\{\{(?:inlay|inlayed)::([a-f0-9-]+)\}\}|\[(?:img|image)\s*[:=]\s*([^\]]+)\]/gi;
                const tokens = [];
                const tokenized = withHtmlTokens.replace(tagRegex, (_full, g1, g2, gInlay, g4) => {
                    const idxToken = tokens.length;
                    if (gInlay) {
                        tokens.push({ kind: 'inlay', val: gInlay.trim() });
                    } else {
                        tokens.push({ kind: 'asset', val: (g1 || g2 || g4 || '').trim() });
                    }
                    return `\n\n@@RISU_ASSET_TOKEN_${idxToken}@@\n\n`;
                });

                const safeText = escapeHtml(tokenized)
                    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
                    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
                    .replace(/"([^"\n]+)"/g, '<span class="q-text">"$1"</span>');

                let built = safeText
                    .split(/\n{2,}/)
                    .map((p) => {
                        const trimmed = p.trim();
                        if (!trimmed) return '';
                        if (/^@@RISU_(?:ASSET_TOKEN|HTML_BLOCK)_\d+@@$/.test(trimmed)) return trimmed;
                        const statusMatch = trimmed.match(/^\[\s*([^|\]]+)\|\s*([^|\]]+)\|\s*([^|\]]+)\|\s*([^\]]+)\s*\]$/);
                        if (statusMatch) {
                            return `<div class="epub-status-card"><div>📅 <strong>날짜:</strong> ${statusMatch[1].trim()}</div><div>🕒 <strong>시간:</strong> ${statusMatch[2].trim()}</div><div>🗺️ <strong>위치:</strong> ${statusMatch[3].trim()}</div><div>💬 <strong>상황:</strong> ${statusMatch[4].trim()}</div></div>`;
                        }
                        return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
                    })
                    .join('');

                // Step C: Restore sanitized HTML status blocks (keeps original <details>/HUD design!)
                for (let hIdx = 0; hIdx < htmlBlocks.length; hIdx++) {
                    const marker = `@@RISU_HTML_BLOCK_${hIdx}@@`;
                    if (fullHide) {
                        built = built.replace(marker, '');
                    } else {
                        let cleanedBlock = cleanRenderedHtml(htmlBlocks[hIdx], { hideAssets, fullHide });
                        if (!hideAssets && cleanedBlock) {
                            cleanedBlock = await rehydrateBlockedImagesInHtml(cleanedBlock, htmlBlocks[hIdx], assetLookup);
                        }
                        built = built.replace(marker, cleanedBlock ? `<div class="epub-hud-wrap">${cleanedBlock}</div>` : '');
                    }
                }

                // Step D: Restore image assets in-place
                for (let tIdx = 0; tIdx < tokens.length; tIdx++) {
                    const marker = `@@RISU_ASSET_TOKEN_${tIdx}@@`;
                    if (hideAssets || fullHide) {
                        built = built.replace(marker, '');
                    } else {
                        const tok = tokens[tIdx];
                        let dataUrl = null;
                        if (tok && tok.kind === 'inlay') {
                            dataUrl = await getIframeDataUrlForInlay(tok.val);
                        } else if (tok) {
                            const assetPath = assetLookup.findPath(tok.val);
                            dataUrl = assetPath ? await getIframeDataUrlForAsset(assetPath) : null;
                        }
                        if (dataUrl) {
                            built = built.replace(marker, `<img src="${dataUrl}" alt="${escapeHtml(tok.val)}" decoding="async" />`);
                        } else {
                            built = built.replace(marker, '');
                        }
                    }
                }
                html = built;
            }

            if (html) {
                items.push({ role: m.role, html });
            }
        }
        return items;
    }

    async function renderCloneView(selectedMode, options = {}) {
        currentIframeMode = 'clone';
        pendingCloneRefresh = false;
        lastCloneSignature = await computeChatSignature();
        startCloneWatcher();
        let defaultModeKey = lastCloneMode;
        const curPresetObj = PRESETS[config.theme.preset];
        if (curPresetObj?.isChatbot) {
            defaultModeKey = config.theme.preset;
        } else if (curPresetObj?.isEpub) {
            const isDarkEpub = curPresetObj.scheme?.type === 'dark';
            defaultModeKey = config.layout.epubTwoPage
                ? (isDarkEpub ? 'epub-night' : 'epub-sepia')
                : (isDarkEpub ? 'epub-night-scroll' : 'epub-sepia-scroll');
        }
        const modeKey = selectedMode || defaultModeKey;
        lastCloneMode = modeKey;

        const preset = PRESETS[modeKey] || PRESETS['ai-gemini'];
        const isEpub = Boolean(preset.isEpub);
        const isLight = preset.scheme && preset.scheme.type === 'light';
        const activeFontKey =
            config.theme.fontFamily && FONT_STACKS[config.theme.fontFamily] && config.theme.fontFamily !== 'inherit'
                ? config.theme.fontFamily
                : (isEpub ? 'epub-serif' : 'epub-clean');
        const fontStack = (FONT_STACKS[activeFontKey] || FONT_STACKS['epub-serif']).css;

        const items = await collectMessagesForReader(modeKey);
        const twoPage = isEpub && (typeof preset.epubSpread === 'boolean' ? preset.epubSpread : config.layout.epubTwoPage);

        const uaStats = computeUATurnStats(items);
        const seenUserTurns = new Set();
        const userTurns = [];
        const extractSnippet = (htmlStr) => {
            const plain = String(htmlStr || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            return plain.length > 22 ? plain.slice(0, 22) + '…' : plain;
        };
        const msgHtml = items.length
            ? items
                  .map((item, idx) => {
                      const isUser = item.role === 'user';
                      const turnNum = uaStats.turnByIndex[idx] || 0;
                      const isFirstOfTurn = isUser && turnNum > 0 && !seenUserTurns.has(turnNum);
                      if (isFirstOfTurn) {
                          seenUserTurns.add(turnNum);
                          userTurns.push({ turnNum, snippet: extractSnippet(item.html) });
                      }
                      if (isEpub) {
                          if (isUser) {
                              return `
                                  <div class="epub-user-block"${isFirstOfTurn ? ` data-user-turn="${turnNum}"` : ''} data-turn-num="${turnNum}">
                                      <div class="epub-turn-tag">▸ 나 · Turn ${turnNum}</div>
                                      <div class="epub-turn-body">${item.html}</div>
                                  </div>
                              `;
                          }
                          return `
                              <div class="epub-bot-block" data-turn-num="${turnNum}">
                                  <div class="epub-turn-divider"><span>${turnNum > 0 ? `✦ Turn ${turnNum}` : '✦ 프롤로그'}</span></div>
                                  <div class="epub-turn-body">${item.html}</div>
                              </div>
                          `;
                      }
                      if (isUser) {
                          return `
                              <div class="msg-row user"${isFirstOfTurn ? ` data-user-turn="${turnNum}"` : ''} data-turn-num="${turnNum}">
                                  <div class="user-bubble">${item.html}</div>
                              </div>
                          `;
                      }
                      return `
                          <div class="msg-row bot" data-turn-num="${turnNum}">
                              <div class="bot-avatar" style="background:${preset.badgeBg}"></div>
                              <div class="bot-content">
                                  <div class="bot-label">${escapeHtml(preset.brandTitle || 'Assistant')}</div>
                                  <div class="bot-body">${item.html}</div>
                              </div>
                          </div>
                      `;
                  })
                  .join('')
            : `<div class="empty-state">표시할 메시지가 없습니다. 아래 입력창에서 대화를 시작해 보세요.</div>`;

        const epubCSS = isEpub
            ? `
                .epub-stage {
                    flex: 1; min-height: 0; display: flex; flex-direction: column;
                    align-items: center; justify-content: center;
                    padding: 16px 24px 8px; overflow: hidden;
                }
                .epub-book-frame {
                    position: relative;
                    width: 100%; max-width: ${twoPage ? '1240px' : '760px'};
                    height: 100%;
                    background: ${preset.pageBg || preset.scheme.bgcolor};
                    border: 1px solid ${preset.borderColor};
                    border-radius: 10px;
                    box-shadow: 0 4px 16px rgba(0,0,0,${isLight ? '0.10' : '0.28'});
                    overflow: hidden;
                    contain: layout paint;
                    perspective: 1750px;
                    display: flex; flex-direction: column;
                }
                .epub-flip-leaf {
                    position: absolute;
                    top: 0;
                    bottom: 40px;
                    width: 50%;
                    pointer-events: none;
                    z-index: 8;
                    display: none;
                    backface-visibility: visible;
                    will-change: transform, opacity;
                    background: ${preset.pageBg || preset.scheme.bgcolor};
                }
                .epub-flip-leaf.flip-next {
                    display: block;
                    left: 50%;
                    transform-origin: left center;
                    border-left: 1px solid ${preset.borderColor};
                    background: linear-gradient(90deg, ${isLight ? 'rgba(0,0,0,0.11)' : 'rgba(255,255,255,0.07)'} 0%, ${preset.pageBg || preset.scheme.bgcolor} 16%, ${preset.pageBg || preset.scheme.bgcolor} 82%, ${isLight ? 'rgba(0,0,0,0.14)' : 'rgba(0,0,0,0.55)'} 100%);
                    box-shadow: -14px 0 34px rgba(0, 0, 0, ${isLight ? '0.24' : '0.62'});
                    animation: epubFlipNext 640ms cubic-bezier(0.36, 0.06, 0.22, 1) forwards;
                }
                .epub-flip-leaf.flip-prev {
                    display: block;
                    left: 0;
                    transform-origin: right center;
                    border-right: 1px solid ${preset.borderColor};
                    background: linear-gradient(270deg, ${isLight ? 'rgba(0,0,0,0.11)' : 'rgba(255,255,255,0.07)'} 0%, ${preset.pageBg || preset.scheme.bgcolor} 16%, ${preset.pageBg || preset.scheme.bgcolor} 82%, ${isLight ? 'rgba(0,0,0,0.14)' : 'rgba(0,0,0,0.55)'} 100%);
                    box-shadow: 14px 0 34px rgba(0, 0, 0, ${isLight ? '0.24' : '0.62'});
                    animation: epubFlipPrev 640ms cubic-bezier(0.36, 0.06, 0.22, 1) forwards;
                }
                @keyframes epubFlipNext {
                    0% { transform: rotateY(0deg); opacity: 0.94; }
                    22% { transform: rotateY(-32deg); opacity: 0.98; }
                    50% { transform: rotateY(-90deg); opacity: 1; }
                    82% { transform: rotateY(-156deg); opacity: 0.88; }
                    100% { transform: rotateY(-180deg); opacity: 0; }
                }
                @keyframes epubFlipPrev {
                    0% { transform: rotateY(0deg); opacity: 0.94; }
                    22% { transform: rotateY(32deg); opacity: 0.98; }
                    50% { transform: rotateY(90deg); opacity: 1; }
                    82% { transform: rotateY(156deg); opacity: 0.88; }
                    100% { transform: rotateY(180deg); opacity: 0; }
                }
                ${
                    twoPage
                        ? `.epub-book-frame::before {
                            content: ''; position: absolute; top: 0; bottom: 40px; left: 50%;
                            width: 1px; background: ${preset.borderColor}; pointer-events: none; z-index: 3;
                        }
                        .epub-book-frame::after {
                            content: ''; position: absolute; top: 0; bottom: 40px; left: 50%;
                            width: 48px; transform: translateX(-50%); pointer-events: none;
                            background: linear-gradient(90deg, transparent, rgba(0,0,0,${isLight ? '0.07' : '0.34'}) 50%, transparent);
                            z-index: 2;
                        }`
                        : ''
                }
                .epub-viewport {
                    flex: 1; min-height: 0;
                    overflow: ${twoPage ? 'hidden' : 'auto'};
                    ${twoPage ? 'margin: 30px auto; padding: 0;' : 'padding: 30px 42px;'}
                    scrollbar-width: none;
                    position: relative;
                }
                .epub-tap-zone {
                    position: absolute;
                    top: 0;
                    bottom: 40px;
                    width: 12%;
                    min-width: 48px;
                    max-width: 110px;
                    z-index: 4;
                    pointer-events: none;
                    background: transparent !important;
                    user-select: none;
                }
                .epub-tap-zone:hover {
                    background: transparent !important;
                }
                .epub-tap-left { left: 0; }
                .epub-tap-right { right: 0; }
                .epub-viewport::-webkit-scrollbar { display: none; }
                .epub-columns {
                    ${
                        twoPage
                            ? `height: 100%; column-fill: auto;`
                            : `max-width: 660px; margin: 0 auto;`
                    }
                    font-size: ${Math.max(15, config.theme.fontSize)}px;
                    line-height: 1.92;
                    letter-spacing: -0.015em;
                    word-break: keep-all;
                    overflow-wrap: break-word;
                    text-align: justify;
                }
                .epub-columns img, .epub-columns table, .epub-columns pre, .epub-columns div { max-width: 100%; }
                .epub-columns p { margin: 0 0 0.85em; }
                .epub-status-card {
                    background: ${preset.userBubbleBg};
                    border: 1px solid ${preset.borderColor};
                    border-radius: 10px;
                    padding: 10px 14px;
                    margin: 12px 0;
                    font-size: 12.5px;
                    line-height: 1.65;
                    text-align: left;
                    break-inside: avoid;
                    font-family: system-ui, -apple-system, "Malgun Gothic", sans-serif;
                }
                .epub-hud-wrap, .epub-columns statusdata, .epub-columns details {
                    display: block;
                    text-align: left !important;
                    break-inside: avoid;
                    margin: 12px 0;
                    font-family: system-ui, -apple-system, "Malgun Gothic", sans-serif;
                }
                .leave-hud-card {
                    margin: 12px 0 6px;
                    padding: 10px 14px;
                    border-radius: 12px;
                    background: rgba(15, 23, 42, 0.82);
                    border: 1px solid rgba(148, 163, 184, 0.28);
                    color: #e2e8f0;
                    font-size: 12.5px;
                    line-height: 1.65;
                    break-inside: avoid;
                    font-family: system-ui, -apple-system, "Malgun Gothic", sans-serif;
                }
                .leave-hud-card summary {
                    cursor: pointer;
                    font-weight: 700;
                    color: #93c5fd;
                }
                .leave-hud-body {
                    margin-top: 8px;
                    white-space: pre-line;
                    color: #e2e8f0;
                }
                .epub-columns img {
                    max-width: 100% !important;
                    max-height: 42vh !important;
                    width: auto !important;
                    height: auto !important;
                    object-fit: contain;
                    display: block;
                    margin: 12px auto;
                    border-radius: 8px;
                    break-inside: avoid;
                }
                .epub-user-block {
                    background: ${preset.userBubbleBg};
                    border: 1px solid ${preset.borderColor};
                    border-left: 3.5px solid ${preset.defaults.accentColor};
                    padding: 11px 15px;
                    border-radius: 8px;
                    margin: 16px 0 18px;
                    break-inside: avoid;
                    font-size: 0.94em;
                }
                .epub-turn-tag {
                    font-size: 11px;
                    font-weight: 700;
                    color: ${preset.defaults.accentColor};
                    letter-spacing: 0.03em;
                    margin-bottom: 6px;
                    opacity: 0.92;
                }
                .epub-bot-block {
                    margin-bottom: 26px;
                    padding-left: 4px;
                    padding-right: 4px;
                    ${!twoPage ? 'content-visibility: auto; contain-intrinsic-size: auto 320px;' : ''}
                }
                .epub-turn-divider {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin: 6px 0 14px;
                    font-size: 11px;
                    font-weight: 700;
                    color: ${preset.scheme.textcolor2};
                    letter-spacing: 0.05em;
                    break-after: avoid;
                }
                .epub-turn-divider::before,
                .epub-turn-divider::after {
                    content: '';
                    flex: 1;
                    height: 1px;
                    background: ${preset.borderColor};
                }
                .epub-nav {
                    height: 40px; flex-shrink: 0;
                    display: flex; align-items: center; justify-content: center; gap: 10px;
                    padding: 0 10px;
                    border-top: 1px solid ${preset.borderColor};
                    font-size: 12px; color: ${preset.scheme.textcolor2};
                }
                .nav-btn {
                    white-space: nowrap; flex-shrink: 0;
                    border: 1px solid ${preset.borderColor};
                    background: transparent; color: ${preset.scheme.textcolor};
                    border-radius: 8px; padding: 4px 10px; font-size: 12px; font-weight: 600; cursor: pointer;
                }
                .epub-book-frame.mobile-single-page::before,
                .epub-book-frame.mobile-single-page::after {
                    display: none !important;
                }
                .epub-book-frame.mobile-single-page .epub-columns {
                    text-align: left !important;
                }
                .epub-book-frame.mobile-single-page .epub-flip-leaf {
                    width: 100% !important;
                    left: 0 !important;
                }
                @media (max-width: 759px) {
                    .epub-stage { padding: 8px 10px 4px; }
                    .epub-viewport { margin: 18px auto !important; }
                    .clone-scroll { padding: 16px 12px 24px; }
                    .user-bubble { max-width: 88%; padding: 10px 14px; }
                    .clone-dock { padding: 8px 10px calc(10px + env(safe-area-inset-bottom)); }
                    .dock-pill { padding: 7px 11px; }
                }
                .nav-btn:hover { background: ${isLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)'}; }
            `
            : '';

        const mainContentHtml = isEpub
            ? `
                <div class="epub-stage">
                    <div class="epub-book-frame">
                        ${
                            twoPage
                                ? `<div class="epub-tap-zone epub-tap-left" id="epub-tap-prev" aria-label="이전 페이지"></div>
                                   <div class="epub-tap-zone epub-tap-right" id="epub-tap-next" aria-label="다음 페이지"></div>
                                   <div class="epub-flip-leaf" id="epub-flip-leaf"></div>`
                                : ''
                        }
                        <div class="epub-viewport" id="epub-viewport">
                            <div class="epub-columns" id="epub-columns">${msgHtml}</div>
                        </div>
                        ${
                            twoPage
                                ? `<div class="epub-nav">
                                    <button class="nav-btn" id="epub-prev">◀ 이전 펼침</button>
                                    <span id="epub-page-info">1 / 1 펼침</span>
                                    <button class="nav-btn" id="epub-next">다음 펼침 ▶</button>
                                </div>`
                                : ''
                        }
                    </div>
                </div>
            `
            : `
                <div class="clone-scroll" id="clone-scroll">
                    <div class="clone-col">${msgHtml}</div>
                </div>
            `;

        document.body.innerHTML = `
            <style>
                * { box-sizing: border-box; }
                html, body {
                    margin: 0; padding: 0; width: 100%; height: 100%;
                    background: ${preset.scheme.bgcolor};
                    color: ${preset.scheme.textcolor};
                    font-family: ${fontStack};
                    display: flex; flex-direction: column; overflow: hidden;
                }
                .clone-header {
                    min-height: 54px; flex-shrink: 0;
                    display: flex; align-items: center; gap: 10px;
                    padding: env(safe-area-inset-top) max(14px, env(safe-area-inset-right)) 0 max(14px, env(safe-area-inset-left));
                    border-bottom: 1px solid ${preset.borderColor};
                    background: ${preset.scheme.bgcolor};
                    overflow: hidden;
                    font-family: system-ui, -apple-system, "Pretendard", "Malgun Gothic", sans-serif;
                }
                .hdr-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; padding-left: 8px; border-left: 1px solid ${preset.borderColor}; }
                .icon-btn { width: 34px; height: 34px; padding: 0 !important; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; }
                .exit-btn { height: 34px; display: inline-flex; align-items: center; gap: 2px; }
                .brand-group { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14.5px; flex-shrink: 0; white-space: nowrap; }
                .brand-dot { width: 12px; height: 12px; border-radius: 50%; background: ${preset.badgeBg}; flex-shrink: 0; }
                .mode-tabs {
                    display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; flex: 1;
                    overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch;
                    min-width: 0; padding: 2px 0; justify-content: flex-start;
                    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
                    mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
                }
                .mode-tabs > :last-child { margin-right: 24px; }
                .mode-tabs::-webkit-scrollbar { display: none; }
                .tab-btn {
                    flex-shrink: 0; white-space: nowrap;
                    border: 1px solid ${preset.borderColor};
                    background: ${isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)'};
                    color: ${preset.scheme.textcolor};
                    border-radius: 999px; padding: 0 12px; height: 32px; font-size: 12px; font-weight: 600; cursor: pointer;
                    font-family: inherit; transition: background 140ms ease, border-color 140ms ease;
                }
                .tab-btn:hover { background: ${isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.10)'}; }
                .font-ctrl-group { flex-shrink: 0; }
                @media (max-width: 820px) {
                    .brand-text { display: none; }
                    .clone-header { padding-left: max(10px, env(safe-area-inset-left)); padding-right: max(10px, env(safe-area-inset-right)); gap: 8px; }
                    .tab-btn { padding: 0 10px; font-size: 11.5px; }
                    .exit-lbl { display: none; }
                    .exit-btn { width: 34px; padding: 0 !important; justify-content: center; }
                }
                @media (pointer: coarse) {
                    .dock-pill textarea { font-size: 16px !important; }
                }
                .tab-btn.active {
                    background: ${preset.defaults.accentColor}; color: ${getContrastText(preset.defaults.accentColor)}; border-color: transparent;
                }
                .font-ctrl-group {
                    display: inline-flex; align-items: center; gap: 4px;
                    padding: 2px 6px; border-radius: 999px;
                    border: 1px solid ${preset.borderColor};
                    background: ${isLight ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.04)'};
                }
                .font-select {
                    border: none; outline: none; background: transparent;
                    color: ${preset.scheme.textcolor}; font-size: 11.5px; font-weight: 600;
                    cursor: pointer; padding: 2px 4px;
                }
                .font-select option {
                    background: ${isLight ? '#ffffff' : '#1b1d24'};
                    color: ${isLight ? '#1a1918' : '#ececec'};
                }
                .font-step-btn {
                    border: none; background: transparent; color: ${preset.scheme.textcolor};
                    font-size: 12px; font-weight: 700; cursor: pointer;
                    padding: 2px 5px; border-radius: 6px;
                }
                .font-step-btn:hover { background: ${isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.10)'}; }
                .font-size-lbl {
                    font-size: 11px; font-weight: 700; opacity: 0.78; min-width: 28px; text-align: center;
                }
                .clone-scroll { flex: 1; overflow-y: auto; padding: 26px 20px 38px; contain: strict; }
                .msg-row { content-visibility: auto; contain-intrinsic-size: auto 180px; }
                .clone-col { max-width: ${preset.defaults.chatMaxWidth}px; margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
                .msg-row.user { display: flex; justify-content: flex-end; }
                .user-bubble {
                    background: ${preset.userBubbleBg};
                    color: ${preset.scheme.textcolor};
                    padding: 12px 18px; border-radius: 20px; max-width: 78%;
                    font-size: ${config.theme.fontSize}px; line-height: ${config.theme.lineHeight};
                }
                .user-bubble p, .bot-body p { margin: 0 0 0.7em; }
                .user-bubble p:last-child, .bot-body p:last-child { margin-bottom: 0; }
                .msg-row.bot { display: flex; align-items: flex-start; gap: 14px; }
                .bot-avatar { width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0; margin-top: 2px; }
                .bot-content { flex: 1; min-width: 0; }
                .bot-label { font-size: 12px; font-weight: 700; opacity: 0.65; margin-bottom: 6px; }
                .bot-body {
                    font-size: ${config.theme.fontSize}px;
                    line-height: ${config.theme.lineHeight};
                    word-break: keep-all;
                }
                .bot-body img { max-width: 100%; border-radius: 10px; margin: 10px 0; }
                .q-text { color: ${preset.textTheme.FontColorQuote1}; }
                mark {
                    background: transparent !important;
                    color: ${preset.textTheme.FontColorQuote1} !important;
                    padding: 0 !important;
                }
                mark[risu-mark="quote2"] {
                    color: ${preset.textTheme.FontColorQuote2} !important;
                }
                .empty-state { text-align: center; opacity: 0.6; padding: 80px 20px; font-size: 14px; }
                .clone-dock { flex-shrink: 0; padding: 10px max(20px, env(safe-area-inset-right)) calc(14px + env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); background: ${preset.scheme.bgcolor}; }
                .dock-pill:focus-within { border-color: ${preset.defaults.accentColor}; box-shadow: 0 0 0 3px ${preset.defaults.accentColor}33, 0 3px 12px rgba(0,0,0,0.12); }
                .dock-pill {
                    max-width: ${isEpub && twoPage ? '920px' : `${preset.defaults.chatMaxWidth}px`};
                    margin: 0 auto; display: flex; align-items: flex-end; gap: 10px;
                    background: ${preset.inputBg}; border: 1px solid ${preset.inputBorder};
                    border-radius: 24px; padding: 9px 14px; box-shadow: 0 3px 12px rgba(0,0,0,0.12);
                }
                .dock-pill textarea {
                    flex: 1; border: none; outline: none; resize: none; background: transparent;
                    color: ${preset.scheme.textcolor}; font-family: inherit; font-size: 15px; line-height: 1.5;
                    max-height: 120px; min-height: 24px; overflow-y: auto; scrollbar-width: none;
                }
                .send-btn {
                    background: ${preset.defaults.accentColor}; color: ${getContrastText(preset.defaults.accentColor)}; border: none;
                    border-radius: 999px; padding: 7px 14px; font-size: 13px; font-weight: 700; cursor: pointer;
                }
                .send-btn:disabled { opacity: 0.5; cursor: wait; }
                .turn-ruler-wrap {
                    flex-shrink: 0;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    padding: 4px 20px 2px;
                    background: ${preset.scheme.bgcolor};
                    position: relative;
                    z-index: 15;
                }
                .turn-ruler-track {
                    display: flex;
                    align-items: flex-end;
                    justify-content: center;
                    gap: 2px;
                    max-width: ${isEpub && twoPage ? '920px' : `${preset.defaults.chatMaxWidth}px`};
                    width: 100%;
                    height: 22px;
                    overflow: visible;
                }
                .turn-tick {
                    position: relative;
                    border: none;
                    background: transparent;
                    padding: 5px 4px 3px;
                    margin: 0;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: flex-end;
                    justify-content: center;
                    height: 22px;
                    outline: none;
                }
                .tick-bar {
                    display: block;
                    width: 2px;
                    height: 8px;
                    border-radius: 2px;
                    background: ${preset.scheme.textcolor2};
                    opacity: 0.36;
                    transform-origin: bottom center;
                    will-change: transform, opacity;
                    transition: transform 120ms ease, opacity 120ms ease;
                }
                .turn-tick.major .tick-bar {
                    transform: scaleY(1.35);
                    opacity: 0.55;
                }
                .turn-tick.active .tick-bar {
                    transform: scaleY(1.5);
                    background: ${preset.defaults.accentColor};
                    opacity: 0.92;
                }
                .turn-tick:hover .tick-bar {
                    transform: scaleX(1.5) scaleY(2.15);
                    background: ${preset.defaults.accentColor};
                    opacity: 1;
                }
                .tick-tip {
                    position: absolute;
                    bottom: calc(100% + 6px);
                    left: 50%;
                    transform: translateX(-50%) translateY(4px);
                    background: ${isLight ? '#1f1d1a' : '#2a2d38'};
                    color: #f4f4f6;
                    border: 1px solid ${isLight ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.14)'};
                    font-size: 11px;
                    font-weight: 600;
                    padding: 4px 9px;
                    border-radius: 8px;
                    white-space: nowrap;
                    pointer-events: none;
                    opacity: 0;
                    box-shadow: 0 6px 18px rgba(0,0,0,0.28);
                    transition: opacity 130ms ease, transform 130ms ease;
                    z-index: 50;
                    font-family: system-ui, -apple-system, "Malgun Gothic", sans-serif;
                }
                .turn-tick:hover .tick-tip {
                    opacity: 1;
                    transform: translateX(-50%) translateY(0);
                }
                ${epubCSS}
            </style>
            <div class="clone-header">
                <div class="brand-group">
                    <span class="brand-dot"></span>
                    <span class="brand-text">${escapeHtml(preset.brandTitle)} ${escapeHtml(preset.brandModel)}</span>
                </div>
                <div class="mode-tabs">
                    <div class="font-ctrl-group" title="글꼴 및 크기 설정">
                        <select class="font-select" id="reader-font-select">
                            <option value="epub-serif" ${activeFontKey === 'epub-serif' ? 'selected' : ''}>명조체</option>
                            <option value="epub-sans" ${activeFontKey === 'epub-sans' ? 'selected' : ''}>고딕체</option>
                            <option value="epub-clean" ${activeFontKey === 'epub-clean' ? 'selected' : ''}>산세리프</option>
                            <option value="inherit" ${config.theme.fontFamily === 'inherit' ? 'selected' : ''}>기본</option>
                        </select>
                        <button class="font-step-btn" id="reader-font-dec" title="글자 작게">A-</button>
                        <span class="font-size-lbl" id="reader-font-val">${config.theme.fontSize}</span>
                        <button class="font-step-btn" id="reader-font-inc" title="글자 크게">A+</button>
                    </div>
                    <button class="tab-btn ${modeKey === 'ai-gemini' ? 'active' : ''}" data-cmode="ai-gemini">Gemini</button>
                    <button class="tab-btn ${modeKey === 'ai-claude' ? 'active' : ''}" data-cmode="ai-claude">Claude</button>
                    <button class="tab-btn ${modeKey === 'ai-chatgpt' ? 'active' : ''}" data-cmode="ai-chatgpt">ChatGPT</button>
                    <button class="tab-btn ${modeKey === 'epub-sepia-scroll' ? 'active' : ''}" data-cmode="epub-sepia-scroll">📜 1쪽(낮)</button>
                    <button class="tab-btn ${modeKey === 'epub-night-scroll' ? 'active' : ''}" data-cmode="epub-night-scroll">📜 1쪽(밤)</button>
                    <button class="tab-btn ${modeKey === 'epub-sepia' ? 'active' : ''}" data-cmode="epub-sepia">📖 2쪽(낮)</button>
                    <button class="tab-btn ${modeKey === 'epub-night' ? 'active' : ''}" data-cmode="epub-night">🌙 2쪽(밤)</button>
                    ${isEpub ? `<button class="tab-btn ${config.layout.epubShowAssets ? 'active' : ''}" id="btn-epub-assets">${config.layout.epubShowAssets ? '🖼️ 에셋 ON' : '🖼️ 에셋 OFF'}</button>` : ''}
                </div>
                <div class="hdr-actions">
                    <button class="tab-btn icon-btn" id="btn-refresh-clone" title="화면 새로고침 (인레이·에셋 다시 불러오기)" aria-label="새로고침">🔄</button>
                    <button class="tab-btn icon-btn" id="btn-open-studio-from-clone" title="테마 & UX 설정" aria-label="설정">🎨</button>
                    <button class="tab-btn exit-btn" id="btn-exit-clone" title="원래 화면으로" aria-label="원래 화면으로">✕<span class="exit-lbl"> 원래 화면</span></button>
                </div>
            </div>
            ${mainContentHtml}
            ${
                userTurns.length > 0
                    ? `<div class="turn-ruler-wrap" id="turn-ruler">
                        <div class="turn-ruler-track">
                            ${userTurns
                                .map(
                                    (ut, i) => `
                                <button class="turn-tick ${i === userTurns.length - 1 ? 'active' : ''} ${ut.turnNum % 5 === 0 ? 'major' : ''}" data-jump-turn="${ut.turnNum}" aria-label="${ut.turnNum}턴">
                                    <span class="tick-tip">${ut.turnNum}턴${ut.snippet ? ` · ${escapeHtml(ut.snippet)}` : ''}</span>
                                    <span class="tick-bar"></span>
                                </button>`
                                )
                                .join('')}
                        </div>
                    </div>`
                    : ''
            }
            <div class="clone-dock">
                <div class="dock-pill">
                    <textarea id="clone-input" rows="1" placeholder="${escapeHtml(preset.brandTitle)}에게 메시지 보내기... (Enter 전송)"></textarea>
                    <button class="send-btn" id="clone-send">전송</button>
                </div>
            </div>
        `;

        if (isEpub && twoPage) {
            const vp = document.getElementById('epub-viewport');
            const cols = document.getElementById('epub-columns');
            const info = document.getElementById('epub-page-info');
            let colGap = 96;
            let colsPerSpread = 2;
            let spreadStride = 1;
            let totalSpreads = 1;
            let curSpread = 0;
            let wheelLock = false;

            const updatePageInfo = () => {
                if (!info) return;
                if (colsPerSpread === 1) {
                    info.textContent = `${curSpread + 1} / ${totalSpreads}쪽`;
                } else {
                    const pLeft = curSpread * 2 + 1;
                    const pRight = curSpread * 2 + 2;
                    info.textContent = `${pLeft}–${pRight}쪽 (${curSpread + 1} / ${totalSpreads} 펼침)`;
                }
            };

            const flipLeaf = document.getElementById('epub-flip-leaf');
            let flipMidTimer = null;
            let flipEndTimer = null;

            const goToSpread = (idx, animateFlip) => {
                if (!vp) return;
                const prevSpread = curSpread;
                const nextSpread = Math.max(0, Math.min(totalSpreads - 1, idx));
                curSpread = nextSpread;

                if (flipMidTimer) { clearTimeout(flipMidTimer); flipMidTimer = null; }
                if (flipEndTimer) { clearTimeout(flipEndTimer); flipEndTimer = null; }

                if (animateFlip && flipLeaf && nextSpread !== prevSpread) {
                    const dirClass = nextSpread > prevSpread ? 'flip-next' : 'flip-prev';
                    flipLeaf.classList.remove('flip-next', 'flip-prev');
                    // Restart GPU animation cleanly
                    void flipLeaf.offsetWidth;
                    flipLeaf.classList.add(dirClass);

                    // Swap the underlying spread at the exact midpoint when the paper stands upright
                    flipMidTimer = setTimeout(() => {
                        flipMidTimer = null;
                        vp.scrollLeft = curSpread * spreadStride;
                        updatePageInfo();
                    }, 300);

                    flipEndTimer = setTimeout(() => {
                        flipEndTimer = null;
                        flipLeaf.classList.remove('flip-next', 'flip-prev');
                    }, 650);
                } else {
                    if (flipLeaf) flipLeaf.classList.remove('flip-next', 'flip-prev');
                    vp.scrollLeft = curSpread * spreadStride;
                    updatePageInfo();
                }
            };

            const layoutSpreads = (jumpToLast) => {
                if (!vp || !cols) return;
                const frame = vp.parentElement;
                const frameW = frame ? frame.clientWidth : vp.clientWidth;
                const isNarrow = frameW < 760;
                colsPerSpread = isNarrow ? 1 : 2;
                colGap = isNarrow ? 36 : 96;
                const sideMargin = isNarrow ? 36 : 96;

                if (frame) {
                    frame.classList.toggle('mobile-single-page', isNarrow);
                }

                const rawInnerW = Math.max(220, frameW - sideMargin);
                const evenW = Math.floor(rawInnerW / 2) * 2;
                vp.style.width = `${evenW}px`;
                cols.style.width = `${evenW}px`;
                cols.style.margin = '0';
                cols.style.padding = '0';
                cols.style.boxSizing = 'border-box';
                cols.style.columnWidth = 'auto';
                cols.style.columnCount = String(colsPerSpread);
                cols.style.columnGap = `${colGap}px`;
                cols.style.columnFill = 'auto';
                cols.style.height = '100%';
                spreadStride = evenW + colGap;
                totalSpreads = Math.max(1, Math.ceil((cols.scrollWidth - 4) / spreadStride));
                if (jumpToLast && typeof options.targetSpread === 'number') {
                    goToSpread(options.targetSpread, false);
                } else if (jumpToLast && options.jumpToTurn) {
                    const tEl = cols.querySelector(`[data-user-turn="${options.jumpToTurn}"]`);
                    if (tEl) {
                        const vpRect = vp.getBoundingClientRect();
                        const tRect = tEl.getBoundingClientRect();
                        const absLeft = (tRect.left - vpRect.left) + vp.scrollLeft;
                        goToSpread(Math.floor(Math.max(0, absLeft + 4) / spreadStride), false);
                    } else {
                        goToSpread(curSpread, false);
                    }
                } else if (jumpToLast && options.preservePosition && typeof options.scrollRatio === 'number') {
                    const targetSpread = Math.round(options.scrollRatio * Math.max(0, totalSpreads - 1));
                    goToSpread(targetSpread, false);
                } else if (jumpToLast) {
                    const userBlocks = cols.querySelectorAll('.epub-user-block');
                    const targetEl = userBlocks.length
                        ? userBlocks[userBlocks.length - 1]
                        : cols.querySelector('.epub-bot-block:last-of-type');
                    if (targetEl) {
                        const vpRect = vp.getBoundingClientRect();
                        const tRect = targetEl.getBoundingClientRect();
                        const absLeft = (tRect.left - vpRect.left) + vp.scrollLeft;
                        const targetSpread = Math.floor(Math.max(0, absLeft + 4) / spreadStride);
                        goToSpread(targetSpread, false);
                    } else {
                        goToSpread(totalSpreads - 1, false);
                    }
                } else {
                    goToSpread(curSpread, false);
                }
            };

            const turnPage = (dir) => {
                const nextSpread = Math.max(0, Math.min(totalSpreads - 1, curSpread + dir));
                if (pendingCloneRefresh && config.layout.autoRefreshClone) {
                    pendingCloneRefresh = false;
                    renderCloneView(modeKey, { targetSpread: nextSpread });
                    return;
                }
                goToSpread(nextSpread, true);
            };

            setTimeout(() => layoutSpreads(true), 60);
            let resizeTimer = null;
            window.onresize = () => {
                if (resizeTimer) clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => layoutSpreads(false), 110);
            };

            let touchStartX = 0;
            let touchStartY = 0;
            const bookFrameEl = vp ? vp.parentElement : null;
            if (bookFrameEl) {
                bookFrameEl.ontouchstart = (e) => {
                    if (e.touches && e.touches.length === 1) {
                        touchStartX = e.touches[0].clientX;
                        touchStartY = e.touches[0].clientY;
                    }
                };
                bookFrameEl.ontouchend = (e) => {
                    if (!e.changedTouches || !e.changedTouches.length) return;
                    const dx = e.changedTouches[0].clientX - touchStartX;
                    const dy = e.changedTouches[0].clientY - touchStartY;
                    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.25) {
                        turnPage(dx < 0 ? 1 : -1);
                    }
                };
            }

            vp.onwheel = (e) => {
                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                    e.preventDefault();
                    if (wheelLock) return;
                    wheelLock = true;
                    turnPage(e.deltaY > 0 ? 1 : -1);
                    setTimeout(() => { wheelLock = false; }, 260);
                }
            };
            document.getElementById('epub-prev').onclick = () => turnPage(-1);
            document.getElementById('epub-next').onclick = () => turnPage(1);
            const epubFrame = vp ? vp.closest('.epub-book-frame') : null;
            const isInteractiveEpubTarget = (target, rootEl) => {
                if (!target || target.nodeType !== 1) return false;
                if (target.closest('button, a, summary, input, select, textarea, label, [role="button"], [onclick], [risu-btn], [risu-trigger], [x-risu-btn], img, .epub-nav')) {
                    return true;
                }
                let cur = target;
                let hops = 0;
                while (cur && cur !== rootEl && hops < 12) {
                    if (cur.nodeType === 1 && typeof window.getComputedStyle === 'function') {
                        try {
                            if (window.getComputedStyle(cur).cursor === 'pointer') return true;
                        } catch (_) {}
                    }
                    cur = cur.parentElement;
                    hops += 1;
                }
                return false;
            };
            if (epubFrame) {
                if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
                    epubFrame.addEventListener('mousemove', (e) => {
                        const rect = epubFrame.getBoundingClientRect();
                        const zoneW = Math.max(48, Math.min(110, rect.width * 0.12));
                        const relX = e.clientX - rect.left;
                        const inPrev = relX <= zoneW && spreadIdx > 0;
                        const inNext = relX >= rect.width - zoneW && spreadIdx < totalSpreads - 1;
                        epubFrame.style.cursor = ((inPrev || inNext) && !isInteractiveEpubTarget(e.target, epubFrame)) ? 'pointer' : '';
                    });
                    epubFrame.addEventListener('mouseleave', () => {
                        epubFrame.style.cursor = '';
                    });
                }
                epubFrame.addEventListener('click', (e) => {
                    if (e.defaultPrevented || (e.button && e.button !== 0)) return;
                    const selTxt = window.getSelection ? String(window.getSelection()).trim() : '';
                    if (selTxt) return;
                    if (isInteractiveEpubTarget(e.target, epubFrame)) return;
                    const rect = epubFrame.getBoundingClientRect();
                    const zoneW = Math.max(48, Math.min(110, rect.width * 0.12));
                    const relX = e.clientX - rect.left;
                    if (relX <= zoneW) turnPage(-1);
                    else if (relX >= rect.width - zoneW) turnPage(1);
                });
            }
            document.onkeydown = (e) => {
                if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
                if (e.key === 'ArrowRight') turnPage(1);
                if (e.key === 'ArrowLeft') turnPage(-1);
            };

            // Bind Turn Ruler ticks for 2-page EPUB spread
            document.querySelectorAll('[data-jump-turn]').forEach((tickBtn) => {
                tickBtn.onclick = () => {
                    const tNum = tickBtn.getAttribute('data-jump-turn');
                    if (pendingCloneRefresh && config.layout.autoRefreshClone) {
                        pendingCloneRefresh = false;
                        renderCloneView(modeKey, { jumpToTurn: tNum });
                        return;
                    }
                    const targetEl = cols ? cols.querySelector(`[data-user-turn="${tNum}"]`) : null;
                    if (!targetEl || !vp) return;
                    const vpRect = vp.getBoundingClientRect();
                    const tRect = targetEl.getBoundingClientRect();
                    const absLeft = (tRect.left - vpRect.left) + vp.scrollLeft;
                    const targetSpread = Math.floor(Math.max(0, absLeft + 4) / spreadStride);
                    goToSpread(targetSpread, true);
                    document.querySelectorAll('.turn-tick').forEach((b) => b.classList.remove('active'));
                    tickBtn.classList.add('active');
                };
            });
        } else {
            document.onkeydown = null;
            const scrollEl = document.getElementById('clone-scroll') || document.getElementById('epub-viewport');
            if (scrollEl) {
                if (options.jumpToTurn) {
                    const tEl = scrollEl.querySelector(`[data-user-turn="${options.jumpToTurn}"]`);
                    if (tEl) tEl.scrollIntoView({ behavior: 'auto', block: 'start' });
                } else if (options.preservePosition && typeof options.scrollRatio === 'number') {
                    const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
                    scrollEl.scrollTop = Math.round(options.scrollRatio * maxScroll);
                } else {
                const userEls = scrollEl.querySelectorAll('.epub-user-block, .msg-row.user');
                const target = userEls.length ? userEls[userEls.length - 1] : null;
                if (target) {
                    target.scrollIntoView({ behavior: 'auto', block: 'start' });
                } else {
                    scrollEl.scrollTop = scrollEl.scrollHeight;
                }
                }
            }

            // Bind Turn Ruler ticks for 1-page EPUB scroll & Official Chatbot views
            document.querySelectorAll('[data-jump-turn]').forEach((tickBtn) => {
                tickBtn.onclick = () => {
                    const tNum = tickBtn.getAttribute('data-jump-turn');
                    if (pendingCloneRefresh && config.layout.autoRefreshClone) {
                        pendingCloneRefresh = false;
                        renderCloneView(modeKey, { jumpToTurn: tNum });
                        return;
                    }
                    const targetEl = document.querySelector(`[data-user-turn="${tNum}"]`);
                    if (!targetEl) return;
                    targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    document.querySelectorAll('.turn-tick').forEach((b) => b.classList.remove('active'));
                    tickBtn.classList.add('active');
                };
            });
        }

        const getCurrentReadingRatio = () => {
            const vpEl = document.getElementById('epub-viewport');
            if (isEpub && twoPage && vpEl) {
                const maxLeft = Math.max(1, vpEl.scrollWidth - vpEl.clientWidth);
                return Math.max(0, Math.min(1, vpEl.scrollLeft / maxLeft));
            }
            const scEl = document.getElementById('clone-scroll') || vpEl;
            if (scEl) {
                const maxTop = Math.max(1, scEl.scrollHeight - scEl.clientHeight);
                return Math.max(0, Math.min(1, scEl.scrollTop / maxTop));
            }
            return 1;
        };

        const fontSel = document.getElementById('reader-font-select');
        if (fontSel) {
            fontSel.onchange = async (e) => {
                const ratio = getCurrentReadingRatio();
                config.theme.fontFamily = e.target.value;
                await saveConfig();
                await upsertStyleTag('theme-layout-stealth', buildLayoutAndThemeCSS());
                await renderCloneView(modeKey, { preservePosition: true, scrollRatio: ratio });
            };
        }
        const stepFontSize = async (delta) => {
            const nextSize = Math.max(12, Math.min(24, (Number(config.theme.fontSize) || 15) + delta));
            if (nextSize === config.theme.fontSize) return;
            const ratio = getCurrentReadingRatio();
            config.theme.fontSize = nextSize;
            await saveConfig();
            await upsertStyleTag('theme-layout-stealth', buildLayoutAndThemeCSS());
            await renderCloneView(modeKey, { preservePosition: true, scrollRatio: ratio });
        };
        const btnDec = document.getElementById('reader-font-dec');
        const btnInc = document.getElementById('reader-font-inc');
        if (btnDec) btnDec.onclick = () => stepFontSize(-1);
        if (btnInc) btnInc.onclick = () => stepFontSize(1);

        document.querySelectorAll('[data-cmode]').forEach((btn) => {
            btn.onclick = () => renderCloneView(btn.getAttribute('data-cmode'));
        });
        const activeModeTab = document.querySelector('.mode-tabs [data-cmode].active');
        const modeStrip = document.querySelector('.mode-tabs');
        if (activeModeTab && modeStrip && modeStrip.scrollWidth > modeStrip.clientWidth) {
            modeStrip.scrollLeft = Math.max(0, activeModeTab.offsetLeft - modeStrip.offsetLeft - modeStrip.clientWidth / 2 + activeModeTab.offsetWidth / 2);
        }

        const epubAssetsBtn = document.getElementById('btn-epub-assets');
        if (epubAssetsBtn) {
            epubAssetsBtn.onclick = async () => {
                const ratio = getCurrentReadingRatio();
                config.layout.epubShowAssets = !config.layout.epubShowAssets;
                await saveConfig();
                await renderCloneView(modeKey, { preservePosition: true, scrollRatio: ratio });
            };
        }

        const refreshCloneBtn = document.getElementById('btn-refresh-clone');
        if (refreshCloneBtn) {
            refreshCloneBtn.onclick = async () => {
                const ratio = getCurrentReadingRatio();
                refreshCloneBtn.disabled = true;
                await renderCloneView(modeKey, { preservePosition: true, scrollRatio: ratio });
            };
        }

        const openStudioBtn = document.getElementById('btn-open-studio-from-clone');
        if (openStudioBtn) {
            openStudioBtn.onclick = () => {
                document.onkeydown = null;
                renderStudioUI();
            };
        }

        document.getElementById('btn-exit-clone').onclick = async () => {
            currentIframeMode = null;
            stopCloneWatcher();
            document.onkeydown = null;
            await risuai.hideContainer();
        };

        const inputEl = document.getElementById('clone-input');
        const sendBtn = document.getElementById('clone-send');
        const doSend = async () => {
            const val = inputEl.value.trim();
            if (!val) return;
            inputEl.value = '';
            sendBtn.disabled = true;
            sendBtn.textContent = '생성 중...';
            try {
                await risuai.sendChat(val);
            } catch (err) {
                console.warn('[RisuStand] 메시지 전송 실패:', err);
            } finally {
                if (currentIframeMode === 'clone') {
                    setTimeout(() => renderCloneView(modeKey), 250);
                }
            }
        };

        sendBtn.onclick = doSend;
        inputEl.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                doSend();
            }
        };
    }

    async function openCloneView() {
        await risuai.showContainer('fullscreen');
        await renderCloneView();
    }

    // =========================================================================
    // 5. Fullscreen Theme & Layout Studio UI
    // =========================================================================
    function clearStudioListeners() {
        if (studioPointerUpHandler) {
            window.removeEventListener('pointerup', studioPointerUpHandler);
            studioPointerUpHandler = null;
        }
    }

    function renderStudioUI() {
        currentIframeMode = 'studio';
        stopCloneWatcher();
        clearStudioListeners();
        document.onkeydown = null;
        const renderPresetCard = ([key, p]) => {
            const active =
                config.theme.preset === key ||
                (key === 'epub-sepia' && config.theme.preset === 'epub-sepia-scroll') ||
                (key === 'epub-night' && config.theme.preset === 'epub-night-scroll')
                    ? 'active'
                    : '';
            const pvBg = p.pageBg || (p.scheme ? p.scheme.bgcolor : '#1e1f26');
            const pvText = p.scheme ? p.scheme.textcolor : '#d4d4d8';
            const pvSub = p.scheme ? p.scheme.textcolor2 : '#71717a';
            const pvAccent = p.defaults.accentColor;
            const pvUser = p.userBubbleBg || (p.scheme ? p.scheme.selected : '#2a2a30');
            const pvAvatar = p.badgeBg || pvAccent;
            const pvInputBg = p.inputBg || pvUser;
            const pvInputBorder = p.inputBorder || pvSub;
            const tag = p.isChatbot
                ? '<span class="pill">에셋 숨김</span>'
                : (p.isEpub ? '<span class="pill epub">EPUB</span>' : '');
            return `
                <button class="preset-card ${active}" data-preset="${key}" aria-pressed="${active ? 'true' : 'false'}">
                    <span class="pv-check">✓</span>
                    <div class="pv" style="background:${pvBg}">
                        ${tag}
                        <div class="pv-user" style="background:${pvUser}"></div>
                        <div class="pv-row"><span class="pv-av" style="background:${pvAvatar}"></span><span class="pv-line" style="background:${pvText}; width:62%"></span></div>
                        <div class="pv-row"><span class="pv-av" style="background:transparent"></span><span class="pv-line" style="background:${pvSub}; width:44%"></span></div>
                        <div class="pv-input" style="background:${pvInputBg}; border-color:${pvInputBorder}"><i style="background:${pvAccent}"></i></div>
                    </div>
                    <div class="preset-head">
                        <div class="preset-title">${escapeHtml(p.label)}</div>
                    </div>
                    <div class="preset-desc">${escapeHtml(p.desc)}</div>
                </button>
            `;
        };
        const mainSkinCards = Object.entries(PRESETS)
            .filter(([key]) => key !== 'epub-sepia-scroll' && key !== 'epub-night-scroll')
            .map(renderPresetCard)
            .join('');

        const fontOptions = Object.entries(FONT_STACKS)
            .map(([key, f]) => `<option value="${key}" ${config.theme.fontFamily === key ? 'selected' : ''}>${escapeHtml(f.label)}</option>`)
            .join('');

        const permBanner = domPermissionGranted
            ? `<div class="badge ok">mainDom 권한 활성 · 자동 최소화 드래그 바, 2단 스텔스, 2쪽 EPUB &amp; 테마 전체 작동 중</div>`
            : `<div class="badge warn">mainDom 권한 미승인 · 기본 색상 테마만 적용됩니다. 아래 버튼으로 권한을 허용해 주세요.</div>`;

        document.body.innerHTML = `
            <style>
                ${buildPanelChromeCSS()}
                .shell {
                    max-width: 1000px; margin: 24px auto; background: var(--bg1); border: 1px solid var(--line);
                    border-radius: 20px; overflow: hidden; display: flex; flex-direction: column;
                    max-height: calc(100vh - 48px); max-height: calc(100dvh - 48px);
                    box-shadow: 0 30px 80px -20px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.02) inset;
                }
                .header {
                    display: flex; justify-content: space-between; align-items: center; gap: 12px;
                    padding: 14px 20px; border-bottom: 1px solid var(--line);
                    background: linear-gradient(180deg, var(--acc-soft), transparent 140%);
                }
                .header h1 { margin: 0; font-size: 16px; font-weight: 800; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px; white-space: nowrap; }
                .header h1 .logo { width: 30px; height: 30px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; background: var(--acc-soft); border: 1px solid var(--acc-line); font-size: 16px; color: var(--acc); }
                .header h1 .logo svg { width: 24px; height: 24px; display: block; }
                .header h1 .ver { font-size: 11px; font-weight: 700; color: var(--tx3); padding: 2px 7px; border: 1px solid var(--line2); border-radius: 999px; }
                .hdr-actions { display: flex; gap: 8px; min-width: 0; }
                .close-btn { display: inline-flex; align-items: center; gap: 6px; background: var(--bg2); color: var(--tx); border: 1px solid var(--line2); border-radius: 10px; padding: 0 13px; min-height: 36px; cursor: pointer; font-weight: 700; font-size: 13px; white-space: nowrap; }
                .close-btn:hover { background: var(--bg3); }
                .content { padding: 18px 20px 22px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; overscroll-behavior: contain; }
                .badge { padding: 10px 14px; border-radius: 12px; font-size: 12.5px; line-height: 1.5; }
                .badge.ok { background: rgba(74, 222, 128, 0.08); border: 1px solid rgba(74, 222, 128, 0.25); color: #bbf7d0; }
                .badge.warn { background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.3); color: #fde68a; }
                .section { background: var(--bg2); border: 1px solid var(--line); border-radius: 16px; padding: 18px; }
                .section h2 { margin: 0 0 4px; font-size: 14.5px; font-weight: 800; letter-spacing: -0.01em; }
                .section .sub { margin: 0 0 14px; font-size: 12.5px; color: var(--tx2); line-height: 1.55; }
                .preset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
                .preset-card {
                    position: relative; text-align: left; background: var(--bg1); border: 1px solid var(--line); border-radius: 14px; padding: 8px 8px 11px;
                    color: var(--tx); cursor: pointer; display: flex; flex-direction: column;
                    transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
                }
                .preset-card:hover { transform: translateY(-2px); border-color: var(--line2); box-shadow: 0 10px 24px -14px rgba(0,0,0,0.8); }
                .preset-card.active { border-color: var(--acc); box-shadow: 0 0 0 3px var(--acc-soft); }
                .pv {
                    position: relative; height: 74px; border-radius: 9px; overflow: hidden; margin-bottom: 10px;
                    border: 1px solid rgba(127,127,127,0.18); display: flex; flex-direction: column; gap: 5px; padding: 9px 10px;
                }
                .pv-row { display: flex; align-items: center; gap: 6px; }
                .pv-av { width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0; }
                .pv-line { height: 5px; border-radius: 3px; opacity: 0.55; }
                .pv-user { align-self: flex-end; height: 13px; width: 46%; border-radius: 7px; }
                .pv-input { position: absolute; left: 10px; right: 10px; bottom: 7px; height: 11px; border-radius: 999px; border: 1px solid; display: flex; justify-content: flex-end; padding: 2px; }
                .pv-input i { width: 7px; height: 7px; border-radius: 50%; display: block; }
                .pv-check { position: absolute; top: 14px; right: 14px; width: 18px; height: 18px; border-radius: 50%; background: var(--acc); color: var(--on-acc); font-size: 11px; font-weight: 900; display: none; align-items: center; justify-content: center; z-index: 1; }
                .preset-card.active .pv-check { display: flex; }
                .preset-head { display: flex; align-items: center; gap: 6px; padding: 0 3px; margin-bottom: 3px; min-width: 0; }
                .pv .pill { position: absolute; top: 6px; left: 7px; z-index: 1; }
                .pill { margin-left: auto; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 999px; background: rgba(74, 222, 128, 0.12); color: #86efac; border: 1px solid rgba(74, 222, 128, 0.25); white-space: nowrap; flex-shrink: 0; }
                .pill.epub { background: rgba(245, 158, 11, 0.14); color: #fcd34d; border-color: rgba(245, 158, 11, 0.3); }
                .pill.scroll { background: rgba(96, 165, 250, 0.14); color: #93c5fd; border-color: rgba(96, 165, 250, 0.3); }
                .preset-title { font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
                .preset-desc { font-size: 11.5px; color: var(--tx2); line-height: 1.45; padding: 0 3px; }
                .launch-row { display: flex; flex-wrap: wrap; gap: 8px; }
                .launch-row .btn { min-height: 36px; font-weight: 600; font-size: 12.5px; }
                .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; }
                .field { display: flex; flex-direction: column; gap: 7px; font-size: 13px; }
                .field label { display: flex; justify-content: space-between; gap: 8px; color: var(--tx2); font-weight: 600; font-size: 12.5px; }
                .field label span { color: var(--tx); font-variant-numeric: tabular-nums; }
                .field input[type="range"], .field select, .field textarea { width: 100%; }
                .field textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; resize: vertical; }
                .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 11px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; line-height: 1.45; cursor: pointer; }
                .toggle-row:last-child { border-bottom: none; }
                .footer { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 12px 20px; padding-bottom: calc(12px + env(safe-area-inset-bottom)); background: var(--bg1); border-top: 1px solid var(--line); }
                .footer-sec { display: flex; gap: 8px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
                .footer-sec::-webkit-scrollbar { display: none; }
                .footer-sec .btn { font-weight: 600; font-size: 12.5px; }
                @media (max-width: 680px) {
                    .shell { margin: 0; border-radius: 0; border: none; max-height: 100vh; max-height: 100dvh; height: 100%; }
                    .header { padding: calc(10px + env(safe-area-inset-top)) 14px 10px; }
                    .header h1 .ver { display: none; }
                    .close-btn { padding: 0 11px; font-size: 12.5px; }
                    .close-btn .lbl-long { display: none; }
                    .content { padding: 12px 12px 18px; gap: 12px; }
                    .section { padding: 14px; border-radius: 14px; }
                    .preset-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
                    .preset-desc { display: none; }
                    .preset-title { white-space: normal; line-height: 1.35; font-size: 12.5px; }
                    .pv { height: 62px; }
                    .footer { padding: 10px 12px; padding-bottom: calc(10px + env(safe-area-inset-bottom)); }
                    .footer-sec .btn { min-height: 36px; padding: 0 11px; font-size: 12px; }
                }
                @media (prefers-reduced-motion: reduce) {
                    *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
                }
                body { transition: background 140ms ease; }
                .shell, .section, .header, .footer, .badge, .field, .toggle-row, .preset-grid {
                    transition: opacity 140ms ease, background 140ms ease, border-color 140ms ease;
                }
                body.live-previewing {
                    background: transparent !important;
                    backdrop-filter: none !important;
                    -webkit-backdrop-filter: none !important;
                }
                body.live-previewing .content {
                    scrollbar-width: none !important;
                }
                body.live-previewing .content::-webkit-scrollbar {
                    display: none !important;
                }
                body.live-previewing .shell,
                body.live-previewing .section,
                body.live-previewing .header,
                body.live-previewing .footer {
                    background: transparent !important;
                    border-color: transparent !important;
                    box-shadow: none !important;
                }
                body.live-previewing .header,
                body.live-previewing .footer,
                body.live-previewing .badge,
                body.live-previewing .section h2,
                body.live-previewing .section .sub,
                body.live-previewing .preset-grid,
                body.live-previewing .toggle-row:not(.active-preview-field),
                body.live-previewing .field:not(.active-preview-field) {
                    opacity: 0 !important;
                    visibility: hidden !important;
                    pointer-events: none !important;
                }
                body.live-previewing .active-preview-field {
                    opacity: 0.96 !important;
                    visibility: visible !important;
                    background: rgba(16, 20, 32, 0.84) !important;
                    border: 1px solid rgba(129, 140, 248, 0.65) !important;
                    border-radius: 12px;
                    padding: 10px 14px !important;
                    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.38);
                }
            </style>
            <div class="shell">
                <div class="header">
                    <h1><span class="logo">${RS_MARK_SVG}</span>RisuStand <span class="ver">v${RISUSTAND_VERSION}</span></h1>
                    <div class="hdr-actions">
                        <button class="close-btn" id="btn-open-clone">🖥️ <span class="lbl-long">공홈 · EPUB </span>전용 뷰</button>
                        <button class="close-btn" id="btn-close" aria-label="닫기">✕<span class="lbl-long"> 닫기</span></button>
                    </div>
                </div>
                <div class="content">
                    ${permBanner}

                    <div class="section">
                        <h2>🎨 기존 RisuAI 채팅 화면 꾸미기 (메인 화면 스킨)</h2>
                        <p class="sub">원래 RisuAI 채팅창과 봇 메뉴를 그대로 유지하면서 배경·카드·배색을 적용합니다.</p>
                        <div class="preset-grid">${mainSkinCards}</div>

                        <h2 style="margin-top:22px;">🖥️ 전체 화면 전용 뷰 바로 열기 (새 화면 렌더링)</h2>
                        <p class="sub">메인 채팅창 대신 전용 공홈 화면이나 1쪽·2쪽 전자책 뷰어를 전체 화면으로 바로 띄웁니다.</p>
                        <div class="launch-row">
                            <button class="btn btn-ghost" data-launch-clone="ai-gemini">✦ Gemini 공홈 뷰</button>
                            <button class="btn btn-ghost" data-launch-clone="ai-claude">✴ Claude 공홈 뷰</button>
                            <button class="btn btn-ghost" data-launch-clone="ai-chatgpt">● ChatGPT 공홈 뷰</button>
                            <button class="btn btn-ghost" data-launch-clone="epub-sepia-scroll">📜 EPUB 1쪽 (낮)</button>
                            <button class="btn btn-ghost" data-launch-clone="epub-night-scroll">📜 EPUB 1쪽 (밤)</button>
                            <button class="btn btn-ghost" data-launch-clone="epub-sepia">📖 EPUB 2쪽 펼침 (낮)</button>
                            <button class="btn btn-ghost" data-launch-clone="epub-night">🌙 EPUB 2쪽 펼침 (밤)</button>
                        </div>
                    </div>

                    <div class="section">
                        <h2>🎨 테마 · 화면 스타일 세부 조정</h2>
                        <p class="sub">게이지를 드래그하거나 토글을 누르면 창이 투명해지며 뒤쪽 RisuAI 화면에 실시간으로 반영됩니다.</p>
                        <div class="grid-2">
                            <div class="field">
                                <label>메시지 레이아웃 스타일</label>
                                <select id="th-bubble">
                                    <option value="chatbot" ${config.theme.bubbleStyle === 'chatbot' ? 'selected' : ''}>🤖 AI 챗봇 공홈</option>
                                    <option value="epub" ${config.theme.bubbleStyle === 'epub' ? 'selected' : ''}>📖 EPUB 전자책</option>
                                    <option value="glass" ${config.theme.bubbleStyle === 'glass' ? 'selected' : ''}>글래스 톤 카드</option>
                                    <option value="card" ${config.theme.bubbleStyle === 'card' ? 'selected' : ''}>솔리드 카드</option>
                                    <option value="flat" ${config.theme.bubbleStyle === 'flat' ? 'selected' : ''}>플랫 액센트 바</option>
                                    <option value="default" ${config.theme.bubbleStyle === 'default' ? 'selected' : ''}>기본 레이아웃</option>
                                </select>
                            </div>
                            <div class="field">
                                <label>기본 시스템 글꼴 (무용량)</label>
                                <select id="th-font-family">${fontOptions}</select>
                            </div>
                            <div class="field">
                                <label>본문 최대 너비 <span id="th-width-val">${config.theme.chatMaxWidth}px</span></label>
                                <input type="range" id="th-width" min="580" max="1160" step="20" value="${config.theme.chatMaxWidth}" />
                            </div>
                            <div class="field">
                                <label>글자 크기 <span id="th-font-val">${config.theme.fontSize}px</span></label>
                                <input type="range" id="th-font" min="13" max="21" step="1" value="${config.theme.fontSize}" />
                            </div>
                            <div class="field">
                                <label>줄 간격 <span id="th-lh-val">${config.theme.lineHeight}</span></label>
                                <input type="range" id="th-lh" min="1.3" max="2.3" step="0.05" value="${config.theme.lineHeight}" />
                            </div>
                        </div>
                        <div style="margin-top:12px;">
                            <label class="toggle-row">
                                <span>문단 양쪽 정렬</span>
                                <input type="checkbox" id="th-justify" ${config.theme.justifyText ? 'checked' : ''} />
                            </label>
                            <label class="toggle-row">
                                <span>입력창을 중앙 캡슐 도크 형태로 변환</span>
                                <input type="checkbox" id="ly-capsule" ${config.layout.floatingCapsuleInput ? 'checked' : ''} />
                            </label>
                            <label class="toggle-row">
                                <span>젠(Zen) 집중 모드 — 사이드바 숨기기</span>
                                <input type="checkbox" id="ly-zen" ${config.layout.zenMode ? 'checked' : ''} />
                            </label>
                            <label class="toggle-row">
                                <span>사이드바 좌↔우 반전 배치</span>
                                <input type="checkbox" id="ly-right" ${config.layout.sidebarRight ? 'checked' : ''} />
                            </label>
                            <label class="toggle-row">
                                <span>메시지 수정/삭제 버튼을 마우스 올릴 때만 표시</span>
                                <input type="checkbox" id="ly-hover" ${config.layout.hoverActionsOnly ? 'checked' : ''} />
                            </label>
                        </div>
                        <div class="field" style="margin-top:12px;">
                            <label>추가 커스텀 CSS</label>
                            <textarea id="th-css" rows="3">${escapeHtml(config.theme.customCSS)}</textarea>
                        </div>
                    </div>

                    <div class="section">
                        <h2>🛠️ 편의 기능 &amp; UX 설정</h2>
                        <p class="sub">외출용 에셋 가리기, 상단 미니 바 동작, EPUB 기본 보기 및 리로드 깜빡임 완화를 설정합니다.</p>
                        <div>
                            <label class="toggle-row">
                                <span>🕶️ 외출(에셋 가리기) — 채팅 이미지 숨김 + AI 원형 배지</span>
                                <input type="checkbox" id="st-enabled" ${config.stealth.mode !== 'off' ? 'checked' : ''} />
                            </label>
                            <label class="toggle-row">
                                <span>상단 드래그·자동 최소화 미니 바 표시</span>
                                <input type="checkbox" id="ly-topbar" ${config.layout.showFloatingTopBar ? 'checked' : ''} />
                            </label>
                            <label class="toggle-row">
                                <span>EPUB 풀스크린 기본 2쪽 양면 펼침 보기</span>
                                <input type="checkbox" id="ly-epub2" ${config.layout.epubTwoPage ? 'checked' : ''} />
                            </label>
                            <label class="toggle-row">
                                <span>전체 화면 뷰 자동 새로고침 (페이지 넘길 때 자연스럽게 반영)</span>
                                <input type="checkbox" id="ly-autorefresh" ${config.layout.autoRefreshClone ? 'checked' : ''} />
                            </label>
                            <label class="toggle-row">
                                <span>리로드 높이 잠금(Anti-Collapse) 활성화 — 깜빡임 완화</span>
                                <input type="checkbox" id="af-enabled" ${config.antiFlicker.enabled ? 'checked' : ''} />
                            </label>
                        </div>
                        <div class="grid-2" style="margin-top:12px;">
                            <div class="field">
                                <label>미니 바 자동 최소화 대기 시간 <span id="ly-minsec-val">${config.layout.autoMinimizeSec}초</span></label>
                                <input type="range" id="ly-minsec" min="2" max="15" step="1" value="${config.layout.autoMinimizeSec}" />
                            </div>
                            <div class="field">
                                <label>리로드 높이 유지 시간 <span id="af-lock-val">${config.antiFlicker.lockMs}ms</span></label>
                                <input type="range" id="af-lock-ms" min="350" max="2400" step="50" value="${config.antiFlicker.lockMs}" />
                            </div>
                        </div>
                    </div>
                </div>
                <div class="footer">
                    <div class="footer-sec">
                        <button class="btn btn-ghost" id="btn-reset">기본값 복원</button>
                        <button class="btn btn-ghost" id="btn-reset-pos">상단 바 위치 초기화</button>
                        ${!domPermissionGranted ? '<button class="btn btn-ghost" id="btn-perm">mainDom 권한 요청</button>' : ''}
                    </div>
                    <button class="btn btn-primary" id="btn-apply">저장 및 적용</button>
                </div>
            </div>
        `;

        document.getElementById('btn-close').onclick = async () => {
            clearStudioListeners();
            currentIframeMode = null;
            await risuai.hideContainer();
        };
        document.getElementById('btn-open-clone').onclick = async () => {
            clearStudioListeners();
            const cur = PRESETS[config.theme.preset];
            if (cur?.isChatbot) {
                await renderCloneView(config.theme.preset);
            } else {
                const isDark = cur?.scheme?.type === 'dark';
                await renderCloneView(isDark ? 'epub-night' : 'epub-sepia');
            }
        };
        document.getElementById('btn-reset-pos').onclick = async () => {
            config.layout.topBarPos = null;
            await saveConfig();
            await syncTopBar();
        };

        let liveCssTimer = null;
        const scheduleLiveCSSPreview = () => {
            if (liveCssTimer) return;
            liveCssTimer = setTimeout(async () => {
                liveCssTimer = null;
                await upsertStyleTag('theme-layout-stealth', buildLayoutAndThemeCSS());
            }, 50);
        };

        let flashPreviewTimer = null;
        const enterLivePreview = (inputEl) => {
            if (flashPreviewTimer) {
                clearTimeout(flashPreviewTimer);
                flashPreviewTimer = null;
            }
            document.body.classList.add('live-previewing');
            document.querySelectorAll('.active-preview-field').forEach((el) => el.classList.remove('active-preview-field'));
            const wrap = inputEl && inputEl.closest ? inputEl.closest('.field, .toggle-row') : null;
            if (wrap) wrap.classList.add('active-preview-field');
        };
        const exitLivePreview = () => {
            if (flashPreviewTimer) {
                clearTimeout(flashPreviewTimer);
                flashPreviewTimer = null;
            }
            document.body.classList.remove('live-previewing');
            document.querySelectorAll('.active-preview-field').forEach((el) => el.classList.remove('active-preview-field'));
        };
        const flashLivePreview = (inputEl, ms = 2000) => {
            enterLivePreview(inputEl);
            flashPreviewTimer = setTimeout(() => {
                flashPreviewTimer = null;
                exitLivePreview();
            }, ms);
        };

        const bindLiveRange = (id, valId, fmt, onVal) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.onpointerdown = () => enterLivePreview(el);
            el.onpointerup = exitLivePreview;
            el.onpointercancel = exitLivePreview;
            el.onchange = exitLivePreview;
            el.oninput = (e) => {
                const v = e.target.value;
                const lbl = document.getElementById(valId);
                if (lbl) lbl.textContent = fmt(v);
                onVal(v);
                scheduleLiveCSSPreview();
            };
        };

        studioPointerUpHandler = () => { if (!flashPreviewTimer) exitLivePreview(); };
        window.addEventListener('pointerup', studioPointerUpHandler, { passive: true });

        document.getElementById('ly-minsec').oninput = (e) => { document.getElementById('ly-minsec-val').textContent = `${e.target.value}초`; };
        document.getElementById('af-lock-ms').oninput = (e) => { document.getElementById('af-lock-val').textContent = `${e.target.value}ms`; };

        bindLiveRange('th-width', 'th-width-val', (v) => `${v}px`, (v) => { config.theme.chatMaxWidth = Number(v); });
        bindLiveRange('th-font', 'th-font-val', (v) => `${v}px`, (v) => { config.theme.fontSize = Number(v); });
        bindLiveRange('th-lh', 'th-lh-val', (v) => `${v}`, (v) => { config.theme.lineHeight = Number(v); });

        // Apply live 2-second crystal-clear preview on typography/layout/stealth toggles & dropdowns
        const bindFlashControl = (id, applyFn) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.onchange = (e) => {
                applyFn(e.target);
                scheduleLiveCSSPreview();
                flashLivePreview(el, 2000);
            };
        };
        bindFlashControl('th-bubble', (el) => { config.theme.bubbleStyle = el.value; });
        bindFlashControl('th-font-family', (el) => { config.theme.fontFamily = el.value; });
        bindFlashControl('th-justify', (el) => { config.theme.justifyText = el.checked; });
        bindFlashControl('st-enabled', (el) => {
            config.stealth.mode = el.checked ? 'soft' : 'off';
            config.stealth.hideSidebarAvatars = config.stealth.mode !== 'off';
        });
        bindFlashControl('ly-capsule', (el) => { config.layout.floatingCapsuleInput = el.checked; });
        bindFlashControl('ly-zen', (el) => { config.layout.zenMode = el.checked; });
        bindFlashControl('ly-right', (el) => { config.layout.sidebarRight = el.checked; });
        bindFlashControl('ly-hover', (el) => { config.layout.hoverActionsOnly = el.checked; });

        document.querySelectorAll('[data-launch-clone]').forEach((btn) => {
            btn.onclick = async () => {
                clearStudioListeners();
                const targetMode = btn.getAttribute('data-launch-clone');
                await renderCloneView(targetMode);
            };
        });

        document.querySelectorAll('.preset-card').forEach((btn) => {
            btn.onclick = async () => {
                const key = btn.getAttribute('data-preset');
                const p = PRESETS[key];
                if (!p) return;
                config.theme = { ...config.theme, preset: key, ...p.defaults };
                if (p.stealthDefaults) config.stealth = { ...config.stealth, ...p.stealthDefaults };
                if (p.layoutDefaults) config.layout = { ...config.layout, ...p.layoutDefaults };
                await saveConfig();
                await applyAll();
                renderStudioUI();
            };
        });

        const permBtn = document.getElementById('btn-perm');
        if (permBtn) {
            permBtn.onclick = async () => {
                await ensureRootDocument();
                await setupDragDocumentListeners();
                await setupAntiFlickerEngine();
                await applyAll();
                renderStudioUI();
            };
        }

        document.getElementById('btn-reset').onclick = async () => {
            config = structuredClone(DEFAULT_CONFIG);
            config.theme.preset = 'original';
            config.theme = { ...config.theme, ...PRESETS.original.defaults };
            config.stealth = { ...PRESETS.original.stealthDefaults };
            config.layout = { ...config.layout, showFloatingTopBar: false, floatingCapsuleInput: false, zenMode: false, sidebarRight: false, hoverActionsOnly: false, compactHeaders: false };
            await saveConfig();
            await setupAntiFlickerEngine();
            await applyAll();
            renderStudioUI();
        };

        document.getElementById('btn-apply').onclick = async () => {
            config.stealth.mode = document.getElementById('st-enabled').checked ? 'soft' : 'off';
            config.stealth.hideSidebarAvatars = config.stealth.mode !== 'off';

            config.layout.showFloatingTopBar = document.getElementById('ly-topbar').checked;
            config.layout.autoMinimizeSec = Number(document.getElementById('ly-minsec').value);
            config.layout.epubTwoPage = document.getElementById('ly-epub2').checked;
            config.layout.autoRefreshClone = document.getElementById('ly-autorefresh').checked;
            config.layout.floatingCapsuleInput = document.getElementById('ly-capsule').checked;
            config.layout.zenMode = document.getElementById('ly-zen').checked;
            config.layout.sidebarRight = document.getElementById('ly-right').checked;
            config.layout.hoverActionsOnly = document.getElementById('ly-hover').checked;

            config.antiFlicker.enabled = document.getElementById('af-enabled').checked;
            config.antiFlicker.lockMs = Number(document.getElementById('af-lock-ms').value);

            config.theme.bubbleStyle = document.getElementById('th-bubble').value;
            config.theme.fontFamily = document.getElementById('th-font-family').value;
            config.theme.justifyText = document.getElementById('th-justify').checked;
            config.theme.chatMaxWidth = Number(document.getElementById('th-width').value);
            config.theme.fontSize = Number(document.getElementById('th-font').value);
            config.theme.lineHeight = Number(document.getElementById('th-lh').value);
            config.theme.customCSS = document.getElementById('th-css').value;

            await saveConfig();
            await setupAntiFlickerEngine();
            await applyAll();
            currentIframeMode = null;
            await risuai.hideContainer();
        };
    }

    async function openStudio() {
        await risuai.showContainer('fullscreen');
        renderStudioUI();
    }

    async function updateQuickButtons() {
        await risuai.registerButton(
            {
                name: 'RisuStand 설정',
                icon: '📖',
                iconType: 'html',
                location: 'hamburger',
                id: 'risustand-studio-btn',
            },
            openStudio
        );

        await risuai.registerButton(
            {
                name: 'RisuStand 전용 뷰 (EPUB·공홈)',
                icon: '📖',
                iconType: 'html',
                location: 'hamburger',
                id: 'risustand-clone-btn',
            },
            openCloneView
        );
    }

    // =========================================================================
    // 6. Bootstrap & Cleanup
    // =========================================================================
    const PERMS_PROMPTED_KEY = 'risustand_perms_prompted_v3';
    const PERMS_PROMPT_TTL_MS = Math.floor(2.9 * 24 * 60 * 60 * 1000);

    function computePluginBuildSig() {
        try {
            const src = String(risustandPluginMain);
            let h = 2166136261;
            for (let i = 0; i < src.length; i++) {
                h ^= src.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            return (h >>> 0).toString(16);
        } catch (_) {
            return '0';
        }
    }
    const PLUGIN_BUILD_SIG = computePluginBuildSig();

    async function requestAllPermissionsOnce(force = false) {
        try {
            if (!force) {
                const already = await risuai.pluginStorage.getItem(PERMS_PROMPTED_KEY);
                const raw = String(already || '');
                const parts = raw.split(':');
                const ver = parts[0] || '';
                const sig = parts.length >= 3 ? parts[1] : '';
                const ts = parts.length >= 3 ? Number(parts[2]) : NaN;
                if (
                    ver === RISUSTAND_VERSION &&
                    sig === PLUGIN_BUILD_SIG &&
                    Number.isFinite(ts) &&
                    (Date.now() - ts) < PERMS_PROMPT_TTL_MS
                ) {
                    return;
                }
            }
        } catch (_) {}

        try { await ensureRootDocument(); } catch (_) {}
        try { await risuai.getDatabase(['enabledModules']); } catch (_) {}
        try { await risuai.setDatabaseLite({}); } catch (_) {}
        if (typeof risuai.readInlay === 'function') {
            try { await risuai.readInlay('__risustand_perm_probe__'); } catch (_) {}
        }

        if (typeof risuai.requestPluginPermission === 'function') {
            for (const perm of ['mainDom', 'db', 'dbWrite', 'sendChat', 'inlay']) {
                try {
                    await risuai.requestPluginPermission(perm);
                } catch (_) {}
            }
        }

        try {
            await risuai.pluginStorage.setItem(PERMS_PROMPTED_KEY, `${RISUSTAND_VERSION}:${PLUGIN_BUILD_SIG}:${Date.now()}`);
        } catch (_) {}
    }

    await loadConfig();
    await requestAllPermissionsOnce(false);
    await ensureRootDocument();
    await setupDragDocumentListeners();
    await setupAntiFlickerEngine();
    await applyAll();

    await risuai.registerSetting(
        'RisuStand (리수 독서대)',
        openStudio,
        '🚀',
        'html',
        'risustand-setting'
    );

    chatOutputListener = async () => {
        if (currentIframeMode === 'clone' && config.layout.autoRefreshClone) {
            pendingCloneRefresh = true;
        }
    };
    try {
        await risuai.addRisuChatListener('output', chatOutputListener);
    } catch (_) {}


    // =========================================================================
    // 7. Integrated RisuStand Remote Bridge Engine (v2.0)
    // =========================================================================
    async function initIntegratedRemoteBridge() {
    
        const STORAGE_KEY = 'risustand_remote_bridge_v2';
        const LEGACY_KEY = 'risustand_remote_bridge_v1';
        const SWIPE_STORE_KEY = 'risustand_swipe_history_v1';
        const DEFAULT_CFG = {
            enabled: false,
            relayUrl: 'http://127.0.0.1:8787',
            token: '',
            includeImages: true,
            pollIntervalMs: 1800,
        };
    
        let cfg = { ...DEFAULT_CFG };
        let pollTimer = null;
        let isPolling = false;
        let pendingForcePoll = false;
        let isGenerating = false;
        let lastStatus = '대기 중';
        let lastSyncTime = '';
        let lastSnapSig = '';
        let lastCatalogSig = '';
        const CATALOG_POLL_INTERVAL_MS = 18000;
        const SNAP_DB_TTL_MS = 10000;
        let lastCatalogBuildAt = 0;
        let lastCatalogPcChar = -2;
        let lastCatalogPcChat = -2;
        let cachedSnapDb = null;
        let cachedSnapDbAt = 0;
        let pendingTriggerEvent = null;
        let lastPcAlertSig = '';
        let viewCharIndex = -1;
        let viewChatIndex = -1;
        const assetDataCache = new Map();
        const charIdByIndex = new Map(); // charIndex -> chaId
        let swipeHistory = Object.create(null);

        function makeSwipeKey(charObj, cIdx, chatObj, chIdx, msgIdx) {
            return `${(charObj && charObj.chaId) || cIdx}:${(chatObj && chatObj.id) || chIdx}:${msgIdx}`;
        }

        function recordSwipeVersion(key, prevText, nextText) {
            let entry = swipeHistory[key];
            if (!entry || !Array.isArray(entry.swipes)) {
                entry = { swipes: [], index: 0 };
            }
            const prev = String(prevText ?? '');
            if (prev && !entry.swipes.includes(prev)) {
                entry.swipes.push(prev);
            }
            if (nextText !== undefined && nextText !== null) {
                const nxt = String(nextText);
                const existingIdx = entry.swipes.indexOf(nxt);
                if (existingIdx >= 0) {
                    entry.index = existingIdx;
                } else {
                    entry.swipes.push(nxt);
                    entry.index = entry.swipes.length - 1;
                }
            } else {
                entry.index = Math.max(0, entry.swipes.length - 1);
            }
            delete swipeHistory[key];
            swipeHistory[key] = entry;
            const keys = Object.keys(swipeHistory);
            while (keys.length > 60) {
                delete swipeHistory[keys.shift()];
            }
            return entry;
        }

        async function saveSwipeHistory() {
            try {
                await risuai.pluginStorage.setItem(SWIPE_STORE_KEY, JSON.stringify(swipeHistory));
            } catch (_) {}
        }
    
        async function loadCfg() {
            try {
                let raw = await risuai.pluginStorage.getItem(STORAGE_KEY);
                if (!raw) raw = await risuai.pluginStorage.getItem(LEGACY_KEY);
                if (raw) {
                    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    cfg = { ...DEFAULT_CFG, ...parsed };
                }
            } catch (_) {}
            try {
                const swRaw = await risuai.pluginStorage.getItem(SWIPE_STORE_KEY);
                if (swRaw) {
                    const parsedSw = typeof swRaw === 'string' ? JSON.parse(swRaw) : swRaw;
                    if (parsedSw && typeof parsedSw === 'object') {
                        swipeHistory = Object.assign(Object.create(null), parsedSw);
                    }
                }
            } catch (_) {}
        }
    
        async function saveCfg() {
            try {
                await risuai.pluginStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
            } catch (_) {}
        }
    
        function parseDefaultVariables(text, target) {
            if (!text || typeof text !== 'string') return;
            for (const rawLine of text.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line || line.startsWith('#')) continue;
                const eq = line.indexOf('=');
                if (eq <= 0) continue;
                const k = line.slice(0, eq).trim();
                const v = line.slice(eq + 1).trim();
                if (k) target[k] = v;
            }
        }

        function applyDefaultToggleSyntax(syntax, target) {
            if (!syntax || typeof syntax !== 'string' || !target) return;
            for (const rawLine of syntax.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line || line.startsWith('//') || line.startsWith('#') || line.startsWith('=group') || line.startsWith('=divider')) continue;
                const parts = line.split('=');
                if (parts.length < 2) continue;
                const key = (parts[0] || '').trim();
                if (!key || key.startsWith('=')) continue;
                const kind = (parts[2] || '').trim().toLowerCase();
                if (kind === 'caption' || kind === 'group' || kind === 'groupend' || kind === 'divider') continue;
                const defVal = (kind === 'text' || kind === 'textarea') ? '' : '0';
                const fullKey = key.startsWith('toggle_') ? key : ('toggle_' + key);
                if (!Object.prototype.hasOwnProperty.call(target, fullKey)) {
                    target[fullKey] = defVal;
                }
            }
        }

        function findMatchingClose(str, openIdx) {
            let depth = 0;
            let i = openIdx;
            while (i < str.length - 1) {
                if (str[i] === '{' && str[i + 1] === '{') {
                    depth += 1;
                    i += 2;
                    continue;
                }
                if (str[i] === '}' && str[i + 1] === '}') {
                    depth -= 1;
                    if (depth === 0) return i;
                    i += 2;
                    continue;
                }
                i += 1;
            }
            return -1;
        }

        function splitTopLevel(str, delim = '::') {
            const parts = [];
            let depth = 0;
            let start = 0;
            let i = 0;
            while (i < str.length) {
                if (str[i] === '{' && str[i + 1] === '{') {
                    depth += 1;
                    i += 2;
                    continue;
                }
                if (str[i] === '}' && str[i + 1] === '}') {
                    depth = Math.max(0, depth - 1);
                    i += 2;
                    continue;
                }
                if (depth === 0 && str.startsWith(delim, i)) {
                    parts.push(str.slice(start, i));
                    i += delim.length;
                    start = i;
                    continue;
                }
                i += 1;
            }
            parts.push(str.slice(start));
            return parts;
        }

        function isCbsTruthy(v) {
            const s = String(v ?? '').trim().toLowerCase();
            return s !== '' && s !== '0' && s !== 'false' && s !== 'null' && s !== 'undefined';
        }

        function evalSimpleExpr(expr) {
            const src = String(expr || '').trim();
            if (!src) return '0';
            let pos = 0;
            const skipWs = () => { while (pos < src.length && /\s/.test(src[pos])) pos++; };
            const peek = () => { skipWs(); return src.slice(pos); };

            function parsePrimary() {
                skipWs();
                if (src[pos] === '(') {
                    pos++;
                    const v = parseOr();
                    skipWs();
                    if (src[pos] === ')') pos++;
                    return v;
                }
                if (src[pos] === '"' || src[pos] === "'") {
                    const q = src[pos++];
                    let out = '';
                    while (pos < src.length && src[pos] !== q) {
                        if (src[pos] === '\\' && pos + 1 < src.length) pos++;
                        out += src[pos++];
                    }
                    if (src[pos] === q) pos++;
                    return out;
                }
                const mNum = src.slice(pos).match(/^-?\d+(?:\.\d+)?/);
                if (mNum) {
                    pos += mNum[0].length;
                    return Number(mNum[0]);
                }
                const mId = src.slice(pos).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
                if (mId) {
                    pos += mId[0].length;
                    if (mId[0] === 'true') return 1;
                    if (mId[0] === 'false' || mId[0] === 'null' || mId[0] === 'undefined') return 0;
                    return mId[0];
                }
                return 0;
            }
            function parseUnary() {
                const rest = peek();
                if (rest.startsWith('!')) { pos++; return isCbsTruthy(parseUnary()) ? 0 : 1; }
                if (rest.startsWith('-') && !/^-\d/.test(rest)) { pos++; return -Number(parseUnary() || 0); }
                return parsePrimary();
            }
            function parseMul() {
                let left = parseUnary();
                while (true) {
                    const rest = peek();
                    const op = rest[0];
                    if (op !== '*' && op !== '/' && op !== '%') break;
                    pos++;
                    const right = Number(parseUnary() || 0);
                    const l = Number(left || 0);
                    left = op === '*' ? l * right : op === '/' ? (right === 0 ? 0 : l / right) : (right === 0 ? 0 : l % right);
                }
                return left;
            }
            function parseAdd() {
                let left = parseMul();
                while (true) {
                    const rest = peek();
                    const op = rest[0];
                    if (op !== '+' && op !== '-') break;
                    pos++;
                    const right = parseMul();
                    if (op === '+' && (typeof left === 'string' || typeof right === 'string')) left = String(left) + String(right);
                    else left = op === '+' ? Number(left || 0) + Number(right || 0) : Number(left || 0) - Number(right || 0);
                }
                return left;
            }
            function parseCmp() {
                let left = parseAdd();
                while (true) {
                    const rest = peek();
                    const m = rest.match(/^(===|!==|==|!=|>=|<=|=|>|<)/);
                    if (!m) break;
                    pos += m[1].length;
                    const right = parseAdd();
                    const op = m[1];
                    const bothNum = (typeof left === 'number' || (typeof left === 'string' && left.trim() !== '' && Number.isFinite(Number(left))))
                        && (typeof right === 'number' || (typeof right === 'string' && right.trim() !== '' && Number.isFinite(Number(right))));
                    if (op === '=' || op === '==' || op === '===') left = (String(left) === String(right) || (bothNum && Number(left) === Number(right))) ? 1 : 0;
                    else if (op === '!=' || op === '!==') left = (String(left) !== String(right) && !(bothNum && Number(left) === Number(right))) ? 1 : 0;
                    else if (op === '>') left = Number(left) > Number(right) ? 1 : 0;
                    else if (op === '<') left = Number(left) < Number(right) ? 1 : 0;
                    else if (op === '>=') left = Number(left) >= Number(right) ? 1 : 0;
                    else if (op === '<=') left = Number(left) <= Number(right) ? 1 : 0;
                }
                return left;
            }
            function parseAnd() {
                let left = parseCmp();
                while (peek().startsWith('&&')) {
                    pos += 2;
                    const right = parseCmp();
                    left = isCbsTruthy(left) && isCbsTruthy(right) ? 1 : 0;
                }
                return left;
            }
            function parseOr() {
                let left = parseAnd();
                while (peek().startsWith('||')) {
                    pos += 2;
                    const right = parseAnd();
                    left = isCbsTruthy(left) || isCbsTruthy(right) ? 1 : 0;
                }
                return left;
            }
            try {
                const res = parseOr();
                return typeof res === 'number' && !Number.isFinite(res) ? '0' : String(res);
            } catch (_) {
                return '0';
            }
        }

        function evalWhenCondition(rawCond, ctx, depth) {
            const tokens = splitTopLevel(String(rawCond || ''), '::').map((t) => t.trim());
            while (tokens.length && (tokens[0] === 'keep' || tokens[0] === 'legacy')) {
                tokens.shift();
            }
            if (!tokens.length) return false;

            const evalWhenCmp = (leftRaw, op, rightRaw) => {
                const lStr = String(leftRaw ?? '');
                const rStr = String(rightRaw ?? '');
                if (op === 'is' || op === '==' || op === '=') return lStr === rStr;
                if (op === 'isnot' || op === '!=') return lStr !== rStr;
                if (op === '>' || op === 'greater') return Number(lStr) > Number(rStr);
                if (op === '<' || op === 'less') return Number(lStr) < Number(rStr);
                if (op === '>=' || op === 'greater_equal' || op === 'greaterequal') return Number(lStr) >= Number(rStr);
                if (op === '<=' || op === 'less_equal' || op === 'lessequal') return Number(lStr) <= Number(rStr);
                if (op === 'includes' || op === 'contains') {
                    if (lStr.trim().startsWith('[')) {
                        try {
                            const arr = JSON.parse(lStr);
                            if (Array.isArray(arr)) return arr.some((x) => String(x) === rStr);
                        } catch (_) {}
                    }
                    return lStr.includes(rStr);
                }
                if (op === 'in' || op === 'notin') {
                    let found = false;
                    if (rStr.trim().startsWith('[')) {
                        try {
                            const arr = JSON.parse(rStr);
                            if (Array.isArray(arr)) found = arr.some((x) => String(x) === lStr);
                        } catch (_) {}
                    } else {
                        found = rStr.split(',').map((s) => s.trim()).includes(lStr);
                    }
                    return op === 'in' ? found : !found;
                }
                return false;
            };

            const CMP_OPS = new Set([
                'is', 'isnot', 'vis', 'visnot', 'tis', 'tisnot',
                '==', '=', '!=', '>', 'greater', '<', 'less',
                '>=', 'greater_equal', 'greaterequal', '<=', 'less_equal', 'lessequal',
                'in', 'notin', 'includes', 'contains',
            ]);

            const evalAtom = (arr) => {
                if (!arr.length) return false;
                let neg = false;
                let idx = 0;
                while (idx < arr.length && arr[idx] === 'not') {
                    neg = !neg;
                    idx += 1;
                }
                const rem = arr.slice(idx);
                let result = false;
                if (rem.length === 1 && (rem[0] === 'is_first_msg' || rem[0] === 'isfirstmsg')) {
                    result = ctx.chatIndex === -1 || ctx.chatIndex === 0;
                } else if (rem.length === 1 && (rem[0] === 'is_last_msg' || rem[0] === 'islastmsg')) {
                    result = ctx.chatIndex === ctx.lastMessageId;
                } else if (rem.length >= 3 && CMP_OPS.has(rem[1])) {
                    const op = rem[1];
                    const right = evalCBS(rem.slice(2).join('::'), ctx, depth + 1).trim();
                    if (op === 'vis' || op === 'visnot') {
                        const varKey = evalCBS(rem[0], ctx, depth + 1).trim();
                        const val = Object.prototype.hasOwnProperty.call(ctx.vars, varKey) ? String(ctx.vars[varKey] ?? '') : '';
                        result = op === 'vis' ? (val === right) : (val !== right);
                    } else if (op === 'tis' || op === 'tisnot') {
                        const togKey = evalCBS(rem[0], ctx, depth + 1).trim();
                        const val = Object.prototype.hasOwnProperty.call(ctx.globalVars, 'toggle_' + togKey)
                            ? String(ctx.globalVars['toggle_' + togKey] ?? '')
                            : (Object.prototype.hasOwnProperty.call(ctx.globalVars, togKey) ? String(ctx.globalVars[togKey] ?? '') : '');
                        result = op === 'tis' ? (val === right) : (val !== right);
                    } else {
                        const left = evalCBS(rem[0], ctx, depth + 1).trim();
                        result = evalWhenCmp(left, op, right);
                    }
                } else if (rem.length >= 2 && (rem[0] === 'var' || rem[0] === 'toggle')) {
                    const k = evalCBS(rem[1], ctx, depth + 1).trim();
                    const rawVal = rem[0] === 'var'
                        ? (Object.prototype.hasOwnProperty.call(ctx.vars, k) ? ctx.vars[k] : 'null')
                        : (Object.prototype.hasOwnProperty.call(ctx.globalVars, k)
                            ? ctx.globalVars[k]
                            : ctx.globalVars['toggle_' + k]);
                    if (rem.length >= 4 && CMP_OPS.has(rem[2])) {
                        const r = evalCBS(rem.slice(3).join('::'), ctx, depth + 1).trim();
                        result = evalWhenCmp(String(rawVal ?? ''), rem[2], r);
                    } else {
                        result = isCbsTruthy(rawVal);
                    }
                } else {
                    const val = evalCBS(rem.join('::'), ctx, depth + 1).trim();
                    result = isCbsTruthy(val);
                }
                return neg ? !result : result;
            };

            // Split by ::or:: (lowest precedence) then ::and::
            const orGroups = [];
            let curOr = [];
            for (const tok of tokens) {
                if (tok === 'or') {
                    orGroups.push(curOr);
                    curOr = [];
                } else {
                    curOr.push(tok);
                }
            }
            orGroups.push(curOr);

            for (const og of orGroups) {
                const andAtoms = [];
                let curAnd = [];
                for (const tok of og) {
                    if (tok === 'and') {
                        andAtoms.push(curAnd);
                        curAnd = [];
                    } else {
                        curAnd.push(tok);
                    }
                }
                andAtoms.push(curAnd);
                if (andAtoms.length && andAtoms.every((a) => evalAtom(a))) {
                    return true;
                }
            }
            return false;
        }

        function findBlockBranches(str, startAfterOpen, ignoreElse = false) {
            const branches = [];
            let blockDepth = 1;
            let segStart = startAfterOpen;
            let curCond = null; // first segment condition is handled by caller
            let pos = startAfterOpen;
            while (pos < str.length) {
                const openAt = str.indexOf('{{', pos);
                if (openAt < 0) break;
                const closeAt = findMatchingClose(str, openAt);
                if (closeAt < 0) break;
                const inner = str.slice(openAt + 2, closeAt);
                const trimmed = inner.trim();

                if (/^#(?:when|if|if_pure|each|func|escape)(?:[\s:]|$)/i.test(trimmed)) {
                    blockDepth += 1;
                } else if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
                    blockDepth -= 1;
                    if (blockDepth === 0) {
                        branches.push({ cond: curCond, body: str.slice(segStart, openAt) });
                        return { branches, endPos: closeAt + 2 };
                    }
                } else if (!ignoreElse && blockDepth === 1 && /^:(?:else|elif|elseif|else\s+if)(?:[\s:]|$)/i.test(trimmed)) {
                    branches.push({ cond: curCond, body: str.slice(segStart, openAt) });
                    if (/^:else\s*$/i.test(trimmed)) {
                        curCond = '__ELSE__';
                    } else {
                        curCond = trimmed.replace(/^:(?:elif|elseif|else\s+if)(?:::|\s+)/i, '');
                    }
                    segStart = closeAt + 2;
                }
                pos = closeAt + 2;
            }
            return null;
        }

        function parseEachHeader(argStr) {
            const topParts = splitTopLevel(argStr, '::');
            if (topParts.length >= 2) {
                return {
                    iterExpr: topParts.slice(0, -1).join('::').trim(),
                    slotName: topParts[topParts.length - 1].trim(),
                };
            }
            let depth = 0;
            let lastWsStart = -1;
            let lastWsEnd = -1;
            let i = 0;
            while (i < argStr.length) {
                if (argStr[i] === '{' && argStr[i + 1] === '{') {
                    depth += 1;
                    i += 2;
                    continue;
                }
                if (argStr[i] === '}' && argStr[i + 1] === '}') {
                    depth = Math.max(0, depth - 1);
                    i += 2;
                    continue;
                }
                if (depth === 0 && /\s/.test(argStr[i])) {
                    const start = i;
                    while (i < argStr.length && /\s/.test(argStr[i])) i += 1;
                    if (i < argStr.length) {
                        lastWsStart = start;
                        lastWsEnd = i;
                    }
                    continue;
                }
                i += 1;
            }
            if (lastWsStart >= 0) {
                return {
                    iterExpr: argStr.slice(0, lastWsStart).trim(),
                    slotName: argStr.slice(lastWsEnd).trim(),
                };
            }
            return { iterExpr: argStr.trim(), slotName: '' };
        }

        function getModuleAssetListJson(ns, ctx) {
            const nsLower = String(ns || '').trim().toLowerCase();
            const mods = Array.isArray(ctx && ctx.enabledModules) ? ctx.enabledModules : [];
            let matched = mods.filter((m) => {
                if (!m) return false;
                if (!nsLower) return true;
                return String(m.namespace || '').trim().toLowerCase() === nsLower;
            });
            if (!matched.length && nsLower) {
                matched = mods.filter((m) => m && (
                    String(m.id || '').trim().toLowerCase() === nsLower ||
                    String(m.name || '').trim().toLowerCase() === nsLower
                ));
            }
            const out = [];
            const seen = new Set();
            for (const m of matched) {
                if (!Array.isArray(m.assets)) continue;
                for (const a of m.assets) {
                    if (!Array.isArray(a) || !a[0]) continue;
                    const name = String(a[0]);
                    if (!seen.has(name)) {
                        seen.add(name);
                        out.push(name);
                    }
                    if (a[2] && !name.includes('.')) {
                        const withExt = `${name}.${String(a[2])}`;
                        if (!seen.has(withExt)) {
                            seen.add(withExt);
                            out.push(withExt);
                        }
                    }
                }
            }
            return JSON.stringify(out);
        }

        function evalCBS(input, ctx, depth = 0) {
            const str = String(input ?? '');
            if (!str || depth > 200 || !str.includes('{{')) return str;

            let out = '';
            let pos = 0;
            while (pos < str.length) {
                const openAt = str.indexOf('{{', pos);
                if (openAt < 0) {
                    out += str.slice(pos);
                    break;
                }
                out += str.slice(pos, openAt);
                const closeAt = findMatchingClose(str, openAt);
                if (closeAt < 0) {
                    out += str.slice(openAt);
                    break;
                }
                const rawInner = str.slice(openAt + 2, closeAt);
                const trimmed = rawInner.trim();

                // Raw escape block: {{#escape}}...{{/escape}}
                if (/^#escape(?:[\s:]|$)/i.test(trimmed)) {
                    const parsed = findBlockBranches(str, closeAt + 2, true);
                    if (parsed) {
                        out += parsed.branches.length ? parsed.branches[0].body : '';
                        pos = parsed.endPos;
                        continue;
                    }
                }

                // Pure display block: {{#pure_display}}...{{/pure_display}} / {{#pure}}...{{/pure}}
                if (/^#pure(?:_?display)?(?:[\s:]|$)/i.test(trimmed)) {
                    const parsed = findBlockBranches(str, closeAt + 2, true);
                    if (parsed) {
                        out += evalCBS(parsed.branches.length ? parsed.branches[0].body : '', ctx, depth + 1);
                        pos = parsed.endPos;
                        continue;
                    }
                }

                // Block conditionals: {{#when...}}, {{#if...}}, {{#if_pure...}}
                const blockMatch = trimmed.match(/^#(when|if_pure|if)(?:::|\s+)([\s\S]*)$/i);
                if (blockMatch) {
                    const parsed = findBlockBranches(str, closeAt + 2);
                    if (parsed) {
                        const firstCond = blockMatch[2];
                        let chosenBody = '';
                        for (let bi = 0; bi < parsed.branches.length; bi++) {
                            const br = parsed.branches[bi];
                            const condStr = bi === 0 ? firstCond : br.cond;
                            if (condStr === '__ELSE__' || evalWhenCondition(condStr, ctx, depth)) {
                                chosenBody = br.body;
                                break;
                            }
                        }
                        if (chosenBody) {
                            let bodyToRender = chosenBody;
                            if (bodyToRender.startsWith('\r\n')) bodyToRender = bodyToRender.slice(2);
                            else if (bodyToRender.startsWith('\n')) bodyToRender = bodyToRender.slice(1);
                            out += evalCBS(bodyToRender, ctx, depth + 1);
                        }
                        pos = parsed.endPos;
                        continue;
                    }
                }

                // Loop block: {{#each arrayExpr slotName}}...{{/each}}
                const eachMatch = trimmed.match(/^#each(?:::|\s+)([\s\S]*)$/i);
                if (eachMatch) {
                    const parsed = findBlockBranches(str, closeAt + 2);
                    if (parsed) {
                        const { iterExpr, slotName } = parseEachHeader(eachMatch[1]);
                        const rawList = evalCBS(iterExpr, ctx, depth + 1).trim();
                        let arr = [];
                        if (rawList.startsWith('[')) {
                            try {
                                const parsedArr = JSON.parse(rawList);
                                if (Array.isArray(parsedArr)) arr = parsedArr;
                            } catch (_) {}
                        }
                        if (!arr.length && rawList && !rawList.startsWith('[')) {
                            arr = rawList.split('::').filter(Boolean);
                        }
                        let bodyToRender = parsed.branches.length ? parsed.branches[0].body : '';
                        if (bodyToRender.startsWith('\r\n')) bodyToRender = bodyToRender.slice(2);
                        else if (bodyToRender.startsWith('\n')) bodyToRender = bodyToRender.slice(1);

                        const slots = ctx.slots || (ctx.slots = Object.create(null));
                        const hadPrev = slotName && Object.prototype.hasOwnProperty.call(slots, slotName);
                        const prevVal = hadPrev ? slots[slotName] : undefined;
                        const limit = Math.min(arr.length, 20000);
                        for (let i = 0; i < limit; i++) {
                            if (slotName) slots[slotName] = String(arr[i] ?? '');
                            const iterOut = evalCBS(bodyToRender, ctx, depth + 1);
                            if (/\S/.test(iterOut)) out += iterOut;
                        }
                        if (slotName) {
                            if (hadPrev) slots[slotName] = prevVal;
                            else delete slots[slotName];
                        }
                        pos = parsed.endPos;
                        continue;
                    }
                }

                // Define inline CBS function {{#func name [args...]}}...{{/func}}
                const funcMatch = trimmed.match(/^#func(?:(?:::|\s+)([\s\S]*))?$/i);
                if (funcMatch) {
                    const parsed = findBlockBranches(str, closeAt + 2, true);
                    if (parsed) {
                        const headerTokens = String(funcMatch[1] || '').split(/(?:\s+|::)/).map((t) => t.trim()).filter(Boolean);
                        const funcName = headerTokens[0] || '';
                        if (funcName) {
                            if (!ctx.functions) ctx.functions = new Map();
                            ctx.functions.set(funcName, {
                                data: (parsed.branches[0] ? parsed.branches[0].body : '').trim(),
                                params: headerTokens.slice(1),
                            });
                        }
                        pos = parsed.endPos;
                        continue;
                    }
                }

                // Preserve asset/inlay macros for inline resolution (resolve nested CBS inside arguments)
                const assetMacro = rawInner.match(/^\s*(img|raw|path|asset|image|emotion|inlay|inlayed)::([\s\S]+)$/i);
                if (assetMacro) {
                    const resolvedArg = evalCBS(assetMacro[2], ctx, depth + 1).trim();
                    out += `{{${assetMacro[1].toLowerCase()}::${resolvedArg}}}`;
                    pos = closeAt + 2;
                    continue;
                }

                // Expression {{? ...}}
                if (trimmed.startsWith('?')) {
                    const exprStr = evalCBS(trimmed.slice(1), ctx, depth + 1);
                    out += evalSimpleExpr(exprStr);
                    pos = closeAt + 2;
                    continue;
                }

                const parts = splitTopLevel(rawInner, '::');
                let cmd = (parts[0] || '').trim().toLowerCase();
                let effectiveParts = parts;
                if (parts.length === 1 && cmd.includes(':')) {
                    const colonIdx = rawInner.indexOf(':');
                    cmd = rawInner.slice(0, colonIdx).trim().toLowerCase();
                    effectiveParts = [cmd, rawInner.slice(colonIdx + 1)];
                }

                if (cmd === 'user') {
                    out += ctx.userName || 'User';
                } else if (cmd === 'char') {
                    out += ctx.charName || 'Character';
                } else if (cmd === 'persona') {
                    out += ctx.personaPrompt || '';
                } else if (cmd === 'description' || cmd === 'char_desc') {
                    out += ctx.charDesc || '';
                } else if (cmd === 'personality') {
                    out += ctx.personality || '';
                } else if (cmd === 'scenario') {
                    out += ctx.scenario || '';
                } else if (cmd === 'authorsnote' || cmd === 'authornote') {
                    out += ctx.note || '';
                } else if (cmd === 'globalnote') {
                    out += ctx.globalNote || '';
                } else if (cmd === 'mainprompt') {
                    out += ctx.mainPrompt || '';
                } else if (cmd === 'jailbreak') {
                    out += ctx.jailbreak || '';
                } else if (cmd === 'source') {
                    const target = evalCBS(effectiveParts[1] || '', ctx, depth + 1).trim().toLowerCase();
                    const rawSrc = target === 'user' ? String(ctx.userIcon || '') : (target === 'char' ? String(ctx.charImage || '') : '');
                    if (rawSrc) {
                        out += /^(?:https?:\/\/|data:image\/|\/)/i.test(rawSrc) ? rawSrc : `{{raw::${rawSrc}}}`;
                    }
                } else if (cmd === 'lastmessage') {
                    const list = Array.isArray(ctx.chatList) ? ctx.chatList : [];
                    if (list.length) out += String((list[list.length - 1] && list[list.length - 1].content) ?? '');
                } else if (cmd === 'lastcharmessage') {
                    const list = Array.isArray(ctx.chatList) ? ctx.chatList : [];
                    for (let li = list.length - 1; li >= 0; li -= 1) {
                        if (list[li] && list[li].role !== 'user') { out += String(list[li].content ?? ''); break; }
                    }
                } else if (cmd === 'lastusermessage') {
                    const list = Array.isArray(ctx.chatList) ? ctx.chatList : [];
                    for (let li = list.length - 1; li >= 0; li -= 1) {
                        if (list[li] && list[li].role === 'user') { out += String(list[li].content ?? ''); break; }
                    }
                } else if (cmd === 'firstmessage') {
                    out += String(ctx.firstMessage || '');
                } else if (cmd === 'idle_duration' || cmd === 'idleduration') {
                    out += String(ctx.idleDuration || '0s');
                } else if (cmd === 'role') {
                    out += ctx.msgRole || 'char';
                } else if (cmd === 'br' || cmd === 'newline') {
                    out += '\n';
                } else if (cmd === 'blank' || cmd === 'comment' || cmd === 'hidden_key' || cmd === 'hiddenkey' || cmd.startsWith('//')) {
                    // hidden / non-prose
                } else if (cmd === 'chat_index' || cmd === 'chatindex' || cmd === 'chat_id') {
                    out += String(ctx.chatIndex ?? 0);
                } else if (cmd === 'lastmessageid' || cmd === 'last_message_id') {
                    out += String(ctx.lastMessageId ?? 0);
                } else if (cmd === 'message_count' || cmd === 'msgcount') {
                    out += String(Array.isArray(ctx.chatList) ? ctx.chatList.length : Math.max(0, (ctx.lastMessageId ?? -1) + 1));
                } else if (cmd === 'is_first_msg' || cmd === 'isfirstmsg') {
                    out += (ctx.chatIndex === -1 || ctx.chatIndex === 0) ? '1' : '0';
                } else if (cmd === 'is_last_msg' || cmd === 'islastmsg') {
                    out += (ctx.chatIndex === ctx.lastMessageId) ? '1' : '0';
                } else if (cmd === 'previous_chat_log' || cmd === 'previouschatlog') {
                    const idx = Number(evalCBS(effectiveParts[1] || '', ctx, depth + 1).trim());
                    if (Array.isArray(ctx.chatList) && Number.isInteger(idx) && idx >= 0 && idx < ctx.chatList.length) {
                        out += String((ctx.chatList[idx] && ctx.chatList[idx].content) ?? '');
                    }
                } else if (cmd === 'history' || cmd === 'raw_history') {
                    const sub = evalCBS(effectiveParts[1] || '', ctx, depth + 1).trim().toLowerCase();
                    const list = Array.isArray(ctx.chatList) ? ctx.chatList : [];
                    if (sub === 'role') {
                        out += JSON.stringify(list.map((m) => `${m && m.role === 'user' ? 'user' : 'char'}: ${String((m && m.content) ?? '')}`));
                    } else {
                        out += JSON.stringify(list.map((m) => String((m && m.content) ?? '')));
                    }
                } else if (cmd === 'array' || cmd === 'makearray' || cmd === 'a') {
                    out += JSON.stringify(effectiveParts.slice(1).map((p) => evalCBS(p, ctx, depth + 1)));
                } else if (cmd === 'length') {
                    const valStr = evalCBS(effectiveParts[1] || '', ctx, depth + 1);
                    const tr = valStr.trim();
                    let lenOut = null;
                    if (tr.startsWith('[')) {
                        try {
                            const parsed = JSON.parse(tr);
                            if (Array.isArray(parsed)) lenOut = String(parsed.length);
                        } catch (_) {}
                    }
                    out += lenOut !== null ? lenOut : String(valStr.length);
                } else if (cmd === 'contains') {
                    const hay = evalCBS(effectiveParts[1] || '', ctx, depth + 1);
                    const needle = evalCBS(effectiveParts[2] || '', ctx, depth + 1);
                    out += hay.includes(needle) ? '1' : '0';
                } else if (cmd === 'replace') {
                    const srcText = evalCBS(effectiveParts[1] || '', ctx, depth + 1);
                    const fromStr = evalCBS(effectiveParts[2] || '', ctx, depth + 1);
                    const toStr = evalCBS(effectiveParts[3] || '', ctx, depth + 1);
                    out += srcText.split(fromStr).join(toStr);
                } else if (cmd === 'ruby') {
                    const baseTxt = evalCBS(effectiveParts[1] || '', ctx, depth + 1);
                    const rtTxt = evalCBS(effectiveParts[2] || '', ctx, depth + 1);
                    out += `<ruby>${baseTxt}<rt>${rtTxt}</rt></ruby>`;
                } else if (cmd === 'random') {
                    let choices = effectiveParts.slice(1).map((p) => evalCBS(p, ctx, depth + 1));
                    if (choices.length === 1) {
                        if (choices[0].includes(':')) choices = choices[0].split(':');
                        else if (choices[0].includes(',')) choices = choices[0].split(',');
                    }
                    if (choices.length) out += String(choices[Math.floor(Math.random() * choices.length)] ?? '');
                } else if (cmd === 'roll') {
                    const spec = evalCBS(effectiveParts[1] || '20', ctx, depth + 1).trim();
                    const dm = spec.match(/^(\d+)d(\d+)$/i);
                    if (dm) {
                        const cnt = Math.min(100, Math.max(1, Number(dm[1]) || 1));
                        const sides = Math.max(1, Number(dm[2]) || 20);
                        let total = 0;
                        for (let ri = 0; ri < cnt; ri += 1) total += 1 + Math.floor(Math.random() * sides);
                        out += String(total);
                    } else {
                        const sides = Math.max(1, Number(spec) || 20);
                        out += String(1 + Math.floor(Math.random() * sides));
                    }
                } else if (cmd === 'u' || cmd === 'unicode') {
                    const cp = parseInt(evalCBS(effectiveParts[1] || '', ctx, depth + 1).trim(), 16);
                    if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10FFFF) out += String.fromCodePoint(cp);
                } else if (cmd === 'time' || cmd === 'date' || cmd === 'isodate' || cmd === 'isotime' || cmd === 'unixtime') {
                    const d = new Date();
                    if (cmd === 'unixtime') {
                        out += String(Math.floor(d.getTime() / 1000));
                    } else if (cmd === 'isodate') {
                        out += d.toISOString().slice(0, 10);
                    } else if (cmd === 'isotime') {
                        out += d.toISOString().slice(11, 19);
                    } else {
                        const pad = (n) => String(n).padStart(2, '0');
                        const defFmt = cmd === 'date' ? 'YYYY-MM-DD' : 'HH:mm:ss';
                        const fmt = evalCBS(effectiveParts[1] || defFmt, ctx, depth + 1).trim() || defFmt;
                        const tMap = { YYYY: String(d.getFullYear()), YY: String(d.getFullYear()).slice(-2), MM: pad(d.getMonth() + 1), DD: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) };
                        out += fmt.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (tk) => tMap[tk] ?? tk);
                    }
                } else if (cmd === 'slot') {
                    const k = evalCBS(parts[1] || '', ctx, depth + 1).trim();
                    const slots = ctx.slots || {};
                    if (k && Object.prototype.hasOwnProperty.call(slots, k)) {
                        out += String(slots[k]);
                    } else if (!k) {
                        const first = Object.values(slots)[0];
                        out += first !== undefined ? String(first) : '';
                    }
                } else if (cmd === 'module_assetlist' || cmd === 'moduleassetlist') {
                    const ns = evalCBS(parts.slice(1).join('::'), ctx, depth + 1);
                    out += getModuleAssetListJson(ns, ctx);
                } else if (cmd === 'assetlist' || cmd === 'char_assetlist') {
                    const list = Array.isArray(ctx && ctx.charAssetNames) ? ctx.charAssetNames : [];
                    out += JSON.stringify(list);
                } else if (cmd === 'emotionlist') {
                    const list = Array.isArray(ctx && ctx.emotionNames) ? ctx.emotionNames : [];
                    out += JSON.stringify(list);
                } else if (cmd === 'button') {
                    const lbl = evalCBS(parts[1] || '', ctx, depth + 1).trim();
                    const trig = evalCBS(parts[2] || '', ctx, depth + 1).trim();
                    if (trig) {
                        out += `<button type="button" class="risu-cbs-btn" risu-trigger="${escapeHtml(trig)}">${escapeHtml(lbl || trig)}</button>`;
                    }
                } else if (cmd === 'getvar' || cmd === 'getchatvar' || cmd === 'var') {
                    const k = evalCBS(parts[1] || '', ctx, depth + 1).trim();
                    out += Object.prototype.hasOwnProperty.call(ctx.vars, k) ? String(ctx.vars[k]) : 'null';
                } else if (cmd === 'setvar') {
                    const k = evalCBS(parts[1] || '', ctx, depth + 1).trim();
                    const v = evalCBS(parts.slice(2).join('::'), ctx, depth + 1);
                    if (k) ctx.vars[k] = v;
                } else if (cmd === 'setdefaultvar') {
                    const k = evalCBS(parts[1] || '', ctx, depth + 1).trim();
                    const v = evalCBS(parts.slice(2).join('::'), ctx, depth + 1);
                    if (k && (!Object.prototype.hasOwnProperty.call(ctx.vars, k) || ctx.vars[k] === 'null' || ctx.vars[k] === '')) {
                        ctx.vars[k] = v;
                    }
                } else if (cmd === 'addvar' || cmd === 'subvar' || cmd === 'mulvar' || cmd === 'divvar') {
                    const k = evalCBS(parts[1] || '', ctx, depth + 1).trim();
                    const operand = Number(evalCBS(parts[2] || '0', ctx, depth + 1)) || 0;
                    const curNum = Number(ctx.vars[k]) || 0;
                    if (k) {
                        if (cmd === 'addvar') ctx.vars[k] = String(curNum + operand);
                        else if (cmd === 'subvar') ctx.vars[k] = String(curNum - operand);
                        else if (cmd === 'mulvar') ctx.vars[k] = String(curNum * operand);
                        else ctx.vars[k] = operand === 0 ? '0' : String(curNum / operand);
                    }
                } else if (cmd === 'gettempvar' || cmd === 'tempvar') {
                    const k = evalCBS(parts[1] || '', ctx, depth + 1).trim();
                    out += Object.prototype.hasOwnProperty.call(ctx.tempVars, k) ? String(ctx.tempVars[k]) : '';
                } else if (cmd === 'settempvar') {
                    const k = evalCBS(parts[1] || '', ctx, depth + 1).trim();
                    const v = evalCBS(parts.slice(2).join('::'), ctx, depth + 1);
                    if (k) ctx.tempVars[k] = v;
                } else if (cmd === 'getglobalvar' || cmd === 'globalvar' || cmd === 'toggle') {
                    const k = evalCBS(parts[1] || '', ctx, depth + 1).trim();
                    if (Object.prototype.hasOwnProperty.call(ctx.globalVars, k)) out += String(ctx.globalVars[k]);
                    else if (Object.prototype.hasOwnProperty.call(ctx.globalVars, 'toggle_' + k)) out += String(ctx.globalVars['toggle_' + k]);
                    else out += 'null';
                } else if (cmd === 'equal' || cmd === 'eq' || cmd === '==') {
                    const a = evalCBS(parts[1] || '', ctx, depth + 1).trim();
                    const b = evalCBS(parts[2] || '', ctx, depth + 1).trim();
                    const na = Number(a);
                    const nb = Number(b);
                    out += (a === b || (cmd !== 'equal' && a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb) && na === nb)) ? '1' : '0';
                } else if (cmd === 'not_equal' || cmd === 'notequal' || cmd === 'neq' || cmd === '!=') {
                    const a = evalCBS(parts[1] || '', ctx, depth + 1).trim();
                    const b = evalCBS(parts[2] || '', ctx, depth + 1).trim();
                    const na = Number(a);
                    const nb = Number(b);
                    out += (a !== b && !(cmd !== 'not_equal' && cmd !== 'notequal' && a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb) && na === nb)) ? '1' : '0';
                } else if (cmd === 'greater' || cmd === 'gt' || cmd === 'greaterthan' || cmd === 'greater_than' || cmd === '>') {
                    const a = Number(evalCBS(parts[1] || '', ctx, depth + 1).trim());
                    const b = Number(evalCBS(parts[2] || '', ctx, depth + 1).trim());
                    out += a > b ? '1' : '0';
                } else if (cmd === 'less' || cmd === 'lt' || cmd === 'lessthan' || cmd === 'less_than' || cmd === '<') {
                    const a = Number(evalCBS(parts[1] || '', ctx, depth + 1).trim());
                    const b = Number(evalCBS(parts[2] || '', ctx, depth + 1).trim());
                    out += a < b ? '1' : '0';
                } else if (cmd === 'greater_equal' || cmd === 'greaterequal' || cmd === 'gte' || cmd === 'greaterthanequal' || cmd === 'greater_than_equal' || cmd === '>=') {
                    const a = Number(evalCBS(parts[1] || '', ctx, depth + 1).trim());
                    const b = Number(evalCBS(parts[2] || '', ctx, depth + 1).trim());
                    out += a >= b ? '1' : '0';
                } else if (cmd === 'less_equal' || cmd === 'lessequal' || cmd === 'lte' || cmd === 'lessthanequal' || cmd === 'less_than_equal' || cmd === '<=') {
                    const a = Number(evalCBS(parts[1] || '', ctx, depth + 1).trim());
                    const b = Number(evalCBS(parts[2] || '', ctx, depth + 1).trim());
                    out += a <= b ? '1' : '0';
                } else if (cmd === 'tonumber') {
                    const n = Number(evalCBS(parts[1] || '', ctx, depth + 1).trim());
                    out += Number.isFinite(n) ? String(n) : '0';
                } else if (cmd === 'return') {
                    out += evalCBS(parts[1] || '', ctx, depth + 1);
                } else if (cmd === 'and' || cmd === 'all') {
                    const vals = parts.slice(1).map((p) => evalCBS(p, ctx, depth + 1));
                    out += vals.length && vals.every((v) => isCbsTruthy(v)) ? '1' : '0';
                } else if (cmd === 'or' || cmd === 'any') {
                    const vals = parts.slice(1).map((p) => evalCBS(p, ctx, depth + 1));
                    out += vals.some((v) => isCbsTruthy(v)) ? '1' : '0';
                } else if (cmd === 'not') {
                    out += isCbsTruthy(evalCBS(parts[1] || '', ctx, depth + 1)) ? '0' : '1';
                } else if (cmd === 'abs') {
                    const v = Number(evalCBS(parts.slice(1).join('::'), ctx, depth + 1).trim()) || 0;
                    out += String(Math.abs(v));
                } else if (cmd === 'sum') {
                    let s = 0;
                    for (const p of parts.slice(1)) {
                        s += Number(evalCBS(p, ctx, depth + 1).trim()) || 0;
                    }
                    out += String(s);
                } else if (cmd === 'calc') {
                    out += evalSimpleExpr(evalCBS(parts.slice(1).join('::'), ctx, depth + 1));
                } else if (cmd === 'trim') {
                    out += evalCBS(parts.slice(1).join('::'), ctx, depth + 1).trim();
                } else if (cmd === 'lower' || cmd === 'lowercase') {
                    out += evalCBS(parts.slice(1).join('::'), ctx, depth + 1).toLowerCase();
                } else if (cmd === 'upper' || cmd === 'uppercase') {
                    out += evalCBS(parts.slice(1).join('::'), ctx, depth + 1).toUpperCase();
                } else if (cmd === 'includes') {
                    const hay = evalCBS(parts[1] ?? '', ctx, depth + 1);
                    const needle = evalCBS(parts.slice(2).join('::'), ctx, depth + 1);
                    let found = hay.includes(needle);
                    if (!found && hay.trim().startsWith('[')) {
                        try {
                            const arr = JSON.parse(hay);
                            if (Array.isArray(arr)) found = arr.some((item) => String(item) === needle);
                        } catch {}
                    }
                    out += found ? '1' : '0';
                } else if (cmd === 'startswith') {
                    const hay = evalCBS(parts[1] ?? '', ctx, depth + 1);
                    const prefix = evalCBS(parts.slice(2).join('::'), ctx, depth + 1);
                    out += hay.startsWith(prefix) ? '1' : '0';
                } else if (cmd === 'endswith') {
                    const hay = evalCBS(parts[1] ?? '', ctx, depth + 1);
                    const suffix = evalCBS(parts.slice(2).join('::'), ctx, depth + 1);
                    out += hay.endsWith(suffix) ? '1' : '0';
                } else if (cmd === 'index_of' || cmd === 'indexof') {
                    const hay = evalCBS(parts[1] ?? '', ctx, depth + 1);
                    const needle = evalCBS(parts.slice(2).join('::'), ctx, depth + 1);
                    let idx = -1;
                    if (hay.trim().startsWith('[')) {
                        try {
                            const arr = JSON.parse(hay);
                            if (Array.isArray(arr)) idx = arr.findIndex((item) => String(item) === needle);
                        } catch {}
                    }
                    if (idx < 0 && !hay.trim().startsWith('[')) idx = hay.indexOf(needle);
                    out += String(idx);
                } else if (cmd === 'split') {
                    const src = evalCBS(parts[1] ?? '', ctx, depth + 1);
                    const sep = parts.length > 2 ? evalCBS(parts.slice(2).join('::'), ctx, depth + 1) : ',';
                    out += JSON.stringify(src.split(sep));
                } else if (cmd === 'join') {
                    const rawArr = evalCBS(parts[1] ?? '', ctx, depth + 1).trim();
                    const sep = parts.length > 2 ? evalCBS(parts.slice(2).join('::'), ctx, depth + 1) : ',';
                    let items = [];
                    if (rawArr.startsWith('[')) {
                        try {
                            const parsed = JSON.parse(rawArr);
                            if (Array.isArray(parsed)) items = parsed.map((v) => String(v ?? ''));
                        } catch {}
                    } else if (rawArr) {
                        items = rawArr.split('§');
                    }
                    out += items.join(sep);
                } else if (cmd === 'array_element' || cmd === 'arrayelement') {
                    const rawArr = evalCBS(parts[1] ?? '', ctx, depth + 1).trim();
                    const idx = Math.trunc(Number(evalCBS(parts[2] ?? '0', ctx, depth + 1)));
                    let items = null;
                    if (rawArr.startsWith('[')) {
                        try {
                            const parsed = JSON.parse(rawArr);
                            if (Array.isArray(parsed)) items = parsed;
                        } catch {}
                    }
                    if (items && Number.isInteger(idx)) {
                        const resolvedIdx = idx < 0 ? items.length + idx : idx;
                        if (resolvedIdx >= 0 && resolvedIdx < items.length) {
                            const v = items[resolvedIdx];
                            out += typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
                        }
                    }
                } else if (cmd === 'array_length' || cmd === 'arraylength') {
                    const rawArr = evalCBS(parts[1] ?? '', ctx, depth + 1).trim();
                    let len = 0;
                    if (rawArr.startsWith('[')) {
                        try {
                            const parsed = JSON.parse(rawArr);
                            if (Array.isArray(parsed)) len = parsed.length;
                        } catch {}
                    }
                    out += String(len);
                } else if (cmd === 'round' || cmd === 'floor' || cmd === 'ceil') {
                    const n = Number(evalCBS(parts[1] ?? '0', ctx, depth + 1).trim()) || 0;
                    out += String(cmd === 'round' ? Math.round(n) : (cmd === 'floor' ? Math.floor(n) : Math.ceil(n)));
                } else if (cmd === 'min' || cmd === 'max') {
                    const nums = parts.slice(1).map((p) => Number(evalCBS(p, ctx, depth + 1).trim())).filter((n) => Number.isFinite(n));
                    out += nums.length ? String(cmd === 'min' ? Math.min(...nums) : Math.max(...nums)) : '0';
                } else if (cmd === 'rem' || cmd === 'mod') {
                    const a = Number(evalCBS(parts[1] ?? '0', ctx, depth + 1).trim()) || 0;
                    const b = Number(evalCBS(parts[2] ?? '1', ctx, depth + 1).trim()) || 0;
                    out += b === 0 ? '0' : String(a % b);
                } else if (cmd === 'fixnum' || cmd === 'tofixed') {
                    const n = Number(evalCBS(parts[1] ?? '0', ctx, depth + 1).trim()) || 0;
                    const dec = Math.max(0, Math.min(20, Math.trunc(Number(evalCBS(parts[2] ?? '0', ctx, depth + 1).trim()) || 0)));
                    out += n.toFixed(dec);
                } else if (cmd === 'substr' || cmd === 'substring' || cmd === 'slice') {
                    const s = evalCBS(parts[1] ?? '', ctx, depth + 1);
                    const start = Math.trunc(Number(evalCBS(parts[2] ?? '0', ctx, depth + 1).trim()) || 0);
                    if (parts.length > 3) {
                        const end = Math.trunc(Number(evalCBS(parts[3] ?? '0', ctx, depth + 1).trim()) || 0);
                        out += cmd === 'slice' ? s.slice(start, end) : s.substring(start, end);
                    } else {
                        out += cmd === 'slice' ? s.slice(start) : s.substring(start);
                    }
                } else if (cmd === 'capitalize') {
                    const s = evalCBS(parts.slice(1).join('::'), ctx, depth + 1);
                    out += s ? (s.charAt(0).toUpperCase() + s.slice(1)) : '';
                } else if (cmd === 'ltrim') {
                    out += evalCBS(parts.slice(1).join('::'), ctx, depth + 1).trimStart();
                } else if (cmd === 'rtrim') {
                    out += evalCBS(parts.slice(1).join('::'), ctx, depth + 1).trimEnd();
                } else if (cmd === 'padstart' || cmd === 'padend') {
                    const s = evalCBS(parts[1] ?? '', ctx, depth + 1);
                    const len = Math.max(0, Math.trunc(Number(evalCBS(parts[2] ?? '0', ctx, depth + 1).trim()) || 0));
                    const fill = parts.length > 3 ? evalCBS(parts[3] ?? ' ', ctx, depth + 1) : ' ';
                    out += cmd === 'padstart' ? s.padStart(len, fill) : s.padEnd(len, fill);
                } else if (cmd === 'repeat') {
                    const s = evalCBS(parts[1] ?? '', ctx, depth + 1);
                    const cnt = Math.max(0, Math.min(1000, Math.trunc(Number(evalCBS(parts[2] ?? '0', ctx, depth + 1).trim()) || 0)));
                    out += s.repeat(cnt);
                } else if (cmd === 'reverse') {
                    const s = evalCBS(parts.slice(1).join('::'), ctx, depth + 1);
                    if (s.trim().startsWith('[')) {
                        try {
                            const arr = JSON.parse(s);
                            if (Array.isArray(arr)) { out += JSON.stringify([...arr].reverse()); pos = closeAt + 2; continue; }
                        } catch {}
                    }
                    out += Array.from(s).reverse().join('');
                } else if (cmd === 'escape') {
                    out += escapeHtml(evalCBS(parts.slice(1).join('::'), ctx, depth + 1));
                } else if (cmd === 'unescape') {
                    out += evalCBS(parts.slice(1).join('::'), ctx, depth + 1)
                        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
                } else if (cmd === 'dictelement' || cmd === 'dict_element' || cmd === 'object_element') {
                    const rawObj = evalCBS(parts[1] ?? '', ctx, depth + 1).trim();
                    const key = evalCBS(parts[2] ?? '', ctx, depth + 1);
                    try {
                        const obj = JSON.parse(rawObj);
                        if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)) {
                            const v = obj[key];
                            out += typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
                        }
                    } catch {}
                } else if (cmd === 'object_keys' || cmd === 'object_values') {
                    const rawObj = evalCBS(parts[1] ?? '', ctx, depth + 1).trim();
                    try {
                        const obj = JSON.parse(rawObj);
                        if (obj && typeof obj === 'object') {
                            out += JSON.stringify(cmd === 'object_keys' ? Object.keys(obj) : Object.values(obj));
                        } else out += '[]';
                    } catch { out += '[]'; }
                } else if (cmd === 'makedict' || cmd === 'dict') {
                    const dict = {};
                    for (const pair of parts.slice(1)) {
                        const ev = evalCBS(pair, ctx, depth + 1);
                        const eqIdx = ev.indexOf('=');
                        if (eqIdx > 0) dict[ev.slice(0, eqIdx).trim()] = ev.slice(eqIdx + 1);
                    }
                    out += JSON.stringify(dict);
                } else if (cmd === 'array_push') {
                    const rawArr = evalCBS(parts[1] ?? '', ctx, depth + 1).trim();
                    let arr = [];
                    try { const p = JSON.parse(rawArr); if (Array.isArray(p)) arr = p; } catch {}
                    for (const extra of parts.slice(2)) arr.push(evalCBS(extra, ctx, depth + 1));
                    out += JSON.stringify(arr);
                } else if (cmd === 'array_slice') {
                    const rawArr = evalCBS(parts[1] ?? '', ctx, depth + 1).trim();
                    const start = Math.trunc(Number(evalCBS(parts[2] ?? '0', ctx, depth + 1).trim()) || 0);
                    let arr = [];
                    try { const p = JSON.parse(rawArr); if (Array.isArray(p)) arr = p; } catch {}
                    if (parts.length > 3) {
                        const end = Math.trunc(Number(evalCBS(parts[3] ?? '0', ctx, depth + 1).trim()) || 0);
                        out += JSON.stringify(arr.slice(start, end));
                    } else {
                        out += JSON.stringify(arr.slice(start));
                    }
                } else if (cmd === 'array_includes') {
                    const rawArr = evalCBS(parts[1] ?? '', ctx, depth + 1).trim();
                    const needle = evalCBS(parts[2] ?? '', ctx, depth + 1);
                    let ok = false;
                    try { const p = JSON.parse(rawArr); if (Array.isArray(p)) ok = p.some((x) => String(x) === needle); } catch {}
                    out += ok ? '1' : '0';
                } else if (cmd === 'range') {
                    const a = Math.trunc(Number(evalCBS(parts[1] ?? '0', ctx, depth + 1).trim()) || 0);
                    const b = parts.length > 2 ? Math.trunc(Number(evalCBS(parts[2] ?? '0', ctx, depth + 1).trim()) || 0) : a;
                    const s = parts.length > 2 ? a : 0;
                    const e = parts.length > 2 ? b : a;
                    const step = parts.length > 3 ? (Math.trunc(Number(evalCBS(parts[3] ?? '1', ctx, depth + 1).trim()) || 1) || 1) : (s <= e ? 1 : -1);
                    const res = [];
                    for (let v = s; step > 0 ? v < e : v > e; v += step) {
                        if (res.length >= 2000) break;
                        res.push(v);
                    }
                    out += JSON.stringify(res);
                } else if (cmd === 'spread') {
                    const rawArr = evalCBS(parts[1] ?? '', ctx, depth + 1).trim();
                    try {
                        const p = JSON.parse(rawArr);
                        if (Array.isArray(p)) out += p.join('::');
                    } catch {}
                } else if (cmd === 'call') {
                    if ((ctx.callStack || 0) <= 20) {
                        const argData = parts.slice(1).map((p) => evalCBS(p, ctx, depth + 1));
                        const funcName = String(argData[0] || '').trim();
                        const fn = ctx.functions && ctx.functions.get(funcName);
                        if (fn) {
                            let fnBody = fn.data;
                            for (let ai = 0; ai < argData.length; ai += 1) {
                                fnBody = fnBody.split(`{{arg::${ai}}}`).join(String(argData[ai] ?? ''));
                            }
                            out += evalCBS(fnBody, { ...ctx, callArgs: argData, callStack: (ctx.callStack || 0) + 1 }, depth + 1);
                        }
                    }
                } else if (cmd === 'arg') {
                    const idx = Number(evalCBS(parts[1] || '', ctx, depth + 1).trim());
                    if (Array.isArray(ctx.callArgs) && Number.isInteger(idx) && idx >= 0 && idx < ctx.callArgs.length) {
                        out += String(ctx.callArgs[idx] ?? '');
                    }
                } else {
                    out += str.slice(openAt, closeAt + 2);
                }

                pos = closeAt + 2;
            }
            return out;
        }

        function discoverGreetingVariables(rawText) {
            const defaults = {};
            const options = {};
            const str = String(rawText || '');
            let pos = 0;
            while ((pos = str.indexOf('{{#', pos)) !== -1) {
                const closeAt = findMatchingClose(str, pos);
                if (closeAt < 0) break;
                const inner = str.slice(pos + 2, closeAt);
                if (/^#(?:when|if|if_pure)(?:[\s:]|$)/i.test(inner)) {
                    const eqRe = /\{\{equal::\{\{(?:getvar|getchatvar)::([^}]+)\}\}::([^}]*)\}\}/gi;
                    let m;
                    while ((m = eqRe.exec(inner)) !== null) {
                        const k = m[1].trim();
                        const v = m[2].trim();
                        if (!k) continue;
                        if (!Object.prototype.hasOwnProperty.call(defaults, k)) defaults[k] = v;
                        if (!options[k]) options[k] = [];
                        if (!options[k].includes(v)) options[k].push(v);
                    }
                    const varRe = /::var::([^:]+)::is::([^:}]+)/gi;
                    while ((m = varRe.exec(inner)) !== null) {
                        const k = m[1].trim();
                        const v = m[2].trim();
                        if (!k) continue;
                        if (!Object.prototype.hasOwnProperty.call(defaults, k)) defaults[k] = v;
                        if (!options[k]) options[k] = [];
                        if (!options[k].includes(v)) options[k].push(v);
                    }
                }
                pos = closeAt + 2;
            }
            return { defaults, options };
        }

        function buildRenderContext(charObj, chatObj, db, personaName, enabledModules, msgIndex, totalMsgs, allMsgs = [], personaPrompt = '', extra = {}) {
            const vars = Object.create(null);
            for (const m of enabledModules || []) {
                if (m && m.defaultVariables) parseDefaultVariables(m.defaultVariables, vars);
            }
            if (charObj && charObj.defaultVariables) parseDefaultVariables(charObj.defaultVariables, vars);
            if (chatObj && chatObj.scriptstate && typeof chatObj.scriptstate === 'object') {
                for (const [k, v] of Object.entries(chatObj.scriptstate)) {
                    const cleanKey = k.startsWith('$') ? k.slice(1) : k;
                    if (cleanKey && v !== undefined && v !== null && typeof v !== 'object') {
                        vars[cleanKey] = String(v);
                    }
                }
            }

            const globalVars = Object.create(null);
            for (const m of enabledModules || []) {
                if (m && m.customModuleToggle) applyDefaultToggleSyntax(m.customModuleToggle, globalVars);
            }
            if (charObj && charObj.customModuleToggle) applyDefaultToggleSyntax(charObj.customModuleToggle, globalVars);
            if (db && db.globalChatVariables && typeof db.globalChatVariables === 'object') {
                Object.assign(globalVars, db.globalChatVariables);
            }
            if (chatObj && chatObj.useLocallySetGlobalVariables && chatObj.GLGlobalVariables && typeof chatObj.GLGlobalVariables === 'object') {
                Object.assign(globalVars, chatObj.GLGlobalVariables);
            }

            const sortDisplayScripts = (scripts) => {
                if (!Array.isArray(scripts) || scripts.length <= 1) return scripts;
                const getMeta = (sc) => {
                    const flag = (sc && sc.flag) ? String(sc.flag) : '';
                    let bucket = 1;
                    if (flag.includes('<move_top>')) bucket = 0;
                    else if (flag.includes('<move_bottom>')) bucket = 2;
                    const ordMatch = flag.match(/<order\s+(-?\d+)>/i);
                    const order = ordMatch ? Number(ordMatch[1]) : 0;
                    return { bucket, order };
                };
                return scripts
                    .map((sc, idx) => ({ sc, idx, meta: getMeta(sc) }))
                    .sort((a, b) => {
                        if (a.meta.bucket !== b.meta.bucket) return a.meta.bucket - b.meta.bucket;
                        if (a.meta.order !== b.meta.order) return b.meta.order - a.meta.order;
                        return a.idx - b.idx;
                    })
                    .map((x) => x.sc);
            };

            const displayScripts = [];
            if (db && Array.isArray(db.customscript)) {
                for (const sc of db.customscript) if (sc && sc.type === 'editdisplay') displayScripts.push(sc);
            }
            for (const m of enabledModules || []) {
                const modRegex = m && (Array.isArray(m.regex) ? m.regex : (Array.isArray(m.customScripts) ? m.customScripts : null));
                if (modRegex) {
                    for (const sc of modRegex) if (sc && sc.type === 'editdisplay') displayScripts.push(sc);
                }
            }
            const charScripts = charObj && (Array.isArray(charObj.customscript) ? charObj.customscript : (Array.isArray(charObj.customScripts) ? charObj.customScripts : null));
            if (charScripts) {
                for (const sc of charScripts) if (sc && sc.type === 'editdisplay') displayScripts.push(sc);
            }

            const collectCharAssetNames = (arr) => {
                const out = [];
                const seen = new Set();
                for (const item of arr || []) {
                    if (!Array.isArray(item) || !item[0]) continue;
                    const name = String(item[0]);
                    if (!seen.has(name)) {
                        seen.add(name);
                        out.push(name);
                    }
                }
                return out;
            };
            const emotionNames = collectCharAssetNames(charObj && charObj.emotionImages);
            const additionalAssetNames = collectCharAssetNames(charObj && charObj.additionalAssets);
            const charAssetNames = additionalAssetNames.length ? additionalAssetNames : emotionNames;

            return {
                vars,
                globalVars,
                tempVars: Object.create(null),
                slots: Object.create(null),
                functions: new Map(),
                callArgs: null,
                callStack: 0,
                enabledModules: Array.isArray(enabledModules) ? enabledModules : [],
                charAssetNames,
                emotionNames,
                displayScripts: sortDisplayScripts(displayScripts),
                charName: (charObj && charObj.name) || 'Character',
                charDesc: String((charObj && charObj.desc) || ''),
                personality: String((charObj && charObj.personality) || ''),
                scenario: String((charObj && charObj.scenario) || ''),
                note: String((chatObj && chatObj.note) || ''),
                globalNote: String((charObj && charObj.replaceGlobalNote) || ''),
                mainPrompt: String((charObj && charObj.systemPrompt) || ''),
                jailbreak: '',
                firstMessage: String((charObj && charObj.firstMessage) || ''),
                userName: personaName || 'User',
                personaPrompt: String(personaPrompt || ''),
                userIcon: String((extra && extra.personaIcon) || ''),
                charImage: String((extra && extra.charImage) || ''),
                msgRole: 'char',
                chatList: Array.isArray(allMsgs)
                    ? allMsgs.map((m) => ({ role: m && m.role === 'user' ? 'user' : 'assistant', content: String((m && m.data) || '') }))
                    : [],
                chatIndex: msgIndex,
                lastMessageId: Number(totalMsgs || 0) - 1,
            };
        }

        function applyDisplayRegexScripts(text, ctx) {
            let out = String(text || '').replace(/\r\n/g, '\n');
            for (const sc of ctx.displayScripts || []) {
                if (!sc || !sc.in) continue;
                const rawFlag = sc.ableFlag && sc.flag ? String(sc.flag) : '';
                const hasCbsFlag = rawFlag.includes('<cbs>');
                const noEndNl = rawFlag.includes('<no_end_nl>');
                let rawOut = String(sc.out || '');
                if (rawOut.includes('\\n')) rawOut = rawOut.replace(/\\n/g, '\n');
                if (noEndNl && rawOut.endsWith('\n')) rawOut = rawOut.slice(0, -1);
                let jsFlags = 'g';
                if (sc.ableFlag) {
                    const metaAdded = (rawFlag.includes('<ignore_case>') ? 'i' : '')
                        + (rawFlag.includes('<multiline>') ? 'm' : '')
                        + (rawFlag.includes('<dotall>') ? 's' : '')
                        + (rawFlag.includes('<global>') ? 'g' : '');
                    const rawJs = rawFlag.replace(/<[^>]+>/g, '').replace(/[^dgimsuvy]/g, '');
                    jsFlags = Array.from(new Set((rawJs + metaAdded).split(''))).join('');
                    if (!jsFlags && !rawFlag.includes('<no_g>')) jsFlags = 'g';
                    else if (!jsFlags.includes('g') && !rawFlag.includes('<no_g>')) jsFlags += 'g';
                }
                const rawIn = String(sc.in);
                const patternStr = hasCbsFlag ? evalCBS(rawIn, ctx) : rawIn;
                if (!patternStr) continue;

                try {
                    const rx = new RegExp(patternStr, jsFlags);
                    out = out.replace(rx, (...args) => {
                        const fullMatch = args[0];
                        const hasGroups = args.length >= 4 && typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null && typeof args[args.length - 2] === 'string';
                        const groups = hasGroups ? args[args.length - 1] : null;
                        const inputStr = hasGroups ? args[args.length - 2] : args[args.length - 1];
                        const offset = hasGroups ? args[args.length - 3] : args[args.length - 2];
                        const caps = hasGroups ? args.slice(1, -3) : args.slice(1, -2);
                        const substituted = rawOut.replace(/\$(?:\$|&|`|'|<([^>]+)>|(\d{1,2}))/g, (tok, groupName, numStr) => {
                            if (tok === '$$') return '$';
                            if (tok === '$&') return fullMatch;
                            if (tok === '$`') return typeof inputStr === 'string' && typeof offset === 'number' ? inputStr.slice(0, offset) : '';
                            if (tok === "$'") return typeof inputStr === 'string' && typeof offset === 'number' ? inputStr.slice(offset + fullMatch.length) : '';
                            if (groupName !== undefined) return groups && groups[groupName] !== undefined ? String(groups[groupName]) : '';
                            const n = parseInt(numStr, 10);
                            if (n === 0) return fullMatch;
                            if (n >= 1 && n <= caps.length) return caps[n - 1] ?? '';
                            return '';
                        });
                        if (!substituted.includes('{{')) return substituted;
                        return evalCBS(substituted, ctx).replace(/(?:[ \t]*\r?\n){3,}/g, '\n\n');
                    });
                } catch (_) {}
            }
            return out;
        }

        function applyLeavePresetDisplayCompat(str, ctx) {
            let out = String(str || '');
            // Leave regex #2: convert text-only <statusdata> blocks into collapsible Leave HUD cards (unless state_tracker === '2')
            const rawTracker = ctx && ctx.globalVars
                ? (ctx.globalVars.toggle_state_tracker !== undefined ? ctx.globalVars.toggle_state_tracker : ctx.globalVars.state_tracker)
                : '';
            if (String(rawTracker ?? '') === '2') {
                out = out.replace(/<statusdata>(?:(?!<details\b|<\/statusdata>)[\s\S])*?<\/statusdata>\s*/gi, '');
            } else {
                out = out.replace(
                    /<statusdata>\s*(?:📖\s*)?([^\r\n<]+)\r?\n((?:(?!<details\b|<\/statusdata>)[\s\S])+?)\s*<\/statusdata>\s*/gi,
                    (_, title, body) => `<details class="leave-hud-card"><summary>📖 ${escapeHtml(String(title || '').trim())}</summary><div class="leave-hud-body">${escapeHtml(String(body || '').trim())}</div></details>`
                );
                out = out.replace(
                    /<statusdata>((?:(?!<details\b|<\/statusdata>)[\s\S])*?)<\/statusdata>\s*/gi,
                    (_, body) => {
                        const trimmed = String(body || '').trim();
                        return trimmed
                            ? `<details class="leave-hud-card"><summary>📖 Leave HUD</summary><div class="leave-hud-body">${escapeHtml(trimmed)}</div></details>`
                            : '';
                    }
                );
            }
            // Leave regex #3: render <ooc> blocks as styled cards
            out = out.replace(/<ooc>([\s\S]*?)<\/ooc>\s*/gi, '<div class="leave-ooc-card"><div class="leave-ooc-badge">🍃 OOC</div><div>$1</div></div>');
            // Leave regex #1: show collapsible thought block when toggle_thought_display === '1'
            if (ctx && ctx.globalVars && String(ctx.globalVars.toggle_thought_display || '') === '1') {
                out = out.replace(/<(thinking|thoughts?|think)\b[^>]*>([\s\S]*?)<\/\1>\s*/gi, '<details class="leave-thought-box"><summary>💭 생각의 사슬</summary><div class="leave-thought-body">$2</div></details>');
            }
            return out;
        }

        function renderRemoteMessage(raw, ctx) {
            let s = evalCBS(String(raw || ''), ctx);
            s = applyDisplayRegexScripts(s, ctx);
            s = evalCBS(s, ctx);
            s = applyLeavePresetDisplayCompat(s, ctx);
            return s;
        }

        function cleanProse(raw) {
            if (!raw) return '';
            return String(raw)
                .replace(/<!--\s*HAYAKU[\s\S]*?-->/gi, '')
                .replace(/<!--[\s\S]*?-->/gi, '')
                .replace(/<details\b[^>]*class="[^"]*\b(?:leave-thought-box|leave-hud-card)\b[^"]*"[^>]*>[\s\S]*?<\/details>/gi, '')
                .replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, '')
                .replace(/<think>[\s\S]*?<\/think>/gi, '')
                .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
                .replace(/<statusdata\b[^>]*>[\s\S]*?<\/statusdata>/gi, '')
                .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<button\b[^>]*risu-(?:btn|trigger)[^>]*>[\s\S]*?<\/button>/gi, '')
                .replace(/<img\b[^>]*>/gi, '')
                .replace(/\{\{(?:img|raw|asset|image|emotion|inlay|inlayed)::[^}]+\}\}/gi, '')
                .replace(/<[^>]+>/g, '')
                .trim();
        }
    
        async function readAssetDataUrl(assetPath) {
            if (!assetPath) return null;
            if (assetDataCache.has(assetPath)) return assetDataCache.get(assetPath);
            try {
                const raw = await risuai.readImage(assetPath);
                if (!raw) return null;
                const bytes = raw instanceof Uint8Array
                    ? raw
                    : ArrayBuffer.isView(raw)
                    ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
                    : raw instanceof ArrayBuffer
                    ? new Uint8Array(raw)
                    : new Uint8Array(Object.values(raw));
                if (!bytes.length) return null;
                if (bytes.length > 2.5 * 1024 * 1024) return '__RS_TOO_LARGE__';
                const url = `data:${detectImageMime(bytes, assetPath)};base64,${uint8ToBase64(bytes)}`;
                if (url.length <= 2_000_000) {
                    cacheSetBounded(assetDataCache, assetPath, url, 48);
                }
                return url;
            } catch (_) {
                return null;
            }
        }

        async function readInlayDataUrl(inlayId) {
            if (!inlayId || typeof risuai.readInlay !== 'function') return null;
            const cacheKey = `inlay:${inlayId}`;
            if (assetDataCache.has(cacheKey)) return assetDataCache.get(cacheKey);
            try {
                const res = await risuai.readInlay(inlayId);
                if (res && res.data && String(res.data).startsWith('data:')) {
                    if (String(res.data).length > 3.5 * 1024 * 1024) return '__RS_TOO_LARGE__';
                    if (String(res.data).length <= 2_000_000) {
                        cacheSetBounded(assetDataCache, cacheKey, res.data, 24);
                    }
                    return res.data;
                }
            } catch (_) {}
            return null;
        }
    
        function buildLookup(charObj, enabledModules = []) {
            const list = [];
            const pushEntry = (rawName, rawPath, ext) => {
                if (!rawName || !rawPath) return;
                const name = String(rawName).trim();
                const pathStr = String(rawPath).trim();
                list.push({ n: name.toLowerCase(), p: pathStr });
                if (ext && !name.includes('.')) {
                    list.push({ n: `${name}.${String(ext).trim()}`.toLowerCase(), p: pathStr });
                }
            };
            const pushRawItem = (entry) => {
                if (Array.isArray(entry)) {
                    pushEntry(entry[0], entry[1], entry[2]);
                } else if (entry && typeof entry === 'object') {
                    pushEntry(entry.name || entry.key || '', entry.path || entry.key || '', entry.ext || '');
                }
            };
            if (charObj && Array.isArray(charObj.additionalAssets)) {
                for (const a of charObj.additionalAssets) pushRawItem(a);
            }
            if (charObj && Array.isArray(charObj.emotionImages)) {
                for (const e of charObj.emotionImages) pushRawItem(e);
            }
            for (const m of enabledModules || []) {
                if (m && Array.isArray(m.assets)) {
                    for (const a of m.assets) pushRawItem(a);
                }
            }
            const norm = (s) => String(s || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\s_\-]+/g, '').toLowerCase();
            const findSingle = (rawName) => {
                let decoded = String(rawName || '').trim();
                if (decoded.includes('%')) {
                    try { decoded = decodeURIComponent(decoded); } catch (_) {}
                }
                const rawLower = decoded.toLowerCase();
                if (!rawLower) return null;
                for (const item of list) {
                    if (item.n === rawLower) return item.p;
                }
                const k = norm(rawLower);
                if (!k) return null;
                for (const item of list) {
                    if (norm(item.n) === k) return item.p;
                }
                for (const item of list) {
                    const nk = norm(item.n);
                    if (nk && nk.includes(k)) return item.p;
                }
                for (const item of list) {
                    const nk = norm(item.n);
                    if (nk && nk.length >= 2 && k.includes(nk)) return item.p;
                }
                return null;
            };
            return (rawName, seasonSuffix = '') => {
                if (seasonSuffix) {
                    const withSuffix = findSingle(String(rawName || '') + String(seasonSuffix));
                    if (withSuffix) return withSuffix;
                }
                return findSingle(rawName);
            };
        }

        function createAssetCollector(findPath, allowImages, seasonSuffix = '') {
            const assetMap = Object.create(null);
            const urlToId = new Map();
            const pathToId = new Map();
            let seq = 0;
            let totalBytes = 0;
            const MAX_ASSETS = 512;
            const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

            const addRef = (url) => {
                if (!url) return null;
                if (urlToId.has(url)) return urlToId.get(url);
                if (seq >= MAX_ASSETS) return null;
                const isInline = url.startsWith('data:');
                const size = isInline ? String(url).length : 0;
                if (isInline && totalBytes + size > MAX_TOTAL_BYTES) return null;
                const id = `a${seq++}`;
                totalBytes += size;
                urlToId.set(url, id);
                assetMap[id] = url;
                return id;
            };

            const register = async (name, kind = 'asset', { inlineOnly = false, lazyOnly = false } = {}) => {
                if (!allowImages || !cfg.includeImages || !name) return null;
                if (kind === 'inlay') {
                    const inlayId = String(name).trim();
                    if (!inlayId) return null;
                    const cacheKey = `inlay:${inlayId}`;
                    if (pathToId.has(cacheKey)) {
                        const id = pathToId.get(cacheKey);
                        return { id, url: assetMap[id], token: `[[RSASSET:${id}]]` };
                    }
                    let id = null;
                    if (!lazyOnly && totalBytes < MAX_TOTAL_BYTES) {
                        const dataUrl = await readInlayDataUrl(inlayId);
                        if (dataUrl === '__RS_TOO_LARGE__') {
                            if (!inlineOnly) id = addRef(`pcinlay:${inlayId}`);
                        } else if (dataUrl) {
                            id = addRef(dataUrl);
                            if (!id && !inlineOnly) id = addRef(`pcinlay:${inlayId}`);
                        } else {
                            return null;
                        }
                    } else if (!inlineOnly) {
                        id = addRef(`pcinlay:${inlayId}`);
                    }
                    if (!id) return null;
                    pathToId.set(cacheKey, id);
                    return { id, url: assetMap[id], token: `[[RSASSET:${id}]]` };
                }
                const cleanName = String(name).trim();
                if (!cleanName) return null;
                if (/^(?:data:image\/|https?:\/\/|\/api\/asset\/)/i.test(cleanName)) {
                    const id = addRef(cleanName);
                    if (!id) return null;
                    return { id, url: assetMap[id], token: `[[RSASSET:${id}]]` };
                }
                const assetPath = (/^assets\/[^\s"'<>]+$/i.test(cleanName) && !cleanName.includes('..'))
                    ? cleanName
                    : findPath(cleanName, seasonSuffix);
                if (!assetPath) return null;
                if (pathToId.has(assetPath)) {
                    const id = pathToId.get(assetPath);
                    return { id, url: assetMap[id], token: `[[RSASSET:${id}]]` };
                }
                let id = null;
                if (!lazyOnly && totalBytes < MAX_TOTAL_BYTES) {
                    const dataUrl = await readAssetDataUrl(assetPath);
                    if (dataUrl === '__RS_TOO_LARGE__') {
                        if (!inlineOnly) id = addRef(`pcpath:${assetPath}`);
                    } else if (dataUrl) {
                        id = addRef(dataUrl);
                        if (!id && !inlineOnly) id = addRef(`pcpath:${assetPath}`);
                    } else {
                        return null;
                    }
                } else if (!inlineOnly) {
                    id = addRef(`pcpath:${assetPath}`);
                }
                if (!id) return null;
                pathToId.set(assetPath, id);
                return { id, url: assetMap[id], token: `[[RSASSET:${id}]]` };
            };

            return {
                assetMap,
                register,
                lazyView: {
                    assetMap,
                    register: (name, kind = 'asset') => register(name, kind, { lazyOnly: true }),
                },
            };
        }

        function stripDangerousNonHtml(raw) {
            return String(raw || '')
                .replace(/<!--[\s\S]*?-->/gi, '')
                .replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, '')
                .replace(/<think>[\s\S]*?<\/think>/gi, '')
                .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
                .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
        }

        async function resolveHtmlAssetRefs(rawStr, collector) {
            const src = stripDangerousNonHtml(rawStr);
            const msgImgs = [];
            const pushMsgImg = (url) => {
                if (url && !msgImgs.includes(url)) msgImgs.push(url);
            };
            const isInsideAttrOrCssUrl = (index) => {
                const before = src.slice(Math.max(0, index - 400), index);
                if (/(?:src|href|background|poster)\s*=\s*["']?[^"'>]*$/i.test(before)) return true;
                if (/url\(\s*["']?[^"')]*$/i.test(before)) return true;
                return false;
            };

            // Pass 1: Resolve {{raw/path/img/asset/image/emotion/inlay/inlayed::...}} and <img=...>
            const macroRe = /<img\s*=\s*["']?([^"'\s>]+)["']?\s*\/?>|\{\{(?:(inlay|inlayed)|(img|raw|path|asset|image|emotion))::([^}]+)\}\}/gi;
            const macroMatches = [];
            let m;
            while ((m = macroRe.exec(src)) !== null) {
                const isAttrTag = !m[1] && isInsideAttrOrCssUrl(m.index);
                if (m[1]) {
                    macroMatches.push({ start: m.index, end: macroRe.lastIndex, kind: 'asset', name: m[1].trim(), asImgTag: true });
                } else if (m[2]) {
                    macroMatches.push({ start: m.index, end: macroRe.lastIndex, kind: 'inlay', name: m[4].trim(), asImgTag: !isAttrTag });
                } else {
                    const macroName = (m[3] || '').toLowerCase();
                    const isRawUrlMacro = macroName === 'raw' || macroName === 'path';
                    macroMatches.push({ start: m.index, end: macroRe.lastIndex, kind: 'asset', name: m[4].trim(), asImgTag: isRawUrlMacro ? false : !isAttrTag });
                }
            }
            let html = '';
            let cursor = 0;
            for (const mt of macroMatches) {
                html += src.slice(cursor, mt.start);
                cursor = mt.end;
                const entry = await collector.register(mt.name, mt.kind);
                if (entry) {
                    pushMsgImg(entry.token);
                    html += mt.asImgTag ? `<img class="msg-img" src="${entry.token}" />` : entry.token;
                }
            }
            html += src.slice(cursor);

            // Pass 2: Resolve bare <img src=foo> where src is not http(s), data:, /api/asset/, or already [[RSASSET:...]]
            const imgTagRe = /<img\b([^>]*?)\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))([^>]*)>/gi;
            const imgMatches = [];
            while ((m = imgTagRe.exec(html)) !== null) {
                const srcVal = (m[2] || m[3] || m[4] || '').trim();
                if (!srcVal) continue;
                if (srcVal.startsWith('[[RSASSET:')) {
                    const assetId = srcVal.slice(10, -2);
                    if (collector.assetMap[assetId]) pushMsgImg(srcVal);
                    continue;
                }
                if (/^(?:https?:\/\/|data:image\/|\/api\/asset\/)/i.test(srcVal)) {
                    pushMsgImg(srcVal);
                    continue;
                }
                imgMatches.push({
                    start: m.index,
                    end: imgTagRe.lastIndex,
                    beforeAttrs: m[1] || '',
                    afterAttrs: m[5] || '',
                    name: srcVal,
                });
            }
            if (imgMatches.length) {
                let nextHtml = '';
                let c2 = 0;
                for (const im of imgMatches) {
                    nextHtml += html.slice(c2, im.start);
                    c2 = im.end;
                    const entry = await collector.register(im.name, 'asset');
                    if (entry) {
                        pushMsgImg(entry.token);
                        nextHtml += `<img${im.beforeAttrs} src="${entry.token}"${im.afterAttrs}>`;
                    }
                }
                nextHtml += html.slice(c2);
                html = nextHtml;
            }
            if (html.includes('url(')) {
                const resolveCssUrlBlock = async (cssText, innerQuote) => {
                    const urlRe = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)'"\s][^)'"]*?))\s*\)/gi;
                    let c3 = 0;
                    let built = '';
                    let um;
                    while ((um = urlRe.exec(cssText)) !== null) {
                        built += cssText.slice(c3, um.index);
                        c3 = um.index + um[0].length;
                        const rawRef = String(um[1] ?? um[2] ?? um[3] ?? '').trim();
                        if (!rawRef || /^(?:data:|https?:|blob:|pcpath:|pcinlay:|\/|#|a\d+$|__rs_)/i.test(rawRef)) {
                            built += um[0];
                            continue;
                        }
                        let cleanRef = rawRef;
                        try { cleanRef = decodeURIComponent(rawRef); } catch {}
                        const entry = await collector.register(cleanRef, 'asset') || (cleanRef !== rawRef ? await collector.register(rawRef, 'asset') : null);
                        if (entry) {
                            pushMsgImg(entry.token);
                            built += `url(${innerQuote}${entry.token}${innerQuote})`;
                        } else {
                            built += um[0];
                        }
                    }
                    built += cssText.slice(c3);
                    return built;
                };
                const styleAttrRe = /(\bstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
                let sCursor = 0;
                let sNext = '';
                let sm;
                while ((sm = styleAttrRe.exec(html)) !== null) {
                    sNext += html.slice(sCursor, sm.index);
                    sCursor = sm.index + sm[0].length;
                    const quote = sm[2] !== undefined ? '"' : "'";
                    const val = sm[2] !== undefined ? sm[2] : sm[3];
                    if (val && val.toLowerCase().includes('url(')) {
                        const resolvedVal = await resolveCssUrlBlock(val, quote === '"' ? "'" : '"');
                        sNext += `${sm[1]}${quote}${resolvedVal}${quote}`;
                    } else {
                        sNext += sm[0];
                    }
                }
                sNext += html.slice(sCursor);
                html = sNext;
                if (/<style\b/i.test(html)) {
                    const styleTagRe = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
                    let tCursor = 0;
                    let tNext = '';
                    let tm;
                    while ((tm = styleTagRe.exec(html)) !== null) {
                        tNext += html.slice(tCursor, tm.index);
                        tCursor = tm.index + tm[0].length;
                        if (tm[2] && tm[2].toLowerCase().includes('url(')) {
                            const resolvedCss = await resolveCssUrlBlock(tm[2], "'");
                            tNext += `${tm[1]}${resolvedCss}${tm[3]}`;
                        } else {
                            tNext += tm[0];
                        }
                    }
                    tNext += html.slice(tCursor);
                    html = tNext;
                }
            }
            return { html: html.replace(/(?:[ \t]*\r?\n){3,}/g, '\n\n').trim(), images: msgImgs };
        }

        async function renderMessageHtmlAndText(rawMsg, collector) {
            if (!rawMsg) return { text: '', html: '', images: [] };
            const { html, images } = await resolveHtmlAssetRefs(rawMsg, collector);
            let prose = cleanProse(html);
            if (!prose && images.length) {
                prose = images.map((_, i) => `[[RSIMG:${i}]]`).join('\n');
            }
            return { text: prose, html, images };
        }

        async function extractInlineImages(rawMsg, findPath, allowImages, seasonSuffix = '') {
            const collector = createAssetCollector(findPath, allowImages, seasonSuffix);
            const res = await renderMessageHtmlAndText(rawMsg, collector);
            return { text: res.text, images: res.images };
        }

        function hashLoreUid(str) {
            let h = 2166136261;
            const s = String(str || '');
            for (let i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            return (h >>> 0).toString(16).padStart(8, '0');
        }

        function collectStructuredLoreEntries(charObj, chatObj, enabledModules) {
            const out = [];
            const seenUids = new Map();
            const pushEntries = (entries, source, sourceName) => {
                if (!Array.isArray(entries)) return;
                for (const e of entries) {
                    if (!e || e.enabled === false || e.mode === 'folder') continue;
                    const keyRaw = String(e.key || '');
                    if (keyRaw.includes('folder:')) continue;
                    const content = String(e.content || '');
                    if (!content.trim()) continue;
                    const baseUid = `${source}:${hashLoreUid(`${source}|${sourceName}|${e.comment || ''}|${keyRaw}|${content.slice(0, 160)}`)}`;
                    const cnt = (seenUids.get(baseUid) || 0) + 1;
                    seenUids.set(baseUid, cnt);
                    const uid = cnt === 1 ? baseUid : `${baseUid}#${cnt}`;
                    out.push({
                        uid,
                        source,
                        sourceName: String(sourceName || ''),
                        key: keyRaw,
                        secondkey: String(e.secondkey || ''),
                        comment: String(e.comment || ''),
                        content,
                        insertorder: Number.isFinite(Number(e.insertorder)) ? Number(e.insertorder) : 100,
                        alwaysActive: Boolean(e.alwaysActive),
                        selective: Boolean(e.selective),
                        useRegex: Boolean(e.useRegex),
                        mode: String(e.mode || 'normal'),
                    });
                }
            };
            for (const m of enabledModules || []) {
                if (m && Array.isArray(m.lorebook)) pushEntries(m.lorebook, 'module', m.name || m.id || '모듈');
            }
            if (charObj && Array.isArray(charObj.globalLore)) {
                pushEntries(charObj.globalLore, 'char', charObj.name || '캐릭터');
            }
            if (chatObj && Array.isArray(chatObj.localLore)) {
                pushEntries(chatObj.localLore, 'local', '이 채팅방');
            }
            return out;
        }

        function collectLorebookSummary(charObj, enabledModules, recentMessages, chatObj = null) {
            const entries = collectStructuredLoreEntries(charObj, chatObj, enabledModules);
            const depth = Number((charObj && charObj.loreSettings && charObj.loreSettings.scanDepth) || 10);
            const recentText = (Array.isArray(recentMessages) ? recentMessages : [])
                .slice(-Math.max(1, depth))
                .map((m) => String(m && m.data ? m.data : ''))
                .join('\n')
                .toLowerCase();
            const candidates = [];
            for (const e of entries) {
                const body = e.content.replace(/^(?:\s*@@[^\r\n]*\r?\n)+/, '').trim();
                if (!body) continue;
                const keys = e.key.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
                const hit = Boolean(e.alwaysActive) || (recentText && keys.some((k) => recentText.includes(k)));
                if (!hit) continue;
                candidates.push({
                    insertorder: e.insertorder,
                    chunk: e.comment ? `[${e.comment}]\n${body}` : body,
                });
            }
            candidates.sort((a, b) => b.insertorder - a.insertorder);
            const out = [];
            let total = 0;
            const MAX_LORE_CHARS = 30000;
            for (const c of candidates) {
                if (total + c.chunk.length > MAX_LORE_CHARS) continue;
                out.push(c.chunk);
                total += c.chunk.length;
            }
            return out.join('\n\n');
        }
    
        function makeUuid() {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
            return 'rs-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        }
    
        function isTrashedEntry(item) {
            return !item || typeof item !== 'object' || Boolean(item.trashTime) || Boolean(item.removed) || Boolean(item.deleted) || Boolean(item.isTrash);
        }

        async function findFirstActiveCharIndex() {
            try {
                const db = await risuai.getDatabase(['characters']);
                const list = db && Array.isArray(db.characters) ? db.characters : [];
                for (let i = 0; i < list.length; i++) {
                    if (!isTrashedEntry(list[i])) return i;
                }
            } catch (_) {}
            return -1;
        }

        async function buildCatalog(force = false) {
            const pcActiveCharIndex = await risuai.getCurrentCharacterIndex();
            const pcActiveChatIndex = pcActiveCharIndex >= 0 ? await risuai.getCurrentChatIndex() : -1;
            const now = Date.now();
            if (
                !force &&
                lastCatalogSig &&
                (now - lastCatalogBuildAt) < CATALOG_POLL_INTERVAL_MS &&
                pcActiveCharIndex === lastCatalogPcChar &&
                pcActiveChatIndex === lastCatalogPcChat
            ) {
                return { catalog: null, sig: lastCatalogSig };
            }

            let db = null;
            try {
                db = await risuai.getDatabase([
                    'characters',
                    'modules',
                    'enabledModules',
                    'personas',
                    'selectedPersona',
                    'temperature',
                    'maxContext',
                    'maxResponse',
                ]);
            } catch (_) {
                return null;
            }
            if (!db) return null;

            lastCatalogBuildAt = Date.now();
            lastCatalogPcChar = pcActiveCharIndex;
            lastCatalogPcChat = pcActiveChatIndex;
    
            const charsRaw = Array.isArray(db.characters) ? db.characters : [];
            const characters = [];
            for (let idx = 0; idx < charsRaw.length; idx++) {
                const c = charsRaw[idx];
                if (isTrashedEntry(c)) continue;
                const rawChats = Array.isArray(c && c.chats) ? c.chats : [];
                const chats = [];
                let charLastDate = 0;
                for (let cIdx = 0; cIdx < rawChats.length; cIdx++) {
                    const ch = rawChats[cIdx];
                    if (isTrashedEntry(ch)) continue;
                    const msgsArr = Array.isArray(ch && ch.message) ? ch.message : [];
                    const lastMsg = msgsArr.length ? msgsArr[msgsArr.length - 1] : null;
                    const rawLastDate = (ch && typeof ch.lastDate === 'number' && Number.isFinite(ch.lastDate)) ? ch.lastDate : 0;
                    const msgTime = (lastMsg && typeof lastMsg.time === 'number' && Number.isFinite(lastMsg.time)) ? lastMsg.time : 0;
                    const chatLastDate = Math.max(rawLastDate, msgTime);
                    if (chatLastDate > charLastDate) charLastDate = chatLastDate;
                    chats.push({
                        index: cIdx,
                        id: (ch && ch.id) || String(cIdx),
                        name: (ch && ch.name) || `Chat ${cIdx + 1}`,
                        msgCount: msgsArr.length,
                        turnCount: computeUATurnStats(ch && ch.message).completedTurns,
                        lastDate: chatLastDate,
                    });
                }
                characters.push({
                    index: idx,
                    chaId: (c && c.chaId) || String(idx),
                    name: (c && c.name) || `Character ${idx + 1}`,
                    type: (c && c.type) || 'character',
                    image: (c && typeof c.image === 'string') ? c.image : '',
                    lastDate: charLastDate,
                    chatPage: typeof (c && c.chatPage) === 'number' ? c.chatPage : 0,
                    isPcActive: idx === pcActiveCharIndex,
                    chats,
                });
            }
    
            const enabledSet = new Set(Array.isArray(db.enabledModules) ? db.enabledModules : []);
            const modulesRaw = Array.isArray(db.modules) ? db.modules : [];
            const modules = modulesRaw.map((m) => ({
                id: m.id,
                name: m.name || m.id,
                namespace: String(m.namespace || ''),
                assetCount: Array.isArray(m.assets) ? m.assets.length : 0,
                description: String(m.description || '').slice(0, 140),
                enabled: enabledSet.has(m.id),
                hasToggles: Boolean(m.customModuleToggle && String(m.customModuleToggle).trim()),
            }));
    
            const personasRaw = Array.isArray(db.personas) ? db.personas : [];
            const personas = personasRaw.map((p, idx) => ({
                index: idx,
                name: (p && p.name) || `Persona ${idx + 1}`,
                prompt: String((p && p.personaPrompt) || '').slice(0, 400),
            }));
    
            const params = {
                temperature: typeof db.temperature === 'number' ? db.temperature : 80,
                maxContext: typeof db.maxContext === 'number' ? db.maxContext : 8000,
                maxResponse: typeof db.maxResponse === 'number' ? db.maxResponse : 1000,
            };
    
            const catalog = {
                pcActiveCharIndex,
                pcActiveChatIndex,
                selectedPersona: typeof db.selectedPersona === 'number' ? db.selectedPersona : 0,
                params,
                characters,
                modules,
                personas,
            };
    
            const sig = JSON.stringify({
                a: pcActiveCharIndex,
                b: pcActiveChatIndex,
                p: catalog.selectedPersona,
                pr: params,
                c: characters.map((x) => [
                    x.index,
                    x.chaId,
                    x.name,
                    x.image,
                    x.chatPage,
                    x.chats.map((ch) => [ch.index, ch.id, ch.name, ch.msgCount]),
                    x.chats.map((ch) => ch.turnCount),
                    x.chats.map((ch) => ch.lastDate),
                ]),
                m: modules.map((x) => [x.id, x.enabled, x.assetCount]),
                pe: personas.map((x) => x.name),
            });
    
            if (!force && sig === lastCatalogSig) {
                return { catalog: null, sig };
            }
            return { catalog, sig };
        }
    
        function ensureStableChatAndMessageIds(charObj, charIdx, chatObj, chatIdx) {
            if (!chatObj || typeof chatObj !== 'object') return chatObj;
            const cidOwner = String((charObj && charObj.chaId) || charIdx || 0).replace(/[^a-zA-Z0-9_-]/g, '_');
            if (!chatObj.id || !String(chatObj.id).trim()) {
                chatObj.id = `rs-chat-${cidOwner}-${Math.max(0, Number(chatIdx) || 0)}`;
            }
            if (Array.isArray(chatObj.message)) {
                const baseId = String(chatObj.id);
                for (let i = 0; i < chatObj.message.length; i++) {
                    const m = chatObj.message[i];
                    if (m && typeof m === 'object' && (!m.chatId || !String(m.chatId).trim())) {
                        m.chatId = `rs-msg-${baseId}-${i}`;
                    }
                }
            }
            return chatObj;
        }

        async function buildSnapshot(forceFull = false) {
            const pcCharIdx = await risuai.getCurrentCharacterIndex();
            const pcChatIdx = pcCharIdx >= 0 ? await risuai.getCurrentChatIndex() : -1;
    
            if (viewCharIndex < 0) {
                if (pcCharIdx >= 0) {
                    viewCharIndex = pcCharIdx;
                    viewChatIndex = pcChatIdx >= 0 ? pcChatIdx : 0;
                } else {
                    const firstActive = await findFirstActiveCharIndex();
                    viewCharIndex = firstActive >= 0 ? firstActive : 0;
                    viewChatIndex = 0;
                }
            }
    
            let charObj = await risuai.getCharacterFromIndex(viewCharIndex);
            if (!charObj || isTrashedEntry(charObj)) {
                let resolved = false;
                if (pcCharIdx >= 0 && pcCharIdx !== viewCharIndex) {
                    const pcObj = await risuai.getCharacterFromIndex(pcCharIdx);
                    if (pcObj && !isTrashedEntry(pcObj)) {
                        viewCharIndex = pcCharIdx;
                        viewChatIndex = pcChatIdx >= 0 ? pcChatIdx : 0;
                        charObj = pcObj;
                        resolved = true;
                    }
                }
                if (!resolved) {
                    const firstActive = await findFirstActiveCharIndex();
                    if (firstActive >= 0) {
                        viewCharIndex = firstActive;
                        viewChatIndex = 0;
                        charObj = await risuai.getCharacterFromIndex(viewCharIndex);
                    }
                }
            }
            if (!charObj || isTrashedEntry(charObj)) return null;
            if (charObj.chaId) charIdByIndex.set(viewCharIndex, String(charObj.chaId));
    
            const chats = Array.isArray(charObj.chats) ? charObj.chats : [];
            if (viewChatIndex < 0 || viewChatIndex >= chats.length || isTrashedEntry(chats[viewChatIndex])) {
                if (typeof charObj.chatPage === 'number' && charObj.chatPage >= 0 && charObj.chatPage < chats.length && !isTrashedEntry(chats[charObj.chatPage])) {
                    viewChatIndex = charObj.chatPage;
                } else {
                    const firstActiveChat = chats.findIndex((ch) => !isTrashedEntry(ch));
                    viewChatIndex = firstActiveChat >= 0 ? firstActiveChat : 0;
                }
            }
    
            const chatObj = chats[viewChatIndex] || { name: 'Chat 1', message: [] };
            ensureStableChatAndMessageIds(charObj, viewCharIndex, chatObj, viewChatIndex);
            const allMsgs = Array.isArray(chatObj.message) ? chatObj.message : [];
            const startOffset = Math.max(0, allMsgs.length - 36);
            const recent = allMsgs.slice(startOffset);
            let msgHash = 2166136261;
            for (const msg of recent) {
                const s = `${msg.role || ''}:${String(msg.data || '')}`;
                for (let hi = 0; hi < s.length; hi++) {
                    msgHash ^= s.charCodeAt(hi);
                    msgHash = Math.imul(msgHash, 16777619);
                }
            }
            const recentDigest = (msgHash >>> 0).toString(36);
            const isPcActive = viewCharIndex === pcCharIdx;
    
            const localVars = (chatObj && chatObj.GLGlobalVariables && typeof chatObj.GLGlobalVariables === 'object') ? chatObj.GLGlobalVariables : {};
            const useLocalToggles = Boolean(chatObj && chatObj.useLocallySetGlobalVariables);
            const scriptState = (chatObj && chatObj.scriptstate && typeof chatObj.scriptstate === 'object') ? chatObj.scriptstate : {};
            const fmIdx = typeof chatObj.fmIndex === 'number' ? chatObj.fmIndex : -1;
            const altGreetings = Array.isArray(charObj.alternateGreetings) ? charObj.alternateGreetings : [];
            const firstMessageCount = (charObj.firstMessage ? 1 : 0) + altGreetings.length;
            const chatModules = Array.isArray(chatObj && chatObj.modules) ? chatObj.modules.map(String) : [];

            let db = null;
            let toggleBlocks = [];
            let enabledModules = [];
            const enSet = new Set(chatModules);
            try {
                if (!forceFull && cachedSnapDb && (Date.now() - cachedSnapDbAt) < SNAP_DB_TTL_MS) {
                    db = cachedSnapDb;
                } else {
                    db = await risuai.getDatabase([
                        'modules',
                        'enabledModules',
                        'personas',
                        'selectedPersona',
                        'userIcon',
                        'customscript',
                        'globalChatVariables',
                    ]);
                    if (db) {
                        cachedSnapDb = db;
                        cachedSnapDbAt = Date.now();
                    }
                }
                if (db && Array.isArray(db.enabledModules)) {
                    for (const mid of db.enabledModules) enSet.add(String(mid));
                }
                if (db && Array.isArray(db.modules)) {
                    for (const m of db.modules) {
                        if (m && enSet.has(String(m.id))) {
                            enabledModules.push(m);
                            if (m.customModuleToggle && String(m.customModuleToggle).trim()) {
                                toggleBlocks.push({ source: m.name || m.id, syntax: String(m.customModuleToggle) });
                            }
                        }
                    }
                }
            } catch (_) {}
            if (charObj && charObj.customModuleToggle && String(charObj.customModuleToggle).trim()) {
                toggleBlocks.push({ source: charObj.name || 'Character', syntax: String(charObj.customModuleToggle) });
            }

            const enabledModIds = Array.from(enSet).sort().join(',');
            const globalToggleValues = {};
            if (db && db.globalChatVariables && typeof db.globalChatVariables === 'object') {
                for (const [gk, gv] of Object.entries(db.globalChatVariables)) {
                    if (String(gk).startsWith('toggle_') && gv !== undefined && gv !== null) {
                        globalToggleValues[gk] = String(gv);
                    }
                }
            }
            const swipeDigest = recent.map((_, i) => {
                const sw = swipeHistory[makeSwipeKey(charObj, viewCharIndex, chatObj, viewChatIndex, startOffset + i)];
                return sw && Array.isArray(sw.swipes) ? `${sw.index}/${sw.swipes.length}` : '0/1';
            }).join(',');
            const toggleSig = `${useLocalToggles}:${Object.keys(localVars).length}:${JSON.stringify(localVars)}:${JSON.stringify(globalToggleValues)}:${toggleBlocks.length}:${enabledModIds}`;
            const loreSig = `${Array.isArray(charObj.globalLore) ? charObj.globalLore.length : 0}:${Array.isArray(chatObj.localLore) ? chatObj.localLore.length : 0}:${hashLoreUid(charObj.replaceGlobalNote || '')}:${hashLoreUid(chatObj.note || '')}:${hashLoreUid(charObj.desc || '')}:${hashLoreUid(charObj.backgroundHTML || '')}`;
            const activePersonaObj = db && Array.isArray(db.personas) ? db.personas[db.selectedPersona || 0] : null;
            const personaIconVal = String((activePersonaObj && activePersonaObj.icon) || (db && db.userIcon) || '').trim();
            const personaSig = db && Array.isArray(db.personas)
                ? `${db.selectedPersona || 0}:${(activePersonaObj && activePersonaObj.name) || ''}:${personaIconVal}`
                : `0::${personaIconVal}`;
            const stateSig = `${fmIdx}:${firstMessageCount}:${JSON.stringify(scriptState)}:${swipeDigest}:${loreSig}:${personaSig}`;
            const sig = `${viewCharIndex}:${viewChatIndex}:${isPcActive}:${allMsgs.length}:${recentDigest}:${chatObj.name || ''}:${toggleSig}:${stateSig}:${Boolean(cfg.includeImages)}`;
            if (!forceFull && sig === lastSnapSig) {
                return { snapshot: null, sig };
            }

            let personaName = 'User';
            let personaPrompt = '';
            const personaIcon = personaIconVal;
            const charImage = String((charObj && charObj.image) || '').trim();
            if (activePersonaObj) {
                personaName = activePersonaObj.name || 'User';
                personaPrompt = activePersonaObj.personaPrompt || '';
            }

            const findPath = buildLookup(charObj, enabledModules);
            const renderCtx = buildRenderContext(charObj, chatObj, db, personaName, enabledModules, -1, allMsgs.length, allMsgs, personaPrompt, { personaIcon, charImage });
            const collector = createAssetCollector(findPath, Boolean(cfg.includeImages), renderCtx.vars.current_season_suffix || '');
            const outMsgs = [];

            const uaStats = computeUATurnStats(allMsgs);
            let greetingControls = [];
            let inferredDefaults = {};
            let botWidgetHtml = '';
            const firstMessageStyles = [];
            let pendingFirstMsg = null;
            let pendingWidgetHtml = '';
            if (charObj.firstMessage && startOffset === 0) {
                const firstRaw = fmIdx >= 0 && altGreetings[fmIdx] ? altGreetings[fmIdx] : charObj.firstMessage;
                if (firstRaw) {
                    const firstStr = String(firstRaw);
                    const greetingMeta = discoverGreetingVariables(firstStr);
                    inferredDefaults = greetingMeta.defaults;
                    const firstCtx = {
                        ...renderCtx,
                        vars: { ...renderCtx.vars },
                        tempVars: Object.create(null),
                        slots: Object.create(null),
                        chatIndex: -1,
                        msgRole: 'char',
                    };
                    let renderedFirst = renderRemoteMessage(firstStr, firstCtx);
                    const hasFirstContent = (s) => Boolean(
                        cleanProse(stripDangerousNonHtml(s)) ||
                        /<img\b|\{\{(?:img|raw|path|asset|image|emotion|inlay|inlayed)::/i.test(String(s || ''))
                    );
                    if (!hasFirstContent(renderedFirst) && /\{\{#(?:when|if|if_pure)/i.test(firstStr)) {
                        let filled = false;
                        for (const [k, v] of Object.entries(greetingMeta.defaults)) {
                            if (!Object.prototype.hasOwnProperty.call(firstCtx.vars, k)) {
                                firstCtx.vars[k] = v;
                                renderCtx.vars[k] = v;
                                filled = true;
                            }
                        }
                        if (filled) {
                            renderedFirst = renderRemoteMessage(firstStr, firstCtx);
                        }
                    }
                    greetingControls = Object.entries(greetingMeta.options)
                        .filter(([, opts]) => opts.length > 1)
                        .map(([key, opts]) => ({
                            key,
                            value: Object.prototype.hasOwnProperty.call(firstCtx.vars, key)
                                ? String(firstCtx.vars[key])
                                : String(greetingMeta.defaults[key] ?? opts[0] ?? ''),
                            options: opts,
                        }));
                    pendingFirstMsg = { renderedFirst, firstStr };
                }
            } else if (charObj.firstMessage) {
                const firstRaw = fmIdx >= 0 && altGreetings[fmIdx] ? altGreetings[fmIdx] : charObj.firstMessage;
                if (firstRaw) {
                    const firstStr = String(firstRaw);
                    const greetingMeta = discoverGreetingVariables(firstStr);
                    inferredDefaults = greetingMeta.defaults;
                    greetingControls = Object.entries(greetingMeta.options)
                        .filter(([, opts]) => opts.length > 1)
                        .map(([key, opts]) => ({
                            key,
                            value: Object.prototype.hasOwnProperty.call(renderCtx.vars, key)
                                ? String(renderCtx.vars[key])
                                : String(greetingMeta.defaults[key] ?? opts[0] ?? ''),
                            options: opts,
                        }));
                    const firstCtx = {
                        ...renderCtx,
                        vars: { ...renderCtx.vars },
                        tempVars: Object.create(null),
                        slots: Object.create(null),
                        chatIndex: -1,
                        msgRole: 'char',
                    };
                    let renderedFirst = renderRemoteMessage(firstStr, firstCtx);
                    const looksInteractiveWidget = (h) => /position\s*:\s*fixed/i.test(h) || /(?:buttons-container|side-panel|floating|risu-trigger|risu-btn)/i.test(h) || /<input\b[^>]*\btype\s*=\s*["']?(?:checkbox|radio)/i.test(h);
                    if (!looksInteractiveWidget(renderedFirst) && /\{\{#(?:when|if|if_pure)/i.test(firstStr)) {
                        let filled = false;
                        for (const [k, v] of Object.entries(greetingMeta.defaults)) {
                            if (!Object.prototype.hasOwnProperty.call(firstCtx.vars, k)) {
                                firstCtx.vars[k] = v;
                                filled = true;
                            }
                        }
                        if (filled) renderedFirst = renderRemoteMessage(firstStr, firstCtx);
                    }
                    if (renderedFirst && /<style\b/i.test(renderedFirst)) {
                        const styleMatches = renderedFirst.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi);
                        if (styleMatches) {
                            for (const sm of styleMatches) firstMessageStyles.push(sm);
                        }
                    }
                    if (renderedFirst && looksInteractiveWidget(renderedFirst)) {
                        pendingWidgetHtml = renderedFirst;
                    }
                }
            }

            // Evaluate CBS chronologically so var side effects stay exact
            const renderedRecent = [];
            for (let i = 0; i < recent.length; i++) {
                const msg = recent[i];
                const msgCtx = { ...renderCtx, tempVars: Object.create(null), slots: Object.create(null), chatIndex: startOffset + i, msgRole: msg.role || 'char' };
                const renderedMsg = renderRemoteMessage(msg.data, msgCtx);
                const swEntry = swipeHistory[makeSwipeKey(charObj, viewCharIndex, chatObj, viewChatIndex, startOffset + i)];
                renderedRecent.push({
                    idx: startOffset + i,
                    msg,
                    renderedMsg,
                    swEntry,
                    turnIndex: uaStats.turnByIndex[startOffset + i] || 0,
                });
            }

            const bgParts = [];
            if (charObj.backgroundHTML) bgParts.push(String(charObj.backgroundHTML));
            for (const m of enabledModules) {
                if (m && m.backgroundEmbedding) bgParts.push(String(m.backgroundEmbedding));
            }
            for (const fms of firstMessageStyles) bgParts.push(fms);
            const evaluatedBg = bgParts.length
                ? evalCBS(bgParts.join('\n'), { ...renderCtx, tempVars: Object.create(null), slots: Object.create(null) })
                : '';

            // Resolve assets newest-first so latest status card, side drawer, and backgroundHtml get inline priority
            const recentAssetStart = Math.max(0, renderedRecent.length - 8);
            const parsedRecent = new Array(renderedRecent.length);
            if (renderedRecent.length > 0) {
                const lastIdx = renderedRecent.length - 1;
                parsedRecent[lastIdx] = await renderMessageHtmlAndText(renderedRecent[lastIdx].renderedMsg, collector);
            }
            const backgroundHtml = evaluatedBg
                ? (await resolveHtmlAssetRefs(evaluatedBg, collector)).html
                : '';
            if (pendingWidgetHtml) {
                const parsedWidget = await renderMessageHtmlAndText(pendingWidgetHtml, collector);
                botWidgetHtml = parsedWidget.html || '';
            }
            for (let i = renderedRecent.length - 2; i >= recentAssetStart; i--) {
                parsedRecent[i] = await renderMessageHtmlAndText(renderedRecent[i].renderedMsg, collector);
            }
            let parsedFirst = null;
            if (pendingFirstMsg) {
                parsedFirst = await renderMessageHtmlAndText(pendingFirstMsg.renderedFirst, collector);
            }
            for (let i = recentAssetStart - 1; i >= 0; i--) {
                parsedRecent[i] = await renderMessageHtmlAndText(renderedRecent[i].renderedMsg, collector.lazyView);
            }

            if (pendingFirstMsg && parsedFirst) {
                outMsgs.push({
                    index: -1,
                    role: 'char',
                    text: parsedFirst.text,
                    html: parsedFirst.html,
                    raw: pendingFirstMsg.firstStr,
                    images: parsedFirst.images,
                    isFirstMessage: true,
                    turnIndex: 0,
                });
            }
            for (let i = 0; i < renderedRecent.length; i++) {
                const item = renderedRecent[i];
                const parsed = parsedRecent[i] || { text: '', html: '', images: [] };
                outMsgs.push({
                    index: item.idx,
                    role: item.msg.role,
                    chatId: String(item.msg.chatId || ''),
                    text: parsed.text,
                    html: parsed.html,
                    raw: String(item.msg.data || ''),
                    images: parsed.images,
                    turnIndex: item.turnIndex,
                    swipeCount: item.swEntry && Array.isArray(item.swEntry.swipes) ? item.swEntry.swipes.length : 1,
                    swipeIndex: item.swEntry && typeof item.swEntry.index === 'number' ? item.swEntry.index : 0,
                });
            }

            const chatVariables = {};
            for (const [k, v] of Object.entries(inferredDefaults)) {
                chatVariables[k] = String(v);
            }
            for (const [k, v] of Object.entries(renderCtx.vars)) {
                if (Object.keys(chatVariables).length >= 400) break;
                const val = String(v ?? '');
                if (k === 'timetable_html_output' || k.endsWith('_html_output') || val.length > 600) continue;
                chatVariables[k] = val;
            }

            const loreEntries = collectStructuredLoreEntries(charObj, chatObj, enabledModules);
            const moduleLore = collectLorebookSummary(charObj, enabledModules, recent, chatObj);
            const loreSettings = (charObj && charObj.loreSettings && typeof charObj.loreSettings === 'object') ? charObj.loreSettings : {};
            const depthPromptObj = (charObj && charObj.depth_prompt && String(charObj.depth_prompt.prompt || '').trim())
                ? { depth: Number(charObj.depth_prompt.depth || 0), prompt: String(charObj.depth_prompt.prompt) }
                : null;

            return {
                sig,
                snapshot: {
                    charName: charObj.name || 'Character',
                    charIndex: viewCharIndex,
                    chatIndex: viewChatIndex,
                    chatUuid: String(chatObj.id || ''),
                    chatName: chatObj.name || `Chat ${viewChatIndex + 1}`,
                    isPcActive,
                    totalMessages: allMsgs.length,
                    totalTurns: uaStats.completedTurns,
                    pendingTurn: uaStats.pendingTurn,
                    fmIndex: fmIdx,
                    firstMessageCount,
                    greetingControls,
                    chatModules,
                    chatVariables,
                    useLocallySetGlobalVariables: useLocalToggles,
                    globalToggleValues,
                    localToggleValues: localVars,
                    customToggleBlocks: toggleBlocks,
                    backgroundHtml,
                    botWidgetHtml,
                    assetMap: collector.assetMap,
                    messages: outMsgs,
                    charContext: {
                        charId: String((charObj && charObj.chaId) || charObj.name || viewCharIndex),
                        name: charObj.name || 'Character',
                        lowLevelAccess: Boolean(charObj && charObj.lowLevelAccess),
                        desc: String(charObj.desc || '').slice(0, 20000),
                        personality: String(charObj.personality || '').slice(0, 4000),
                        scenario: String(charObj.scenario || '').slice(0, 4000),
                        systemPrompt: String(charObj.systemPrompt || '').slice(0, 6000),
                        moduleLore,
                        loreEntries,
                        replaceGlobalNote: String(charObj.replaceGlobalNote || ''),
                        depthPrompt: depthPromptObj,
                        memory: String((chatObj && chatObj.supaMemoryData) || ''),
                        loreDepth: Number(loreSettings.scanDepth || 10),
                        loreTokenBudget: Number(loreSettings.tokenBudget || 16000),
                        loreRecursive: loreSettings.recursiveScanning !== undefined ? Boolean(loreSettings.recursiveScanning) : true,
                        loreFullWord: Boolean(loreSettings.fullWordMatching),
                        fmIndex: fmIdx,
                        totalChatMessages: allMsgs.length,
                        note: String(chatObj.note || '').slice(0, 4000),
                        personaName,
                        personaPrompt: String(personaPrompt || '').slice(0, 4000),
                        personaIcon,
                        charImage,
                        charAssetNames: renderCtx.charAssetNames,
                        emotionNames: renderCtx.emotionNames,
                        firstMessage: String(charObj.firstMessage || ''),
                    },
                },
            };
        }

        // ================= Embedded RisuAI Lua Trigger Subset VM =================
        class LuaReturnSignal {
            constructor(vals) { this.vals = vals; }
        }
        class LuaBreakSignal {}
        class LuaMultiRet {
            constructor(vals) { this.vals = vals; }
        }
        class LuaPromptPause {
            constructor(info) { this.info = info; }
        }
        class LuaTable {
            constructor() { this.map = new Map(); }
            get(k) { return this.map.has(k) ? this.map.get(k) : null; }
            set(k, v) {
                if (v === null || v === undefined) this.map.delete(k);
                else this.map.set(k, v);
            }
            length() {
                let n = 0;
                while (this.map.has(n + 1)) n++;
                return n;
            }
        }

        function luaIsTruthy(v) {
            return v !== null && v !== undefined && v !== false;
        }
        function luaFirstVal(v) {
            return v instanceof LuaMultiRet ? (v.vals.length ? v.vals[0] : null) : (v === undefined ? null : v);
        }
        function luaExpandVals(rawVals) {
            const out = [];
            for (let i = 0; i < rawVals.length; i++) {
                const v = rawVals[i];
                if (v instanceof LuaMultiRet) {
                    if (i === rawVals.length - 1) out.push(...v.vals);
                    else out.push(v.vals.length ? v.vals[0] : null);
                } else {
                    out.push(v === undefined ? null : v);
                }
            }
            return out;
        }
        function luaToNum(v) {
            if (typeof v === 'number') return v;
            if (typeof v === 'string') {
                const t = v.trim();
                if (!t) return NaN;
                const n = Number(t);
                return Number.isFinite(n) ? n : NaN;
            }
            return NaN;
        }
        function luaToStr(v) {
            if (v === null || v === undefined) return 'nil';
            if (typeof v === 'boolean') return v ? 'true' : 'false';
            if (typeof v === 'number') return String(v);
            if (typeof v === 'string') return v;
            if (v instanceof LuaTable) return 'table';
            if (typeof v === 'function') return 'function';
            return String(v);
        }
        function toLuaValue(jsVal) {
            if (jsVal === null || jsVal === undefined) return null;
            if (Array.isArray(jsVal)) {
                const t = new LuaTable();
                for (let i = 0; i < jsVal.length; i++) t.set(i + 1, toLuaValue(jsVal[i]));
                return t;
            }
            if (typeof jsVal === 'object' && !(jsVal instanceof LuaTable)) {
                const t = new LuaTable();
                for (const [k, v] of Object.entries(jsVal)) t.set(k, toLuaValue(v));
                return t;
            }
            return jsVal;
        }
        function luaTableToArray(tbl) {
            if (Array.isArray(tbl)) return tbl.map((x) => luaToStr(x));
            if (!(tbl instanceof LuaTable)) return [];
            const out = [];
            const len = tbl.length();
            for (let i = 1; i <= len; i++) out.push(luaToStr(tbl.get(i)));
            return out;
        }

        function luaPatternClassChar(ch) {
            switch (ch) {
                case 'a': return 'A-Za-z';
                case 'A': return '^A-Za-z';
                case 'd': return '0-9';
                case 'D': return '^0-9';
                case 'l': return 'a-z';
                case 'L': return '^a-z';
                case 'u': return 'A-Z';
                case 'U': return '^A-Z';
                case 'w': return 'A-Za-z0-9';
                case 'W': return '^A-Za-z0-9';
                case 's': return '\\s';
                case 'S': return '\\S';
                case 'x': return '0-9A-Fa-f';
                case 'X': return '^0-9A-Fa-f';
                case 'c': return '\\x00-\\x1f\\x7f';
                case 'C': return '^\\x00-\\x1f\\x7f';
                case 'p': return '\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e';
                case 'P': return '^\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e';
                case 'z': return '\\x00';
                default: return null;
            }
        }
        function luaEscapeRegex(ch) {
            return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        function luaPatternToRegExp(pat, global = false) {
            const s = String(pat || '');
            let rs = '';
            let i = 0;
            while (i < s.length) {
                const c = s[i];
                if (c === '^' && i === 0) {
                    rs += '^';
                    i++;
                    continue;
                }
                if (c === '$' && i === s.length - 1) {
                    rs += '$';
                    i++;
                    continue;
                }
                let atom = '';
                if (c === '%' && i + 1 < s.length) {
                    const nxt = s[i + 1];
                    const cls = luaPatternClassChar(nxt);
                    atom = cls ? `[${cls}]` : luaEscapeRegex(nxt);
                    i += 2;
                } else if (c === '[') {
                    let j = i + 1;
                    let cls = '[';
                    if (s[j] === '^') { cls += '^'; j++; }
                    if (s[j] === ']') { cls += '\\]'; j++; }
                    while (j < s.length && s[j] !== ']') {
                        if (s[j] === '%' && j + 1 < s.length) {
                            const pCls = luaPatternClassChar(s[j + 1]);
                            cls += pCls ? pCls : luaEscapeRegex(s[j + 1]);
                            j += 2;
                        } else if (s[j] === '\\' || s[j] === '[') {
                            cls += '\\' + s[j++];
                        } else {
                            cls += s[j++];
                        }
                    }
                    cls += ']';
                    atom = cls;
                    i = j < s.length ? j + 1 : s.length;
                } else if (c === '.') {
                    atom = '[\\s\\S]';
                    i++;
                } else if (c === '(' || c === ')') {
                    rs += c;
                    i++;
                    continue;
                } else {
                    atom = luaEscapeRegex(c);
                    i++;
                }

                const q = s[i];
                if (q === '-') {
                    rs += atom + '*?';
                    i++;
                } else if (q === '*' || q === '+' || q === '?') {
                    rs += atom + q;
                    i++;
                } else {
                    rs += atom;
                }
            }
            return new RegExp(rs, global ? 'g' : '');
        }
        function luaStringFormat(fmt, args) {
            let idx = 0;
            return String(fmt || '').replace(/%(%|[-+0 #]*\d*(?:\.\d+)?[diuoxXeEfFgGsScq])/g, (m, spec) => {
                if (spec === '%') return '%';
                const val = args[idx++];
                const type = spec[spec.length - 1];
                const flagsMatch = spec.slice(0, -1).match(/^([-+0 #]*)(\d*)(?:\.(\d+))?$/);
                const flags = (flagsMatch && flagsMatch[1]) || '';
                const width = (flagsMatch && flagsMatch[2]) ? parseInt(flagsMatch[2], 10) : 0;
                const prec = (flagsMatch && flagsMatch[3] !== undefined) ? parseInt(flagsMatch[3], 10) : null;
                let out = '';
                if (type === 'd' || type === 'i' || type === 'u') {
                    const n = Math.trunc(Number(val) || 0);
                    const neg = n < 0;
                    let digits = String(Math.abs(n));
                    const padLen = prec !== null ? prec : (flags.includes('0') ? Math.max(0, width - (neg ? 1 : 0)) : 0);
                    if (digits.length < padLen) digits = digits.padStart(padLen, '0');
                    out = (neg ? '-' : '') + digits;
                } else if (type === 'x' || type === 'X') {
                    const n = Math.trunc(Number(val) || 0) >>> 0;
                    out = n.toString(16);
                    if (type === 'X') out = out.toUpperCase();
                } else if (type === 'o') {
                    out = (Math.trunc(Number(val) || 0) >>> 0).toString(8);
                } else if (type === 'f' || type === 'F' || type === 'g' || type === 'G') {
                    const n = Number(val) || 0;
                    out = prec !== null ? n.toFixed(prec) : String(n);
                } else if (type === 'c') {
                    out = String.fromCharCode(Number(val) || 0);
                } else if (type === 'q') {
                    out = JSON.stringify(luaToStr(val));
                } else {
                    out = luaToStr(val);
                    if (prec !== null) out = out.slice(0, prec);
                }
                if (width && out.length < width) {
                    const padChar = (flags.includes('0') && 'diuoxXfFgG'.includes(type) && !flags.includes('-')) ? '0' : ' ';
                    out = flags.includes('-') ? out.padEnd(width, ' ') : out.padStart(width, padChar);
                }
                return out;
            });
        }

        function tokenizeLua(src) {
            const keywords = new Set([
                'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
                'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return',
                'then', 'true', 'until', 'while',
            ]);
            const tokens = [];
            let i = 0;
            const len = src.length;

            const readLongBracket = (startIdx) => {
                if (src[startIdx] !== '[') return null;
                let j = startIdx + 1;
                while (j < len && src[j] === '=') j++;
                if (src[j] !== '[') return null;
                const eqCount = j - startIdx - 1;
                const closeSeq = ']' + '='.repeat(eqCount) + ']';
                let bodyStart = j + 1;
                if (src[bodyStart] === '\r' && src[bodyStart + 1] === '\n') bodyStart += 2;
                else if (src[bodyStart] === '\n') bodyStart += 1;
                const closeIdx = src.indexOf(closeSeq, bodyStart);
                if (closeIdx < 0) throw new Error('Unclosed long bracket in Lua');
                return { text: src.slice(bodyStart, closeIdx), end: closeIdx + closeSeq.length };
            };

            while (i < len) {
                const c = src[i];
                if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\u00A0') {
                    i++;
                    continue;
                }
                if (c === '-' && src[i + 1] === '-') {
                    if (src[i + 2] === '[') {
                        const lb = readLongBracket(i + 2);
                        if (lb) { i = lb.end; continue; }
                    }
                    while (i < len && src[i] !== '\n') i++;
                    continue;
                }
                if (c === '[') {
                    const lb = readLongBracket(i);
                    if (lb) {
                        tokens.push({ t: 'str', v: lb.text });
                        i = lb.end;
                        continue;
                    }
                }
                if (c === '"' || c === "'") {
                    const q = c;
                    i++;
                    let out = '';
                    while (i < len && src[i] !== q) {
                        if (src[i] === '\\' && i + 1 < len) {
                            const n = src[++i];
                            if (n === 'n') out += '\n';
                            else if (n === 'r') out += '\r';
                            else if (n === 't') out += '\t';
                            else if (n === 'a') out += '\x07';
                            else if (n === 'b') out += '\b';
                            else if (n === 'f') out += '\f';
                            else if (n === 'v') out += '\v';
                            else if (n === '\r') { if (src[i + 1] === '\n') i++; out += '\n'; }
                            else if (n === '\n') out += '\n';
                            else if (n === 'z') { while (i + 1 < len && /\s/.test(src[i + 1])) i++; }
                            else if (n === 'x' && /^[0-9a-fA-F]{2}/.test(src.slice(i + 1, i + 3))) {
                                out += String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16));
                                i += 2;
                            } else if (n === 'u' && src[i + 1] === '{') {
                                const endU = src.indexOf('}', i + 2);
                                if (endU > i + 2) {
                                    out += String.fromCodePoint(parseInt(src.slice(i + 2, endU), 16));
                                    i = endU;
                                }
                            } else if (/[0-9]/.test(n)) {
                                let digits = n;
                                if (/[0-9]/.test(src[i + 1] || '')) digits += src[++i];
                                if (/[0-9]/.test(src[i + 1] || '')) digits += src[++i];
                                out += String.fromCharCode(parseInt(digits, 10));
                            } else {
                                out += n;
                            }
                            i++;
                        } else {
                            out += src[i++];
                        }
                    }
                    if (src[i] === q) i++;
                    tokens.push({ t: 'str', v: out });
                    continue;
                }
                if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
                    const hex = src.slice(i).match(/^0[xX][0-9a-fA-F]+/);
                    if (hex) {
                        tokens.push({ t: 'num', v: parseInt(hex[0], 16) });
                        i += hex[0].length;
                        continue;
                    }
                    const num = src.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
                    if (num) {
                        tokens.push({ t: 'num', v: Number(num[0]) });
                        i += num[0].length;
                        continue;
                    }
                }
                if (/[a-zA-Z_]/.test(c)) {
                    let j = i + 1;
                    while (j < len && /[a-zA-Z0-9_]/.test(src[j])) j++;
                    const w = src.slice(i, j);
                    tokens.push({ t: keywords.has(w) ? 'kw' : 'id', v: w });
                    i = j;
                    continue;
                }
                const three = src.slice(i, i + 3);
                if (three === '...') {
                    tokens.push({ t: 'op', v: '...' });
                    i += 3;
                    continue;
                }
                const two = src.slice(i, i + 2);
                if (two === '..' || two === '==' || two === '~=' || two === '<=' || two === '>=' || two === '//' || two === '<<' || two === '>>') {
                    tokens.push({ t: 'op', v: two });
                    i += 2;
                    continue;
                }
                tokens.push({ t: 'op', v: c });
                i++;
            }
            tokens.push({ t: 'eof', v: '' });
            return tokens;
        }

        function parseLua(src) {
            const toks = tokenizeLua(src);
            let pos = 0;
            const peek = (offset = 0) => toks[Math.min(pos + offset, toks.length - 1)];
            const at = (t, v) => {
                const tk = peek();
                return tk.t === t && (v === undefined || tk.v === v);
            };
            const consume = (t, v) => {
                const tk = peek();
                if (t && tk.t !== t) throw new Error(`Lua parse error: expected ${t} ${v || ''}, got ${tk.t} '${tk.v}'`);
                if (v !== undefined && tk.v !== v) throw new Error(`Lua parse error: expected '${v}', got '${tk.v}'`);
                pos++;
                return tk;
            };
            const tryOp = (v) => {
                if (at('op', v)) { pos++; return true; }
                return false;
            };
            const tryKw = (v) => {
                if (at('kw', v)) { pos++; return true; }
                return false;
            };

            function parseBlock(stopKws) {
                const stmts = [];
                while (!at('eof') && !(peek().t === 'kw' && stopKws.has(peek().v))) {
                    while (tryOp(';')) {}
                    if (at('eof') || (peek().t === 'kw' && stopKws.has(peek().v))) break;
                    const st = parseStmt();
                    if (st) stmts.push(st);
                    if (st && st.type === 'return') {
                        while (tryOp(';')) {}
                        break;
                    }
                }
                return stmts;
            }

            function parseNameList() {
                const names = [consume('id').v];
                while (at('op', ',') && peek(1).t === 'id') {
                    pos++;
                    names.push(consume('id').v);
                }
                return names;
            }

            function parseExprList() {
                const exprs = [parseExpr()];
                while (tryOp(',')) exprs.push(parseExpr());
                return exprs;
            }

            function parseParams() {
                consume('op', '(');
                const params = [];
                let vararg = false;
                if (!at('op', ')')) {
                    while (true) {
                        if (tryOp('...')) {
                            vararg = true;
                            break;
                        }
                        params.push(consume('id').v);
                        if (!tryOp(',')) break;
                    }
                }
                consume('op', ')');
                return { params, vararg };
            }

            function parseFuncBody(addSelf = false) {
                const { params, vararg } = parseParams();
                const finalParams = addSelf ? ['self', ...params] : params;
                const body = parseBlock(new Set(['end']));
                consume('kw', 'end');
                return { type: 'funcExpr', params: finalParams, vararg, body };
            }

            function parseTable() {
                consume('op', '{');
                const fields = [];
                while (!at('op', '}')) {
                    if (tryOp('[')) {
                        const key = parseExpr();
                        consume('op', ']');
                        consume('op', '=');
                        fields.push({ key, val: parseExpr() });
                    } else if (peek().t === 'id' && peek(1).t === 'op' && peek(1).v === '=') {
                        const keyName = consume('id').v;
                        consume('op', '=');
                        fields.push({ key: { type: 'lit', val: keyName }, val: parseExpr() });
                    } else {
                        fields.push({ key: null, val: parseExpr() });
                    }
                    if (!tryOp(',') && !tryOp(';')) break;
                }
                consume('op', '}');
                return { type: 'table', fields };
            }

            function parsePrimary() {
                const tk = peek();
                if (tryOp('(')) {
                    const expr = parseExpr();
                    consume('op', ')');
                    return { type: 'paren', expr };
                }
                if (tk.t === 'id') {
                    pos++;
                    return { type: 'var', name: tk.v };
                }
                throw new Error(`Lua parse error: unexpected token '${tk.v}'`);
            }

            function parseCallArgs() {
                if (at('op', '(')) {
                    pos++;
                    const args = at('op', ')') ? [] : parseExprList();
                    consume('op', ')');
                    return args;
                }
                if (at('op', '{')) return [parseTable()];
                if (at('str')) return [{ type: 'lit', val: consume('str').v }];
                throw new Error(`Lua parse error: expected call args, got '${peek().v}'`);
            }

            function parseSuffixed() {
                let node = parsePrimary();
                while (true) {
                    if (tryOp('.')) {
                        const prop = consume('id').v;
                        node = { type: 'index', obj: node, key: { type: 'lit', val: prop } };
                    } else if (tryOp('[')) {
                        const key = parseExpr();
                        consume('op', ']');
                        node = { type: 'index', obj: node, key };
                    } else if (tryOp(':')) {
                        const method = consume('id').v;
                        const args = parseCallArgs();
                        node = { type: 'methodCall', obj: node, method, args };
                    } else if (at('op', '(') || at('op', '{') || at('str')) {
                        const args = parseCallArgs();
                        node = { type: 'call', fn: node, args };
                    } else {
                        break;
                    }
                }
                return node;
            }

            function parseSimpleExpr() {
                const tk = peek();
                if (tk.t === 'num' || tk.t === 'str') { pos++; return { type: 'lit', val: tk.v }; }
                if (tryKw('nil')) return { type: 'lit', val: null };
                if (tryKw('true')) return { type: 'lit', val: true };
                if (tryKw('false')) return { type: 'lit', val: false };
                if (tryOp('...')) return { type: 'vararg' };
                if (tryKw('function')) return parseFuncBody(false);
                if (at('op', '{')) return parseTable();
                return parseSuffixed();
            }

            const BIN_PREC = {
                or: [1, 1],
                and: [2, 2],
                '<': [3, 3], '>': [3, 3], '<=': [3, 3], '>=': [3, 3], '~=': [3, 3], '==': [3, 3],
                '|': [4, 4],
                '~': [5, 5],
                '&': [6, 6],
                '<<': [7, 7], '>>': [7, 7],
                '..': [8, 7],
                '+': [10, 10], '-': [10, 10],
                '*': [11, 11], '/': [11, 11], '//': [11, 11], '%': [11, 11],
                '^': [14, 13],
            };

            function parseSubExpr(minPrec) {
                let left;
                const tk = peek();
                if (tk.t === 'kw' && tk.v === 'not') {
                    pos++;
                    left = { type: 'unary', op: 'not', arg: parseSubExpr(12) };
                } else if (tk.t === 'op' && (tk.v === '-' || tk.v === '#' || tk.v === '~')) {
                    pos++;
                    left = { type: 'unary', op: tk.v, arg: parseSubExpr(12) };
                } else {
                    left = parseSimpleExpr();
                }

                while (true) {
                    const opTk = peek();
                    const opName = (opTk.t === 'op' || opTk.t === 'kw') ? opTk.v : '';
                    const prec = BIN_PREC[opName];
                    if (!prec || prec[0] < minPrec) break;
                    pos++;
                    const right = parseSubExpr(prec[1]);
                    left = { type: 'binary', op: opName, left, right };
                }
                return left;
            }

            function parseExpr() {
                return parseSubExpr(1);
            }

            function parseStmt() {
                if (tryKw('do')) {
                    const body = parseBlock(new Set(['end']));
                    consume('kw', 'end');
                    return { type: 'do', body };
                }
                if (tryKw('while')) {
                    const cond = parseExpr();
                    consume('kw', 'do');
                    const body = parseBlock(new Set(['end']));
                    consume('kw', 'end');
                    return { type: 'while', cond, body };
                }
                if (tryKw('repeat')) {
                    const body = parseBlock(new Set(['until']));
                    consume('kw', 'until');
                    const cond = parseExpr();
                    return { type: 'repeat', body, cond };
                }
                if (tryKw('if')) {
                    const branches = [];
                    const cond0 = parseExpr();
                    consume('kw', 'then');
                    const body0 = parseBlock(new Set(['elseif', 'else', 'end']));
                    branches.push({ cond: cond0, body: body0 });
                    while (tryKw('elseif')) {
                        const c = parseExpr();
                        consume('kw', 'then');
                        const b = parseBlock(new Set(['elseif', 'else', 'end']));
                        branches.push({ cond: c, body: b });
                    }
                    let elseBody = null;
                    if (tryKw('else')) {
                        elseBody = parseBlock(new Set(['end']));
                    }
                    consume('kw', 'end');
                    return { type: 'if', branches, elseBody };
                }
                if (tryKw('for')) {
                    const firstVar = consume('id').v;
                    if (tryOp('=')) {
                        const start = parseExpr();
                        consume('op', ',');
                        const limit = parseExpr();
                        const step = tryOp(',') ? parseExpr() : { type: 'lit', val: 1 };
                        consume('kw', 'do');
                        const body = parseBlock(new Set(['end']));
                        consume('kw', 'end');
                        return { type: 'forNum', varName: firstVar, start, limit, step, body };
                    }
                    const names = [firstVar];
                    while (tryOp(',')) names.push(consume('id').v);
                    consume('kw', 'in');
                    const iters = parseExprList();
                    consume('kw', 'do');
                    const body = parseBlock(new Set(['end']));
                    consume('kw', 'end');
                    return { type: 'forIn', names, iters, body };
                }
                if (tryKw('function')) {
                    let target = { type: 'var', name: consume('id').v };
                    let isMethod = false;
                    while (tryOp('.')) {
                        const prop = consume('id').v;
                        target = { type: 'index', obj: target, key: { type: 'lit', val: prop } };
                    }
                    if (tryOp(':')) {
                        const prop = consume('id').v;
                        target = { type: 'index', obj: target, key: { type: 'lit', val: prop } };
                        isMethod = true;
                    }
                    const fnExpr = parseFuncBody(isMethod);
                    return { type: 'assign', targets: [target], values: [fnExpr] };
                }
                if (tryKw('local')) {
                    if (tryKw('function')) {
                        const name = consume('id').v;
                        const fnExpr = parseFuncBody(false);
                        return { type: 'local', names: [name], values: [fnExpr], isFuncDecl: true };
                    }
                    const names = parseNameList();
                    const values = tryOp('=') ? parseExprList() : [];
                    return { type: 'local', names, values };
                }
                if (tryKw('return')) {
                    const stop = at('eof') || at('op', ';') || (peek().t === 'kw' && (peek().v === 'end' || peek().v === 'else' || peek().v === 'elseif' || peek().v === 'until'));
                    const values = stop ? [] : parseExprList();
                    return { type: 'return', values };
                }
                if (tryKw('break')) {
                    return { type: 'break' };
                }
                const first = parseSuffixed();
                if (first.type === 'call' || first.type === 'methodCall') {
                    return { type: 'exprStmt', expr: first };
                }
                const targets = [first];
                while (tryOp(',')) {
                    const nxt = parseSuffixed();
                    if (nxt.type === 'call' || nxt.type === 'methodCall') {
                        throw new Error('Lua parse error: syntax error in assignment');
                    }
                    targets.push(nxt);
                }
                consume('op', '=');
                const values = parseExprList();
                return { type: 'assign', targets, values };
            }

            return parseBlock(new Set());
        }

        async function executeRisuLuaTrigger(luaCodes, triggerName, hostApi) {
            const MAX_STEPS = 500000;
            let steps = 0;

            const makeScope = (parent, isVararg = false, varargList = []) => ({
                vars: Object.create(null),
                parent,
                varargList: isVararg ? varargList : (parent ? parent.varargList : []),
            });
            const resolveVar = (scope, name) => {
                let cur = scope;
                while (cur) {
                    if (Object.prototype.hasOwnProperty.call(cur.vars, name)) return cur.vars[name];
                    cur = cur.parent;
                }
                return null;
            };
            const assignVar = (scope, name, val) => {
                let cur = scope;
                while (cur) {
                    if (Object.prototype.hasOwnProperty.call(cur.vars, name)) {
                        cur.vars[name] = val;
                        return;
                    }
                    if (!cur.parent) {
                        cur.vars[name] = val;
                        return;
                    }
                    cur = cur.parent;
                }
            };

            const rootEnv = makeScope(null);
            const strLib = new LuaTable();
            strLib.set('len', (s) => luaToStr(s).length);
            strLib.set('lower', (s) => luaToStr(s).toLowerCase());
            strLib.set('upper', (s) => luaToStr(s).toUpperCase());
            strLib.set('rep', (s, n) => luaToStr(s).repeat(Math.max(0, Math.trunc(Number(n) || 0))));
            strLib.set('sub', (s, i, j) => {
                const str = luaToStr(s);
                const len = str.length;
                let a = Math.trunc(Number(i) || 1);
                let b = j === null || j === undefined ? len : Math.trunc(Number(j));
                if (a < 0) a = len + a + 1;
                if (b < 0) b = len + b + 1;
                a = Math.max(1, a);
                b = Math.min(len, b);
                if (a > b) return '';
                return str.slice(a - 1, b);
            });
            strLib.set('byte', (s, i = 1) => {
                const str = luaToStr(s);
                let idx = Math.trunc(Number(i) || 1);
                if (idx < 0) idx = str.length + idx + 1;
                if (idx < 1 || idx > str.length) return null;
                return str.charCodeAt(idx - 1);
            });
            strLib.set('char', (...codes) => String.fromCharCode(...codes.map((c) => Number(c) || 0)));
            strLib.set('format', (fmt, ...args) => luaStringFormat(fmt, args));
            strLib.set('find', (s, pat, init = 1, plain = false) => {
                const str = luaToStr(s);
                let start = Math.trunc(Number(init) || 1);
                if (start < 0) start = Math.max(1, str.length + start + 1);
                if (plain) {
                    const p = luaToStr(pat);
                    const idx = str.indexOf(p, start - 1);
                    if (idx < 0) return null;
                    return new LuaMultiRet([idx + 1, idx + p.length]);
                }
                const rx = luaPatternToRegExp(pat, false);
                const slice = str.slice(Math.max(0, start - 1));
                const m = rx.exec(slice);
                if (!m) return null;
                const sIdx = (start - 1) + m.index + 1;
                const eIdx = sIdx + m[0].length - 1;
                const caps = m.slice(1).map((x) => (x === undefined ? null : x));
                return new LuaMultiRet([sIdx, eIdx, ...caps]);
            });
            strLib.set('match', (s, pat, init = 1) => {
                const str = luaToStr(s);
                let start = Math.trunc(Number(init) || 1);
                if (start < 0) start = Math.max(1, str.length + start + 1);
                const rx = luaPatternToRegExp(pat, false);
                const m = rx.exec(str.slice(Math.max(0, start - 1)));
                if (!m) return null;
                if (m.length > 1) return new LuaMultiRet(m.slice(1).map((x) => (x === undefined ? null : x)));
                return m[0];
            });
            strLib.set('gmatch', (s, pat) => {
                const str = luaToStr(s);
                const rx = luaPatternToRegExp(pat, true);
                const all = [];
                let m;
                while ((m = rx.exec(str)) !== null) {
                    if (m[0].length === 0) rx.lastIndex++;
                    all.push(m.length > 1 ? new LuaMultiRet(m.slice(1).map((x) => (x === undefined ? null : x))) : m[0]);
                }
                let idx = 0;
                return () => (idx < all.length ? all[idx++] : null);
            });
            strLib.set('gsub', async (s, pat, repl, maxSub) => {
                const str = luaToStr(s);
                const rx = luaPatternToRegExp(pat, true);
                const limit = maxSub === null || maxSub === undefined ? Infinity : Math.max(0, Math.trunc(Number(maxSub) || 0));
                let count = 0;
                let out = '';
                let last = 0;
                let m;
                while (count < limit && (m = rx.exec(str)) !== null) {
                    out += str.slice(last, m.index);
                    const full = m[0];
                    const caps = m.slice(1);
                    let repVal = null;
                    if (typeof repl === 'function') {
                        repVal = luaFirstVal(await repl(...(caps.length ? caps : [full])));
                    } else if (repl instanceof LuaTable) {
                        repVal = repl.get(caps.length ? caps[0] : full);
                    } else {
                        repVal = luaToStr(repl).replace(/%([0-9%])/g, (_, d) => {
                            if (d === '%') return '%';
                            const n = parseInt(d, 10);
                            return n === 0 ? full : (caps[n - 1] ?? '');
                        });
                    }
                    out += (repVal === null || repVal === undefined || repVal === false) ? full : luaToStr(repVal);
                    count++;
                    last = m.index + full.length;
                    if (full.length === 0) rx.lastIndex++;
                }
                out += str.slice(last);
                return new LuaMultiRet([out, count]);
            });

            const tblLib = new LuaTable();
            tblLib.set('insert', (tbl, posOrVal, maybeVal) => {
                if (!(tbl instanceof LuaTable)) return;
                const len = tbl.length();
                if (maybeVal === undefined) {
                    tbl.set(len + 1, posOrVal);
                } else {
                    const p = Math.max(1, Math.min(len + 1, Math.trunc(Number(posOrVal) || (len + 1))));
                    for (let i = len; i >= p; i--) tbl.set(i + 1, tbl.get(i));
                    tbl.set(p, maybeVal);
                }
            });
            tblLib.set('remove', (tbl, posArg) => {
                if (!(tbl instanceof LuaTable)) return null;
                const len = tbl.length();
                if (len === 0) return null;
                const p = posArg === null || posArg === undefined ? len : Math.trunc(Number(posArg) || len);
                const removed = tbl.get(p);
                for (let i = p; i < len; i++) tbl.set(i, tbl.get(i + 1));
                tbl.set(len, null);
                return removed;
            });
            tblLib.set('concat', (tbl, sep = '', i = 1, j) => {
                if (!(tbl instanceof LuaTable)) return '';
                const s = sep === null || sep === undefined ? '' : luaToStr(sep);
                const start = Math.trunc(Number(i) || 1);
                const end = j === null || j === undefined ? tbl.length() : Math.trunc(Number(j));
                const arr = [];
                for (let k = start; k <= end; k++) arr.push(luaToStr(tbl.get(k)));
                return arr.join(s);
            });
            tblLib.set('sort', async (tbl, comp) => {
                if (!(tbl instanceof LuaTable)) return;
                const len = tbl.length();
                const arr = [];
                for (let i = 1; i <= len; i++) arr.push(tbl.get(i));
                if (typeof comp === 'function') {
                    for (let i = 1; i < arr.length; i++) {
                        const cur = arr[i];
                        let j = i - 1;
                        while (j >= 0 && luaIsTruthy(luaFirstVal(await comp(cur, arr[j])))) {
                            arr[j + 1] = arr[j];
                            j--;
                        }
                        arr[j + 1] = cur;
                    }
                } else {
                    arr.sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : luaToStr(a).localeCompare(luaToStr(b))));
                }
                for (let i = 1; i <= len; i++) tbl.set(i, arr[i - 1]);
            });
            tblLib.set('unpack', (tbl, i = 1, j) => {
                if (!(tbl instanceof LuaTable)) return new LuaMultiRet([]);
                const start = Math.trunc(Number(i) || 1);
                const end = j === null || j === undefined ? tbl.length() : Math.trunc(Number(j));
                const vals = [];
                for (let k = start; k <= end; k++) vals.push(tbl.get(k));
                return new LuaMultiRet(vals);
            });
            tblLib.set('shuffle', (tbl) => {
                if (!(tbl instanceof LuaTable)) return tbl;
                const len = tbl.length();
                for (let i = len; i >= 2; i--) {
                    const j = Math.floor(Math.random() * i) + 1;
                    const tmp = tbl.get(i);
                    tbl.set(i, tbl.get(j));
                    tbl.set(j, tmp);
                }
                return tbl;
            });
            tblLib.set('copy', (tbl) => {
                if (!(tbl instanceof LuaTable)) return tbl;
                const c = new LuaTable();
                for (const [k, v] of tbl.map.entries()) c.set(k, v);
                return c;
            });
            tblLib.set('contains', (tbl, val) => {
                if (!(tbl instanceof LuaTable)) return false;
                for (const v of tbl.map.values()) {
                    if (v === val) return true;
                }
                return false;
            });

            const mathLib = new LuaTable();
            mathLib.set('floor', (n) => Math.floor(Number(n) || 0));
            mathLib.set('ceil', (n) => Math.ceil(Number(n) || 0));
            mathLib.set('abs', (n) => Math.abs(Number(n) || 0));
            mathLib.set('sqrt', (n) => Math.sqrt(Number(n) || 0));
            mathLib.set('pow', (a, b) => Math.pow(Number(a) || 0, Number(b) || 0));
            mathLib.set('max', (...xs) => Math.max(...xs.map(Number)));
            mathLib.set('min', (...xs) => Math.min(...xs.map(Number)));
            mathLib.set('random', (m, n) => {
                if (m === null || m === undefined) return Math.random();
                if (n === null || n === undefined) return Math.floor(Math.random() * Math.trunc(Number(m))) + 1;
                const a = Math.trunc(Number(m));
                const b = Math.trunc(Number(n));
                return Math.floor(Math.random() * (b - a + 1)) + a;
            });
            mathLib.set('pi', Math.PI);
            mathLib.set('huge', Infinity);

            const pairsFn = (tbl) => {
                const entries = tbl instanceof LuaTable ? Array.from(tbl.map.entries()) : [];
                let idx = 0;
                const iter = () => {
                    if (idx >= entries.length) return null;
                    const [k, v] = entries[idx++];
                    return new LuaMultiRet([k, v]);
                };
                return new LuaMultiRet([iter, tbl, null]);
            };
            const ipairsFn = (tbl) => {
                const iter = (_t, cur) => {
                    const nxt = (Number(cur) || 0) + 1;
                    if (!(tbl instanceof LuaTable)) return null;
                    const v = tbl.get(nxt);
                    if (v === null || v === undefined) return null;
                    return new LuaMultiRet([nxt, v]);
                };
                return new LuaMultiRet([iter, tbl, 0]);
            };

            const luaValToJsForJson = (val, depth = 0) => {
                if (val === null || val === undefined || depth > 12) return null;
                if (val instanceof LuaTable) {
                    const arrLen = val.length();
                    if (arrLen > 0 && arrLen === val.map.size) {
                        const arr = [];
                        for (let i = 1; i <= arrLen; i++) arr.push(luaValToJsForJson(val.get(i), depth + 1));
                        return arr;
                    }
                    const obj = {};
                    for (const [k, v] of val.map.entries()) {
                        obj[String(k)] = luaValToJsForJson(v, depth + 1);
                    }
                    return obj;
                }
                return val;
            };
            const jsonLib = new LuaTable();
            jsonLib.set('encode', (v) => JSON.stringify(luaValToJsForJson(v)));
            jsonLib.set('decode', (s) => {
                try {
                    return toLuaValue(JSON.parse(String(s ?? '')));
                } catch (_) {
                    return null;
                }
            });

            const utf8Lib = new LuaTable();
            utf8Lib.set('len', (s) => Array.from(luaToStr(s)).length);
            utf8Lib.set('sub', (s, i, j) => {
                const chars = Array.from(luaToStr(s));
                const start = Math.max(1, Number(i) || 1);
                const end = j === undefined || j === null ? chars.length : (Number(j) < 0 ? chars.length + Number(j) + 1 : Number(j));
                return chars.slice(start - 1, Math.max(0, end)).join('');
            });
            utf8Lib.set('codes', (s) => {
                const chars = Array.from(luaToStr(s));
                let idx = 0;
                const iter = () => {
                    if (idx >= chars.length) return null;
                    const ch = chars[idx];
                    const bytePos = idx + 1;
                    idx += 1;
                    return new LuaMultiRet([bytePos, ch.codePointAt(0) || 0]);
                };
                return new LuaMultiRet([iter, null, null]);
            });
            const osLib = new LuaTable();
            osLib.set('time', () => Math.floor(Date.now() / 1000));
            osLib.set('clock', () => Number((Date.now() / 1000).toFixed(3)));
            osLib.set('date', (fmt) => {
                const d = new Date();
                if (!fmt || fmt === '*t') {
                    return toLuaValue({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), min: d.getMinutes(), sec: d.getSeconds() });
                }
                return d.toISOString();
            });

            rootEnv.vars.string = strLib;
            rootEnv.vars.table = tblLib;
            rootEnv.vars.math = mathLib;
            rootEnv.vars.json = jsonLib;
            rootEnv.vars.utf8 = utf8Lib;
            rootEnv.vars.os = osLib;
            rootEnv.vars.require = (modName) => {
                const name = String(modName || '').trim().toLowerCase();
                if (name === 'json' || name === 'dkjson' || name === 'cjson' || name === 'rxi.json') return jsonLib;
                if (name === 'math') return mathLib;
                if (name === 'string') return strLib;
                if (name === 'table') return tblLib;
                if (name === 'utf8') return utf8Lib;
                if (name === 'os') return osLib;
                return new LuaTable();
            };
            rootEnv.vars.tostring = (v) => luaToStr(v);
            rootEnv.vars.tonumber = (v, base) => {
                if (typeof v === 'number') return v;
                const s = String(v ?? '').trim();
                if (!s) return null;
                const n = base ? parseInt(s, Number(base)) : Number(s);
                return Number.isFinite(n) ? n : null;
            };
            rootEnv.vars.type = (v) => {
                if (v === null || v === undefined) return 'nil';
                if (typeof v === 'boolean') return 'boolean';
                if (typeof v === 'number') return 'number';
                if (typeof v === 'string') return 'string';
                if (typeof v === 'function') return 'function';
                if (v instanceof LuaTable) return 'table';
                return 'userdata';
            };
            rootEnv.vars.pairs = pairsFn;
            rootEnv.vars.ipairs = ipairsFn;
            rootEnv.vars.next = (tbl, key) => {
                if (!(tbl instanceof LuaTable)) return null;
                const entries = Array.from(tbl.map.entries());
                if (key === null || key === undefined) {
                    return entries.length ? new LuaMultiRet(entries[0]) : null;
                }
                const i = entries.findIndex(([k]) => k === key);
                if (i >= 0 && i + 1 < entries.length) return new LuaMultiRet(entries[i + 1]);
                return null;
            };
            rootEnv.vars.unpack = tblLib.get('unpack');
            rootEnv.vars.select = (idx, ...args) => {
                if (idx === '#') return args.length;
                const n = Math.trunc(Number(idx) || 1);
                if (n < 1) return null;
                return new LuaMultiRet(args.slice(n - 1));
            };
            rootEnv.vars.pcall = async (fn, ...args) => {
                try {
                    const res = await fn(...args);
                    if (res instanceof LuaMultiRet) return new LuaMultiRet([true, ...res.vals]);
                    return new LuaMultiRet([true, res === undefined ? null : res]);
                } catch (err) {
                    if (err instanceof LuaPromptPause) throw err;
                    return new LuaMultiRet([false, err && err.message ? err.message : String(err)]);
                }
            };
            rootEnv.vars.error = (msg) => { throw new Error(luaToStr(msg)); };
            rootEnv.vars.assert = (cond, msg) => {
                if (!luaIsTruthy(cond)) throw new Error(msg ? luaToStr(msg) : 'assertion failed');
                return cond;
            };
            rootEnv.vars.async = (fn) => async (...args) => fn(...args);
            rootEnv.vars.print = () => {};
            rootEnv.vars.log = () => {};

            for (const [k, fn] of Object.entries(hostApi || {})) {
                rootEnv.vars[k] = fn;
            }

            async function evalExprRaw(node, scope) {
                if (++steps > MAX_STEPS) throw new Error('Lua step budget exceeded');
                switch (node.type) {
                    case 'lit': return node.val;
                    case 'var': return resolveVar(scope, node.name);
                    case 'vararg': return new LuaMultiRet(scope.varargList || []);
                    case 'paren': return luaFirstVal(await evalExprRaw(node.expr, scope));
                    case 'table': {
                        const tbl = new LuaTable();
                        let arrIdx = 1;
                        for (let i = 0; i < node.fields.length; i++) {
                            const f = node.fields[i];
                            if (f.key === null) {
                                const v = await evalExprRaw(f.val, scope);
                                if (v instanceof LuaMultiRet && i === node.fields.length - 1) {
                                    for (const item of v.vals) tbl.set(arrIdx++, item);
                                } else {
                                    tbl.set(arrIdx++, luaFirstVal(v));
                                }
                            } else {
                                const k = luaFirstVal(await evalExprRaw(f.key, scope));
                                const v = luaFirstVal(await evalExprRaw(f.val, scope));
                                tbl.set(k, v);
                            }
                        }
                        return tbl;
                    }
                    case 'funcExpr': {
                        return async (...callArgs) => {
                            const fnScope = makeScope(scope, node.vararg, callArgs.slice(node.params.length));
                            for (let i = 0; i < node.params.length; i++) {
                                fnScope.vars[node.params[i]] = callArgs[i] === undefined ? null : callArgs[i];
                            }
                            try {
                                await execStmts(node.body, fnScope);
                                return null;
                            } catch (sig) {
                                if (sig instanceof LuaReturnSignal) {
                                    if (sig.vals.length === 0) return null;
                                    if (sig.vals.length === 1) return sig.vals[0];
                                    return new LuaMultiRet(sig.vals);
                                }
                                throw sig;
                            }
                        };
                    }
                    case 'index': {
                        const obj = luaFirstVal(await evalExprRaw(node.obj, scope));
                        const key = luaFirstVal(await evalExprRaw(node.key, scope));
                        if (obj instanceof LuaTable) return obj.get(key);
                        if (typeof obj === 'string') return strLib.get(key);
                        if (obj && typeof obj === 'object') return obj[key] ?? null;
                        return null;
                    }
                    case 'call': {
                        const fn = luaFirstVal(await evalExprRaw(node.fn, scope));
                        if (typeof fn !== 'function') {
                            const fnLabel = node.fn && node.fn.type === 'var' ? node.fn.name : (node.fn && node.fn.key && node.fn.key.val ? String(node.fn.key.val) : (node.fn && node.fn.type));
                            const typeDesc = fn === null || fn === undefined ? 'nil' : (fn instanceof LuaTable ? 'table' : typeof fn);
                            throw new Error(`Attempt to call '${fnLabel}' (${typeDesc})`);
                        }
                        const rawArgs = [];
                        for (const a of node.args) rawArgs.push(await evalExprRaw(a, scope));
                        const args = luaExpandVals(rawArgs);
                        return await fn(...args);
                    }
                    case 'methodCall': {
                        const obj = luaFirstVal(await evalExprRaw(node.obj, scope));
                        if (node.method === 'await') {
                            return await obj;
                        }
                        let methodFn = null;
                        if (typeof obj === 'string') methodFn = strLib.get(node.method);
                        else if (obj instanceof LuaTable) methodFn = obj.get(node.method);
                        else if (obj && typeof obj === 'object') methodFn = obj[node.method];
                        if (typeof methodFn !== 'function') {
                            throw new Error(`Attempt to call method '${node.method}' (nil)`);
                        }
                        const rawArgs = [];
                        for (const a of node.args) rawArgs.push(await evalExprRaw(a, scope));
                        const args = luaExpandVals(rawArgs);
                        return await methodFn(obj, ...args);
                    }
                    case 'unary': {
                        const v = luaFirstVal(await evalExprRaw(node.arg, scope));
                        if (node.op === 'not') return !luaIsTruthy(v);
                        if (node.op === '#') {
                            if (typeof v === 'string') return v.length;
                            if (v instanceof LuaTable) return v.length();
                            return 0;
                        }
                        if (node.op === '-') return -luaToNum(v);
                        if (node.op === '~') return ~Math.trunc(luaToNum(v));
                        return null;
                    }
                    case 'binary': {
                        if (node.op === 'and') {
                            const l = luaFirstVal(await evalExprRaw(node.left, scope));
                            return luaIsTruthy(l) ? luaFirstVal(await evalExprRaw(node.right, scope)) : l;
                        }
                        if (node.op === 'or') {
                            const l = luaFirstVal(await evalExprRaw(node.left, scope));
                            return luaIsTruthy(l) ? l : luaFirstVal(await evalExprRaw(node.right, scope));
                        }
                        const l = luaFirstVal(await evalExprRaw(node.left, scope));
                        const r = luaFirstVal(await evalExprRaw(node.right, scope));
                        switch (node.op) {
                            case '..': return luaToStr(l) + luaToStr(r);
                            case '==': return l === r;
                            case '~=': return l !== r;
                            case '<': return (typeof l === 'string' && typeof r === 'string') ? (l < r) : (luaToNum(l) < luaToNum(r));
                            case '>': return (typeof l === 'string' && typeof r === 'string') ? (l > r) : (luaToNum(l) > luaToNum(r));
                            case '<=': return (typeof l === 'string' && typeof r === 'string') ? (l <= r) : (luaToNum(l) <= luaToNum(r));
                            case '>=': return (typeof l === 'string' && typeof r === 'string') ? (l >= r) : (luaToNum(l) >= luaToNum(r));
                            case '+': return luaToNum(l) + luaToNum(r);
                            case '-': return luaToNum(l) - luaToNum(r);
                            case '*': return luaToNum(l) * luaToNum(r);
                            case '/': return luaToNum(l) / luaToNum(r);
                            case '//': return Math.floor(luaToNum(l) / luaToNum(r));
                            case '%': {
                                const a = luaToNum(l), b = luaToNum(r);
                                return a - Math.floor(a / b) * b;
                            }
                            case '^': return Math.pow(luaToNum(l), luaToNum(r));
                            case '&': return Math.trunc(luaToNum(l)) & Math.trunc(luaToNum(r));
                            case '|': return Math.trunc(luaToNum(l)) | Math.trunc(luaToNum(r));
                            case '~': return Math.trunc(luaToNum(l)) ^ Math.trunc(luaToNum(r));
                            case '<<': return Math.trunc(luaToNum(l)) << Math.trunc(luaToNum(r));
                            case '>>': return Math.trunc(luaToNum(l)) >> Math.trunc(luaToNum(r));
                            default: return null;
                        }
                    }
                    default:
                        return null;
                }
            }

            async function evalList(exprs, scope) {
                const raw = [];
                for (const e of exprs) raw.push(await evalExprRaw(e, scope));
                return luaExpandVals(raw);
            }

            async function execStmts(stmts, scope) {
                for (const st of stmts) {
                    if (++steps > MAX_STEPS) throw new Error('Lua step budget exceeded');
                    switch (st.type) {
                        case 'do':
                            await execStmts(st.body, makeScope(scope));
                            break;
                        case 'local': {
                            if (st.isFuncDecl) {
                                scope.vars[st.names[0]] = null;
                                scope.vars[st.names[0]] = luaFirstVal(await evalExprRaw(st.values[0], scope));
                            } else {
                                const vals = st.values.length ? await evalList(st.values, scope) : [];
                                for (let i = 0; i < st.names.length; i++) {
                                    scope.vars[st.names[i]] = vals[i] === undefined ? null : vals[i];
                                }
                            }
                            break;
                        }
                        case 'assign': {
                            const vals = await evalList(st.values, scope);
                            const pairsToSet = [];
                            for (let i = 0; i < st.targets.length; i++) {
                                const tgt = st.targets[i];
                                const val = vals[i] === undefined ? null : vals[i];
                                if (tgt.type === 'var') {
                                    pairsToSet.push({ kind: 'var', name: tgt.name, val });
                                } else if (tgt.type === 'index') {
                                    const obj = luaFirstVal(await evalExprRaw(tgt.obj, scope));
                                    const key = luaFirstVal(await evalExprRaw(tgt.key, scope));
                                    pairsToSet.push({ kind: 'index', obj, key, val });
                                }
                            }
                            for (const pSet of pairsToSet) {
                                if (pSet.kind === 'var') assignVar(scope, pSet.name, pSet.val);
                                else if (pSet.obj instanceof LuaTable) pSet.obj.set(pSet.key, pSet.val);
                            }
                            break;
                        }
                        case 'exprStmt':
                            await evalExprRaw(st.expr, scope);
                            break;
                        case 'if': {
                            let ran = false;
                            for (const br of st.branches) {
                                if (luaIsTruthy(luaFirstVal(await evalExprRaw(br.cond, scope)))) {
                                    await execStmts(br.body, makeScope(scope));
                                    ran = true;
                                    break;
                                }
                            }
                            if (!ran && st.elseBody) await execStmts(st.elseBody, makeScope(scope));
                            break;
                        }
                        case 'while': {
                            while (luaIsTruthy(luaFirstVal(await evalExprRaw(st.cond, scope)))) {
                                try {
                                    await execStmts(st.body, makeScope(scope));
                                } catch (sig) {
                                    if (sig instanceof LuaBreakSignal) break;
                                    throw sig;
                                }
                            }
                            break;
                        }
                        case 'repeat': {
                            while (true) {
                                const rScope = makeScope(scope);
                                try {
                                    await execStmts(st.body, rScope);
                                } catch (sig) {
                                    if (sig instanceof LuaBreakSignal) break;
                                    throw sig;
                                }
                                if (luaIsTruthy(luaFirstVal(await evalExprRaw(st.cond, rScope)))) break;
                            }
                            break;
                        }
                        case 'forNum': {
                            const start = luaToNum(luaFirstVal(await evalExprRaw(st.start, scope)));
                            const limit = luaToNum(luaFirstVal(await evalExprRaw(st.limit, scope)));
                            const step = luaToNum(luaFirstVal(await evalExprRaw(st.step, scope)));
                            for (let v = start; step >= 0 ? v <= limit : v >= limit; v += step) {
                                const loopScope = makeScope(scope);
                                loopScope.vars[st.varName] = v;
                                try {
                                    await execStmts(st.body, loopScope);
                                } catch (sig) {
                                    if (sig instanceof LuaBreakSignal) break;
                                    throw sig;
                                }
                            }
                            break;
                        }
                        case 'forIn': {
                            const initVals = await evalList(st.iters, scope);
                            const iterFn = initVals[0];
                            const stateVal = initVals[1] === undefined ? null : initVals[1];
                            let varVal = initVals[2] === undefined ? null : initVals[2];
                            if (typeof iterFn !== 'function') break;
                            while (true) {
                                const rawNext = await iterFn(stateVal, varVal);
                                const nextVals = rawNext instanceof LuaMultiRet ? rawNext.vals : [rawNext === undefined ? null : rawNext];
                                if (nextVals[0] === null || nextVals[0] === undefined) break;
                                varVal = nextVals[0];
                                const loopScope = makeScope(scope);
                                for (let i = 0; i < st.names.length; i++) {
                                    loopScope.vars[st.names[i]] = nextVals[i] === undefined ? null : nextVals[i];
                                }
                                try {
                                    await execStmts(st.body, loopScope);
                                } catch (sig) {
                                    if (sig instanceof LuaBreakSignal) break;
                                    throw sig;
                                }
                            }
                            break;
                        }
                        case 'return': {
                            const vals = st.values.length ? await evalList(st.values, scope) : [];
                            throw new LuaReturnSignal(vals);
                        }
                        case 'break':
                            throw new LuaBreakSignal();
                    }
                }
            }

            const combined = Array.isArray(luaCodes) ? luaCodes.join('\n') : String(luaCodes || '');
            if (!combined.trim()) return { ran: false, pause: null };

            const ast = parseLua(combined);
            try {
                await execStmts(ast, rootEnv);
                const targetFn = rootEnv.vars[triggerName];
                if (typeof targetFn !== 'function') {
                    return { ran: false, pause: null };
                }
                await targetFn('risustand_trigger');
                return { ran: true, pause: null };
            } catch (sig) {
                if (sig instanceof LuaPromptPause) {
                    return { ran: true, pause: sig.info };
                }
                if (sig instanceof LuaReturnSignal) {
                    return { ran: true, pause: null };
                }
                throw sig;
            }
        }

        async function readSafeElementText(el) {
            if (!el) return '';
            for (const fn of ['getTextContent', 'getInnerText']) {
                if (typeof el[fn] === 'function') {
                    try {
                        const v = await el[fn]();
                        if (typeof v === 'string') return v;
                    } catch (_) {}
                }
            }
            if (typeof el.getInnerHTML === 'function') {
                try {
                    const html = await el.getInnerHTML();
                    if (typeof html === 'string') {
                        return html
                            .replace(/<br\s*\/?>/gi, '\n')
                            .replace(/<[^>]+>/g, '')
                            .replace(/&nbsp;/gi, ' ')
                            .replace(/&amp;/gi, '&')
                            .replace(/&lt;/gi, '<')
                            .replace(/&gt;/gi, '>')
                            .replace(/&quot;/gi, '"')
                            .replace(/&#39;/gi, "'");
                    }
                } catch (_) {}
            }
            return '';
        }

        async function findSafePcAlertModal() {
            if (!rootDoc || typeof rootDoc.querySelector !== 'function') return null;
            try {
                const card = await rootDoc.querySelector('.bg-darkbg.break-any.rounded-md');
                if (!card) return null;

                const h2 = await card.querySelector('h2');
                const heading = h2 ? (await readSafeElementText(h2)).trim() : '';
                if (heading !== '' && heading !== 'Error') return null;

                if (typeof card.querySelector === 'function') {
                    const interactive = await card.querySelector('input, iframe, select');
                    if (interactive) return null;
                }

                const mainSpan = (await card.querySelector('span.whitespace-pre-wrap')) || (await card.querySelector('.chattext.prose'));
                const msg = mainSpan ? (await readSafeElementText(mainSpan)).trim() : '';
                const subSpan = await card.querySelector('span.text-sm');
                const submsg = subSpan ? (await readSafeElementText(subSpan)).trim() : '';
                const combinedMsg = submsg ? `${msg}\n\n${submsg}` : msg;
                if (!combinedMsg.trim()) return null;

                let okBtn = null;
                if (typeof card.querySelectorAll === 'function') {
                    const btns = await unwrapArray(await card.querySelectorAll('button'));
                    for (const btn of btns) {
                        const txt = (await readSafeElementText(btn)).trim().toUpperCase();
                        if (txt === 'OK') {
                            okBtn = btn;
                            break;
                        }
                    }
                }
                if (!okBtn) return null;

                return {
                    heading,
                    message: combinedMsg,
                    okBtn,
                    sig: `${heading}|${combinedMsg}`,
                };
            } catch (_) {
                return null;
            }
        }

        async function pollPcNativeAlert() {
            const modal = await findSafePcAlertModal();
            if (!modal) {
                lastPcAlertSig = '';
                return null;
            }
            if (modal.sig === lastPcAlertSig) return null;
            lastPcAlertSig = modal.sig;
            return {
                id: makeUuid(),
                at: Date.now(),
                kind: modal.heading === 'Error' ? 'alert_error' : 'notice',
                title: modal.heading === 'Error' ? 'Error' : '',
                message: modal.message,
                source: 'pc_alert',
            };
        }

        async function runBotTrigger(cIdx, chIdx, triggerName, promptAnswers = [], opts = {}) {
            const charObj = await risuai.getCharacterFromIndex(cIdx);
            const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
            if (!charObj || !chatObj) {
                return { kind: 'error', message: '캐릭터 또는 채팅방을 찾을 수 없습니다.' };
            }
            if (!chatObj.scriptstate || typeof chatObj.scriptstate !== 'object') {
                chatObj.scriptstate = {};
            }

            let db = null;
            let enabledModules = [];
            try {
                db = await risuai.getDatabase(['modules', 'enabledModules', 'personas', 'selectedPersona', 'globalChatVariables']);
                if (db && Array.isArray(db.modules)) {
                    const enSet = new Set([
                        ...(Array.isArray(db.enabledModules) ? db.enabledModules.map(String) : []),
                        ...(Array.isArray(chatObj.modules) ? chatObj.modules.map(String) : []),
                    ]);
                    enabledModules = db.modules.filter((m) => m && enSet.has(String(m.id)));
                }
            } catch (_) {}

            let pcCharIdx = -1;
            try { pcCharIdx = await risuai.getCurrentCharacterIndex(); } catch (_) {}

            // Layer 1: Try native RisuAI API or live DOM click if available on active PC chat
            if (!opts.skipNativeLayer1 && typeof risuai.runTrigger === 'function' && cIdx === pcCharIdx) {
                try {
                    await risuai.runTrigger(triggerName);
                    lastSnapSig = '';
                    return { kind: 'ok' };
                } catch (_) {}
            }

            // Collect non-Lua manual triggers and isolated Lua trigger code groups
            const luaGroups = [];
            const allTriggers = [];
            const extractLuaCodes = (trList) => {
                const codes = [];
                for (const tr of trList || []) {
                    if (!tr || !Array.isArray(tr.effect)) continue;
                    for (const ef of tr.effect) {
                        if (ef && ef.type === 'triggerlua' && ef.code) {
                            codes.push(String(ef.code));
                        }
                    }
                }
                return codes;
            };
            if (Array.isArray(charObj.triggerscript)) {
                allTriggers.push(...charObj.triggerscript);
                const charLua = extractLuaCodes(charObj.triggerscript);
                if (charLua.length) luaGroups.push({ source: charObj.name || 'character', codes: charLua });
            }
            for (const m of enabledModules) {
                if (m && Array.isArray(m.trigger)) {
                    allTriggers.push(...m.trigger);
                    const modLua = extractLuaCodes(m.trigger);
                    if (modLua.length) luaGroups.push({ source: m.name || m.id || 'module', codes: modLua });
                }
            }

            // Layer 2: Non-Lua manual trigger matching comment/name
            for (const tr of allTriggers) {
                if (!tr || tr.type !== 'manual') continue;
                if (tr.comment === triggerName || tr.id === triggerName) {
                    let applied = false;
                    for (const ef of tr.effect || []) {
                        if (!ef) continue;
                        if ((ef.type === 'setvar' || ef.type === 'v2SetVar') && ef.var) {
                            const key = String(ef.var).startsWith('$') ? String(ef.var).slice(1) : String(ef.var);
                            if (ef.operator === '+=') {
                                chatObj.scriptstate['$' + key] = String((Number(chatObj.scriptstate['$' + key]) || 0) + (Number(ef.value) || 0));
                            } else if (ef.operator === '-=') {
                                chatObj.scriptstate['$' + key] = String((Number(chatObj.scriptstate['$' + key]) || 0) - (Number(ef.value) || 0));
                            } else {
                                chatObj.scriptstate['$' + key] = String(ef.value ?? '');
                            }
                            applied = true;
                        }
                    }
                    if (applied) {
                        await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                        lastSnapSig = '';
                        return { kind: 'ok' };
                    }
                }
            }

            // Layer 3: Execute Lua trigger script groups independently
            if (!luaGroups.length) {
                if (cIdx === pcCharIdx && rootDoc) {
                    try {
                        const el = await rootDoc.querySelector(`[risu-trigger="${String(triggerName).replace(/"/g, '\\"')}"]`);
                        if (el && typeof el.click === 'function') {
                            await el.click();
                            lastSnapSig = '';
                            return { kind: 'ok' };
                        }
                    } catch (_) {}
                }
                return { kind: 'error', message: `트리거 '${triggerName}' 를 실행할 스크립트를 찾지 못했습니다.` };
            }

            let dirty = false;
            const notices = [];
            let promptCursor = 0;
            const answers = Array.isArray(promptAnswers) ? promptAnswers : [];
            const globalVars = {
                ...(db && db.globalChatVariables ? db.globalChatVariables : {}),
                ...(chatObj.useLocallySetGlobalVariables && chatObj.GLGlobalVariables ? chatObj.GLGlobalVariables : {}),
            };
            let personaName = 'User';
            if (db && Array.isArray(db.personas)) {
                const per = db.personas[db.selectedPersona || 0];
                if (per && per.name) personaName = per.name;
            }

            const luaValueToJs = (val, depth = 0) => {
                if (val === null || val === undefined || depth > 12) return null;
                if (val instanceof LuaTable) {
                    const arrLen = val.length();
                    if (arrLen > 0 && arrLen === val.map.size) {
                        const arr = [];
                        for (let i = 1; i <= arrLen; i++) arr.push(luaValueToJs(val.get(i), depth + 1));
                        return arr;
                    }
                    const obj = {};
                    for (const [k, v] of val.map.entries()) {
                        obj[String(k)] = luaValueToJs(v, depth + 1);
                    }
                    return obj;
                }
                return val;
            };

            const hostApi = {
                getChatVar: (_tid, k) => {
                    const clean = String(k || '').replace(/^\$/, '');
                    const key = '$' + clean;
                    if (!Object.prototype.hasOwnProperty.call(chatObj.scriptstate, key)) return null;
                    const v = chatObj.scriptstate[key];
                    return typeof v === 'object' && v !== null ? toLuaValue(v) : v;
                },
                getState: (_tid, k) => {
                    const clean = String(k || '').replace(/^\$/, '');
                    const key = '$' + clean;
                    if (!Object.prototype.hasOwnProperty.call(chatObj.scriptstate, key)) return null;
                    const v = chatObj.scriptstate[key];
                    if (typeof v === 'object' && v !== null) return toLuaValue(v);
                    if (typeof v === 'string' && ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']')))) {
                        try { return toLuaValue(JSON.parse(v)); } catch (_) {}
                    }
                    return v;
                },
                setChatVar: (_tid, k, v) => {
                    const clean = String(k || '').replace(/^\$/, '');
                    if (v === null || v === undefined) chatObj.scriptstate['$' + clean] = '';
                    else if (v instanceof LuaTable) chatObj.scriptstate['$' + clean] = JSON.stringify(luaValueToJs(v));
                    else chatObj.scriptstate['$' + clean] = String(v);
                    dirty = true;
                },
                setState: (_tid, k, v) => {
                    const clean = String(k || '').replace(/^\$/, '');
                    const key = '$' + clean;
                    if (v === null || v === undefined) delete chatObj.scriptstate[key];
                    else chatObj.scriptstate[key] = luaValueToJs(v);
                    dirty = true;
                },
                getGlobalVar: (_tid, k) => {
                    const key = String(k || '');
                    if (Object.prototype.hasOwnProperty.call(globalVars, key)) return globalVars[key];
                    if (Object.prototype.hasOwnProperty.call(globalVars, 'toggle_' + key)) return globalVars['toggle_' + key];
                    return null;
                },
                listenEdit: () => {},
                getName: () => charObj.name || 'Character',
                getPersonaName: () => personaName,
                getFullChat: () => {
                    const list = Array.isArray(chatObj.message) ? chatObj.message : [];
                    return toLuaValue(list.map((m) => ({ role: m.role || 'char', data: String(m.data || '') })));
                },
                getChat: (_tid, idx) => {
                    const list = Array.isArray(chatObj.message) ? chatObj.message : [];
                    const m = list[Number(idx)];
                    return m ? toLuaValue({ role: m.role || 'char', data: String(m.data || '') }) : null;
                },
                getChatLength: () => (Array.isArray(chatObj.message) ? chatObj.message.length : 0),
                setChat: (_tid, idx, data) => {
                    if (!Array.isArray(chatObj.message)) chatObj.message = [];
                    const i = Number(idx);
                    if (i >= 0 && chatObj.message[i]) {
                        chatObj.message[i].data = String(data ?? '');
                        dirty = true;
                    }
                },
                addChat: (_tid, role, data) => {
                    if (!Array.isArray(chatObj.message)) chatObj.message = [];
                    chatObj.message.push({ role: role === 'user' ? 'user' : 'char', data: String(data ?? ''), time: Date.now() });
                    dirty = true;
                },
                removeChat: (_tid, idx) => {
                    if (!Array.isArray(chatObj.message)) return;
                    const i = Number(idx);
                    if (i >= 0 && i < chatObj.message.length) {
                        chatObj.message.splice(i, 1);
                        dirty = true;
                    }
                },
                getAuthorsNote: () => String(chatObj.note || ''),
                setAuthorsNote: (_tid, note) => { chatObj.note = String(note ?? ''); dirty = true; },
                getLoreBooks: () => toLuaValue([]),
                upsertLocalLoreBook: () => {},
                reloadDisplay: () => { dirty = true; },
                reloadChat: () => { dirty = true; },
                stopChat: () => {},
                alertNormal: (_tid, msg) => { notices.push({ kind: 'notice', message: String(msg ?? '') }); },
                alertError: (_tid, msg) => { notices.push({ kind: 'error', message: String(msg ?? '') }); },
                alertConfirm: (_tid, msg) => {
                    if (promptCursor < answers.length) return answers[promptCursor++] === '0';
                    throw new LuaPromptPause({
                        kind: 'prompt_select',
                        message: String(msg ?? '계속할까요?'),
                        options: ['확인', '취소'],
                        trigger: triggerName,
                        charIndex: cIdx,
                        chatIndex: chIdx,
                        answersSoFar: answers.slice(),
                    });
                },
                alertInput: (_tid, msg) => {
                    if (promptCursor < answers.length) return String(answers[promptCursor++] ?? '');
                    throw new LuaPromptPause({
                        kind: 'prompt_input',
                        message: String(msg ?? '값을 입력하세요'),
                        options: [],
                        trigger: triggerName,
                        charIndex: cIdx,
                        chatIndex: chIdx,
                        answersSoFar: answers.slice(),
                    });
                },
                alertSelect: (_tid, options, msg) => {
                    if (promptCursor < answers.length) return String(answers[promptCursor++] ?? '0');
                    throw new LuaPromptPause({
                        kind: 'prompt_select',
                        message: String(msg ?? '항목을 선택하세요'),
                        options: luaTableToArray(options),
                        trigger: triggerName,
                        charIndex: cIdx,
                        chatIndex: chIdx,
                        answersSoFar: answers.slice(),
                    });
                },
            };

            let ran = false;
            let lastLuaErr = null;
            for (const grp of luaGroups) {
                try {
                    const res = await executeRisuLuaTrigger(grp.codes, triggerName, hostApi);
                    if (res.pause) {
                        return res.pause;
                    }
                    if (res.ran) {
                        ran = true;
                        if (!opts.runAllGroups) break;
                    }
                } catch (err) {
                    lastLuaErr = err;
                }
            }
            if (!ran) {
                if (opts.quietMissing) {
                    return { kind: 'ok' };
                }
                if (lastLuaErr) {
                    return { kind: 'error', message: `트리거 오류: ${lastLuaErr && lastLuaErr.message ? lastLuaErr.message : String(lastLuaErr)}` };
                }
                return { kind: 'error', message: `트리거 함수 '${triggerName}' 를 찾지 못했습니다.` };
            }
            if (dirty) {
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                lastSnapSig = '';
            }
            if (notices.length) {
                const lastNotice = notices[notices.length - 1];
                return {
                    kind: notices.some((n) => n.kind === 'error') ? 'alert_error' : 'notice',
                    message: lastNotice.message,
                    notices: notices.map((n) => ({ message: n.message, isError: n.kind === 'error' })),
                };
            }
            return { kind: 'ok' };
        }
    
        function applyTargetSelection(nextChar, nextChat) {
            if (!Number.isInteger(nextChar) || nextChar < 0) return false;
            viewCharIndex = nextChar;
            viewChatIndex = Number.isInteger(nextChat) && nextChat >= 0 ? nextChat : 0;
            lastSnapSig = '';
            lastCatalogSig = '';
            pendingForcePoll = true;
            setTimeout(() => pollOnce(true), 40);
            void (async () => {
                try {
                    const pcCharIdx = await risuai.getCurrentCharacterIndex();
                    if (viewCharIndex === pcCharIdx) {
                        const charObj = await risuai.getCharacterFromIndex(viewCharIndex);
                        if (charObj && Array.isArray(charObj.chats) && viewChatIndex < charObj.chats.length && charObj.chatPage !== viewChatIndex) {
                            charObj.chatPage = viewChatIndex;
                            await risuai.setCharacterToIndex(viewCharIndex, charObj);
                        }
                    }
                } catch (_) {}
            })();
            return true;
        }

        async function handleCommand(cmd) {
            const type = cmd.type;
            const p = cmd.payload || {};
    
            if (type === 'sync_chat' || type === 'sync_all') {
                lastSnapSig = '';
                lastCatalogSig = '';
                pendingForcePoll = true;
                setTimeout(() => pollOnce(true), 80);
                return;
            }
    
            if (type === 'select_target') {
                applyTargetSelection(Number(p.charIndex), Number(p.chatIndex));
                return;
            }
    
            if (type === 'create_chat') {
                const cIdx = Number(p.charIndex);
                if (Number.isNaN(cIdx) || cIdx < 0) return;
                const charObj = await risuai.getCharacterFromIndex(cIdx);
                if (!charObj) return;
                if (!Array.isArray(charObj.chats)) charObj.chats = [];
                const newName = String(p.name || '').trim() || `New Chat ${charObj.chats.length + 1}`;
                charObj.chats.unshift({
                    message: [],
                    note: '',
                    name: newName,
                    localLore: [],
                    fmIndex: -1,
                    scriptstate: {},
                    id: makeUuid(),
                });
                charObj.chatPage = 0;
                await risuai.setCharacterToIndex(cIdx, charObj);
                viewCharIndex = cIdx;
                viewChatIndex = 0;
                lastSnapSig = '';
                lastCatalogSig = '';
                setTimeout(() => pollOnce(true), 150);
                return;
            }
    
            if (type === 'send_chat') {
                const msgText = String(p.text ?? '');
                const targetChar = typeof p.charIndex === 'number' ? p.charIndex : viewCharIndex;
                const targetChat = typeof p.chatIndex === 'number' ? p.chatIndex : viewChatIndex;
                const pcCharIdx = await risuai.getCurrentCharacterIndex();

                if (targetChar === pcCharIdx && pcCharIdx >= 0) {
                    if (isGenerating) return;
                    isGenerating = true;
                    void (async () => {
                        try {
                            const charObj = await risuai.getCharacterFromIndex(pcCharIdx);
                            if (charObj && typeof targetChat === 'number' && targetChat >= 0 && charObj.chatPage !== targetChat) {
                                charObj.chatPage = targetChat;
                                await risuai.setCharacterToIndex(pcCharIdx, charObj);
                            }
                            await risuai.sendChat(msgText);
                        } catch (err) {
                            const errMsg = `전송 오류: ${err && err.message ? err.message : '실패'}`;
                            lastStatus = `⚠️ ${errMsg}`;
                            pendingTriggerEvent = {
                                id: makeUuid(),
                                at: Date.now(),
                                kind: 'error',
                                message: errMsg,
                            };
                        } finally {
                            isGenerating = false;
                            lastSnapSig = '';
                            lastCatalogSig = '';
                            setTimeout(() => pollOnce(true), 250);
                        }
                    })();
                }
                return;
            }
    
            if (type === 'append_messages') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                const list = Array.isArray(p.messages) ? p.messages : [];
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx) || !list.length) return;
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!chatObj) return;
                if (!Array.isArray(chatObj.message)) chatObj.message = [];
                if (!chatObj.id) chatObj.id = makeUuid();
                for (const m of list) {
                    chatObj.message.push({
                        role: m.role === 'user' ? 'user' : 'char',
                        data: String(m.data || ''),
                        chatId: String(m.chatId || makeUuid()),
                        time: Date.now(),
                    });
                }
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                if (list.some((m) => m.role !== 'user')) {
                    try {
                        const ev = await runBotTrigger(cIdx, chIdx, 'onOutput', [], {
                            skipNativeLayer1: true,
                            runAllGroups: true,
                            quietMissing: true,
                        });
                        if (ev && (ev.kind === 'notice' || ev.kind === 'alert_error') && ev.message) {
                            pendingTriggerEvent = { id: makeUuid(), at: Date.now(), ...ev, source: 'lua_output' };
                        }
                    } catch (_) {}
                }
                lastSnapSig = '';
                lastCatalogSig = '';
                setTimeout(() => pollOnce(true), 150);
                return;
            }

            if (type === 'run_output_trigger') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                if (!Number.isNaN(cIdx) && !Number.isNaN(chIdx)) {
                    try {
                        const ev = await runBotTrigger(cIdx, chIdx, 'onOutput', [], {
                            skipNativeLayer1: true,
                            runAllGroups: true,
                            quietMissing: true,
                        });
                        if (ev && (ev.kind === 'notice' || ev.kind === 'alert_error') && ev.message) {
                            pendingTriggerEvent = { id: makeUuid(), at: Date.now(), ...ev, source: 'lua_output' };
                        }
                    } catch (_) {}
                    lastSnapSig = '';
                    setTimeout(() => pollOnce(true), 120);
                }
                return;
            }

            if (type === 'dismiss_pc_alert') {
                try {
                    const modal = await findSafePcAlertModal();
                    if (modal && modal.okBtn && typeof modal.okBtn.click === 'function') {
                        await modal.okBtn.click();
                        lastPcAlertSig = '';
                    }
                } catch (_) {}
                return;
            }
    
            if (type === 'edit_message') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                const mIdx = Number(p.msgIndex);
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx) || Number.isNaN(mIdx) || mIdx < 0) return;
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!chatObj || !Array.isArray(chatObj.message) || !chatObj.message[mIdx]) return;
                chatObj.message[mIdx].data = String(p.text || '');
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'set_author_note') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx)) return;
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!chatObj) return;
                chatObj.note = String(p.note ?? '');
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'set_char_global_note') {
                const cIdx = Number(p.charIndex);
                if (Number.isNaN(cIdx) || cIdx < 0) return;
                const charObj = await risuai.getCharacterFromIndex(cIdx);
                if (!charObj) return;
                charObj.replaceGlobalNote = String(p.replaceGlobalNote ?? '');
                await risuai.setCharacterToIndex(cIdx, charObj);
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }
    
            if (type === 'delete_message') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                const mIdx = Number(p.msgIndex);
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx) || Number.isNaN(mIdx) || mIdx < 0) return;
                const charObj = await risuai.getCharacterFromIndex(cIdx);
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!chatObj || !Array.isArray(chatObj.message) || !chatObj.message[mIdx]) return;
                const prevLen = chatObj.message.length;
                chatObj.message.splice(mIdx, 1);
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                const prefix = `${(charObj && charObj.chaId) || cIdx}:${(chatObj && chatObj.id) || chIdx}:`;
                delete swipeHistory[`${prefix}${mIdx}`];
                for (let k = mIdx + 1; k < prevLen; k++) {
                    if (swipeHistory[`${prefix}${k}`]) {
                        swipeHistory[`${prefix}${k - 1}`] = swipeHistory[`${prefix}${k}`];
                        delete swipeHistory[`${prefix}${k}`];
                    }
                }
                await saveSwipeHistory();
                lastSnapSig = '';
                lastCatalogSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'swipe_message') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                const mIdx = Number(p.msgIndex);
                const delta = Number(p.delta) || 0;
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx) || Number.isNaN(mIdx) || mIdx < 0 || !delta) return;
                const charObj = await risuai.getCharacterFromIndex(cIdx);
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!chatObj || !Array.isArray(chatObj.message) || !chatObj.message[mIdx]) return;
                const key = makeSwipeKey(charObj, cIdx, chatObj, chIdx, mIdx);
                const entry = swipeHistory[key];
                if (!entry || !Array.isArray(entry.swipes) || entry.swipes.length <= 1) return;
                const nextIdx = (entry.index + delta + entry.swipes.length) % entry.swipes.length;
                entry.index = nextIdx;
                chatObj.message[mIdx].data = String(entry.swipes[nextIdx] || '');
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                await saveSwipeHistory();
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'replace_message_with_swipe') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                const mIdx = Number(p.msgIndex);
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx) || Number.isNaN(mIdx) || mIdx < 0) return;
                const charObj = await risuai.getCharacterFromIndex(cIdx);
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!chatObj || !Array.isArray(chatObj.message) || !chatObj.message[mIdx]) return;
                const prevData = String(chatObj.message[mIdx].data || '');
                const newData = String(p.newData || '');
                if (!newData) return;
                const key = makeSwipeKey(charObj, cIdx, chatObj, chIdx, mIdx);
                recordSwipeVersion(key, prevData, newData);
                chatObj.message[mIdx].data = newData;
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                await saveSwipeHistory();
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'reroll_message') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                const mIdx = Number(p.msgIndex);
                const pcCharIdx = await risuai.getCurrentCharacterIndex();
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx) || Number.isNaN(mIdx) || mIdx < 0) return;
                if (cIdx !== pcCharIdx || pcCharIdx < 0) return;
                if (isGenerating) return;

                const charObj = await risuai.getCharacterFromIndex(cIdx);
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!charObj || !chatObj || !Array.isArray(chatObj.message) || !chatObj.message[mIdx]) return;
                if (chatObj.message[mIdx].role === 'user' || mIdx !== chatObj.message.length - 1) return;

                const prevMsg = { ...chatObj.message[mIdx] };
                const key = makeSwipeKey(charObj, cIdx, chatObj, chIdx, mIdx);
                recordSwipeVersion(key, prevMsg.data);
                isGenerating = true;
                void (async () => {
                    try {
                        if (charObj.chatPage !== chIdx) {
                            charObj.chatPage = chIdx;
                            await risuai.setCharacterToIndex(cIdx, charObj);
                        }
                        chatObj.message.splice(mIdx, 1);
                        await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                        await risuai.sendChat('');
                        const afterChat = await risuai.getChatFromIndex(cIdx, chIdx);
                        if (afterChat && Array.isArray(afterChat.message) && afterChat.message[mIdx] && afterChat.message[mIdx].role !== 'user' && String(afterChat.message[mIdx].data || '').trim()) {
                            recordSwipeVersion(key, prevMsg.data, afterChat.message[mIdx].data);
                        } else if (afterChat && Array.isArray(afterChat.message) && afterChat.message.length <= mIdx) {
                            afterChat.message.push(prevMsg);
                            await risuai.setChatToIndex(cIdx, chIdx, afterChat);
                        }
                        await saveSwipeHistory();
                    } catch (err) {
                        try {
                            const fallbackChat = await risuai.getChatFromIndex(cIdx, chIdx);
                            if (fallbackChat && Array.isArray(fallbackChat.message) && fallbackChat.message.length <= mIdx) {
                                fallbackChat.message.push(prevMsg);
                                await risuai.setChatToIndex(cIdx, chIdx, fallbackChat);
                            }
                        } catch (_) {}
                        pendingTriggerEvent = {
                            id: makeUuid(),
                            at: Date.now(),
                            kind: 'error',
                            message: `리롤 오류: ${err && err.message ? err.message : '실패'}`,
                        };
                    } finally {
                        isGenerating = false;
                        lastSnapSig = '';
                        lastCatalogSig = '';
                        setTimeout(() => pollOnce(true), 250);
                    }
                })();
                return;
            }
    
            if (type === 'toggle_module' && p.moduleId) {
                const modId = String(p.moduleId);
                if (p.scope === 'chat') {
                    const cIdx = Number.isNaN(Number(p.charIndex)) ? viewCharIndex : Number(p.charIndex);
                    const chIdx = Number.isNaN(Number(p.chatIndex)) ? viewChatIndex : Number(p.chatIndex);
                    if (cIdx < 0 || chIdx < 0) return;
                    const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                    if (!chatObj) return;
                    const set = new Set(Array.isArray(chatObj.modules) ? chatObj.modules.map(String) : []);
                    if (p.enabled) set.add(modId);
                    else set.delete(modId);
                    chatObj.modules = Array.from(set);
                    await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                } else {
                    const db = await risuai.getDatabase(['enabledModules']);
                    if (!db) return;
                    const set = new Set(Array.isArray(db.enabledModules) ? db.enabledModules.map(String) : []);
                    if (p.enabled) set.add(modId);
                    else set.delete(modId);
                    await risuai.setDatabaseLite({ enabledModules: Array.from(set) });
                }
                lastCatalogSig = '';
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 150);
                return;
            }
    
            if (type === 'select_persona') {
                const idx = Number(p.personaIndex);
                if (Number.isNaN(idx) || idx < 0) return;
                await risuai.setDatabaseLite({ selectedPersona: idx });
                lastCatalogSig = '';
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 150);
                return;
            }
    
            if (type === 'set_custom_toggle' && p.key) {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx)) return;
                const charObj = await risuai.getCharacterFromIndex(cIdx);
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!chatObj) return;
                const fullKey = String(p.key).startsWith('toggle_') ? String(p.key) : ('toggle_' + String(p.key));
                const useGlobal = p.scope === 'global' || (p.scope !== 'local' && !chatObj.useLocallySetGlobalVariables);
                if (useGlobal) {
                    const db = await risuai.getDatabase(['globalChatVariables']);
                    const nextGlobal = (db && db.globalChatVariables && typeof db.globalChatVariables === 'object') ? { ...db.globalChatVariables } : {};
                    if (p.value === null || p.value === undefined || p.value === '') {
                        delete nextGlobal[fullKey];
                    } else {
                        nextGlobal[fullKey] = String(p.value);
                    }
                    await risuai.setDatabaseLite({ globalChatVariables: nextGlobal });
                } else {
                    chatObj.useLocallySetGlobalVariables = true;
                    if (!chatObj.GLGlobalVariables || typeof chatObj.GLGlobalVariables !== 'object') {
                        chatObj.GLGlobalVariables = {};
                    }
                    if (p.value === null || p.value === undefined || p.value === '') {
                        delete chatObj.GLGlobalVariables[fullKey];
                    } else {
                        chatObj.GLGlobalVariables[fullKey] = String(p.value);
                    }
                    await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                }
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'set_local_toggle_mode') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx)) return;
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!chatObj) return;
                const nextEnabled = Boolean(p.enabled);
                chatObj.useLocallySetGlobalVariables = nextEnabled;
                if (nextEnabled && (!chatObj.GLGlobalVariables || Object.keys(chatObj.GLGlobalVariables).length === 0)) {
                    try {
                        const db = await risuai.getDatabase(['globalChatVariables']);
                        if (db && db.globalChatVariables && typeof db.globalChatVariables === 'object') {
                            chatObj.GLGlobalVariables = {};
                            for (const [gk, gv] of Object.entries(db.globalChatVariables)) {
                                if (String(gk).startsWith('toggle_') && gv !== undefined && gv !== null) {
                                    chatObj.GLGlobalVariables[gk] = String(gv);
                                }
                            }
                        }
                    } catch (_) {}
                }
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'set_author_note') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx)) return;
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!chatObj) return;
                chatObj.note = String(p.note ?? '');
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'set_char_global_note') {
                const cIdx = Number(p.charIndex);
                if (Number.isNaN(cIdx) || cIdx < 0) return;
                const charObj = await risuai.getCharacterFromIndex(cIdx);
                if (!charObj) return;
                charObj.replaceGlobalNote = String(p.replaceGlobalNote ?? '');
                await risuai.setCharacterToIndex(cIdx, charObj);
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'set_first_message') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx)) return;
                const charObj = await risuai.getCharacterFromIndex(cIdx);
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!charObj || !chatObj) return;
                const altCount = Array.isArray(charObj.alternateGreetings) ? charObj.alternateGreetings.length : 0;
                const nextFm = Math.max(-1, Math.min(altCount - 1, Number(p.fmIndex)));
                if (Number.isNaN(nextFm)) return;
                chatObj.fmIndex = nextFm;
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'set_author_note') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx)) return;
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!chatObj) return;
                chatObj.note = String(p.note ?? '');
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'set_char_global_note') {
                const cIdx = Number(p.charIndex);
                if (Number.isNaN(cIdx) || cIdx < 0) return;
                const charObj = await risuai.getCharacterFromIndex(cIdx);
                if (!charObj) return;
                charObj.replaceGlobalNote = String(p.replaceGlobalNote ?? '');
                await risuai.setCharacterToIndex(cIdx, charObj);
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'set_chat_var' && p.key) {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx)) return;
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!chatObj) return;
                if (!chatObj.scriptstate || typeof chatObj.scriptstate !== 'object') {
                    chatObj.scriptstate = {};
                }
                const cleanKey = String(p.key).startsWith('$') ? String(p.key).slice(1) : String(p.key);
                if (p.value === null || p.value === undefined) {
                    delete chatObj.scriptstate['$' + cleanKey];
                } else {
                    chatObj.scriptstate['$' + cleanKey] = String(p.value);
                }
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'set_author_note') {
                const cIdx = Number(p.charIndex);
                const chIdx = Number(p.chatIndex);
                if (Number.isNaN(cIdx) || Number.isNaN(chIdx)) return;
                const chatObj = await risuai.getChatFromIndex(cIdx, chIdx);
                if (!chatObj) return;
                chatObj.note = String(p.note ?? '');
                await risuai.setChatToIndex(cIdx, chIdx, chatObj);
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'set_char_global_note') {
                const cIdx = Number(p.charIndex);
                if (Number.isNaN(cIdx) || cIdx < 0) return;
                const charObj = await risuai.getCharacterFromIndex(cIdx);
                if (!charObj) return;
                charObj.replaceGlobalNote = String(p.replaceGlobalNote ?? '');
                await risuai.setCharacterToIndex(cIdx, charObj);
                lastSnapSig = '';
                setTimeout(() => pollOnce(true), 120);
                return;
            }

            if (type === 'run_trigger' && p.trigger) {
                const cIdx = Number.isNaN(Number(p.charIndex)) ? viewCharIndex : Number(p.charIndex);
                const chIdx = Number.isNaN(Number(p.chatIndex)) ? viewChatIndex : Number(p.chatIndex);
                try {
                    const ev = await runBotTrigger(cIdx, chIdx, String(p.trigger), p.promptAnswers || []);
                    if (ev && ev.kind !== 'ok') {
                        pendingTriggerEvent = { id: makeUuid(), at: Date.now(), ...ev };
                    }
                } catch (err) {
                    pendingTriggerEvent = {
                        id: makeUuid(),
                        at: Date.now(),
                        kind: 'error',
                        message: `트리거 오류: ${err && err.message ? err.message : String(err)}`,
                    };
                }
                setTimeout(() => pollOnce(true), 80);
                return;
            }

            if (type === 'update_params') {
                const patch = {};
                if (typeof p.temperature === 'number' && !Number.isNaN(p.temperature)) patch.temperature = p.temperature;
                if (typeof p.maxContext === 'number' && !Number.isNaN(p.maxContext)) patch.maxContext = p.maxContext;
                if (typeof p.maxResponse === 'number' && !Number.isNaN(p.maxResponse)) patch.maxResponse = p.maxResponse;
                if (Object.keys(patch).length) {
                    await risuai.setDatabaseLite(patch);
                    lastCatalogSig = '';
                    setTimeout(() => pollOnce(true), 150);
                }
                return;
            }
        }
    
        let cachedLocalPluginStore = null;
        let cachedPcPluginsList = null;
        let cachedPcPluginsAt = 0;
        const PC_PLUGINS_CACHE_TTL_MS = 60000;
        let hostRpcSupported = false;
        let rpcLoopRunning = false;
        let rpcLoopNonce = 0;

        function computePluginScriptSig(script) {
            const s = String(script || '');
            const len = s.length;
            let h1 = 0x811c9dc5;
            const step = Math.max(1, Math.floor(len / 4096));
            for (let i = 0; i < len; i += step) {
                h1 ^= s.charCodeAt(i);
                h1 = Math.imul(h1, 0x01000193) >>> 0;
            }
            return `${len}:${h1.toString(16)}`;
        }

        async function loadPcPluginsSnapshot(forceRefresh = false) {
            if (!forceRefresh && cachedPcPluginsList && (Date.now() - cachedPcPluginsAt < PC_PLUGINS_CACHE_TTL_MS)) {
                return cachedPcPluginsList;
            }
            const db = await risuai.getDatabase(['plugins']);
            if (db === null || db === undefined) {
                throw new Error('PC RisuAI에서 데이터베이스 접근 권한(db)이 거부되었거나 대기 중입니다. PC RisuAI 창에 권한 허용 팝업이 떠 있는지 확인해 주세요.');
            }
            const raw = Array.isArray(db.plugins) ? db.plugins : [];
            const list = raw
                .filter((p) => p && p.name && p.name !== 'risustand' && typeof p.script === 'string')
                .map((p) => {
                    const script = String(p.script);
                    return {
                        name: String(p.name),
                        displayName: String(p.displayName || p.name),
                        version: String(p.version || '3.0'),
                        versionOfPlugin: String(p.versionOfPlugin || ''),
                        script,
                        scriptLen: script.length,
                        scriptSig: computePluginScriptSig(script),
                        realArg: (p.realArg && typeof p.realArg === 'object') ? p.realArg : {},
                        enabled: p.enabled !== false,
                        allowedIPC: Array.isArray(p.allowedIPC) ? p.allowedIPC : [],
                    };
                });
            cachedPcPluginsList = list;
            cachedPcPluginsAt = Date.now();
            return list;
        }

        async function getSharedLocalPluginStore() {
            if (!cachedLocalPluginStore && typeof risuai.getLocalPluginStorage === 'function') {
                try {
                    cachedLocalPluginStore = await risuai.getLocalPluginStorage();
                } catch (_) {
                    cachedLocalPluginStore = null;
                }
            }
            return cachedLocalPluginStore;
        }

        async function executeHostRpcCall(op, args) {
            const a = Array.isArray(args) ? args : [];
            const kindOp = String(op || '');

            // 1) Shared RisuAI pluginStorage singleton
            if (kindOp === 'pluginStorage.getItem') {
                return risuai.pluginStorage && risuai.pluginStorage.getItem ? await risuai.pluginStorage.getItem(String(a[0] ?? '')) : null;
            }
            if (kindOp === 'pluginStorage.getMany') {
                const out = {};
                const ks = Array.isArray(a[0]) ? [...new Set(a[0].map((k) => String(k ?? '')))] : [];
                if (risuai.pluginStorage && risuai.pluginStorage.getItem) {
                    const CHUNK = 16;
                    for (let i = 0; i < ks.length; i += CHUNK) {
                        const slice = ks.slice(i, i + CHUNK);
                        const vals = await Promise.all(slice.map((k) => risuai.pluginStorage.getItem(k).catch(() => null)));
                        for (let j = 0; j < slice.length; j++) out[slice[j]] = vals[j];
                    }
                }
                return out;
            }
            if (kindOp === 'pluginStorage.setItem') {
                if (risuai.pluginStorage && risuai.pluginStorage.setItem) await risuai.pluginStorage.setItem(String(a[0] ?? ''), a[1]);
                return true;
            }
            if (kindOp === 'pluginStorage.setMany') {
                const pairs = Array.isArray(a[0]) ? a[0] : [];
                if (risuai.pluginStorage && risuai.pluginStorage.setItem) {
                    for (const pair of pairs) {
                        if (Array.isArray(pair)) await risuai.pluginStorage.setItem(String(pair[0] ?? ''), pair[1]);
                    }
                }
                return true;
            }
            if (kindOp === 'pluginStorage.removeItem') {
                if (risuai.pluginStorage && risuai.pluginStorage.removeItem) await risuai.pluginStorage.removeItem(String(a[0] ?? ''));
                return true;
            }
            if (kindOp === 'pluginStorage.clear') {
                if (risuai.pluginStorage && risuai.pluginStorage.clear) await risuai.pluginStorage.clear();
                return true;
            }
            if (kindOp === 'pluginStorage.keys') {
                return risuai.pluginStorage && risuai.pluginStorage.keys ? await risuai.pluginStorage.keys() : [];
            }
            if (kindOp === 'pluginStorage.key') {
                return risuai.pluginStorage && risuai.pluginStorage.key ? await risuai.pluginStorage.key(Number(a[0] || 0)) : null;
            }
            if (kindOp === 'pluginStorage.length') {
                return risuai.pluginStorage && risuai.pluginStorage.length ? await risuai.pluginStorage.length() : 0;
            }

            // 2) Shared safeLocalStorage
            if (kindOp === 'safeLocalStorage.getMany') {
                const out = {};
                const ks = Array.isArray(a[0]) ? [...new Set(a[0].map((k) => String(k ?? '')))] : [];
                const sl = risuai.safeLocalStorage;
                if (sl && typeof sl.getItem === 'function') {
                    const CHUNK = 16;
                    for (let i = 0; i < ks.length; i += CHUNK) {
                        const slice = ks.slice(i, i + CHUNK);
                        const vals = await Promise.all(slice.map((k) => Promise.resolve(sl.getItem(k)).catch(() => null)));
                        for (let j = 0; j < slice.length; j++) out[slice[j]] = vals[j] === undefined ? null : vals[j];
                    }
                }
                return out;
            }
            if (kindOp.startsWith('safeLocalStorage.')) {
                const m = kindOp.slice(17);
                const sl = risuai.safeLocalStorage;
                if (sl && typeof sl[m] === 'function') {
                    return m === 'setItem' ? (await sl.setItem(String(a[0] ?? ''), String(a[1] ?? '')), true) : await sl[m](...a);
                }
                if (m === 'keys') return [];
                if (m === 'length') return 0;
                return null;
            }

            // 3) Shared getLocalPluginStorage()
            if (kindOp === 'localPluginStorage.getMany') {
                const out = {};
                const ks = Array.isArray(a[0]) ? [...new Set(a[0].map((k) => String(k ?? '')))] : [];
                const lps = await getSharedLocalPluginStore();
                if (lps && typeof lps.getItem === 'function') {
                    const CHUNK = 16;
                    for (let i = 0; i < ks.length; i += CHUNK) {
                        const slice = ks.slice(i, i + CHUNK);
                        const vals = await Promise.all(slice.map((k) => Promise.resolve(lps.getItem(k)).catch(() => null)));
                        for (let j = 0; j < slice.length; j++) out[slice[j]] = vals[j] === undefined ? null : vals[j];
                    }
                }
                return out;
            }
            if (kindOp.startsWith('localPluginStorage.')) {
                const m = kindOp.slice(19);
                const lps = await getSharedLocalPluginStore();
                if (lps && typeof lps[m] === 'function') {
                    if (m === 'setItem') { await lps.setItem(String(a[0] ?? ''), a[1]); return true; }
                    if (m === 'removeItem' || m === 'clear') { await lps[m](...a); return true; }
                    return await lps[m](...a);
                }
                if (m === 'keys') return [];
                return null;
            }

            // 4) Direct RisuAI DB Read / Write (dbWrite permission)
            if (kindOp === 'bridge.selectTarget') {
                const nextChar = Number(a[0]);
                const nextChat = Number(a[1]);
                if (!applyTargetSelection(nextChar, nextChat)) {
                    throw new Error('Invalid target character/chat index');
                }
                return { ok: true, charIndex: viewCharIndex, chatIndex: viewChatIndex };
            }
            const buildSlimCharacterMeta = (ch, cIdx) => {
                if (!ch || typeof ch !== 'object') return null;
                return {
                    name: ch.name || '',
                    chaId: ch.chaId ? String(ch.chaId) : String(cIdx),
                    lowLevelAccess: Boolean(ch.lowLevelAccess),
                    triggerscript: Array.isArray(ch.triggerscript) ? ch.triggerscript : [],
                    customscript: Array.isArray(ch.customscript) ? ch.customscript : [],
                    customScripts: Array.isArray(ch.customScripts) ? ch.customScripts : [],
                    additionalAssets: Array.isArray(ch.additionalAssets) ? ch.additionalAssets : [],
                    emotionImages: Array.isArray(ch.emotionImages) ? ch.emotionImages : [],
                    customModuleToggle: String(ch.customModuleToggle || ''),
                };
            };
            const collectActiveModulesFromDb = (db, chatObj, { includeHeavy = true } = {}) => {
                const enSet = new Set([
                    ...(db && Array.isArray(db.enabledModules) ? db.enabledModules.map(String) : []),
                    ...(chatObj && Array.isArray(chatObj.modules) ? chatObj.modules.map(String) : []),
                ]);
                const rawMods = (db && Array.isArray(db.modules)) ? db.modules : [];
                const modules = [];
                const seenIds = new Set();
                for (const m of rawMods) {
                    if (!m || !enSet.has(String(m.id))) continue;
                    const mid = String(m.id);
                    if (seenIds.has(mid)) continue;
                    seenIds.add(mid);
                    const modOut = {
                        id: mid,
                        name: String(m.name || mid),
                        namespace: String(m.namespace || ''),
                        lowLevelAccess: Boolean(m.lowLevelAccess),
                        trigger: Array.isArray(m.trigger) ? m.trigger : [],
                        regex: Array.isArray(m.regex) ? m.regex : [],
                        assets: Array.isArray(m.assets) ? m.assets : [],
                        customModuleToggle: String(m.customModuleToggle || ''),
                    };
                    if (includeHeavy) {
                        modOut.lorebook = Array.isArray(m.lorebook) ? m.lorebook : [];
                        modOut.backgroundEmbedding = String(m.backgroundEmbedding || '');
                    }
                    modules.push(modOut);
                }
                return modules;
            };
            if (kindOp === 'db.getCharacterDisplayMeta') {
                const cIdx = Number(a[0]);
                const ch = await risuai.getCharacterFromIndex(cIdx);
                if (!ch || typeof ch !== 'object') return null;
                if (ch.chaId) charIdByIndex.set(cIdx, String(ch.chaId));
                return buildSlimCharacterMeta(ch, cIdx);
            }
            if (kindOp === 'db.getDisplayLuaBundle') {
                const cIdx = Number(a[0]);
                const chIdx = Number(a[1]);
                const ch = cIdx >= 0 ? await risuai.getCharacterFromIndex(cIdx) : null;
                if (ch && ch.chaId) charIdByIndex.set(cIdx, String(ch.chaId));
                let rawChat = (ch && Array.isArray(ch.chats) && chIdx >= 0 && chIdx < ch.chats.length)
                    ? ch.chats[chIdx]
                    : null;
                if (!rawChat && cIdx >= 0 && chIdx >= 0) {
                    rawChat = await risuai.getChatFromIndex(cIdx, chIdx).catch(() => null);
                }
                const chatObj = ensureStableChatAndMessageIds(ch, cIdx, rawChat, chIdx);
                const db = await risuai.getDatabase([
                    'modules',
                    'enabledModules',
                    'globalChatVariables',
                    'templateDefaultVariables',
                ]);
                return {
                    charObj: buildSlimCharacterMeta(ch, cIdx),
                    chatObj,
                    modules: collectActiveModulesFromDb(db, chatObj, { includeHeavy: false }),
                    globalChatVariables: (db && db.globalChatVariables && typeof db.globalChatVariables === 'object') ? db.globalChatVariables : {},
                    templateDefaultVariables: String((db && db.templateDefaultVariables) || ''),
                    charLowLevelAccess: Boolean(ch && ch.lowLevelAccess),
                };
            }
            if (kindOp === 'db.getCurrentIndices') {
                const charIndex = await risuai.getCurrentCharacterIndex();
                const chatIndex = charIndex >= 0 ? await risuai.getCurrentChatIndex() : -1;
                return { charIndex, chatIndex, viewCharIndex, viewChatIndex };
            }
            if (kindOp === 'db.getCharacter') {
                const cIdx = Number(a[0]);
                const ch = await risuai.getCharacterFromIndex(cIdx);
                if (ch && ch.chaId) charIdByIndex.set(cIdx, String(ch.chaId));
                if (ch && Array.isArray(ch.chats)) {
                    for (let ci = 0; ci < ch.chats.length; ci++) {
                        ensureStableChatAndMessageIds(ch, cIdx, ch.chats[ci], ci);
                    }
                }
                return ch;
            }
            if (kindOp === 'db.setCharacter') {
                await risuai.setCharacterToIndex(Number(a[0]), a[1]);
                cachedSnapDb = null;
                lastSnapSig = '';
                lastCatalogSig = '';
                setTimeout(() => pollOnce(true), 80);
                return true;
            }
            if (kindOp === 'db.getChat') {
                const cIdx = Number(a[0]);
                const chIdx = Number(a[1]);
                const chat = await risuai.getChatFromIndex(cIdx, chIdx);
                let chaId = charIdByIndex.get(cIdx) || '';
                if (!chaId && (!chat || !chat.id)) {
                    const ch = await risuai.getCharacterFromIndex(cIdx).catch(() => null);
                    if (ch && ch.chaId) {
                        chaId = String(ch.chaId);
                        charIdByIndex.set(cIdx, chaId);
                    }
                }
                return ensureStableChatAndMessageIds(chaId ? { chaId } : null, cIdx, chat, chIdx);
            }
            if (kindOp === 'db.setChat') {
                await risuai.setChatToIndex(Number(a[0]), Number(a[1]), a[2]);
                cachedSnapDb = null;
                lastSnapSig = '';
                lastCatalogSig = '';
                setTimeout(() => pollOnce(true), 80);
                return true;
            }
            if (kindOp === 'db.getDatabase') {
                return await risuai.getDatabase(a[0] === undefined ? 'all' : a[0]);
            }
            if (kindOp === 'db.setDatabaseLite') {
                await risuai.setDatabaseLite(a[0] || {});
                cachedSnapDb = null;
                lastSnapSig = '';
                lastCatalogSig = '';
                setTimeout(() => pollOnce(true), 80);
                return true;
            }
            if (kindOp === 'db.setDatabase') {
                if (typeof risuai.setDatabase === 'function') await risuai.setDatabase(a[0] || {});
                else await risuai.setDatabaseLite(a[0] || {});
                cachedSnapDb = null;
                lastSnapSig = '';
                lastCatalogSig = '';
                setTimeout(() => pollOnce(true), 80);
                return true;
            }
            if (kindOp === 'db.listPluginsMeta') {
                const list = await loadPcPluginsSnapshot(a[0] !== false);
                return list.map(({ script, ...meta }) => meta);
            }
            if (kindOp === 'db.getPluginScriptChunk') {
                const targetName = String(a[0] || '');
                const offset = Math.max(0, Number(a[1]) || 0);
                const maxChars = Math.max(65536, Math.min(2000000, Number(a[2]) || 1500000));
                let list = await loadPcPluginsSnapshot(false);
                let found = list.find((p) => p.name === targetName);
                if (!found && offset === 0) {
                    list = await loadPcPluginsSnapshot(true);
                    found = list.find((p) => p.name === targetName);
                }
                if (!found) return null;
                const chunk = found.script.slice(offset, offset + maxChars);
                return {
                    name: found.name,
                    chunk,
                    offset,
                    totalLen: found.script.length,
                    scriptSig: found.scriptSig,
                    eof: (offset + chunk.length) >= found.script.length,
                };
            }
            if (kindOp === 'db.getPlugins') {
                const list = await loadPcPluginsSnapshot(true);
                return list.map((p) => ({
                    name: p.name,
                    displayName: p.displayName,
                    version: p.version,
                    versionOfPlugin: p.versionOfPlugin,
                    script: p.script,
                    realArg: p.realArg,
                    enabled: p.enabled,
                    allowedIPC: p.allowedIPC,
                }));
            }
            if (kindOp === 'db.reloadPcPlugins') {
                cachedPcPluginsList = null;
                cachedPcPluginsAt = 0;
                setTimeout(() => {
                    try {
                        if (typeof risuai.loadPlugins === 'function') {
                            Promise.resolve(risuai.loadPlugins()).catch(() => {});
                        }
                    } catch (_) {}
                }, 120);
                return true;
            }
            if (kindOp === 'db.getActiveModules') {
                const cIdx = Number(a[0]);
                const chIdx = Number(a[1]);
                const charObj = cIdx >= 0 ? await risuai.getCharacterFromIndex(cIdx) : null;
                const chatObj = (cIdx >= 0 && chIdx >= 0) ? await risuai.getChatFromIndex(cIdx, chIdx) : null;
                const db = await risuai.getDatabase([
                    'modules',
                    'enabledModules',
                    'globalChatVariables',
                    'templateDefaultVariables',
                ]);
                const modules = collectActiveModulesFromDb(db, chatObj, { includeHeavy: true });
                return {
                    modules,
                    globalChatVariables: (db && db.globalChatVariables && typeof db.globalChatVariables === 'object') ? db.globalChatVariables : {},
                    templateDefaultVariables: String((db && db.templateDefaultVariables) || ''),
                    charLowLevelAccess: Boolean(charObj && charObj.lowLevelAccess),
                };
            }
            if (kindOp === 'db.getImageGenConfig') {
                const db = await risuai.getDatabase([
                    'sdProvider',
                    'NAIImgUrl',
                    'NAIApiKey',
                    'NAIImgModel',
                    'NAIImgConfig',
                    'NAII2I',
                    'comfyUiUrl',
                    'comfyConfig',
                    'webUiUrl',
                    'sdSteps',
                    'sdCFG',
                    'sdConfig',
                    'openAIKey',
                    'dallEQuality',
                ]);
                return {
                    sdProvider: String((db && db.sdProvider) || ''),
                    NAIImgUrl: String((db && db.NAIImgUrl) || ''),
                    NAIApiKey: String((db && db.NAIApiKey) || ''),
                    NAIImgModel: String((db && db.NAIImgModel) || ''),
                    NAIImgConfig: (db && db.NAIImgConfig && typeof db.NAIImgConfig === 'object') ? db.NAIImgConfig : {},
                    NAII2I: Boolean(db && db.NAII2I),
                    comfyUiUrl: String((db && db.comfyUiUrl) || ''),
                    comfyConfig: (db && db.comfyConfig && typeof db.comfyConfig === 'object') ? db.comfyConfig : {},
                    webUiUrl: String((db && db.webUiUrl) || ''),
                    sdSteps: Number((db && db.sdSteps) || 25),
                    sdCFG: Number((db && db.sdCFG) || 7),
                    sdConfig: (db && db.sdConfig && typeof db.sdConfig === 'object') ? db.sdConfig : {},
                    openAIKey: String((db && db.openAIKey) || ''),
                    dallEQuality: String((db && db.dallEQuality) || 'standard'),
                };
            }
            if (kindOp === 'db.getCharacterImageAssets') {
                const cIdx = Number(a[0]);
                const ch = await risuai.getCharacterFromIndex(cIdx);
                if (!ch || typeof ch !== 'object') return null;
                const assets = [];
                const seenPaths = new Set();
                const mediaRx = /(?:^|\.)(?:mp3|wav|ogg|mp4|webm|m4a|flac)$/i;
                const pushAsset = (rawName, rawPath, kind, rawExt = '') => {
                    if (assets.length >= 300) return;
                    const p = String(rawPath || '').trim();
                    if (!p || seenPaths.has(p)) return;
                    const nm = String(rawName || '').trim();
                    const ex = String(rawExt || '').trim();
                    if (kind === 'additional' && (mediaRx.test(ex) || mediaRx.test(nm) || mediaRx.test(p))) return;
                    seenPaths.add(p);
                    assets.push({ name: nm || p, path: p, kind });
                };
                if (typeof ch.image === 'string' && ch.image.trim()) {
                    pushAsset('기본 아이콘', ch.image, 'main');
                }
                if (Array.isArray(ch.emotionImages)) {
                    for (const e of ch.emotionImages) {
                        if (Array.isArray(e)) pushAsset(e[0], e[1], 'emotion', e[2]);
                    }
                }
                if (Array.isArray(ch.additionalAssets)) {
                    for (const item of ch.additionalAssets) {
                        if (Array.isArray(item)) pushAsset(item[0], item[1], 'additional', item[2]);
                    }
                }
                return {
                    chaId: String(ch.chaId || cIdx),
                    name: String(ch.name || ''),
                    image: typeof ch.image === 'string' ? ch.image : '',
                    assets,
                };
            }
            if (kindOp === 'asset.readImage') {
                const targetPath = String(a[0] || '').trim();
                if (!targetPath || /^\[\[RS/i.test(targetPath) || typeof risuai.readImage !== 'function') return null;
                let raw = null;
                try {
                    raw = await risuai.readImage(targetPath);
                } catch (_) {
                    return null;
                }
                if (!raw) return null;
                const bytes = raw instanceof Uint8Array
                    ? raw
                    : ArrayBuffer.isView(raw)
                    ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
                    : raw instanceof ArrayBuffer
                    ? new Uint8Array(raw)
                    : new Uint8Array(Object.values(raw));
                if (!bytes.length) return null;
                return { __b64: uint8ToBase64(bytes), mime: detectImageMime(bytes, targetPath) };
            }
            if (kindOp === 'asset.saveAsset') {
                const payload = (a[0] && typeof a[0] === 'object') ? a[0] : {};
                if (!payload.__b64 || typeof risuai.saveAsset !== 'function') return '';
                const bytes = base64ToUint8(payload.__b64);
                const savedPath = await risuai.saveAsset(bytes);
                lastSnapSig = '';
                return String(savedPath || '');
            }
            if (kindOp === 'asset.readInlay') {
                const inlayId = String(a[0] || '').trim();
                if (!inlayId || typeof risuai.readInlay !== 'function') return null;
                try {
                    return (await risuai.readInlay(inlayId)) || null;
                } catch (_) {
                    return null;
                }
            }
            if (kindOp === 'asset.createInlay') {
                const payload = (a[0] && typeof a[0] === 'object') ? a[0] : {};
                if (typeof risuai.createInlay !== 'function') return null;
                const dataArg = payload.kind === 'dataUri' ? String(payload.dataUri || '') : base64ToUint8(payload.__b64 || '');
                const opts = payload.name ? { name: String(payload.name) } : undefined;
                const inlayId = await risuai.createInlay(dataArg, opts);
                if (inlayId) {
                    assetDataCache.delete('inlay:' + inlayId);
                    iframeInlayDataCache.delete(String(inlayId));
                    lastSnapSig = '';
                }
                return inlayId ? String(inlayId) : null;
            }

            throw new Error(`Unsupported host RPC op: ${kindOp}`);
        }

        function base64ToUint8(b64) {
            const clean = String(b64 || '').replace(/\s+/g, '');
            if (!clean) return new Uint8Array(0);
            if (typeof atob === 'function') {
                const bin = atob(clean);
                const out = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                return out;
            }
            return new Uint8Array(Buffer.from(clean, 'base64'));
        }

        function isMutatingHostRpcOp(op) {
            const s = String(op || '');
            return /(?:^|\.)(?:set|remove|clear|save|create|reload|post|delete|update|write)/i.test(s);
        }

        async function runHostRpcBatch(calls) {
            if (!Array.isArray(calls) || !calls.length || !cfg.enabled || !cfg.relayUrl || !cfg.token) return;
            const results = new Array(calls.length);
            const hasMutation = calls.some((c) => isMutatingHostRpcOp(c && c.op));
            const runOne = async (idx) => {
                const c = calls[idx];
                try {
                    const value = await executeHostRpcCall(c.op, c.args);
                    results[idx] = { id: c.id, ok: true, value };
                } catch (err) {
                    results[idx] = { id: c.id, ok: false, error: err && err.message ? err.message : String(err) };
                }
            };
            if (hasMutation || calls.length <= 1) {
                for (let i = 0; i < calls.length; i++) {
                    await runOne(i);
                }
            } else {
                const workerCount = Math.min(12, calls.length);
                let nextIdx = 0;
                await Promise.all(Array.from({ length: workerCount }, async () => {
                    while (true) {
                        const i = nextIdx++;
                        if (i >= calls.length) break;
                        await runOne(i);
                    }
                }));
            }
            const resEndpoint = cfg.relayUrl.replace(/\/+$/, '') + '/api/pc/rpc-result';
            try {
                const postResp = await risuai.nativeFetch(resEndpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-RisuStand-Token': cfg.token,
                    },
                    body: JSON.stringify({ results }),
                    logFetch: false,
                });
                if (!postResp || !postResp.ok) {
                    throw new Error(`HTTP ${postResp ? postResp.status : 'unknown'}`);
                }
            } catch (postErr) {
                try {
                    const errMsg = `PC 브릿지 RPC 응답 전송 실패: ${postErr && postErr.message ? postErr.message : String(postErr)}`;
                    await risuai.nativeFetch(resEndpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-RisuStand-Token': cfg.token,
                        },
                        body: JSON.stringify({
                            results: calls.map((c) => ({ id: c.id, ok: false, error: errMsg })),
                        }),
                        logFetch: false,
                    });
                } catch (_) {}
            }
        }

        function startHostRpcLoop() {
            if (rpcLoopRunning || !cfg.enabled || !cfg.relayUrl || !cfg.token || !hostRpcSupported) return;
            rpcLoopRunning = true;
            const myNonce = ++rpcLoopNonce;
            const activeRpcBatches = new Set();
            void (async () => {
                try {
                    while (rpcLoopNonce === myNonce && cfg.enabled && cfg.relayUrl && cfg.token && hostRpcSupported) {
                        if (activeRpcBatches.size >= 4) {
                            await Promise.race(activeRpcBatches).catch(() => {});
                            continue;
                        }
                        try {
                            const waitEndpoint = cfg.relayUrl.replace(/\/+$/, '') + '/api/pc/rpc-wait';
                            const resp = await risuai.nativeFetch(waitEndpoint, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'X-RisuStand-Token': cfg.token,
                                },
                                body: JSON.stringify({ timeoutMs: 12000 }),
                                logFetch: false,
                            });
                            if (!resp || !resp.ok) {
                                await new Promise((r) => setTimeout(r, 1500));
                                continue;
                            }
                            const payload = await resp.json();
                            if (Array.isArray(payload && payload.calls) && payload.calls.length) {
                                const hasMutation = payload.calls.some((c) => isMutatingHostRpcOp(c && c.op));
                                const batchPromise = runHostRpcBatch(payload.calls).finally(() => {
                                    activeRpcBatches.delete(batchPromise);
                                });
                                activeRpcBatches.add(batchPromise);
                                if (hasMutation) await batchPromise;
                            }
                        } catch (_) {
                            if (rpcLoopNonce !== myNonce || !cfg.enabled) break;
                            await new Promise((r) => setTimeout(r, 1500));
                        }
                    }
                } finally {
                    await Promise.allSettled([...activeRpcBatches]);
                    if (rpcLoopNonce === myNonce) rpcLoopRunning = false;
                }
            })();
        }

        async function pollOnce(forceFull = false) {
            if (!cfg.enabled || !cfg.relayUrl || !cfg.token) return;
            if (isPolling) {
                if (forceFull) pendingForcePoll = true;
                return;
            }
            isPolling = true;
            try {
                const endpoint = cfg.relayUrl.replace(/\/+$/, '') + '/api/pc/poll';
                const catRes = await buildCatalog(forceFull);
                const snapRes = await buildSnapshot(forceFull);
                if (!pendingTriggerEvent) {
                    const pcAlert = await pollPcNativeAlert();
                    if (pcAlert) pendingTriggerEvent = pcAlert;
                }
                const triggerEvent = pendingTriggerEvent;
    
                const res = await risuai.nativeFetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-RisuStand-Token': cfg.token,
                    },
                    body: JSON.stringify({
                        bridgeVersion: '2.0.0',
                        pluginVersion: RISUSTAND_VERSION,
                        generating: isGenerating,
                        supportsBatchCommands: true,
                        catalog: catRes ? catRes.catalog : null,
                        snapshot: snapRes ? snapRes.snapshot : null,
                        triggerEvent,
                    }),
                    logFetch: false,
                });
    
                if (!res || !res.ok) {
                    lastStatus = `연결 오류 (HTTP ${res ? res.status : '?'})`;
                    return;
                }
                if (catRes && catRes.catalog) lastCatalogSig = catRes.sig;
                if (snapRes && snapRes.snapshot) lastSnapSig = snapRes.sig;
                if (triggerEvent && pendingTriggerEvent && pendingTriggerEvent.id === triggerEvent.id) {
                    pendingTriggerEvent = null;
                }
    
                const data = await res.json();
                lastStatus = data && data.relayVersion ? `🟢 중계 서버 v${data.relayVersion} 연결됨` : '🟢 중계 서버 연결됨';
                lastSyncTime = new Date().toLocaleTimeString();

                if (!forceFull && data && data.needFullSync) {
                    lastCatalogSig = '';
                    lastSnapSig = '';
                    setTimeout(() => pollOnce(true), 120);
                }
                if (Array.isArray(data && data.rpcCalls) && data.rpcCalls.length) {
                    void runHostRpcBatch(data.rpcCalls);
                }
                if (data && data.supportsHostRpc) {
                    hostRpcSupported = true;
                    startHostRpcLoop();
                }
    
                const cmds = Array.isArray(data && data.commands)
                    ? data.commands
                    : (data && data.command ? [data.command] : []);
                for (const cmd of cmds) {
                    await handleCommand(cmd);
                }
            } catch (err) {
                lastStatus = `🔴 연결 실패 (${err && err.message ? err.message : '네트워크 오류'})`;
            } finally {
                isPolling = false;
                if (pendingForcePoll) {
                    pendingForcePoll = false;
                    setTimeout(() => pollOnce(true), 60);
                }
            }
        }
    
        function restartPolling() {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            if (!cfg.enabled) {
                hostRpcSupported = false;
                rpcLoopNonce += 1;
                lastStatus = '꺼짐';
                return;
            }
            const ms = Math.max(1200, Math.min(10000, Number(cfg.pollIntervalMs) || 1800));
            pollOnce(true);
            pollTimer = setInterval(() => pollOnce(false), ms);
        }
    
        function renderSettingsUI() {
            currentIframeMode = 'remote';
            stopCloneWatcher();
            clearStudioListeners();
            document.onkeydown = null;
            document.body.innerHTML = `
                <style>
                    ${buildPanelChromeCSS()}
                    .wrap { max-width:560px; margin:28px auto; background:var(--bg1); border:1px solid var(--line); border-radius:20px; padding:22px; box-shadow:0 30px 80px -20px rgba(0,0,0,0.7); }
                    .ttl { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
                    .ttl .logo { width:38px; height:38px; border-radius:11px; display:flex; align-items:center; justify-content:center; font-size:19px; background:var(--acc-soft); border:1px solid var(--acc-line); flex-shrink:0; }
                    h2 { margin:0; font-size:17px; font-weight:800; letter-spacing:-0.01em; }
                    .sub { font-size:12px; color:var(--tx2); margin-top:2px; line-height:1.5; }
                    .status { padding:11px 13px; border-radius:12px; background:var(--bg0); border:1px solid var(--line); font-size:13px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center; gap:10px; }
                    .status .st-dot { width:8px; height:8px; border-radius:50%; background:${cfg.enabled ? 'var(--ok)' : 'var(--tx3)'}; box-shadow:0 0 0 3px ${cfg.enabled ? 'rgba(74,222,128,0.18)' : 'transparent'}; flex-shrink:0; }
                    .status .st-l { display:flex; align-items:center; gap:9px; min-width:0; }
                    .status .st-l span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
                    label { display:block; font-size:12px; font-weight:600; color:var(--tx2); margin:14px 0 6px; }
                    .chk { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0; padding:12px 0; font-size:13.5px; font-weight:500; color:var(--tx); cursor:pointer; border-bottom:1px solid var(--line); }
                    .btns { display:flex; gap:8px; margin-top:20px; }
                    .btns button { flex:1; }
                    .tip { margin-top:16px; font-size:12px; color:var(--tx2); line-height:1.6; background:var(--bg0); padding:12px 14px; border-radius:12px; border:1px solid var(--line); }
                    .tip b { color:var(--tx); }
                    code { background:var(--bg3); padding:1px 6px; border-radius:5px; color:var(--acc); font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11.5px; word-break:break-all; }
                    @media (max-width: 600px) {
                        .wrap { margin:0; border-radius:0; border:none; min-height:100%; padding:calc(18px + env(safe-area-inset-top)) 16px calc(18px + env(safe-area-inset-bottom)); }
                        .btns { flex-wrap:wrap; }
                        .btns .btn-primary { flex-basis:100%; }
                    }
                </style>
                <div class="wrap">
                    <div class="ttl">
                        <span class="logo">📡</span>
                        <div>
                            <h2>RisuStand Remote Bridge</h2>
                            <div class="sub">봇/방 전환 · 모듈 · 페르소나 · 파라미터 · 릴레이 모델 라우터 연동</div>
                        </div>
                    </div>
                    <div class="status">
                        <span class="st-l"><span class="st-dot"></span><span id="stText">${escapeHtml(lastStatus)}</span></span>
                        <span style="color:var(--tx3); font-size:12px; flex-shrink:0;">${escapeHtml(lastSyncTime || '-')}</span>
                    </div>
                    <label class="chk">
                        <span>원격 브릿지 활성화</span>
                        <input type="checkbox" id="enabled" ${cfg.enabled ? 'checked' : ''} />
                    </label>
                    <label>중계 서버 주소 (PC 로컬)</label>
                    <input type="text" id="relayUrl" value="${escapeHtml(cfg.relayUrl)}" placeholder="http://127.0.0.1:8787" />
                    <label>보안 접속 토큰 (PC 터미널에 출력된 값)</label>
                    <input type="password" id="token" value="${escapeHtml(cfg.token)}" placeholder="토큰 붙여넣기" />
                    <label class="chk" style="margin-top:6px;">
                        <span>최근 메시지의 캐릭터 에셋 이미지 함께 전송</span>
                        <input type="checkbox" id="includeImages" ${cfg.includeImages ? 'checked' : ''} />
                    </label>
                    <label>폴링 주기 (ms, 기본 1800)</label>
                    <input type="number" id="pollIntervalMs" value="${escapeHtml(cfg.pollIntervalMs)}" min="1200" max="10000" />
                    <div class="btns">
                        <button class="btn btn-primary" id="saveBtn">저장 및 연결</button>
                        <button class="btn btn-ghost" id="syncBtn">전체 동기화</button>
                        <button class="btn btn-ghost" id="permBtn">🔐 권한 요청</button>
                        <button class="btn btn-ghost" id="closeBtn">닫기</button>
                    </div>
                    <div class="tip">
                        <b>릴레이 모델 라우터 &amp; 원격 라우팅 안내</b><br>
                        • PC RisuAI 모델 설정(Reverse Proxy / OpenAI 호환)의 URL을 <code>http://127.0.0.1:8787/v1/chat/completions</code>, API 키에 위 <b>보안 접속 토큰</b>, 모델 이름에 <code>risustand-router</code>를 지정하면 휴대폰에서 모델·프롬프트·번역을 실시간 제어할 수 있습니다. (PC 로컬 접속은 기존 키도 동작하지만 원격 프록시 호출에는 토큰이 필요합니다.)<br>
                        • <b>PC 활성 vs 원격 라우팅</b>: PC RisuAI에 현재 열려 있는 봇(<code>PC 활성</code>)은 <code>risuai.sendChat()</code>을 통해 동작합니다. PC가 홈 화면이거나 다른 봇을 열어 둔 상태(<code>원격 라우팅</code>)에서는 모바일 <b>[모듈/설정]</b>의 <b>백엔드 플러그인 어댑터</b>에서 켠 RisuAI v3 플러그인들이 RisuAI <code>pluginStorage</code>·<code>DB</code>에 직접 연결되어 동일하게 작동합니다.
                    </div>
                </div>
            `;
    
            document.getElementById('saveBtn').onclick = async () => {
                cfg.enabled = document.getElementById('enabled').checked;
                cfg.relayUrl = document.getElementById('relayUrl').value.trim() || 'http://127.0.0.1:8787';
                cfg.token = document.getElementById('token').value.trim();
                cfg.includeImages = document.getElementById('includeImages').checked;
                cfg.pollIntervalMs = Number(document.getElementById('pollIntervalMs').value) || 1800;
                await saveCfg();
                if (cfg.enabled) {
                    await requestAllPermissionsOnce(false);
                }
                lastSnapSig = '';
                lastCatalogSig = '';
                restartPolling();
                setTimeout(renderSettingsUI, 700);
            };
    
            document.getElementById('syncBtn').onclick = async () => {
                lastSnapSig = '';
                lastCatalogSig = '';
                await pollOnce(true);
                renderSettingsUI();
            };

            document.getElementById('permBtn').onclick = async () => {
                await requestAllPermissionsOnce(true);
                lastStatus = '🔐 권한 요청 완료';
                renderSettingsUI();
            };
    
            document.getElementById('closeBtn').onclick = () => {
                currentIframeMode = null;
                risuai.hideContainer();
            };
        }
    
        await loadCfg();
    
        await risuai.registerButton(
            {
                name: 'RisuStand 원격 접속',
                icon: '📡',
                iconType: 'html',
                location: 'hamburger',
                id: 'risustand-remote-btn',
            },
            async () => {
                renderSettingsUI();
                await risuai.showContainer('fullscreen');
            }
        );
    
        await risuai.registerSetting('📡 RisuStand 원격 접속 (Remote)', async () => {
            renderSettingsUI();
            await risuai.showContainer('fullscreen');
        }, '📡', 'html');
    
        const remoteChatOutputListener = async () => {
            lastSnapSig = '';
            lastCatalogSig = '';
            setTimeout(() => pollOnce(true), 250);
        };
        try {
            await risuai.addRisuChatListener('output', remoteChatOutputListener);
        } catch (_) {}
    
        if (cfg.enabled && cfg.token) {
            restartPolling();
        }
    
        return async () => {
            hostRpcSupported = false;
            rpcLoopNonce += 1;
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            try { await risuai.removeRisuChatListener('output', remoteChatOutputListener); } catch (_) {}
        };
    }

    let stopRemoteBridge = null;
    try {
        stopRemoteBridge = await initIntegratedRemoteBridge();
    } catch (e) {
        console.warn('[RisuStand] Remote bridge init error:', e);
    }

    await risuai.onUnload(async () => {
        if (typeof stopRemoteBridge === 'function') await stopRemoteBridge();
        clearStudioListeners();
        clearIframeCaches();
        clearAutoMinimize();
        stopCloneWatcher();
        if (lockReleaseTimer) {
            clearTimeout(lockReleaseTimer);
            lockReleaseTimer = null;
        }
        await releaseMessageHeightLocks();
        if (rootDoc) {
            if (pointerListenerId) await rootDoc.removeEventListener('pointerdown', pointerListenerId);
            if (docMoveListenerId) await rootDoc.removeEventListener('pointermove', docMoveListenerId);
            if (docUpListenerId) await rootDoc.removeEventListener('pointerup', docUpListenerId);
        }
        if (mutationObserver) await mutationObserver.disconnect();
        if (chatOutputListener) {
            try { await risuai.removeRisuChatListener('output', chatOutputListener); } catch (_) {}
        }
        await removeTopBar();
        await upsertStyleTag('anti-flicker', '');
        await upsertStyleTag('theme-layout-stealth', '');
    });

    console.log(`[RisuStand] v${RISUSTAND_VERSION} initialized`);
})();
