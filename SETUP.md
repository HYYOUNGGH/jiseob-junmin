# 지섭이와 준민이 — 수정 가이드

## 🔴 원본 코드의 5가지 버그 요약

| # | 버그 | 위치 | 증상 |
|---|------|------|------|
| 1 | `input_file_1.mp4` 파일 없음 | HomeView | 챌린지 영상 404 에러 |
| 2 | MediaPipe `useEffect([isStarted])` | CameraView | 포즈 감지기 재초기화 → 브라우저 멈춤 |
| 3 | 두 번째 MediaPipe 인스턴스 | CameraView | 챌린지 영상 실시간 처리 → 극심한 프레임 드롭 |
| 4 | `process.env.GEMINI_API_KEY` | Gemini 함수 | Vite에서 undefined → API 오류 |
| 5 | `gemini-3-flash-preview` | Gemini 함수 | 존재하지 않는 모델명 → 오류 |

---

## ✅ 빠른 셋업

### 1. .env 파일 설정
```bash
cp .env.example .env
# .env 파일에서 아래 값 채우기:
VITE_GEMINI_API_KEY=your_key_here
```

### 2. 챌린지 영상 추가
```
/public/challenge_001.mp4   ← TWICE 영상 여기에 넣기
```

### 3. 포즈 JSON 추출 (Python 백엔드)
```bash
cd backend
pip install fastapi uvicorn python-multipart mediapipe opencv-python
uvicorn main:app --reload

# 영상 업로드
curl -X POST "http://localhost:8000/extract-poses?challenge_id=challenge_001" \
     -F "file=@/path/to/twice_dance.mp4"

# 생성된 파일: backend/pose_data/challenge_001_poses.json
# → /public/challenge_001_poses.json 으로 복사
cp backend/pose_data/challenge_001_poses.json public/
```

### 4. 프론트엔드 실행
```bash
npm install
npm run dev
```

---

## 아키텍처 (수정 후)

```
[TWICE 영상]
    ↓ (관리자 1회 업로드)
[Python FastAPI + MediaPipe]
    ↓
[challenge_001_poses.json] → /public/ 폴더에 저장
    ↓ (앱 실행 시 로드)
[CameraView]
    ├── 챌린지 포즈 JSON → 프레임 인덱싱으로 타겟 포즈 조회
    └── 유저 카메라 → MediaPipe 단일 인스턴스 실시간 처리
         ↓
    calculateScore(user, target) → 유클리드 거리 → 0~100점
         ↓
    Gemini AI 코치 피드백
```

---

## Flutter로 전환하고 싶다면?

Google AI Studio는 Flutter를 지원하지 않아서 React로 뽑혔어.  
진짜 Flutter 앱이 필요하면:
- `flutter create jiseob_junmin`
- `google_mlkit_pose_detection` 패키지 (온디바이스, CDN 없이 빠름)
- `camera` + `video_player` 패키지
- 현재 React 로직을 Dart로 포팅 (calculateScore 함수 그대로 사용 가능)

Flutter를 원하면 말해줘, 전체 코드 다시 작성해줄게.
