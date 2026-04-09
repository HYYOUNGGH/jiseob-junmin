"""
Python FastAPI 백엔드 — 챌린지 영상 포즈 추출기
사용법:
  pip install fastapi uvicorn python-multipart mediapipe opencv-python
  uvicorn main:app --reload

엔드포인트:
  POST /extract-poses   → challenge_001_poses.json 생성
  GET  /poses/{id}      → 저장된 포즈 JSON 반환
"""

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import mediapipe as mp
import cv2
import json
import tempfile
import os
from pathlib import Path

app = FastAPI(title="지섭이와 준민이 Pose Extractor")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

POSE_DIR = Path("./pose_data")
POSE_DIR.mkdir(exist_ok=True)

# MediaPipe 초기화
mp_pose = mp.solutions.pose


def extract_poses_from_video(video_path: str) -> dict:
    """
    영상에서 프레임별 MediaPipe 포즈 추출.
    반환 형식: { "frames": [{ "time": float, "landmarks": [...] }, ...] }
    """
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    frames_data = []

    # FIX: model_complexity=1 (모바일 최적화)
    with mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,
        smooth_landmarks=True,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    ) as pose:
        frame_idx = 0
        # 매 2프레임마다 추출 (30fps → 15fps 데이터, 파일 크기 절반)
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % 2 == 0:  # 2프레임 간격
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                results = pose.process(rgb)

                landmarks = []
                if results.pose_landmarks:
                    for lm in results.pose_landmarks.landmark:
                        landmarks.append({
                            "x": round(lm.x, 4),
                            "y": round(lm.y, 4),
                            "z": round(lm.z, 4),
                            "visibility": round(lm.visibility, 3),
                        })
                else:
                    # 포즈 미감지 프레임: 빈 배열
                    landmarks = []

                frames_data.append({
                    "frame": frame_idx,
                    "time": round(frame_idx / fps, 3),
                    "landmarks": landmarks,
                })

            frame_idx += 1

    cap.release()

    return {
        "total_frames": total_frames,
        "fps": fps,
        "sampled_frames": len(frames_data),
        "frames": frames_data,
    }


@app.post("/extract-poses")
async def extract_poses(
    file: UploadFile = File(...),
    challenge_id: str = "challenge_001",
):
    """
    영상 업로드 → 포즈 JSON 추출 → 저장 및 반환.
    
    사용 예시:
      curl -X POST "http://localhost:8000/extract-poses?challenge_id=challenge_001" \
           -F "file=@twice_dance.mp4"
    """
    if not file.content_type.startswith("video/"):
        raise HTTPException(400, "비디오 파일만 업로드 가능합니다.")

    # 임시 파일 저장
    suffix = Path(file.filename).suffix
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        print(f"⏳ 포즈 추출 시작: {file.filename} ({len(content) // 1024}KB)")
        pose_data = extract_poses_from_video(tmp_path)
        
        # 저장
        output_path = POSE_DIR / f"{challenge_id}_poses.json"
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(pose_data, f, ensure_ascii=False)

        print(f"✅ 완료: {pose_data['sampled_frames']}개 프레임 추출 → {output_path}")
        return {
            "challenge_id": challenge_id,
            "file": str(output_path),
            "total_frames": pose_data["total_frames"],
            "sampled_frames": pose_data["sampled_frames"],
            "fps": pose_data["fps"],
        }
    finally:
        os.unlink(tmp_path)


@app.get("/poses/{challenge_id}")
async def get_poses(challenge_id: str):
    """저장된 포즈 JSON 반환 (프론트엔드에서 직접 fetch)"""
    path = POSE_DIR / f"{challenge_id}_poses.json"
    if not path.exists():
        raise HTTPException(404, f"{challenge_id} 포즈 데이터를 찾을 수 없습니다.")
    return FileResponse(path, media_type="application/json")


@app.get("/health")
async def health():
    return {"status": "ok", "message": "지섭이와 준민이 백엔드 실행 중 🎵"}
