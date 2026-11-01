export type Language = "ko" | "en";

const compact = (text: string) => text.toLowerCase().replace(/[\s.,!?~…'’]/g, "");

// The call follows whichever language the caller speaks. Words Koreans also say ("오케이" heard as "okay") do not flip it.
export function nextLanguage(text: string, current: Language): Language {
  if (/[가-힣]/.test(text)) return "ko";
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  return words.some((word) => !/^(ok|okay|yes|no)$/.test(word)) ? "en" : current;
}

const AFFIRMATIVE = /^(네|예|응|그래|맞아|맞아요|맞습니다|맞네|맞다|그래요|그럼요|좋아|좋아요|부탁해요|주문해|주문해요|주문해줘|주문해주세요|보내줘|보내주세요|해줘|해주세요|그렇게해주세요|그렇게해줘|yes|yeah|yep|yup|correct|right|sure|ok|okay|please|goahead|thatsright|thatscorrect|soundsgood|confirm|placeit|placetheorder|sendit)+$/;
const NEGATIVE = /아니|아뇨|안돼|안되|안해|하지마|말고|틀려|틀렸|다르|취소|잠깐|잠시|바꿔|빼/;
const NEGATIVE_EN = /\b(no|nope|not|don'?t|wrong|cancel|wait|hold on|change|remove|stop)\b/i;
const FILLER = /^(음+|어+|아+|으+|네+|예+|응+|그+|저+|에+|u+m+|u+h+|h?m+|a+h+|o+h+|yes|yeah|yep|ok|okay|right|sure)+$/;

export function isNegative(text: string): boolean {
  return NEGATIVE.test(compact(text)) || NEGATIVE_EN.test(text);
}

// Anchored on purpose: "네 근데 하나 더요" must not place an order.
export function isAffirmative(text: string): boolean {
  const spoken = compact(text);
  return !isNegative(spoken) && AFFIRMATIVE.test(spoken);
}

export function isRepeatRequest(text: string): boolean {
  return /(다시|한번더).*(말|얘기|해주|들려)|뭐라고|안들려|못들었/.test(compact(text)) || /\b(repeat|say (that|it) again|come again|pardon|what did you say|didn'?t (hear|catch))\b/i.test(text);
}

export function isHandoffRequest(text: string): boolean {
  return /상담원|상담사|사람바꿔|사람연결|사람이랑|직원바꿔/.test(compact(text)) || /\b(agent|operator|representative|human|real person|customer service)\b/i.test(text);
}

// Backchannel sounds ("음", "네") must not cut the agent off mid-sentence.
export function isBargeIn(partial: string): boolean {
  const spoken = compact(partial);
  return spoken.length >= 2 && !FILLER.test(spoken);
}

// TTS must never read markdown, emoji or parentheses aloud.
export function sanitizeForTts(text: string): string {
  return text
    .replace(/\([^)]*\)|（[^）]*）/g, "")
    .replace(/[*_#`>\[\]~]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Pulls whole sentences out of a streaming buffer. Decimal points inside numbers do not end a sentence.
export function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const char = buffer[i]!;
    const boundary = char === "\n" || "?!。".includes(char) || (char === "." && !/\d/.test(buffer[i + 1] ?? ""));
    if (!boundary) continue;
    if (char === "." && i === buffer.length - 1 && /\d/.test(buffer[i - 1] ?? "")) break;
    const sentence = buffer.slice(start, i + 1).trim();
    if (sentence) sentences.push(sentence);
    start = i + 1;
  }
  return { sentences, rest: buffer.slice(start) };
}

const DIGITS = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];

function underTenThousand(n: number): string {
  const parts: string[] = [];
  for (const [unit, label] of [[1000, "천"], [100, "백"], [10, "십"]] as const) {
    const digit = Math.floor(n / unit) % 10;
    if (digit) parts.push((digit === 1 ? "" : DIGITS[digit]) + label);
  }
  if (n % 10) parts.push(DIGITS[n % 10]!);
  return parts.join(" ");
}

export function wonToKorean(amount: number): string {
  if (amount === 0) return "영 원";
  const man = Math.floor(amount / 10000);
  const rest = amount % 10000;
  const parts: string[] = [];
  if (man) parts.push(man === 1 ? "만" : `${underTenThousand(man)}만`);
  if (rest) parts.push(underTenThousand(rest));
  return `${parts.join(" ")} 원`;
}

const COUNTS = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉", "열"];

export function countToKorean(n: number): string {
  return COUNTS[n] ?? String(n);
}
