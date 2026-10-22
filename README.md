# KidsNote Backup

Chrome Manifest V3 확장프로그램으로, 로그인된 KidsNote 세션을 이용해 지정 기간의 알림장과 원본 사진을 로컬에 백업합니다.

## 주요 기능

- 시작일 / 종료일 지정
- KidsNote 알림장 목록 API를 cursor 방식으로 자동 순회
- 응답의 `next` 값을 다음 요청의 `page` 파라미터로 사용
- `attached_images[].original` 원본 사진 다운로드
- 사진 저장 방식을 **날짜별 폴더** 또는 **한 폴더에 모두 저장** 중 선택
- 사진 파일명은 `yyyy-mm-dd-일련번호` 형식으로 저장
- 알림장 Markdown과 JSON은 사진 저장 방식과 무관하게 각각 별도 폴더에 모아 저장
- 페이지와 알림장 처리 상태를 `chrome.storage.local`에 저장
- 중단 후 이어받기, 일시정지, 취소
- 이미 처리한 report ID는 재개 시 건너뜀
- 별도 외부 서버나 LLM을 사용하지 않음

## 설치

1. 이 저장소를 내려받습니다.
2. Chrome에서 `chrome://extensions`를 엽니다.
3. **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 눌러 저장소 폴더를 선택합니다.
5. KidsNote에 로그인한 뒤 `https://www.kidsnote.com/`의 알림장 목록 화면을 엽니다.
6. 확장 설치 후 이미 열려 있던 KidsNote 탭이라면 한 번 새로고침합니다.
7. 확장 아이콘을 열어 Child ID를 자동 감지하고 백업 기간과 사진 저장 방식을 선택합니다.

자동 감지가 되지 않으면 Child ID를 직접 입력할 수 있습니다. Child ID는 KidsNote Network 요청의 다음 경로에서 확인할 수 있습니다.

```text
/v1_2/children/{childId}/reports/
```

## 확인된 API 흐름

목록 요청 형식:

```text
https://kapi.kidsnote.com/v1_2/children/{childId}/reports/?page_size=12&tz=Asia%2FSeoul&child={childId}
```

다음 페이지가 있으면 응답의 `next` 값을 그대로 `page`에 전달합니다.

```text
...?page={next}&page_size=12&tz=Asia%2FSeoul&child={childId}
```

확장프로그램은 서버가 반환한 cursor를 해석하거나 새로 생성하지 않습니다.

사진은 URL을 추측하거나 변환하지 않고 API가 직접 제공하는 다음 값을 사용합니다.

```text
results[].attached_images[].original
```

## 저장 구조

`report ID` 폴더는 만들지 않습니다.

### 1. 날짜별 사진 폴더

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
   │  ├─ 2026-10-20.md
   │  └─ 2026-10-21.md
   └─ JSON/
      ├─ 2026-10-20.json
      └─ 2026-10-21.json
```

### 2. 사진을 한 폴더에 모두 저장

```text
KidsNote/
└─ ChildName/
   ├─ Photos/
   │  ├─ 2026-10-20-001.jpg
   │  ├─ 2026-10-20-002.jpg
   │  ├─ 2026-10-21-001.jpg
   │  └─ 2026-10-21-002.jpg
   ├─ Diary/
   │  ├─ 2026-10-20.md
   │  └─ 2026-10-21.md
   └─ JSON/
      ├─ 2026-10-20.json
      └─ 2026-10-21.json
```

사진 저장 방식을 어떤 것으로 선택하더라도 `Diary`와 `JSON` 폴더 구조는 바뀌지 않습니다. Chrome의 기본 다운로드 폴더 아래에 `KidsNote` 폴더가 생성됩니다.

## 이어받기 방식

각 알림장을 처리한 뒤 report ID와 날짜별 사진 일련번호를 저장합니다. 한 페이지를 모두 처리한 뒤 다음 cursor를 저장하므로, 작업이 중간에 종료되어도 현재 페이지를 다시 불러온 다음 이미 완료한 report ID를 건너뛸 수 있습니다.

확장프로그램 팝업에서 **이어받기**를 누르면 저장된 상태에서 다시 시작합니다.

## 주의사항

- 이 프로젝트는 현재 KidsNote 웹에서 확인된 비공개 API 응답 구조를 기반으로 합니다. KidsNote에서 API 형식을 변경하면 수정이 필요할 수 있습니다.
- API 오류나 인증 오류가 발생하면 임의로 다른 endpoint를 추측하지 않고 작업을 중단하고 오류를 표시합니다.
- 한 번에 많은 파일을 내려받을 경우 Chrome에서 다중 다운로드 허용을 요청할 수 있습니다.
- 백업에는 자녀 사진 및 알림장 내용 등 개인정보가 포함될 수 있으므로 다운로드 폴더를 안전하게 관리하세요.
- 본 확장프로그램은 사용자가 본인의 로그인 세션으로 접근할 수 있는 자료를 개인적으로 백업하는 용도로 설계되었습니다.

## 개인정보 처리

KidsNote API 응답과 사진은 제3자 서버로 전송하지 않습니다. 처리 상태만 브라우저의 `chrome.storage.local`에 저장하며, 결과 파일은 사용자의 Chrome 다운로드 폴더에 저장됩니다.
