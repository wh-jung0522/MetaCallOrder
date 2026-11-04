export type Language = "ko" | "en";

const compact = (text: string) => text.toLowerCase().replace(/[\s.,!?~…'’]/g, "");

// The call follows whichever language the caller speaks. Words Koreans also say ("오케이" heard as "okay") do not flip it.
export function nextLanguage(text: string, current: Language): Language {
  if (/[가-힣]/.test(text)) return "ko";
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  return words.some((word) => !/^(ok|okay|yes|no)$/.test(word)) ? "en" : current;
}

// "그걸로 해줘", "주문해 주세요", "그대로요": every way of saying go ahead with what was read back.
const GO_AHEAD = ["해", "보내", "주문해", "배달해", "부탁해", "그렇게", "그렇게해", "그걸로", "그걸로해", "그대로", "그대로해", "이대로", "이대로해"]
  .flatMap((stem) => [stem, `${stem}요`, `${stem}줘`, `${stem}줘요`, `${stem}주세요`]);
const YES_WORDS = [
  "네", "넵", "넹", "예", "응", "웅", "그래", "그래요", "그러자", "그러세요", "그럼", "그럼요", "그렇지", "그렇죠", "그렇습니다", "당연하지", "당연하죠",
  "맞아", "맞어", "맞아요", "맞습니다", "맞죠", "맞지", "맞네", "맞네요", "맞다", "맞고요", "좋아", "좋아요", "좋습니다", "좋지", "좋죠", "좋네요",
  "오케이", "알겠어", "알겠어요", "알겠습니다", "알았어", "알았어요", "주세요", "주문할게", "주문할게요", "주문합니다", "그걸로할게요", "부탁합니다", "부탁드려요", "부탁드립니다",
  ...GO_AHEAD,
  "yes", "yeah", "yep", "yup", "correct", "right", "sure", "ok", "okay", "please", "goahead", "thatsright", "thatscorrect", "soundsgood", "confirm", "placeit", "placetheorder", "sendit",
];
// Longest first, so "그래요" is not read as "그래" plus a stray "요". A leading "어" or "음" is just a breath.
const AFFIRMATIVE = new RegExp(`^(음|어|아|으)*(${[...YES_WORDS].sort((a, b) => b.length - a.length).join("|")})+$`);
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
