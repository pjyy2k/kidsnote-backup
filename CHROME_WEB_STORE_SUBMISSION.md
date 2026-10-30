# Chrome Web Store 제출 정보

기준 버전: 0.3.3

## 기본 정보

**이름**
KidsNote Backup

**요약 설명**
키즈노트 알림장과 앨범의 원본 사진 및 데이터를 기간별로 사용자의 컴퓨터에 백업합니다.

**카테고리 추천**
Productivity

**언어**
한국어 (Korean)

## 상세 설명

KidsNote Backup은 사용자가 로그인한 KidsNote 계정에서 직접 접근할 수 있는 알림장과 앨범 자료를 개인 컴퓨터에 백업할 수 있도록 도와주는 브라우저 확장 프로그램입니다.

원하는 기간을 선택하면 알림장 또는 앨범의 원본 사진을 다운로드할 수 있으며, 알림장의 경우 JSON 및 Markdown 형태의 데이터 백업도 선택할 수 있습니다. 장시간 백업 작업은 일시정지 후 이어받을 수 있습니다.

주요 기능
- 기간을 지정하여 KidsNote 알림장 백업
- KidsNote 앨범 원본 사진 백업
- 알림장 원본 사진, JSON, Markdown 선택 저장
- 날짜별 폴더 또는 한 폴더 저장 방식 선택
- 장시간 백업의 일시정지 및 이어받기
- 백업 파일을 사용자의 로컬 다운로드 폴더에 직접 저장

개인정보 보호
- KidsNote 비밀번호를 수집하거나 저장하지 않습니다.
- 사용자가 이미 로그인한 KidsNote 세션을 사용합니다.
- 백업 데이터와 사진을 개발자 서버로 전송하지 않습니다.
- 광고, 분석 및 사용자 추적 기능을 사용하지 않습니다.

KidsNote Backup은 KidsNote의 공식 확장 프로그램이 아닙니다.

## Single purpose

로그인된 사용자가 접근 권한을 가진 KidsNote 알림장 및 앨범 자료를 사용자가 지정한 기간에 따라 로컬 다운로드 폴더에 백업하고, 백업 작업의 일시정지 및 이어받기를 제공하는 확장 프로그램입니다.

## 권한 사용 사유

### storage
백업 작업의 진행 상태, 페이지 커서, 처리 완료 항목 및 사진 일련번호를 브라우저 로컬 저장소에 저장하여 일시정지 및 이어받기 기능을 제공하기 위해 사용합니다. 저장 정보는 개발자 서버로 전송하지 않습니다.

### downloads
사용자가 요청한 KidsNote 알림장 및 앨범의 원본 사진과 백업 파일(JSON, Markdown, HTML)을 사용자의 로컬 다운로드 폴더에 저장하기 위해 사용합니다.

### alarms
Manifest V3 서비스 워커가 중단될 수 있는 환경에서 장시간 백업 작업의 다음 처리 단계를 예약하고 안정적으로 이어가기 위해 사용합니다.

### Host permission: https://*.kidsnote.com/*
로그인된 사용자가 접근 가능한 KidsNote 알림장 및 앨범 데이터를 조회하고 백업하기 위해 사용합니다. 접근은 KidsNote 도메인으로 제한되며, 백업 데이터를 개발자 서버로 전송하지 않습니다.

## Remote code

**선택:** No, I am not using remote code.

확장 프로그램은 원격 JavaScript, WebAssembly 또는 기타 실행 코드를 다운로드하거나 실행하지 않습니다. 실행 코드는 패키지 내부 파일에 한정됩니다.

## 데이터 사용 공개

Chrome Web Store Privacy 탭에서는 실제 화면에 표시되는 데이터 유형 명칭에 맞춰 다음 원칙으로 선택합니다.

- KidsNote 게시물의 내용 및 사진처럼 사용자가 요청한 백업 기능을 제공하기 위해 확장 프로그램이 접근하는 사용자 콘텐츠는 해당되는 데이터 유형으로 공개합니다.
- 데이터는 사용자 요청에 따라 로컬 백업을 만들기 위해서만 처리합니다.
- 개발자 서버로 수집하거나 전송하지 않습니다.
- 광고, 프로파일링, 신용평가 또는 판매 목적으로 사용하지 않습니다.
- Limited Use 관련 인증 항목은 모두 실제 동작과 일치하는 범위에서 체크합니다.

## 개인정보처리방침 URL

https://github.com/pjyy2k/kidsnote-backup/blob/main/PRIVACY.md

## 지원 URL

https://github.com/pjyy2k/kidsnote-backup/issues

## 홈페이지

https://github.com/pjyy2k/kidsnote-backup

## 그래픽 자산

Chrome Web Store 제출 시 다음이 필요합니다.

- Store icon: 128 x 128 px
- Screenshot: 최소 1장, 1280 x 800 px 또는 640 x 400 px (최대 5장)
- Small promo tile: 선택 사항, 440 x 280 px
- Marquee image: 선택 사항, 1400 x 560 px

추천 스크린샷 구성
1. 확장 프로그램 팝업 전체 화면 - 알림장/앨범 다운로드 버튼 포함
2. 기간 및 저장 옵션 설정 화면
3. 백업 진행 상태와 일시정지/이어받기 화면
4. 완료된 로컬 폴더 구조 화면

실제 자녀 이름, 사진, Child ID 등 개인정보가 노출되지 않도록 데모 또는 마스킹된 화면을 사용합니다.

## 배포 설정 추천

- Visibility: Public
- Regions: All regions (특별한 제한 사유가 없다면)
- Mature content: No

## 제출 전 체크

- Google 계정 2단계 인증 활성화
- Chrome Web Store 개발자 계정 등록 및 1회 등록비 결제
- 최신 main에서 Store용 ZIP 생성
- ZIP 루트에 manifest.json이 직접 위치하는지 확인
- 128x128 아이콘 준비
- 최소 1장의 규격 스크린샷 준비
- Store listing 작성
- Privacy practices 작성
- 개인정보처리방침 URL 입력 및 공개 접근 확인
- 최종 제출 전 실제 Chrome에서 설치/백업 테스트
