# 📖 RisuStand v1.0.0 (리수 독서대)

> **집에 두고 온 이야기를, 주머니에서 꺼내 읽는 독서대.**

PC에 설치한 **순정 로컬 RisuAI**를 아이폰 · 아이패드 · 안드로이드에서 그대로 이어 쓰게 해 주는 원격 접속 키트입니다.
RisuAI 원본 소스는 한 줄도 고치지 않습니다. 공식 **Plugin API v3.0** 플러그인 하나와 PC에서 켜 두는 작은 중계 서버만으로 동작합니다.

로컬 리스를 아끼지만 *"밖에서는 못 쓴다"*는 아쉬움을 안고 있던 분들을 위해 만들었습니다.
내 봇, 내 채팅방, 내 모듈과 페르소나가 모두 PC에 그대로 있고, 휴대폰은 그 책상 위 책을 펼쳐 보는 창이 됩니다.

- 📦 저장소: <https://github.com/rusinus12-droid/RisuStand>
- ⬇️ 최신 릴리즈: <https://github.com/rusinus12-droid/RisuStand/releases/latest>

---

## ✨ 무엇을 할 수 있나요

### 1. 어디서든 내 PC의 RisuAI로 (원격 접속 · 핵심 기능)
- **순정 로컬 RisuAI를 원격에서**: 클라우드 동기화나 서버 이전 없이, PC에서 돌아가는 RisuAI에 휴대폰 브라우저로 접속합니다.
- **Tailscale로 안전하게**: 포트포워딩 없이 내 기기끼리만 연결되는 사설망(Tailscale)과 보안 토큰으로 접속합니다.
- **봇 · 채팅방 그대로**: 봇 검색, 채팅방 전환, 새 방 만들기, 메시지 수정 · 삭제, 인라인 에셋을 제자리에 표시합니다.
- **모듈 · 페르소나 · 프리셋 토글**: 전역 모듈 ON/OFF, 페르소나 전환, 기본 파라미터, 커스텀 토글(로컬 토글 연동)을 휴대폰에서 바꿀 수 있습니다.
- **외출 모드**: 에셋을 `표시 🖼️` / `블러 + 터치 확인 🌫️` / `완전 감추기 🙈` 중에서 고르고, Gemini · Claude · ChatGPT 공홈처럼 보이는 테마로 바꿀 수 있습니다.
- **모델 전환 · 번역**: OpenRouter / OpenAI / Gemini / Claude 프로필을 휴대폰에서 전환하고, 말풍선 번역과 한→영 입력 번역을 씁니다.
- **휴대폰에서 서버 업데이트**: 새 릴리즈가 나오면 `🧩 모듈/설정` 탭에서 버튼 한 번으로 PC의 중계 서버를 업데이트합니다.

### 2. 독서대 테마 (PC · 태블릿)
- **10종 테마**: Gemini · Claude · ChatGPT 공홈, EPUB 세피아/다크(1쪽 스크롤 · 2쪽 펼침), 미드나잇 글래스, 사쿠라 파스텔, 포레스트 모스
- **종이책처럼**: 3D 책장 넘김, 좌우 스와이프, 하단 턴 룰러
- **휴대폰 · 태블릿 · PC 반응형**: 화면 크기에 맞춰 하단 탭바와 좌측 레일, 1쪽과 2쪽 펼침이 자동으로 바뀝니다.

---

## 📦 구성 파일

| 파일 | 설명 |
|---|---|
| `risustand.js` | PC RisuAI에 설치하는 플러그인 (API v3.0). RisuAI가 자동 업데이트를 확인합니다. |
| `risustand-relay-server.js` | PC에서 켜 두는 중계 서버 · 모바일 웹앱 · 모델 라우터 (Node.js 18+, 외부 패키지 없음) |
| `risustand-updater.cjs` | 공식 릴리즈 검증 · 설치 · 롤백을 맡는 업데이터 |
| `start-risustand-remote.bat` / `.sh` | 중계 서버 실행 런처 (토큰 자동 생성 + Tailscale IP 표시) |
| `update-risustand.bat` / `.sh` | 서버를 끈 상태에서 PC에서 직접 업데이트하는 런처 |

---

## 🚀 처음 설치하기

### 1단계 — PC RisuAI에 플러그인 설치
1. [최신 릴리즈](https://github.com/rusinus12-droid/RisuStand/releases/latest)에서 `RisuStand-x.y.z.zip`을 받아 원하는 폴더에 풉니다.
2. PC RisuAI → **설정 → 플러그인 → 플러그인 추가**에서 `risustand.js`를 불러옵니다.
3. 햄버거 메뉴(☰)에 **`📖 RisuStand 설정`**, **`📖 RisuStand 전용 뷰`**, **`📡 RisuStand 원격 접속`**이 생기면 설치가 끝난 것입니다.

### 2단계 — PC에서 중계 서버 켜기
1. [Node.js LTS (v18 이상)](https://nodejs.org)를 설치합니다.
2. 압축을 푼 폴더에서 `start-risustand-remote.bat`(macOS/Linux는 `start-risustand-remote.sh`)을 실행합니다.
3. 창에 표시되는 **`Security Token`**을 복사해 둡니다. 휴대폰으로 접속할 때 쓰는 열쇠입니다. 처음 한 번 만들어지고 이후에는 같은 토큰을 씁니다.
4. PC RisuAI → **`📡 RisuStand 원격 접속`** → `원격 브릿지 활성화`를 켜고 주소 `http://127.0.0.1:8787`, 토큰을 붙여넣은 뒤 **저장 및 연결**을 누릅니다.
   처음 한 번 뜨는 RisuAI DB 권한 팝업은 허용해 주세요. 상태가 `🟢 중계 서버 연결됨`으로 바뀌면 됩니다.

> 중계 서버 창은 원격으로 쓰는 동안 켜 두어야 합니다. 창을 닫으면 원격 접속도 멈춥니다.

### 3단계 — Tailscale로 휴대폰 연결하기
Tailscale은 내 기기끼리만 보이는 사설 네트워크를 만들어 줍니다. 공유기 설정이나 포트포워딩 없이, 집 밖 LTE/5G에서도 PC에 안전하게 닿을 수 있습니다. 개인 사용은 무료입니다.

1. **PC에 설치**: <https://tailscale.com/download>에서 설치한 뒤 로그인합니다(Google · Microsoft · Apple 계정 등).
2. **휴대폰에 설치**: App Store / Play 스토어에서 **Tailscale**을 설치하고 **PC와 같은 계정**으로 로그인합니다. VPN 구성 추가 요청이 뜨면 허용합니다.
3. **PC 주소 확인**: 휴대폰 Tailscale 앱의 기기 목록에서 **PC 이름 옆 `100.x.x.x` 주소**를 확인합니다. 휴대폰 자신의 주소가 아니라 **PC의 주소**를 씁니다. 중계 서버 런처 창에도 `iPhone / iPad : http://100.x.x.x:8787`로 표시됩니다.
4. **접속**: 휴대폰에서 Tailscale이 **연결됨(Connected)** 상태인지 확인하고, Safari/Chrome에서 `http://100.x.x.x:8787`을 엽니다. 토큰을 입력하면 끝입니다. 한 번 로그인하면 기기에 기억됩니다.
5. **홈 화면에 추가 (추천)**: Safari 공유 버튼 → **홈 화면에 추가**를 누르면 앱처럼 전체 화면으로 열립니다.

> 💡 MagicDNS가 켜져 있으면 IP 대신 `http://<PC 이름>:8787`로도 접속할 수 있습니다.

#### 접속이 안 될 때
- **Windows 방화벽** — 관리자 권한 PowerShell에서 한 번 실행합니다:
  ```powershell
  netsh advfirewall firewall add rule name="RisuStand Relay 8787" dir=in action=allow protocol=TCP localport=8787
  ```
- 휴대폰과 PC의 Tailscale이 **모두 켜져 있고 같은 계정**인지 확인합니다.
- PC가 **절전 모드**에 들어가면 연결이 끊깁니다. 외출 전에 절전 설정을 확인해 주세요.
- 화면 상단의 점이 회색이면 PC RisuAI의 브릿지가 꺼져 있는 상태입니다. 2단계 4번을 다시 확인합니다.

### 4단계 — (선택) 휴대폰에서 모델 실시간 전환
1. PC RisuAI → **설정 → 모델 → `Custom API`**:
   - **URL**: `http://127.0.0.1:8787/v1/chat/completions`
   - **API 키**: `risustand` (아무 값)
   - **모델 이름**: `risustand-router`
2. 휴대폰 **`⚡ 모델/번역`** 탭에서 실제로 쓸 모델의 API 키와 모델 ID를 저장하고 **선택**을 누르면 바로 반영됩니다.

### 5단계 — (선택) 프롬프트 프리셋 토글 등록
RisuAI 보안 정책상 프롬프트 프리셋의 커스텀 토글 정의는 플러그인이 직접 읽을 수 없습니다.
휴대폰 **`🧩 모듈/설정`** 탭의 **`+ 프리셋 토글`**에 PC 프리셋의 커스텀 토글 텍스트를 한 번만 붙여넣으면, 그룹 · 체크박스 · 드롭다운이 채팅방의 **로컬 토글**로 연동됩니다.

---

## 🔄 업데이트

| 대상 | 방법 |
|---|---|
| **중계 서버** (`risustand-relay-server.js` 등) | 휴대폰 `🧩 모듈/설정` → **🔄 업데이트** → `서버 업데이트`. 또는 서버를 끄고 PC에서 `update-risustand.bat`(`.sh`) 실행 |
| **플러그인** (`risustand.js`) | RisuAI가 `//@update-url`로 새 버전을 확인합니다. PC RisuAI의 플러그인 설정에서 업데이트하세요. |

업데이터는 [공식 릴리즈](https://github.com/rusinus12-droid/RisuStand/releases)만 받아 아래 순서로 확인한 다음에야 파일을 바꿉니다.

1. GitHub 정식 릴리즈(초안 · 프리릴리즈 제외)의 정확한 파일 `RisuStand-x.y.z.zip`
2. GitHub가 제공하는 SHA-256 값과 내려받은 파일 비교
3. ZIP 구조 · 경로 · CRC 검사 (폴더 밖으로 나가는 경로 차단)
4. `update-manifest.json`의 저장소 · 버전 · 태그 · 업데이트 정책
5. `SHA256SUMS.txt`로 모든 파일 해시 확인, JS 문법 검사

검증을 통과하면 기존 파일을 `.update/backups/`에 백업한 뒤 교체하고, 서버를 같은 창 · 같은 토큰으로 다시 시작합니다.
**새 버전이 정상적으로 켜지지 않으면 자동으로 이전 버전으로 되돌립니다.**
`.risustand-token`과 `.risustand-config.json`은 읽지도 바꾸지도 않습니다. 실행 중인 런처(`.bat`/`.sh`)가 바뀐 경우에는 덮어쓰지 않고 `파일명.new`로 옆에 둡니다.

---

## 🏷️ 릴리즈 만들기 (관리자용)

`.github/workflows/manual-release.yml` — Librarian System의 Manual Release를 RisuStand에 맞게 옮긴 워크플로입니다.

1. GitHub 저장소 → **Actions → Manual Release → Run workflow** (브랜치 `main`)
2. `version` 입력: 비우면 **다음 패치 버전**, 현재 `VERSION`과 같으면 **현재 커밋을 그대로 배포**, 더 높으면 **그 버전으로 올려서 배포**
3. 워크플로가 하는 일: 버전 일괄 갱신(`VERSION` · 플러그인 `//@version` · 서버 상수 · README · 정책) → 릴리즈 ZIP 빌드와 자체 검증 → 테스트 → `chore(release): vX.Y.Z` 커밋 · 태그 → GitHub Release 생성(ZIP + 빌드 리포트)

중간에 실패해도 다시 실행하면 이어서 진행합니다. 이미 올라간 파일은 SHA-256으로 대조하고, 없는 파일만 추가로 올립니다.
로컬에서 확인할 때는 `node tools/build_release.cjs --check`, `node --test "tests/*_test.cjs"`를 실행합니다.

---

## 🔒 보안 · 개인정보
- 서버 폴더에 생기는 `.risustand-token`(접속 토큰)과 `.risustand-config.json`(API 키 · 프리셋 토글)은 **절대 공유하거나 업로드하지 마세요.**
  저장소 `.gitignore`에서 추적 대상에서 빠져 있고, 릴리즈 빌더도 이 파일들(과 그 안의 값)이 결과물에 섞이면 빌드를 거부합니다.
- 공유기 포트포워딩으로 8787 포트를 인터넷에 직접 열지 마세요. Tailscale처럼 내 기기끼리만 보이는 망을 권장합니다.

## 📄 라이선스
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — 전문은 [LICENSE](LICENSE) 참고.

- ✅ 개인 사용 · 취미 · 연구 · 학습 등 **비상업적 목적**의 사용, 수정, 재배포 허용
- ❌ **상업적 이용 불가** (유료 판매, 유료 서비스 포함 등)
- 재배포 시 라이선스 전문(또는 URL)과 `Required Notice:` 문구를 함께 포함해야 합니다.

> Required Notice: Copyright (c) 2026 rusinus12
