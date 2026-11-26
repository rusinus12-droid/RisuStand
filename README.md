# 📖 RisuStand v1.0.0 (리수 독서대)

**순정 RisuAI 원본 소스를 수정하지 않고**, Plugin API v3.0만으로 동작하는 **독서대 테마 · EPUB 종이책 리더 · 원격 접속(Pocket) 통합 키트**입니다.

## ✨ 주요 기능

### 1. PC / 태블릿 독서대 (`risustand.js`)
- **10종 테마 프리셋**: Gemini · Claude · ChatGPT 공홈 스텔스, EPUB 세피아/다크(1쪽 스크롤 · 2쪽 펼침), 미드나잇 글래스, 사쿠라 파스텔, 포레스트 모스
- **종이책 3D 페이지 넘김**: 640ms 3D 책장 넘김 애니메이션, 좌우 터치 스와이프, 하단 미니멀 턴 룰러
- **외출 스텔스 & 쾌적한 독서 UX**: 시스템 글꼴(명조/고딕/기본), 글자 크기·줄간격 실시간 미리보기, 봇 플로팅 메뉴 클릭 시 깜빡임 완화, 상태창 HUD 보존

### 2. 원격 접속 & 로컬 모델 라우터 (`risustand-relay-server.js`)
- **아이폰 · 아이패드 · 안드로이드 원격 접속**: Tailscale VPN을 통해 내 PC의 RisuAI에 안전하게 접속
- **전체 봇 · 채팅방 관리**: 봇 목록 검색, 채팅방 전환, 새 방 파기, 메시지 수정·삭제, 인라인 에셋 정위치 렌더링
- **3단계 에셋 가리기·감추기**: `표시(🖼️)` / `블러 가리기 + 터치 확인(🌫️)` / `완전 감추기 + 공홈 마스킹(🙈)`
- **모듈 · 프리셋 토글 & 페르소나 제어**: 전역 모듈 ON/OFF, 페르소나 전환, 기본 파라미터 반영, 커스텀 모듈·프롬프트 프리셋 토글(로컬 토글 연동)
- **원격 모델 전환 (로컬 프록시 라우터)**: OpenRouter · OpenAI · Google Gemini · Anthropic Claude 프로필을 모바일에서 실시간 전환 및 선택적 시스템 프롬프트 오버라이드
- **자체 번역기**: 말풍선별 원문 ↔ 번역 토글, AI 응답 자동 번역, 내 입력 한→영 자동 번역 후 전송

---

## 📦 구성 파일

| 파일 | 설명 |
|---|---|
| `risustand.js` | PC RisuAI에 설치하는 단일 통합 플러그인 (API v3.0) |
| `risustand-relay-server.js` | PC에서 실행하는 무의존성 Node.js 원격 릴레이·모델 라우터 서버 (Node 18+) |
| `start-risustand-remote.bat` | Windows용 원클릭 실행 런처 (토큰 자동 생성 + Tailscale IP 표시) |
| `start-risustand-remote.sh` | macOS / Linux용 실행 런처 |

---

## 🚀 설치 및 실행 가이드

### 1단계: PC RisuAI에 플러그인 설치
1. PC RisuAI → **설정 → 플러그인 → 플러그인 추가**에서 `risustand.js`를 불러옵니다.
2. 햄버거 메뉴(☰)에 **`📖 RisuStand 설정`**, **`📖 RisuStand 전용 뷰`**, **`📡 RisuStand 원격 접속`** 버튼이 추가됩니다.

### 2단계: 원격 릴레이 서버 실행 (PC)
1. [Node.js LTS (v18 이상)](https://nodejs.org)가 설치되어 있어야 합니다.
2. `risustand-relay-server.js`와 `start-risustand-remote.bat`(macOS/Linux는 `.sh`)을 **같은 폴더**에 두고 실행합니다.
3. 터미널 창에 표시되는 **`Security Token`**을 복사합니다.
4. PC RisuAI → **`📡 RisuStand 원격 접속`** → `원격 브릿지 활성화` 체크 → 주소 `http://127.0.0.1:8787`, 토큰 붙여넣기 → **저장 및 연결**을 누릅니다. (최초 1회 RisuAI DB 권한 팝업을 허용해 주세요.)

### 3단계: 모바일에서 접속 (Tailscale 권장)
1. PC와 스마트폰에 [Tailscale](https://tailscale.com)을 설치하고 같은 계정으로 로그인합니다.
2. Tailscale 앱에서 **내 PC의 IP (`100.x.x.x`)**를 확인합니다. (스마트폰 자신의 IP가 아닌 PC의 IP를 사용하세요.)
3. 스마트폰 브라우저에서 `http://<PC-Tailscale-IP>:8787`로 접속하고 터미널의 보안 토큰을 입력합니다.

> **Windows 방화벽 때문에 접속이 안 될 때** (관리자 권한 PowerShell에서 1회 실행):
> ```powershell
> netsh advfirewall firewall add rule name="RisuStand Relay 8787" dir=in action=allow protocol=TCP localport=8787
> ```

### 4단계: 모바일에서 모델 실시간 전환 연동 (선택)
1. PC RisuAI → **설정 → 모델 → `Custom API`** 선택:
   - **URL**: `http://127.0.0.1:8787/v1/chat/completions`
   - **API 키**: `risustand` (임의 값)
   - **모델 이름**: `risustand-router`
2. 모바일 하단 **`⚡ 모델/번역`** 탭에서 실제 사용할 모델(OpenRouter / Gemini / Claude / OpenAI)의 API 키와 모델 ID를 저장하고 **선택**을 누르면 즉시 반영됩니다.

### 5단계: 프롬프트 프리셋 토글 등록 (선택)
- RisuAI 보안 정책상 프롬프트 프리셋의 커스텀 토글 정의는 플러그인이 직접 읽을 수 없습니다.
- 모바일 **`🧩 모듈/설정`** 탭 맨 위 **`+ 프리셋 토글`** 버튼에 PC 프리셋의 커스텀 토글 텍스트를 한 번만 붙여넣어 두면, 모든 접이식 그룹·체크박스·드롭다운이 채팅방의 **로컬 토글**로 즉시 연동됩니다.

---

## 🔒 보안 주의사항
- 서버를 실행하면 같은 폴더에 `.risustand-token`(접속 토큰)과 `.risustand-config.json`(API 키·프리셋 토글) 파일이 자동 생성됩니다.
- **절대 이 두 파일을 타인과 공유하거나 GitHub에 업로드하지 마세요.** (동봉된 `.gitignore`에 이미 제외 처리되어 있습니다.)

## 📄 라이선스
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — 전문은 [LICENSE](LICENSE) 참고.

- ✅ 개인 사용 · 취미 · 연구 · 학습 등 **비상업적 목적**의 사용, 수정, 재배포 허용
- ❌ **상업적 이용 불가** (유료 판매, 유료 서비스 포함 등)
- 재배포 시 라이선스 전문(또는 URL)과 `Required Notice:` 문구를 함께 포함해야 합니다.

> Required Notice: Copyright (c) 2026 RisuStand Contributors
