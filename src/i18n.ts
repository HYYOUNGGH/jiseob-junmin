import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

const resources = {
  en: {
    translation: {
      "app_name": "Jiseob & Junmin",
      "welcome": "Ready for the Challenge?",
      "start_challenge": "Start Challenge",
      "leaderboard": "Leaderboard",
      "profile": "Profile",
      "score": "Score",
      "accuracy": "Accuracy",
      "level": "Level",
      "exp": "EXP",
      "loading_ai": "Initializing AI Coach...",
      "camera_permission": "Camera permission is required",
      "congrats": "Great Job!",
      "try_again": "Try Again"
    }
  },
  ko: {
    translation: {
      "app_name": "지섭이와 준민이",
      "welcome": "챌린지에 도전하시겠어요?",
      "start_challenge": "챌린지 시작",
      "leaderboard": "리더보드",
      "profile": "내 정보",
      "score": "점수",
      "accuracy": "정확도",
      "level": "레벨",
      "exp": "경험치",
      "loading_ai": "AI 코치 준비 중...",
      "camera_permission": "카메라 권한이 필요합니다",
      "congrats": "참 잘했어요!",
      "try_again": "다시 시도"
    }
  }
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false
    }
  });

export default i18n;
