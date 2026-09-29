import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeVoice } from "../lib/api";

const MAX_SECONDS = 60;
const AUTO_STOP_WARN_SECONDS = 55;

// BCP-47 codes for the Web Speech API, this is the same on-device/cloud
// speech engine Android Chrome (and WhatsApp's OS-level dictation) uses,
// so it's both faster (no server round trip, streams interim results live)
// and generally more accurate than our own faster-whisper backend path for
// these languages. Kept as the primary path; MediaRecorder+backend is the
// fallback for browsers without SpeechRecognition (desktop Firefox/Safari).
const SPEECH_LANG_MAP: Record<string, string> = {
  hi: "hi-IN", ta: "ta-IN", te: "te-IN", bn: "bn-IN", mr: "mr-IN", kn: "kn-IN",
  gu: "gu-IN", pa: "pa-IN", or: "or-IN", ml: "ml-IN", ur: "ur-IN", en: "en-IN",
  ar: "ar-SA", fr: "fr-FR", es: "es-ES", zh: "zh-CN", sw: "sw-KE",
};

const FORCE_RESET_MS = 2000;

// Append `next` to `acc`, unless one already contains the other — some
// engines deliver cumulative chunks ("weather in" then "weather in delhi").
function joinUnique(acc: string, next: string): string {
  if (!next) return acc;
  if (!acc) return next;
  const a = acc.toLowerCase();
  const n = next.toLowerCase();
  if (n.startsWith(a)) return next;
  if (a.endsWith(n)) return acc;
  return `${acc} ${next}`;
}

function getSpeechRecognition(): any {
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
}

export function useVoiceRecorder(sessionId: string, hintLang?: string) {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [detectedLang, setDetectedLang] = useState<string | null>(null);
  const [error, setError] = useState<"denied" | "unsupported" | "transcribe_failed" | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<any>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startWebSpeech = useCallback((SpeechRecognitionCtor: any) => {
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = SPEECH_LANG_MAP[hintLang || "en"] || "en-IN";
    // Single-utterance mode. With continuous=true, Android Chrome repeats the
    // whole utterance in every final result (and resultIndex resets), so
    // appending finals doubled the text: "12" -> "12 12". A weather query is
    // one utterance anyway; recognition ends on its own after a pause.
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => setIsRecording(true);

    recognition.onresult = (event: any) => {
      // Rebuild from the full results list on every event instead of
      // appending to previous state — idempotent, so re-delivered results
      // can't duplicate text.
      let finalText = "";
      let interimText = "";
      for (let i = 0; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript.trim();
        if (event.results[i].isFinal) finalText = joinUnique(finalText, chunk);
        else interimText = joinUnique(interimText, chunk);
      }
      setInterimTranscript(interimText);
      if (finalText) {
        setTranscript(finalText);
        setDetectedLang(hintLang || "en");
      }
    };

    recognition.onerror = (event: any) => {
      if (event.error === "not-allowed" || event.error === "permission-denied") setError("denied");
      setIsRecording(false);
      setIsProcessing(false);
    };

    recognition.onend = () => {
      setIsRecording(false);
      setIsProcessing(false);
      setInterimTranscript("");
    };

    recognitionRef.current = recognition;
    recognition.start();
    timerRef.current = setTimeout(() => stop(), MAX_SECONDS * 1000);
  }, [hintLang]);

  const startMediaRecorderFallback = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("unsupported");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("denied");
      return;
    }

    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    chunksRef.current = [];
    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    recorder.onstop = async () => {
      setIsProcessing(true);
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      try {
        const result = await transcribeVoice(blob, sessionId, hintLang);
        setTranscript(result.transcribed_text);
        setDetectedLang(result.detected_lang);
      } catch {
        setError("transcribe_failed");
      } finally {
        setIsProcessing(false);
        stream.getTracks().forEach((t) => t.stop());
      }
    };
    recorder.start();
    mediaRecorderRef.current = recorder;
    setIsRecording(true);
    timerRef.current = setTimeout(() => stop(), MAX_SECONDS * 1000);
  }, [sessionId, hintLang]);

  const start = useCallback(async () => {
    setError(null);
    setTranscript("");
    setInterimTranscript("");
    const SpeechRecognitionCtor = getSpeechRecognition();
    if (SpeechRecognitionCtor) {
      startWebSpeech(SpeechRecognitionCtor);
    } else {
      await startMediaRecorderFallback();
    }
  }, [startWebSpeech, startMediaRecorderFallback]);

  const stop = useCallback(() => {
    if (recognitionRef.current) {
      setIsProcessing(true);
      recognitionRef.current.stop();
      // onend may never fire if recognition errors silently, force reset.
      setTimeout(() => {
        setIsRecording(false);
        setIsProcessing(false);
        setInterimTranscript("");
      }, FORCE_RESET_MS);
    }
    mediaRecorderRef.current?.stop();
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(() => () => { recognitionRef.current?.stop(); }, []);

  return {
    isRecording, isProcessing, start, stop, transcript, interimTranscript, detectedLang, error,
    MAX_SECONDS, AUTO_STOP_WARN_SECONDS,
  };
}
