# 스토어 심사 입력 문구 / Store review justifications

## 한국어

### 전용 목적
사용자가 로그인한 본인의 KidsNote 계정에서 볼 수 있는 알림장과 앨범 자료를, 사용자가 지정한 기간만큼 내 컴퓨터로 백업합니다.

### storage
백업 진행 상태(작업 종류, 기간, 처리한 항목 ID, 다음 페이지 위치, 사진 일련번호)를 브라우저 내부에 저장합니다. 일시정지 후 이어받기와 중복 처리 방지에 필요합니다. 외부로 전송하지 않습니다.

### downloads
알림장·앨범의 원본 사진과 사용자가 선택한 Markdown, JSON, HTML 리포트 파일을 기본 다운로드 폴더 아래 KidsNote 폴더에 저장하는 데 사용합니다. 이 확장의 핵심 기능입니다.

### alarms
목록 페이지를 일정 간격으로 나누어 처리합니다. 백업이 길어져 서비스 워커가 중지되더라도 다음 페이지 처리를 이어가는 데 필요합니다.

### 호스트 권한: https://*.kidsnote.com/*
KidsNote 페이지에서 사용자의 로그인 세션으로 알림장·앨범 목록을 조회하고, 자녀·원·반 정보를 감지하며, 현재 탭이 KidsNote인지 확인하는 데 사용합니다. 다른 사이트에는 접근하지 않습니다.

### 호스트 권한: https://up-kids-kage.kakao.com/*
KidsNote가 첨부 사진을 제공하는 저장소 도메인입니다. API가 알려 준 원본 사진 URL을 내려받는 데만 사용합니다.

### 콘텐츠 스크립트: https://www.kidsnote.com/*
KidsNote 화면에서 자녀 정보를 감지하고, 필요하면 추억보기로 전환하며, 로그인 세션으로 목록 API를 호출합니다.

### 원격 코드
사용하지 않습니다. 모든 JavaScript는 패키지에 포함되어 있으며 eval이나 외부 스크립트를 쓰지 않습니다.

### 데이터 사용
KidsNote 자료는 사용자의 컴퓨터에만 저장되며 개발자나 제3자 서버로 전송되지 않습니다. 로그인 비밀번호를 읽거나 저장하지 않고, 광고·분석 도구를 사용하지 않습니다.

## English

### Single purpose
Backs up the daily reports and album photos that the signed-in user can already view in their own KidsNote account to their computer, for a date range the user chooses.

### storage
Stores backup progress in the browser (job type, date range, processed item IDs, next-page cursor, photo sequence numbers). Required for pause/resume and to avoid duplicate processing. Never sent externally.

### downloads
Saves original report and album photos, plus the Markdown, JSON, and HTML report files the user selects, to a KidsNote folder under the default download folder. This is the extension's core function.

### alarms
Processes list pages in separate steps so a long backup can continue after the service worker is suspended.

### Host permission: https://*.kidsnote.com/*
Used to read report and album lists with the user's signed-in session, detect child, center, and class information, and confirm the current tab is KidsNote. No other sites are accessed.

### Host permission: https://up-kids-kage.kakao.com/*
Storage domain where KidsNote serves attached photos. Used only to download the original photo URLs returned by the KidsNote API.

### Content script: https://www.kidsnote.com/*
Detects child information on KidsNote pages, switches to the memory view when needed, and calls the list API with the user's signed-in session.

### Remote code
None. All JavaScript is included in the package. No eval or external scripts are used.

### Data use
KidsNote data is saved only on the user's computer and is never sent to the developer or any third-party server. The extension does not read or store login passwords and uses no advertising or analytics tools.
