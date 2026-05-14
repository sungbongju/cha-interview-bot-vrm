import { useState, useRef, useCallback, useEffect } from 'react'
import AvatarPanel from './components/AvatarPanel'
import ChatPanel from './components/ChatPanel'
import AuthModal from './components/AuthModal'
import SurveyModal from './components/SurveyModal'
import styles from './App.module.css'
import { getUser, clearAuth, verifyToken, newSessionId, saveChat } from './lib/api'
import { MicRecorder, isMicRecorderSupported } from './lib/stt'

// 아바타: VRoid VRM (이경영) — 브라우저에서 three-vrm 으로 직접 렌더 + 립싱크.
// 기존 LiveAvatar(HeyGen 후속, LiveKit 기반 SaaS) 를 대체. TTS 는 middleton
// OmniVoice 서버(/api/tts)를 쓴다 — 렌더링·TTS 모두 자체 인프라라 제로 코스트.

// 봇 발화 종료 후 마이크 재개까지의 지연 (스피커 잔향이 마이크로 다시 잡히는 echo 회피)
const ECHO_RESUME_DELAY_MS = 700

function normalizeTranscript(text) {
  return (text || '').replace(/\s+/g, ' ').trim()
}

function getUserDisplayName(user) {
  return user?.name || user?.nickname || '사용자'
}

function getVisitCount(user) {
  const rawCount = user?.visit_count ?? user?.visitCount ?? user?.login_count ?? user?.loginCount ?? user?.visits
  const count = Number(rawCount)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1
}

function getKoreanVisitOrdinal(count) {
  const ones = ['', '첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉']
  const compoundOnes = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉']
  const exactTens = {
    10: '열',
    20: '스무',
    30: '서른',
    40: '마흔',
    50: '쉰',
    60: '예순',
    70: '일흔',
    80: '여든',
    90: '아흔',
  }
  const compoundTens = { ...exactTens, 20: '스물' }

  if (count > 0 && count < 10) return `${ones[count]}번째`
  if (count >= 10 && count < 100) {
    const ten = Math.floor(count / 10) * 10
    const one = count % 10
    return one === 0 ? `${exactTens[ten]}번째` : `${compoundTens[ten]}${compoundOnes[one]}번째`
  }
  return `${count}번째`
}

function getVisitGreeting(user) {
  if (!user) return ''
  return `${getUserDisplayName(user)}님 ${getKoreanVisitOrdinal(getVisitCount(user))} 방문을 환영합니다. `
}

function getGreetingText(user) {
  return (
    '안녕하세요. ' +
    getVisitGreeting(user) +
    '저는 차의과학대학교 신입생 전공상담을 돕는 AI 면담 어시스턴트예요. ' +
    '전공 선택이나 진로에 대해 궁금한 점을 편하게 물어봐 주세요.'
  )
}

function getGreetingTts(user) {
  return (
    '안녕하세요. ' +
    getVisitGreeting(user) +
    '저는 차 의과학 대학교 신입생 전공 상담을 돕는 에이아이 면담 어시스턴트예요. ' +
    '전공 선택이나 진로에 대해 궁금한 점을 편하게 물어봐 주세요.'
  )
}

function normalizeTtsText(text) {
  if (!text) return ''

  return String(text)
    .replace(/😊|😀|😃|😄|😁|🙂|😉|👍|🙏|✨|💡|📌|🎓|📷|🎙|🎤|▶|■|◉/g, '')
    .replace(/차의과학대학교/g, '차 의과학 대학교')
    .replace(/AI의료데이터학/g, '에이아이 의료 데이터학')
    .replace(/AI의료데이터/g, '에이아이 의료 데이터')
    .replace(/SW융합/g, '소프트웨어 융합')
    .replace(/\bAI\b/gi, '에이아이')
    .replace(/\bGPT\b/gi, '지피티')
    .replace(/\bGemma\b/gi, '젬마')
    .replace(/\bHeyGen\b/gi, '헤이젠')
    .replace(/\bSyncTalk\b/gi, '싱크톡')
    .replace(/\bLiveKit\b/gi, '라이브킷')
    .replace(/\bChrome\b/gi, '크롬')
    .replace(/\bVercel\b/gi, '버셀')
    .replace(/\bRAG\b/gi, '랙')
    .replace(/\bAPI\b/gi, '에이피아이')
    .replace(/\bURL\b/gi, '유알엘')
    .replace(/\bSTT\b/gi, '에스티티')
    .replace(/\bTTS\b/gi, '티티에스')
    .replace(/\bFTF\b/gi, '에프티에프')
    .replace(/\bSTS\b/gi, '에스티에스')
    .replace(/\bTTT\b/gi, '티티티')
    .replace(/CHA/g, '차')
    .replace(/IT/g, '아이티')
    .replace(/OK/g, '오케이')
    .replace(/\s+/g, ' ')
    .trim()
}

export default function App() {
  const [status, setStatus]             = useState('idle')   // idle | connecting | connected | speaking
  const [messages, setMessages]         = useState([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [videoReady, setVideoReady]     = useState(false)    // VRM 로드 완료 여부
  const [isListening, setIsListening]   = useState(false)
  const [autoListen, setAutoListen]     = useState(false)
  const [user, setUser]                 = useState(getUser())     // 로그인된 사용자 (없으면 null = 익명)
  const [conversationMode, setConversationMode] = useState('ftf')  // ftf | sts | ttt
  const [theme, setTheme]               = useState(() => {
    if (typeof window === 'undefined') return 'light'
    return localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme(prev => (prev === 'light' ? 'dark' : 'light'))
  }, [])
  const [cameraStream, setCameraStream] = useState(null)
  // 첫 접속 시 자동으로 로그인 모달 — 저장된 토큰(=user)이 있으면 안 띄움
  const [authOpen, setAuthOpen]         = useState(() => !getUser())
  const [surveyOpen, setSurveyOpen]     = useState(false)
  const [surveySessionId, setSurveySessionId] = useState(null)
  const [surveyModesUsed, setSurveyModesUsed] = useState([])
  const modesUsedRef = useRef(new Set())   // 세션 동안 실제 사용된 모드 누적
  const userTurnCountRef = useRef(0)       // 사용자 발화 턴 수 (3턴 이상일 때만 설문 노출)
  const lastEndedSessionIdRef = useRef(null) // 종료 직후 헤더 "설문" 버튼이 마지막 세션을 참조하도록 보존
  const lastEndedModesRef = useRef([])

  const vrmAvatarRef      = useRef(null)   // <VRMAvatar> imperative handle (speak/stopSpeaking/...)
  const sessionRef        = useRef(null)   // 아바타 세션 활성 플래그 (ftf/sts true, idle/ttt null)
  const userVideoRef      = useRef(null)
  const cameraStreamRef   = useRef(null)
  const historyRef        = useRef([])
  const sessionIdRef      = useRef(null)   // 학교 DB용 세션 ID (아바타 시작 시 새로)
  const conversationModeRef = useRef('ftf')

  // 토큰 검증 — 성공하면 모달 닫음 / 실패하면 모달 유지 (이미 열려있음)
  useEffect(() => {
    verifyToken().then(u => {
      if (u) {
        setUser(u)
        setAuthOpen(false)
      }
    })
  }, [])

  const handleLogout = () => {
    clearAuth()
    setUser(null)
  }

  const handleAvatarReady = useCallback(() => {
    setVideoReady(true)
  }, [])

  // ─── STT (middleton whisper 기반 MicRecorder) ────────────────────────
  // 기존 Web Speech API(webkitSpeechRecognition)는 iOS Safari / 카카오 in-app
  // 브라우저에서 불안정 → MediaRecorder + RMS VAD로 발화 구간을 잡아 우리 whisper
  // 서버로 보내는 방식으로 교체. echo guard는 status 기반 pause/resume로 단순화.
  const micRecorderRef    = useRef(null)
  const isSpeakingRef     = useRef(false)
  const isProcessingRef   = useRef(false)
  const autoListenRef     = useRef(false)
  const isListeningRef    = useRef(false)
  const echoResumeTimerRef = useRef(null)
  const lastSubmittedSpeechRef = useRef({ key: '', at: 0 })

  useEffect(() => { isProcessingRef.current = isProcessing }, [isProcessing])
  useEffect(() => { autoListenRef.current   = autoListen }, [autoListen])
  useEffect(() => { isListeningRef.current  = isListening }, [isListening])
  useEffect(() => { isSpeakingRef.current   = (status === 'speaking') }, [status])
  useEffect(() => {
    conversationModeRef.current = conversationMode
    if (conversationMode) modesUsedRef.current.add(conversationMode)
  }, [conversationMode])

  useEffect(() => {
    if (userVideoRef.current) userVideoRef.current.srcObject = cameraStream || null
  }, [cameraStream])

  const stopUserCamera = useCallback(() => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach(track => track.stop())
      cameraStreamRef.current = null
    }
    setCameraStream(null)
  }, [])

  // 카메라 프레임 1장 캡처 → JPEG data URL (없으면 null)
  // 640x480 / quality 0.7 → 약 30KB. 매 사용자 발화 시점에 1장 캡처 후 백엔드 vision LLM에 첨부.
  const captureCameraFrame = useCallback(() => {
    const video = userVideoRef.current
    if (!video || !cameraStreamRef.current) return null
    if (!video.videoWidth || !video.videoHeight) return null
    try {
      const W = 640, H = 480
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      canvas.getContext('2d').drawImage(video, 0, 0, W, H)
      return canvas.toDataURL('image/jpeg', 0.7)
    } catch (e) {
      console.warn('[captureCameraFrame] failed:', e)
      return null
    }
  }, [])

  const startUserCamera = useCallback(async () => {
    if (cameraStreamRef.current) return true
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('이 브라우저는 카메라 연결을 지원하지 않아요.')
      return false
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false
      })
      cameraStreamRef.current = stream
      setCameraStream(stream)
      return true
    } catch {
      alert('카메라 권한이 필요해요. 브라우저 주소창 왼쪽의 자물쇠 아이콘에서 카메라를 허용해주세요.')
      return false
    }
  }, [])

  useEffect(() => () => stopUserCamera(), [stopUserCamera])

  // ─── TTS 발화 (LLM 답변 텍스트 → middleton OmniVoice → VRM 립싱크) ──────
  // 기존 LiveAvatar 의 sendAvatarCommand('avatar.speak_text') 를 대체한다.
  // fire-and-forget: status 를 내부에서 speaking↔connected 로 관리한다.
  const speakViaTTS = useCallback(async (text) => {
    const t = (text || '').trim()
    if (!t) return
    const avatar = vrmAvatarRef.current
    try {
      isSpeakingRef.current = true
      setStatus('speaking')
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: t }),
      })
      if (!res.ok) throw new Error('tts ' + res.status)
      const buf = await res.arrayBuffer()
      if (avatar && avatar.speak) {
        await avatar.speak(buf)   // 오디오 재생 + 립싱크, 끝나면(또는 인터럽트 시) resolve
      }
    } catch (e) {
      console.warn('[tts] speak 실패:', e)
    } finally {
      isSpeakingRef.current = false
      // 인터럽트로 이미 connected 로 바뀌었을 수 있으니 speaking 일 때만 되돌린다
      setStatus(s => (s === 'speaking' ? 'connected' : s))
    }
  }, [])

  // ─── 메시지 전송 ───────────────────────────────────
  const sendMessage = useCallback(async (userText) => {
    const text = userText.trim()
    if (!text || isProcessingRef.current) return
    // 봇 발화 중에 STT echo가 새 질문으로 들어오면 여기서 방어 (무한루프 차단 마지막 보루)
    if (isSpeakingRef.current) {
      console.warn('[echo guard] sendMessage suppressed during avatar speaking:', text.slice(0, 30))
      return
    }
    isProcessingRef.current = true
    setIsProcessing(true)

    setMessages(prev => [...prev, { role: 'user', text }])
    historyRef.current = [...historyRef.current, { role: 'user', content: text }]
    userTurnCountRef.current += 1

    // DB 저장 (사용자 메시지)
    if (sessionIdRef.current) saveChat(sessionIdRef.current, 'user', text)

    setMessages(prev => [...prev, { role: 'assistant', text: null }]) // typing

    try {
      const frame = captureCameraFrame()
      const images = frame ? [frame] : []
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: historyRef.current.slice(-8), images })
      })
      const data = await res.json()
      const reply    = data.reply    || '죄송해요, 답변을 생성하지 못했어요.'
      const ttsReply = normalizeTtsText(data.ttsReply || reply)

      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = { role: 'assistant', text: reply, contact: data.contact || null }
        return next
      })
      historyRef.current = [...historyRef.current, { role: 'assistant', content: reply }]

      // DB 저장 (어시스턴트 답변)
      if (sessionIdRef.current) saveChat(sessionIdRef.current, 'assistant', reply)

      // 아바타 발화 — TTS → VRM 립싱크 (ttt 모드 제외). fire-and-forget.
      if (conversationModeRef.current !== 'ttt') {
        speakViaTTS(ttsReply)
      }
    } catch {
      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = { role: 'assistant', text: '오류가 발생했어요. 다시 시도해 주세요.' }
        return next
      })
    } finally {
      isProcessingRef.current = false
      setIsProcessing(false)
    }
  }, [captureCameraFrame, speakViaTTS])

  // ─── STT 텍스트 제출 (whisper 결과 → sendMessage) ────────────────────
  const submitSpeechText = useCallback((rawText) => {
    const text = normalizeTranscript(rawText)
    if (!text || text.length < 2) return
    // 봇 발화 중 / LLM 처리 중에 들어온 결과는 echo 가능성 → 무시
    if (isSpeakingRef.current || isProcessingRef.current) {
      console.warn('[echo guard] transcript dropped (speaking/processing):', text.slice(0, 30))
      return
    }
    // 동일 발화 8초 내 중복 제출 방지 (whisper가 같은 구간 두 번 인식하는 경우)
    const key = text.replace(/\s+/g, '')
    const now = Date.now()
    const last = lastSubmittedSpeechRef.current
    if (key === last.key && now - last.at < 8000) return
    lastSubmittedSpeechRef.current = { key, at: now }
    sendMessage(text)
  }, [sendMessage])

  // ─── MicRecorder 생성 (lazy) ─────────────────────────
  const ensureMicRecorder = useCallback(() => {
    if (micRecorderRef.current) return micRecorderRef.current
    if (!isMicRecorderSupported()) {
      alert('이 브라우저는 음성 인식을 지원하지 않아요.\n텍스트 모드를 이용하시거나 최신 Chrome/Safari에서 시도해주세요.')
      return null
    }
    const rec = new MicRecorder({
      sttEndpoint: '/api/stt',
      onTranscript: (text) => submitSpeechText(text),
      onError: (err) => console.warn('[STT] MicRecorder error:', err),
      onStateChange: (st) => {
        const listening = st === 'listening' || st === 'recording'
        isListeningRef.current = listening
        setIsListening(listening)
      },
    })
    micRecorderRef.current = rec
    return rec
  }, [submitSpeechText])

  // ─── 마이크 시작 / 정지 ──────────────────────────────
  const startListening = useCallback(async () => {
    const rec = ensureMicRecorder()
    if (!rec) {
      autoListenRef.current = false
      setAutoListen(false)
      return
    }
    try {
      if (!rec.isRunning) {
        await rec.start()
      } else {
        rec.resume()
      }
    } catch (e) {
      console.warn('[STT] start failed:', e)
      const denied = e?.name === 'NotAllowedError' || /denied|permission|allowed/i.test(e?.message || '')
      if (denied) {
        alert('마이크 권한이 필요해요.\n브라우저 주소창 왼쪽의 자물쇠 아이콘을 클릭하여 마이크를 허용해주세요.')
      } else {
        alert('마이크를 시작하지 못했어요. 다른 앱이 마이크를 쓰고 있지 않은지 확인해주세요.')
      }
      autoListenRef.current = false
      setAutoListen(false)
    }
  }, [ensureMicRecorder])

  const stopListening = useCallback(() => {
    const rec = micRecorderRef.current
    if (rec) {
      try { rec.stop() } catch {}
      micRecorderRef.current = null
    }
    isListeningRef.current = false
    setIsListening(false)
  }, [])

  // ─── 아바타 발화 인터럽트 ────────────────────────
  const interruptAvatar = useCallback(() => {
    // 봇 발화만 멈춤. 마이크(MicRecorder)는 그대로 유지 — status가 'connected'로
    // 바뀌면 아래 echo guard useEffect가 알아서 resume 한다.
    try {
      vrmAvatarRef.current?.stopSpeaking?.()
    } catch (e) { console.error('interrupt error:', e) }
    isSpeakingRef.current = false
    setStatus('connected')
  }, [])

  // ─── echo guard: 봇 발화 중 마이크 pause / 발화 끝나면 resume ──────────
  // status === 'speaking' → MicRecorder.pause() (스트림 유지, VAD/녹음만 중단)
  // status === 'connected' → ECHO_RESUME_DELAY_MS 후 resume (autoListen 켜져있을 때만)
  useEffect(() => {
    const rec = micRecorderRef.current
    clearTimeout(echoResumeTimerRef.current)
    if (!rec || !rec.isRunning) return

    if (status === 'speaking') {
      rec.pause()
    } else if (status === 'connected' && autoListenRef.current) {
      echoResumeTimerRef.current = setTimeout(() => {
        const r = micRecorderRef.current
        if (r && r.isRunning && autoListenRef.current && !isSpeakingRef.current && !isProcessingRef.current) {
          r.resume()
        }
      }, ECHO_RESUME_DELAY_MS)
    }
    return () => clearTimeout(echoResumeTimerRef.current)
  }, [status])

  // ─── LLM 처리 끝나면 마이크 resume (autoListen 켜져있을 때) ───────────
  useEffect(() => {
    const rec = micRecorderRef.current
    if (!isProcessing && autoListen && rec && rec.isRunning && !isSpeakingRef.current) {
      // 봇이 발화 중이 아니면 바로 resume. 발화 중이면 위 status useEffect가 처리.
      rec.resume()
    }
  }, [isProcessing, autoListen])

  // ─── 마이크 토글 (사용자 액션) ─────────────────────
  const toggleMic = useCallback(() => {
    if (conversationModeRef.current === 'ttt') return
    if (!sessionRef.current) {
      alert('먼저 아바타를 시작해주세요.')
      return
    }
    if (autoListenRef.current || isListeningRef.current) {
      autoListenRef.current = false
      setAutoListen(false)
      stopListening()
    } else {
      autoListenRef.current = true
      setAutoListen(true)
      startListening()
    }
  }, [startListening, stopListening])

  // ─── ESC 키로 발화 인터럽트 (OAC SOFT-INTERRUPT 패턴 차용) ───
  useEffect(() => {
    const handleGlobalKeydown = (e) => {
      if (e.key !== 'Escape' && e.code !== 'Escape') return
      if (!sessionRef.current) return
      e.preventDefault()
      e.stopPropagation()
      const target = e.target
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) {
        target.blur()
      }
      interruptAvatar()
    }
    window.addEventListener('keydown', handleGlobalKeydown, true)
    document.addEventListener('keydown', handleGlobalKeydown, true)
    return () => {
      window.removeEventListener('keydown', handleGlobalKeydown, true)
      document.removeEventListener('keydown', handleGlobalKeydown, true)
    }
  }, [interruptAvatar])

  // ─── 아바타 종료 ───────────────────────────────────
  const stopAvatar = useCallback(async () => {
    // STT 중지
    clearTimeout(echoResumeTimerRef.current)
    lastSubmittedSpeechRef.current = { key: '', at: 0 }
    autoListenRef.current = false
    setAutoListen(false)
    stopListening()
    setIsListening(false)
    stopUserCamera()
    isSpeakingRef.current = false

    // 진행 중인 TTS 발화 중단
    try { vrmAvatarRef.current?.stopSpeaking?.() } catch {}

    // 설문 트리거 — 사용자 턴 3회 이상일 때만 노출
    const endedSessionId = sessionIdRef.current
    const usedTurns = userTurnCountRef.current
    const usedModes = Array.from(modesUsedRef.current)

    // 상태 리셋
    sessionRef.current     = null
    sessionIdRef.current   = null
    historyRef.current     = []
    setStatus('idle')
    setMessages([])           // 채팅 초기화 — 깔끔하게 다시 시작

    // 종료 직후 헤더 "설문" 버튼이 방금 끝난 세션을 참조할 수 있도록 보존
    if (endedSessionId) lastEndedSessionIdRef.current = endedSessionId
    lastEndedModesRef.current = usedModes

    if (usedTurns >= 3) {
      setSurveySessionId(endedSessionId)
      setSurveyModesUsed(usedModes)
      setSurveyOpen(true)
    }
    userTurnCountRef.current = 0
    modesUsedRef.current = new Set()
  }, [stopListening, stopUserCamera])

  const startTextMode = useCallback(() => {
    clearTimeout(echoResumeTimerRef.current)
    lastSubmittedSpeechRef.current = { key: '', at: 0 }
    autoListenRef.current = false
    setAutoListen(false)
    stopListening()
    setIsListening(false)
    stopUserCamera()
    isSpeakingRef.current = false

    sessionRef.current = null
    sessionIdRef.current = newSessionId()
    historyRef.current = []
    setStatus('connected')

    const greetingText = getGreetingText(user)
    setMessages([{ role: 'assistant', text: greetingText }])
    saveChat(sessionIdRef.current, 'assistant', greetingText)
  }, [stopListening, stopUserCamera, user])

  // ─── 아바타 시작 (VRM) ─────────────────────────────
  // VRM 은 AvatarPanel 에 항상 마운트돼 앱 로드 시점부터 자체 로딩된다.
  // 여기서는 카메라/세션/인사말만 처리하고, VRM 로드가 안 끝났으면 잠깐 기다린다.
  const startAvatar = useCallback(async () => {
    setStatus('connecting')
    sessionIdRef.current = newSessionId()
    lastSubmittedSpeechRef.current = { key: '', at: 0 }
    if (conversationModeRef.current === 'ftf') {
      await startUserCamera()
    } else {
      stopUserCamera()
    }

    // VRM 로드 대기 (보통 이미 로드 완료 — 최대 5초)
    for (let i = 0; i < 50 && !vrmAvatarRef.current?.isReady?.(); i++) {
      await new Promise(r => setTimeout(r, 100))
    }

    sessionRef.current = true   // 아바타 세션 활성
    historyRef.current = []
    setStatus('connected')

    // 인사말 — 채팅 표시 + TTS 발화
    const greetingText = getGreetingText(user)
    const greetingTts = normalizeTtsText(getGreetingTts(user))
    setMessages([{ role: 'assistant', text: greetingText }])
    saveChat(sessionIdRef.current, 'assistant', greetingText)
    speakViaTTS(greetingTts)   // fire-and-forget — status 를 speaking↔connected 로 관리

    // 마이크 자동 시작 (사용자 클릭(시작 버튼) 컨텍스트 안이라 권한 prompt 가능)
    // MicRecorder는 인사말 발화 중엔 echo guard로 pause → 발화 끝나면 자동 resume
    autoListenRef.current = true
    setAutoListen(true)
    startListening()
  }, [startListening, startUserCamera, stopUserCamera, user, speakViaTTS])

  const startConversation = useCallback(() => {
    if (conversationModeRef.current === 'ttt') {
      startTextMode()
      return
    }
    startAvatar()
  }, [startAvatar, startTextMode])

  const changeConversationMode = useCallback((nextMode) => {
    if (nextMode === conversationModeRef.current) return

    const hasAvatarSession = Boolean(sessionRef.current)
    const isTextOnlySession = status !== 'idle' && !hasAvatarSession

    if (isTextOnlySession && nextMode !== 'ttt') {
      alert('텍스트 상담에서 음성/화상으로 바꾸려면 대화를 종료한 뒤 다시 시작해주세요.')
      return
    }

    conversationModeRef.current = nextMode
    setConversationMode(nextMode)

    if (nextMode === 'ftf') {
      if (hasAvatarSession) startUserCamera()
    } else {
      stopUserCamera()
    }

    if (nextMode === 'ttt') {
      autoListenRef.current = false
      setAutoListen(false)
      stopListening()
      return
    }

    if (hasAvatarSession) {
      autoListenRef.current = true
      setAutoListen(true)
      startListening()
    }
  }, [startListening, startUserCamera, status, stopListening, stopUserCamera])

  // 언마운트 시 마이크 정리
  useEffect(() => () => {
    clearTimeout(echoResumeTimerRef.current)
    if (micRecorderRef.current) {
      try { micRecorderRef.current.stop() } catch {}
      micRecorderRef.current = null
    }
  }, [])

  const isChatConnected = status !== 'idle' && status !== 'connecting'

  return (
    <div className={styles.app}>
      <AvatarPanel
        status={status}
        mode={conversationMode}
        onModeChange={changeConversationMode}
        vrmAvatarRef={vrmAvatarRef}
        onAvatarReady={handleAvatarReady}
        userVideoRef={userVideoRef}
        videoReady={videoReady}
        cameraActive={Boolean(cameraStream)}
        onStart={startConversation}
        onStop={stopAvatar}
        onInterrupt={interruptAvatar}
        isListening={isListening}
      />
      <ChatPanel
        messages={messages}
        isProcessing={isProcessing}
        onSend={sendMessage}
        connected={isChatConnected}
        isListening={isListening}
        onToggleMic={toggleMic}
        micEnabled={conversationMode !== 'ttt' && isChatConnected}
        micAvailable={conversationMode !== 'ttt'}
        mode={conversationMode}
        user={user}
        onLoginClick={() => setAuthOpen(true)}
        onLogout={handleLogout}
        onOpenSurvey={() => {
          const liveSid = sessionIdRef.current
          const sid = liveSid || lastEndedSessionIdRef.current || null
          const liveModes = Array.from(modesUsedRef.current)
          const modes = liveModes.length ? liveModes : lastEndedModesRef.current
          setSurveySessionId(sid)
          setSurveyModesUsed(modes)
          setSurveyOpen(true)
        }}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onSuccess={(u) => setUser(u)}
      />
      <SurveyModal
        open={surveyOpen}
        onClose={() => setSurveyOpen(false)}
        sessionId={surveySessionId}
        modesUsed={surveyModesUsed}
        visitCount={user?.visit_count ?? 1}
      />
    </div>
  )
}
