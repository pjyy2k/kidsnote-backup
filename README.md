# KidsNote Backup

Chrome Manifest V3 확장프로그램으로, 로그인된 KidsNote 세션을 이용해 지정 기간의 **알림장**과 **앨범 원본 사진**을 로컬에 백업합니다.

## 주요 기능

- 시작일 / 종료일 지정
- **알림장 다운로드**와 **앨범 다운로드** 버튼 분리
- 알림장 API와 앨범 API를 cursor 방식으로 자동 순회
- 목록 요청은 `page_size=99999`를 사용해 페이지 이동을 최대한 줄임
- 서버가 `next` cursor를 반환하면 해당 값을 다음 요청의 `page` 파라미터로 그대로 사용
- `attached_images[].original` 원본 사진 다운로드
- 사진 저장 방식을 **날짜별 폴더** 또는 **한 폴더에 모두 저장** 중 선택
- 사진 파일명은 `yyyy-mm-dd-일련번호` 형식으로 저장
- 알림장 Markdown과 JSON 저장
- 알림장 백업 완료 시 `Reports/daily-report.html` 생성
- 앨범 사진은 알림장 사진과 섞이지 않도록 `Album/Photos`에 별도 저장
- 앨범 API에 필요한 Child / Center / Class ID를 가능한 범위에서 자동 감지
- 중단 후 이어받기, 일시정지, 취소
- 처리한 항목 ID와 날짜별 사진 일련번호를 저장해 이어받기 시 중복 처리를 줄임
- 별도 외부 서버나 LLM을 사용하지 않음

## 설치

1. 이 저장소를 내려받습니다.
2. Chrome에서 `chrome://extensions`를 엽니다.
3. **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 눌러 저장소 폴더를 선택합니다.
5. KidsNote에 로그인합니다.
6. 확장 설치 후 이미 열려 있던 KidsNote 탭이라면 한 번 새로고침합니다.
7. KidsNote 알림장 화면을 한 번 연 뒤 확장프로그램을 실행하면 Child ID와 원/반 정보 자동 감지가 쉬워집니다.

## 백업 방법

### 알림장

1. `KidsNote 알림장 열기`를 누릅니다.
2. Child ID를 자동 감지하거나 직접 입력합니다.
3. 시작일 / 종료일을 선택합니다.
4. 원본 사진 / JSON / Markdown 저장 여부와 사진 저장 방식을 선택합니다.
5. **알림장 다운로드**를 누릅니다.

오래전 알림장은 해당 날짜까지 탐색하는 데 시간이 걸릴 수 있습니다.

### 앨범

1. KidsNote에 로그인된 상태인지 확인합니다.
2. Child ID를 자동 감지하거나 직접 입력합니다.
3. 시작일 / 종료일과 사진 저장 방식을 선택합니다.
4. **앨범 다운로드**를 누릅니다.

앨범 백업은 게시물의 `attached_images[].original`을 사용해 **원본 사진만 일괄 다운로드**합니다.

## 확인된 API 흐름

### 알림장

```text
GET https://kapi.kidsnote.com/v1_2/children/{childId}/reports/
    ?page_size=99999
    &tz=Asia%2FSeoul
    &child={childId}
```

다음 페이지가 있으면:

```text
&page={next}
```

을 추가합니다.

### 앨범

```text
GET https://kapi.kidsnote.com/v1_3/children/{childId}/albums/
    ?tz=Asia%2FSeoul
    &page_size=99999
    &center={centerId}
    &cls={classId}
    &child={childId}
```

앨범도 응답의 `next` 값을 해석하거나 다시 생성하지 않고 그대로 다음 요청의 `page` 값으로 전달합니다.

확장프로그램은 Center/Class 값을 특정 사용자 값으로 하드코딩하지 않습니다. 현재 KidsNote 페이지의 API 요청에서 탐지하거나, 필요 시 로그인 세션을 사용해 알림장 1건을 조회하여 보완합니다.

## 원본 사진

알림장과 앨범 모두 사진 URL을 추측하거나 변환하지 않고 API가 제공한 값을 그대로 사용합니다.

```text
results[].attached_images[].original
```

## 저장 구조

`report ID` 또는 `album ID` 폴더는 만들지 않습니다.

### 알림장 — 날짜별 사진 폴더

```text
KidsNote/
└─ ChildName/
   ├─ Photos/
   │  ├─ 2026-10-20/
   │  │  ├─ 2026-10-20-001.jpg
   │  │  └─ 2026-10-20-002.jpg
   │  └─ 2026-10-21/
   │     ├─ 2026-10-21-001.jpg
   │     └─ 2026-10-21-002.jpg
   ├─ Diary/
   │  └─ 2026-10-21.md
   ├─ JSON/
   │  └─ 2026-10-21.json
   └─ Reports/
      └─ daily-report.html
```

### 앨범 — 날짜별 사진 폴더

```text
KidsNote/
└─ ChildName/
   └─ Album/
      └─ Photos/
         ├─ 2026-10-19/
         │  ├─ 2026-10-19-001.jpg
         │  ├─ 2026-10-19-002.jpg
         │  └─ 2026-10-19-003.jpg
         └─ 2026-10-14/
            ├─ 2026-10-14-001.jpg
            └─ 2026-10-14-002.jpg
```

### 한 폴더에 모두 저장

알림장:

```text
KidsNote/ChildName/Photos/2026-10-21-001.jpg
```

앨범:

```text
KidsNote/ChildName/Album/Photos/2026-10-21-001.jpg
```

앨범 API 응답에 자녀명이 없고 알림장에서도 자녀명을 확인할 수 없는 경우에는 안전한 fallback으로 `child-{ChildID}` 폴더를 사용합니다.

## 일시정지 / 이어받기 / 취소

- **일시정지**: 현재 실행 토큰을 폐기하고 이후 처리를 중단합니다.
- **이어받기**: 사용자가 이어받기 버튼을 눌렀을 때만 새 실행 토큰을 발급하고 저장된 cursor에서 다시 시작합니다.
- **취소**: 작업 상태를 `cancelled`로 종료하며 자동 재개하지 않습니다.
- 이미 Chrome 다운로드 API에 전달된 파일은 일시정지/취소 직후에도 다운로드가 완료될 수 있습니다.

## 주의사항

- 이 프로젝트는 KidsNote 웹에서 확인된 비공개 API 응답 구조를 기반으로 합니다. KidsNote에서 API 형식을 변경하면 수정이 필요할 수 있습니다.
- `page_size=99999`를 요청하더라도 서버가 자체 제한을 적용할 수 있습니다. 이 경우 응답의 `next` cursor를 따라 계속 조회합니다.
- API 오류나 인증 오류가 발생하면 임의로 다른 endpoint를 추측하지 않고 작업을 중단하고 오류를 표시합니다.
- 한 번에 많은 파일을 내려받을 경우 Chrome에서 다중 다운로드 허용을 요청할 수 있습니다.
- 백업에는 자녀 사진 및 알림장 내용 등 개인정보가 포함될 수 있으므로 다운로드 폴더를 안전하게 관리하세요.
- 본 확장프로그램은 사용자가 본인의 로그인 세션으로 접근할 수 있는 자료를 개인적으로 백업하는 용도로 설계되었습니다.

## 개인정보 처리

KidsNote API 응답과 사진은 제3자 서버로 전송하지 않습니다. 처리 상태와 이어받기에 필요한 정보만 브라우저의 `chrome.storage.local`에 저장하며, 결과 파일은 사용자의 Chrome 다운로드 폴더에 저장됩니다.
