import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Trophy, User, Play, ChevronRight, Award,
  Globe, X, Loader2, Sparkles, Upload, Plus,
  Heart, CheckCircle
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  doc, getDoc, setDoc, collection, addDoc, serverTimestamp,
  onSnapshot, query, orderBy, limit, updateDoc, increment
} from 'firebase/firestore';
import {
  onAuthStateChanged
} from 'firebase/auth';
import { GoogleGenAI } from '@google/genai';
import { db, auth } from './firebase';
import './index.css';
import './i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Landmark { x: number; y: number; z?: number; visibility?: number; }

interface UserProfile {
  id: string;
  displayName: string;
  photoURL?: string;
  level: number;
  exp: number;
  badges: string[];
}

interface Challenge {
  id: string;
  title: string;
  creatorName: string;
  creatorId: string;
  videoUrl: string;
  poseData: Landmark[][];
  thumbnail?: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  likeCount: number;
  participantCount: number;
  timestamp: any;
}

// ─── 상수 ─────────────────────────────────────────────────────────────────────

const POSE_CONNECTIONS: [number, number][] = [
  [11,12],[11,13],[13,15],[12,14],[14,16],
  [11,23],[12,24],[23,24],
  [23,25],[25,27],[24,26],[26,28],
];
const FACE_CONNECTIONS: [number, number][] = [
  [0,1],[1,2],[2,3],[3,7],
  [0,4],[4,5],[5,6],[6,8],
  [9,10],
];
const KEY_JOINTS = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,23,24,25,26,27,28];

// ─── 유틸 함수 ────────────────────────────────────────────────────────────────

function calculateScore(user: Landmark[], target: Landmark[]): number {
  if (!user?.length || !target?.length) return 0;
  let total = 0, valid = 0;
  KEY_JOINTS.forEach(i => {
    const u = user[i], t = target[i];
    if (u && t && (u.visibility??1)>0.5 && (t.visibility??1)>0.5) {
      const dist = Math.sqrt((u.x-t.x)**2 + (u.y-t.y)**2);
      total += Math.max(0, 1 - dist/0.25);
      valid++;
    }
  });
  return valid > 0 ? Math.round((total/valid)*100) : 0;
}

async function getAIFeedback(score: number, accuracy: number, lang: string) {
  try {
    const ai = new GoogleGenAI({ apiKey: import.meta.env.VITE_GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: `You are a trendy AI dance coach for "지섭이와 준민이".
Score: ${score}, Accuracy: ${accuracy}%.
2 sentences max, ${lang==='ko'?'한국어':'English'}, Gen Z style, use emojis.`,
    });
    return response.text ?? '';
  } catch {
    return lang==='ko' ? '진짜 대박이었어요! 다음엔 퍼펙트 노려봐요! 🔥' : 'Absolutely fire! 🔥';
  }
}

// ─── CameraView용 Pose 싱글톤 캐시 ───────────────────────────────────────────
let cachedPose: any = null;
async function getCameraPose() {
  if (cachedPose) return cachedPose;
  const { Pose } = await import('@mediapipe/pose');
  const pose = new Pose({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}` });
  pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  cachedPose = pose;
  return pose;
}

// ─── 포즈 추출 (업로드 시 클라이언트에서 자동 실행) ─────────────────────────

async function extractPosesFromVideo(videoFile: File): Promise<Landmark[][]> {
  return new Promise(async (resolve) => {
    const { Pose } = await import('@mediapipe/pose');
    const pose = new Pose({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}`,
    });
    pose.setOptions({
      modelComplexity: 2,
      smoothLandmarks: true,
      enableSegmentation: false,
      smoothSegmentation: false,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.7,
    });

    const frames: Landmark[][] = [];
    let lastFrame: Landmark[] | null = null;

    pose.onResults((r: any) => {
      if (!r.poseLandmarks) return;

      const lms: Landmark[] = r.poseLandmarks.map((lm: any) => ({
        x: Math.round(lm.x * 10000) / 10000,
        y: Math.round(lm.y * 10000) / 10000,
        visibility: Math.round(lm.visibility * 1000) / 1000,
      }));

      // 화면 중앙에 가장 가까운 사람인지 확인 (평균 x가 0.5 기준 0.35 이상 벗어나면 스킵)
      const avgX = lms.reduce((s, lm) => s + lm.x, 0) / lms.length;
      if (Math.abs(avgX - 0.5) > 0.35) return;

      // 점프 감지: 주요 관절 평균 이동거리가 0.15 이상이면 이전 프레임 유지
      if (lastFrame) {
        const keyJoints = [11, 12, 23, 24];
        const avgDist = keyJoints.reduce((sum, i) => {
          const prev = lastFrame![i], curr = lms[i];
          if (!prev || !curr) return sum;
          return sum + Math.sqrt((curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2);
        }, 0) / keyJoints.length;

        if (avgDist >= 0.15) {
          frames.push(lastFrame);
          return;
        }
      }

      lastFrame = lms;
      frames.push(lms);
    });

    const video = document.createElement('video');
    video.src = URL.createObjectURL(videoFile);
    video.muted = true;
    await new Promise(r => { video.onloadedmetadata = r; });

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d')!;

    const interval = 0.1;
    let currentTime = 0;

    const processNext = async () => {
      if (currentTime >= video.duration) {
        await pose.close();
        URL.revokeObjectURL(video.src);
        resolve(frames);
        return;
      }
      video.currentTime = currentTime;
      await new Promise(r => { video.onseeked = r; });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      await pose.send({ image: canvas });
      currentTime += interval;
      setTimeout(processNext, 50);
    };
    processNext();
  });
}

// ─── UploadView ───────────────────────────────────────────────────────────────

const UploadView = ({ userProfile }: { userProfile: UserProfile | null }) => {
  const { t } = useTranslation();
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [difficulty, setDifficulty] = useState<'Easy'|'Medium'|'Hard'>('Medium');
  const [status, setStatus] = useState<'idle'|'analyzing'|'uploading'|'done'>('idle');
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('video/')) { alert('영상 파일만 올려주세요!'); return; }
    if (file.size > 100 * 1024 * 1024) { alert('100MB 이하 영상만 가능해요'); return; }
    setVideoFile(file);
    setVideoPreview(URL.createObjectURL(file));
  };

  const handleUpload = async () => {
    if (!videoFile || !title.trim() || !userProfile) return;

    try {
      // 1단계: 포즈 분석
      setStatus('analyzing');
      setAnalyzeProgress(10);
      const poseFrames = await extractPosesFromVideo(videoFile);
      setAnalyzeProgress(100);

      // 2단계: Cloudinary에 영상 업로드
      setStatus('uploading');
      const formData = new FormData();
      formData.append('file', videoFile);
      formData.append('upload_preset', 'ml_default');

      const res = await fetch(
        `https://api.cloudinary.com/v1_1/${import.meta.env.VITE_CLOUDINARY_CLOUD_NAME}/video/upload`,
        { method: 'POST', body: formData }
      );
      const data = await res.json();
      console.log('Cloudinary 응답:', data);
      if (!data.secure_url) throw new Error(data.error?.message ?? JSON.stringify(data));
      const videoUrl = data.secure_url;

      // 3단계: Firestore에 챌린지 등록
      await addDoc(collection(db, 'challenges'), {
        title: title.trim(),
        creatorName: userProfile.displayName,
        creatorId: userProfile.id,
        videoUrl,
        poseData: JSON.stringify(poseFrames),
        difficulty,
        likeCount: 0,
        participantCount: 0,
        timestamp: serverTimestamp(),
      });

      // 4단계: EXP 지급
      await setDoc(doc(db, 'users', userProfile.id), {
        exp: (userProfile.exp ?? 0) + 300,
      }, { merge: true });

      setStatus('done');
    } catch (err) {
      console.error(err);
      alert('업로드 중 오류가 났어요. 다시 시도해봐요!');
      setStatus('idle');
    }
  };


  if (status === 'done') {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[60vh] space-y-6">
        <motion.div initial={{scale:0}} animate={{scale:1}} className="text-green-500">
          <CheckCircle size={80} />
        </motion.div>
        <h2 className="text-2xl font-black">챌린지 등록 완료!</h2>
        <p className="text-gray-500 text-center">피드에 올라갔어요. 다른 사람들이 따라할 거예요 🔥</p>
        <button onClick={() => { setStatus('idle'); setVideoFile(null); setVideoPreview(null); setTitle(''); }}
          className="bg-orange-600 text-white px-8 py-4 rounded-2xl font-bold">
          또 올리기
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 pb-24 space-y-6">
      <h2 className="text-2xl font-black uppercase italic">챌린지 만들기</h2>

      {/* 영상 선택 */}
      <div
        onClick={() => fileInputRef.current?.click()}
        className="relative aspect-video bg-gray-100 rounded-3xl overflow-hidden flex items-center justify-center cursor-pointer border-2 border-dashed border-gray-300 hover:border-orange-400 transition-colors"
      >
        {videoPreview ? (
          <video src={videoPreview} className="w-full h-full object-cover" muted playsInline controls />
        ) : (
          <div className="text-center space-y-3">
            <Upload className="mx-auto text-gray-400" size={40} />
            <p className="font-bold text-gray-500">영상 파일 선택</p>
            <p className="text-xs text-gray-400">mp4, mov 등 100MB 이하</p>
          </div>
        )}
        <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleFileChange} />
      </div>

      {/* 제목 */}
      <div className="space-y-2">
        <label className="text-sm font-bold text-gray-600">챌린지 제목</label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="예: 준민이 스쿼트 챌린지 💪"
          className="w-full border border-gray-200 rounded-2xl px-4 py-3 font-medium focus:outline-none focus:border-orange-400"
          maxLength={30}
        />
      </div>

      {/* 난이도 */}
      <div className="space-y-2">
        <label className="text-sm font-bold text-gray-600">난이도</label>
        <div className="flex gap-3">
          {(['Easy','Medium','Hard'] as const).map(d => (
            <button key={d}
              onClick={() => setDifficulty(d)}
              className={`flex-1 py-3 rounded-2xl font-bold text-sm transition-colors ${
                difficulty===d ? 'bg-orange-600 text-white' : 'bg-gray-100 text-gray-500'
              }`}>
              {d==='Easy'?'쉬움':d==='Medium'?'보통':'어려움'}
            </button>
          ))}
        </div>
      </div>

      {/* 업로드 진행 상태 */}
      {status !== 'idle' && (
        <div className="bg-orange-50 rounded-3xl p-5 space-y-3">
          {status === 'analyzing' && (
            <>
              <div className="flex items-center gap-3">
                <Loader2 className="animate-spin text-orange-600" size={20} />
                <p className="font-bold text-orange-800">AI가 포즈 분석 중... {analyzeProgress}%</p>
              </div>
              <div className="h-2 bg-orange-200 rounded-full"><div className="h-full bg-orange-600 rounded-full transition-all" style={{width:`${analyzeProgress}%`}}/></div>
              <p className="text-xs text-orange-600">영상 길이에 따라 1~3분 걸려요</p>
            </>
          )}
          {status === 'uploading' && (
            <div className="flex items-center gap-3">
              <Loader2 className="animate-spin text-orange-600" size={20} />
              <p className="font-bold text-orange-800">업로드 중...</p>
            </div>
          )}
        </div>
      )}

      {/* 업로드 버튼 */}
      <motion.button
        whileTap={{ scale: 0.97 }}
        onClick={handleUpload}
        disabled={!videoFile || !title.trim() || status !== 'idle'}
        className="w-full bg-gray-900 text-white py-5 rounded-2xl font-black text-lg disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-3"
      >
        <Plus size={24} />
        챌린지 올리기
      </motion.button>
    </div>
  );
};

// ─── FeedView (모든 챌린지 피드) ─────────────────────────────────────────────

const FeedView = ({ onSelectChallenge }: { onSelectChallenge: (c: Challenge) => void }) => {
  const { i18n } = useTranslation();
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, 'challenges'), orderBy('timestamp', 'desc'), limit(20));
    return onSnapshot(q, snap => {
      setChallenges(snap.docs.map(d => {
        const data = d.data();
        if (typeof data.poseData === 'string') data.poseData = JSON.parse(data.poseData);
        return { id: d.id, ...data } as Challenge;
      }));
      setLoading(false);
    });
  }, []);

  const handleLike = async (e: React.MouseEvent, challengeId: string) => {
    e.stopPropagation();
    await updateDoc(doc(db, 'challenges', challengeId), { likeCount: increment(1) });
  };

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="animate-spin text-orange-600" size={40}/></div>;

  if (challenges.length === 0) return (
    <div className="p-6 flex flex-col items-center justify-center min-h-[60vh] text-center space-y-4">
      <p className="text-6xl">🎬</p>
      <p className="font-bold text-xl">아직 챌린지가 없어요</p>
      <p className="text-gray-500">첫 번째 챌린지를 올려보세요!</p>
    </div>
  );

  return (
    <div className="p-4 pb-24 space-y-4">
      <h2 className="text-2xl font-black uppercase italic px-2">피드</h2>
      {challenges.map(challenge => (
        <motion.div
          key={challenge.id}
          whileTap={{ scale: 0.98 }}
          onClick={() => onSelectChallenge(challenge)}
          className="bg-white border border-gray-100 rounded-3xl overflow-hidden shadow-sm cursor-pointer"
        >
          {/* 영상 썸네일 */}
          <div className="relative aspect-video bg-gray-100">
            <video
              src={challenge.videoUrl}
              className="w-full h-full object-cover"
              muted playsInline
              onMouseEnter={e => (e.currentTarget as HTMLVideoElement).play()}
              onMouseLeave={e => { (e.currentTarget as HTMLVideoElement).pause(); (e.currentTarget as HTMLVideoElement).currentTime = 0; }}
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="bg-black/40 rounded-full p-3">
                <Play fill="white" className="text-white" size={28} />
              </div>
            </div>
            <span className="absolute top-3 left-3 bg-orange-600 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase">
              {challenge.difficulty}
            </span>
          </div>

          {/* 정보 */}
          <div className="p-4 space-y-2">
            <h3 className="font-bold text-lg leading-tight">{challenge.title}</h3>
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">by {challenge.creatorName}</p>
              <div className="flex items-center gap-4">
                <button
                  onClick={e => handleLike(e, challenge.id)}
                  className="flex items-center gap-1 text-sm text-gray-500 hover:text-red-500 transition-colors"
                >
                  <Heart size={16} />
                  <span>{challenge.likeCount}</span>
                </button>
                <span className="text-sm text-gray-400">{challenge.participantCount}명 참여</span>
              </div>
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
};

// ─── CameraView (챌린지 따라하기) ────────────────────────────────────────────

const CameraView = ({ challenge, onComplete, onClose }: {
  challenge: Challenge;
  onComplete: (score: number, accuracy: number) => void;
  onClose: () => void;
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const challengeVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isAIReady, setIsAIReady] = useState(false);
  const [isStarted, setIsStarted] = useState(false);
  const [currentScore, setCurrentScore] = useState(0);
  const [progress, setProgress] = useState(0);
  const [countdown, setCountdown] = useState<number|null>(null);
  const isStartedRef = useRef(false);
  const totalRef = useRef(0);
  const frameRef = useRef(0);
  const rafRef = useRef(0);
  const poseRef = useRef<any>(null);

  useEffect(() => {
    let mounted = true;
    let stream: MediaStream;

    console.log('poseData 길이:', challenge.poseData?.length);
    console.log('poseData 첫 프레임:', challenge.poseData?.[0]);

    const init = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        if (videoRef.current && mounted) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      } catch { alert('카메라 권한이 필요해요'); return; }

      const pose = await getCameraPose();
      if (!mounted) return;

      pose.onResults((results: any) => {
        if (!canvasRef.current || !mounted) return;
        const ctx = canvasRef.current.getContext('2d')!;
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

        if (results.poseLandmarks) {
          drawStickman(ctx, results.poseLandmarks, '#EF4444', 4, false);
          if (isStartedRef.current && challenge.poseData?.length && challengeVideoRef.current) {
            const fps = challenge.poseData.length / (challengeVideoRef.current.duration || 1);
            const idx = Math.min(Math.floor(challengeVideoRef.current.currentTime * fps), challenge.poseData.length - 1);
            const score = calculateScore(results.poseLandmarks, challenge.poseData[idx]);
            setCurrentScore(score);
            totalRef.current += score;
            frameRef.current += 1;
          }
        }
      });

      poseRef.current = pose;
      setIsAIReady(true);

      const loop = async () => {
        if (!mounted) return;

        // 빨간 스틱맨: 카메라 분석 (onResults 안에서 clearRect + 빨간 그리기)
        if (videoRef.current?.readyState >= 2) {
          try { await pose.send({ image: videoRef.current }); } catch {}
        }

        // 초록 스틱맨: pose.send 이후에 그려야 clearRect에 안 지워짐
        if (challenge.poseData?.length && challengeVideoRef.current && canvasRef.current) {
          const fps = challenge.poseData.length / (challengeVideoRef.current.duration || 1);
          const idx = Math.min(
            Math.floor(challengeVideoRef.current.currentTime * fps),
            challenge.poseData.length - 1
          );
          const ctx = canvasRef.current.getContext('2d');
          if (ctx && challenge.poseData[idx]?.length) {
            drawGhostStickman(ctx, challenge.poseData[idx]);
          }
        }

        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    };

    init();
    return () => {
      mounted = false;
      cancelAnimationFrame(rafRef.current);
      stream?.getTracks().forEach(t => t.stop());
      // pose는 캐시 재사용을 위해 close 하지 않음
    };
  }, []);

  const drawStickman = (ctx: CanvasRenderingContext2D, lms: Landmark[], color: string, lw: number, ghost: boolean) => {
    if (!lms?.length || !canvasRef.current) return;
    const { width: w, height: h } = canvasRef.current;
    ctx.save();

    if (ghost) {
      const scale = 0.28;
      const offsetX = 10;
      const offsetY = h * 0.72;

      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
      POSE_CONNECTIONS.forEach(([i, j]) => {
        const p1 = lms[i], p2 = lms[j];
        if (p1 && p2 && (p1.visibility ?? 1) > 0.4 && (p2.visibility ?? 1) > 0.4) {
          ctx.beginPath();
          ctx.moveTo(offsetX + p1.x * w * scale, offsetY + p1.y * h * scale);
          ctx.lineTo(offsetX + p2.x * w * scale, offsetY + p2.y * h * scale);
          ctx.stroke();
        }
      });
      ctx.fillStyle = color;
      KEY_JOINTS.forEach(i => {
        const lm = lms[i];
        if (lm && (lm.visibility ?? 1) > 0.4) {
          ctx.beginPath();
          ctx.arc(offsetX + lm.x * w * scale, offsetY + lm.y * h * scale, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    } else {
      // 유저 포즈: 전신 + 얼굴
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
      [...POSE_CONNECTIONS, ...FACE_CONNECTIONS].forEach(([i, j]) => {
        const p1 = lms[i], p2 = lms[j];
        if (p1 && p2 && (p1.visibility ?? 1) > 0.4 && (p2.visibility ?? 1) > 0.4) {
          ctx.beginPath();
          ctx.moveTo(p1.x * w, p1.y * h);
          ctx.lineTo(p2.x * w, p2.y * h);
          ctx.stroke();
        }
      });
      ctx.fillStyle = '#FFF';
      KEY_JOINTS.forEach(i => {
        const lm = lms[i];
        if (lm && (lm.visibility ?? 1) > 0.4) {
          ctx.beginPath();
          ctx.arc(lm.x * w, lm.y * h, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }

    ctx.restore();
  };

  const drawGhostStickman = (ctx: CanvasRenderingContext2D, lms: Landmark[]) => {
    if (!lms?.length || !canvasRef.current) return;
    const { width: w, height: h } = canvasRef.current;
    const scale = 0.28;
    const offsetX = 10;
    const offsetY = h * 0.72;
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = '#22C55E'; ctx.lineWidth = 8; ctx.lineCap = 'round';
    POSE_CONNECTIONS.forEach(([i, j]) => {
      const p1 = lms[i], p2 = lms[j];
      if (p1 && p2 && (p1.visibility ?? 1) > 0.4 && (p2.visibility ?? 1) > 0.4) {
        ctx.beginPath();
        ctx.moveTo(offsetX + p1.x * w * scale, offsetY + p1.y * h * scale);
        ctx.lineTo(offsetX + p2.x * w * scale, offsetY + p2.y * h * scale);
        ctx.stroke();
      }
    });
    ctx.fillStyle = '#22C55E';
    KEY_JOINTS.forEach(i => {
      const lm = lms[i];
      if (lm && (lm.visibility ?? 1) > 0.4) {
        ctx.beginPath();
        ctx.arc(offsetX + lm.x * w * scale, offsetY + lm.y * h * scale, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    ctx.restore();
  };

  const handleStart = () => {
    setCountdown(3);
    const t = setInterval(() => setCountdown(prev => {
      if (prev===1) { clearInterval(t); isStartedRef.current=true; setIsStarted(true); challengeVideoRef.current?.play(); return null; }
      return (prev??1)-1;
    }), 1000);
  };

  const handleTimeUpdate = () => {
    const v = challengeVideoRef.current;
    if (!v) return;
    const p = (v.currentTime/v.duration)*100;
    setProgress(p);
    if (p>=98) {
      const accuracy = frameRef.current>0 ? Math.round(totalRef.current/frameRef.current) : 0;
      updateDoc(doc(db,'challenges',challenge.id), { participantCount: increment(1) });
      onComplete(totalRef.current, accuracy);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black flex flex-col">
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover scale-x-[-1]" playsInline muted />
        <div className="absolute top-24 right-4 w-36 aspect-[9/16] rounded-2xl overflow-hidden border-2 border-white/40 z-20 bg-black">
          <video ref={challengeVideoRef} src={challenge.videoUrl} className="w-full h-full object-cover" playsInline muted onTimeUpdate={handleTimeUpdate} />
        </div>
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full scale-x-[-1] z-10" width={720} height={1280} />

        {!isAIReady && (
          <div className="absolute inset-0 z-50 bg-black/80 flex flex-col items-center justify-center gap-4">
            <Loader2 className="animate-spin text-orange-500" size={48} />
            <p className="text-white font-bold">AI 코치 준비 중...</p>
          </div>
        )}
        {!isStarted && isAIReady && countdown===null && (
          <div className="absolute inset-0 z-50 bg-black/60 flex items-center justify-center">
            <motion.button whileTap={{scale:0.95}} onClick={handleStart}
              className="bg-orange-600 text-white px-10 py-5 rounded-full font-black text-2xl uppercase italic flex items-center gap-3">
              <Play fill="white" size={28} /> 시작!
            </motion.button>
          </div>
        )}
        <AnimatePresence>
          {countdown!==null && (
            <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/50">
              <motion.div key={countdown} initial={{scale:2,opacity:0}} animate={{scale:1,opacity:1}} exit={{scale:0.5,opacity:0}}
                className="text-white font-black italic text-9xl">{countdown}</motion.div>
            </div>
          )}
        </AnimatePresence>
        <div className="absolute top-8 left-4 right-4 flex justify-between items-start z-30">
          <button onClick={onClose} className="bg-white/20 backdrop-blur-md p-2 rounded-full text-white"><X size={24}/></button>
          <div className="bg-red-600 px-5 py-2 rounded-2xl text-white font-black italic text-2xl">{currentScore}%</div>
        </div>
        <div className="absolute bottom-10 left-4 right-4 z-30 space-y-2">
          <div className="h-2 bg-white/20 rounded-full overflow-hidden">
            <motion.div className="h-full bg-orange-500" animate={{width:`${progress}%`}}/>
          </div>
          <p className="text-white font-bold">{challenge.title}</p>
          <p className="text-white/60 text-sm">by {challenge.creatorName}</p>
        </div>
      </div>
    </div>
  );
};

// ─── ResultModal ──────────────────────────────────────────────────────────────

const ResultModal = ({ score, accuracy, feedback, onClose }: { score:number; accuracy:number; feedback:string; onClose:()=>void }) => (
  <motion.div initial={{opacity:0}} animate={{opacity:1}}
    className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center p-6">
    <motion.div initial={{scale:0.9,y:20}} animate={{scale:1,y:0}}
      className="bg-white rounded-[40px] w-full max-w-sm p-8 text-center space-y-6">
      <div><Award className="mx-auto text-orange-600 mb-2" size={56}/></div>
      <h2 className="text-3xl font-black italic uppercase">참 잘했어요!</h2>
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gray-50 p-4 rounded-3xl">
          <p className="text-[10px] font-bold text-gray-400 uppercase">점수</p>
          <p className="text-2xl font-black italic">{score.toLocaleString()}</p>
        </div>
        <div className="bg-gray-50 p-4 rounded-3xl">
          <p className="text-[10px] font-bold text-gray-400 uppercase">정확도</p>
          <p className="text-2xl font-black italic">{accuracy}%</p>
        </div>
      </div>
      <div className="bg-orange-50 p-5 rounded-3xl text-left relative">
        <Sparkles className="absolute top-2 right-2 text-orange-200" size={20}/>
        <p className="text-orange-800 text-sm leading-relaxed">{feedback||'...'}</p>
      </div>
      <button onClick={onClose} className="w-full bg-gray-900 text-white py-5 rounded-2xl font-bold">다시 도전</button>
    </motion.div>
  </motion.div>
);

// ─── LeaderboardView ──────────────────────────────────────────────────────────

const LeaderboardView = () => {
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const q = query(collection(db,'submissions'), orderBy('score','desc'), limit(10));
    return onSnapshot(q, snap => { setSubmissions(snap.docs.map(d=>({id:d.id,...d.data()}))); setLoading(false); });
  }, []);
  return (
    <div className="p-6 pb-24 space-y-6">
      <h2 className="text-2xl font-black uppercase italic">리더보드</h2>
      {loading ? <div className="flex justify-center py-12"><Loader2 className="animate-spin text-orange-600"/></div> : (
        <div className="space-y-3">
          {submissions.map((s,i) => (
            <div key={s.id} className="flex items-center gap-4 bg-gray-50 p-4 rounded-3xl">
              <div className={`w-10 h-10 rounded-2xl flex items-center justify-center font-black italic ${i===0?'bg-orange-600 text-white':'bg-white text-gray-400'}`}>{i+1}</div>
              <div className="flex-1">
                <p className="font-bold">{s.displayName||'익명'}</p>
                <p className="text-xs text-gray-400 uppercase tracking-widest">{s.accuracy}% 정확도 · {s.challengeTitle}</p>
              </div>
              <p className="font-black italic text-orange-600">{s.score.toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── ProfileView ──────────────────────────────────────────────────────────────

const ProfileView = ({ userProfile }: { userProfile: UserProfile }) => {
  const expNeeded = (userProfile.level+1)*1000;
  return (
    <div className="p-6 pb-24 space-y-6">
      <h2 className="text-2xl font-black uppercase italic">내 정보</h2>
      <div className="bg-white rounded-[32px] p-8 shadow-sm border border-gray-100 space-y-6">
        <div className="flex items-center gap-5">
          <div className="w-20 h-20 rounded-full bg-orange-100 flex items-center justify-center text-orange-600">
            <User size={40}/>
          </div>
          <div>
            <h3 className="text-xl font-bold">{userProfile.displayName}</h3>
            <div className="flex items-center gap-2 text-orange-600 font-bold text-sm mt-1">
              <Award size={14}/><span>LV. {userProfile.level}</span>
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex justify-between text-xs font-bold uppercase tracking-wider text-gray-400">
            <span>경험치</span><span>{userProfile.exp} / {expNeeded}</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <motion.div initial={{width:0}} animate={{width:`${(userProfile.exp/expNeeded)*100}%`}} className="h-full bg-orange-600"/>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Navbar ───────────────────────────────────────────────────────────────────

const Navbar = ({ activeTab, setActiveTab }: { activeTab:string; setActiveTab:(t:string)=>void }) => {
  const tabs = [
    { id:'feed', icon:Play, label:'피드' },
    { id:'upload', icon:Plus, label:'올리기' },
    { id:'leaderboard', icon:Trophy, label:'랭킹' },
    { id:'profile', icon:User, label:'내 정보' },
  ];
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-lg border-t border-gray-100 px-4 py-3 flex justify-around items-center z-50">
      {tabs.map(tab => (
        <button key={tab.id} onClick={() => setActiveTab(tab.id)}
          className={`flex flex-col items-center gap-1 transition-colors ${activeTab===tab.id?'text-orange-600':'text-gray-400'}`}>
          <tab.icon size={tab.id==='upload'?28:22} />
          <span className="text-[10px] font-medium">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
};

// ─── App Root ─────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState('feed');
  const [selectedChallenge, setSelectedChallenge] = useState<Challenge|null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile|null>(null);
  const [lastResult, setLastResult] = useState<{score:number;accuracy:number;feedback:string}|null>(null);
  const { i18n } = useTranslation();

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setUserProfile({ id: 'guest', displayName: '게스트', level: 1, exp: 0, badges: [] });
        return;
      }
      const ref = doc(db, 'users', user.uid);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        setUserProfile({ id: user.uid, ...snap.data() } as UserProfile);
      } else {
        const p = { displayName: user.displayName ?? 'User', level: 1, exp: 0, badges: [] };
        await setDoc(ref, p);
        setUserProfile({ id: user.uid, ...p });
      }
    });
  }, []);

  const handleComplete = async (score: number, accuracy: number) => {
    const feedback = await getAIFeedback(score, accuracy, i18n.language);
    setLastResult({ score, accuracy, feedback });
    if (userProfile && selectedChallenge) {
      await addDoc(collection(db,'submissions'), {
        userId: userProfile.id,
        displayName: userProfile.displayName,
        challengeId: selectedChallenge.id,
        challengeTitle: selectedChallenge.title,
        score, accuracy,
        timestamp: serverTimestamp(),
      });
      const newExp = userProfile.exp + 500;
      await setDoc(doc(db,'users',userProfile.id), { exp:newExp, level:Math.floor(newExp/1000)+1 }, { merge:true });
    }
    setSelectedChallenge(null);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans">
      <button onClick={() => i18n.changeLanguage(i18n.language==='ko'?'en':'ko')}
        className="fixed top-6 right-6 z-50 bg-white/80 backdrop-blur-md border border-gray-200 p-3 rounded-full shadow-lg">
        <Globe size={20} className="text-gray-600"/>
      </button>

      <main className="max-w-md mx-auto min-h-screen">
        <AnimatePresence mode="wait">
          <motion.div key={activeTab} initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-10}} transition={{duration:0.2}}>
            {activeTab==='feed' && <FeedView onSelectChallenge={c => { setSelectedChallenge(c); }} />}
            {activeTab==='upload' && <UploadView userProfile={userProfile} />}
            {activeTab==='leaderboard' && <LeaderboardView />}
            {activeTab==='profile' && <ProfileView userProfile={userProfile} />}
          </motion.div>
        </AnimatePresence>

        <AnimatePresence>
          {selectedChallenge && <CameraView challenge={selectedChallenge} onClose={() => setSelectedChallenge(null)} onComplete={handleComplete} />}
        </AnimatePresence>
        <AnimatePresence>
          {lastResult && <ResultModal {...lastResult} onClose={() => setLastResult(null)} />}
        </AnimatePresence>

        <Navbar activeTab={activeTab} setActiveTab={setActiveTab} />
      </main>
    </div>
  );
}
